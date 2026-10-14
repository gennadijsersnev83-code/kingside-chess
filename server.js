const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

let Pool = null;
try { Pool = require('pg').Pool; } catch (e) { console.warn('pg не установлен, работаем на JSON-файле'); }

const app = express();
const server = http.createServer(app);
const io = new Server(server, { transports: ['websocket', 'polling'], pingTimeout: 30000, pingInterval: 10000 });
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
//  РОЛИ
// ============================================================
const ADMINS = new Set(['PeshkaSasha']);
const MODS = new Set(['Debian']);
function isAdmin(u) { return ADMINS.has(u); }
function isMod(u) { return isAdmin(u) || MODS.has(u); }

// ============================================================
//  БАЗА (PostgreSQL если есть, иначе JSON)
// ============================================================
let pool = null;
let db = { users: {}, totalGames: 0 };
const DATA_FILE = path.join(__dirname, 'data.json');

async function initDB() {
  if (process.env.DATABASE_URL && Pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, salt TEXT NOT NULL,
        rating INT DEFAULT 1200, wins INT DEFAULT 0, losses INT DEFAULT 0, draws INT DEFAULT 0,
        games INT DEFAULT 0, created_at BIGINT, muted_until BIGINT DEFAULT 0, is_bot BOOLEAN DEFAULT FALSE
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS games (
        id SERIAL PRIMARY KEY, white TEXT, black TEXT, result TEXT, reason TEXT,
        time_control REAL, increment INT, white_before INT, black_before INT,
        white_after INT, black_after INT, finished_at BIGINT, category TEXT,
        is_arena BOOLEAN DEFAULT FALSE, arena_name TEXT, is_bot BOOLEAN DEFAULT FALSE
      )`);
      console.log('[DB] PostgreSQL готов');
      return;
    } catch (e) { console.error('[DB] Postgres недоступен, откат на JSON:', e.message); pool = null; }
  }
  if (fs.existsSync(DATA_FILE)) {
    try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
  }
  console.log('[DB] JSON-файл');
}
function saveDB() {
  if (pool) return;
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) {}
}
async function saveUser(name) {
  const u = db.users[name]; if (!u) return;
  if (pool) {
    try {
      await pool.query(`INSERT INTO users (username,password_hash,salt,rating,wins,losses,draws,games,created_at,muted_until,is_bot)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (username) DO UPDATE SET rating=EXCLUDED.rating, wins=EXCLUDED.wins, losses=EXCLUDED.losses,
        draws=EXCLUDED.draws, games=EXCLUDED.games, muted_until=EXCLUDED.muted_until`,
        [name, u.passwordHash || '', u.salt || '', u.rating, u.wins, u.losses, u.draws, u.games, u.createdAt || Date.now(), u.mutedUntil || 0, !!u.isBot]);
    } catch (e) { console.error('saveUser:', e.message); }
  } else saveDB();
}
async function saveGame(g) {
  db.totalGames++;
  if (pool) {
    try {
      await pool.query(`INSERT INTO games (white,black,result,reason,time_control,increment,white_before,black_before,white_after,black_after,finished_at,category,is_arena,arena_name,is_bot)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [g.white, g.black, g.result, g.reason, g.timeControl, g.increment, g.whiteBefore, g.blackBefore, g.whiteAfter, g.blackAfter, g.finishedAt, g.category, !!g.isArena, g.arenaName || null, !!g.isBot]);
    } catch (e) { console.error('saveGame:', e.message); }
  } else saveDB();
}

// ============================================================
//  ПАРОЛИ
// ============================================================
function hash(pw, salt) { return crypto.pbkdf2Sync(pw, salt, 50000, 32, 'sha256').toString('hex'); }
function newSalt() { return crypto.randomBytes(16).toString('hex'); }
function verify(pw, salt, h) {
  try { return crypto.timingSafeEqual(Buffer.from(hash(pw, salt), 'hex'), Buffer.from(h, 'hex')); } catch (e) { return false; }
}

// ============================================================
//  ШАХМАТЫ
// ============================================================
function parse(f) {
  const p = f.split(' ');
  const b = Array.from({ length: 8 }, () => Array(8).fill(null));
  p[0].split('/').forEach((row, r) => { let x = 0; for (const ch of row) { if (/\d/.test(ch)) x += +ch; else b[r][x++] = ch; } });
  return { b, turn: p[1], cast: p[2], ep: p[3] };
}
function toFen(s) {
  const rows = s.b.map(r => { let str = '', e = 0; for (const c of r) { if (c) { if (e) { str += e; e = 0; } str += c; } else e++; } if (e) str += e; return str; }).join('/');
  return [rows, s.turn, s.cast, s.ep || '-', 0, 1].join(' ');
}
const isW = p => !!p && p === p.toUpperCase();
const ok = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;

function pseudo(s, r, c) {
  const p = s.b[r][c]; if (!p) return [];
  const m = [], white = isW(p), t = p.toLowerCase(), dir = white ? -1 : 1;
  const add = (rr, cc) => { if (!ok(rr, cc)) return false; const x = s.b[rr][cc]; if (x && isW(x) === white) return false; m.push([rr, cc]); return !x; };
  if (t === 'p') {
    const sr = white ? 6 : 1, r1 = r + dir;
    if (ok(r1, c) && !s.b[r1][c]) { m.push([r1, c]); const r2 = r + 2 * dir; if (r === sr && ok(r2, c) && !s.b[r2][c]) m.push([r2, c]); }
    for (const dc of [-1, 1]) { const rr = r + dir, cc = c + dc; if (!ok(rr, cc)) continue; const x = s.b[rr][cc]; if (x && isW(x) !== white) m.push([rr, cc]); const epT = String.fromCharCode(97 + cc) + (8 - rr); if (s.ep && s.ep === epT && !x) m.push([rr, cc]); }
  } else if (t === 'n') { [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]].forEach(([a,b]) => add(r+a, c+b)); }
  else if (t === 'k') {
    [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]].forEach(([a,b]) => add(r+a, c+b));
    if (white && r === 7 && c === 4) {
      if (s.cast.includes('K') && !s.b[7][5] && !s.b[7][6] && s.b[7][7] === 'R') m.push([7, 6]);
      if (s.cast.includes('Q') && !s.b[7][3] && !s.b[7][2] && !s.b[7][1] && s.b[7][0] === 'R') m.push([7, 2]);
    }
    if (!white && r === 0 && c === 4) {
      if (s.cast.includes('k') && !s.b[0][5] && !s.b[0][6] && s.b[0][7] === 'r') m.push([0, 6]);
      if (s.cast.includes('q') && !s.b[0][3] && !s.b[0][2] && !s.b[0][1] && s.b[0][0] === 'r') m.push([0, 2]);
    }
  } else {
    const dirs = [];
    if (t === 'r' || t === 'q') dirs.push([-1,0],[1,0],[0,-1],[0,1]);
    if (t === 'b' || t === 'q') dirs.push([-1,-1],[-1,1],[1,-1],[1,1]);
    for (const [a,b] of dirs) { let rr = r + a, cc = c + b; while (add(rr, cc)) { rr += a; cc += b; } }
  }
  return m;
}
function findK(s, white) { const k = white ? 'K' : 'k'; for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (s.b[r][c] === k) return [r, c]; return null; }
function atk(s, r, c, byW) {
  for (let rr = 0; rr < 8; rr++) for (let cc = 0; cc < 8; cc++) {
    const p = s.b[rr][cc]; if (!p || isW(p) !== byW) continue;
    const t = p.toLowerCase();
    if (t === 'p') { const d = byW ? -1 : 1; if (rr + d === r && (cc - 1 === c || cc + 1 === c)) return true; continue; }
    if (t === 'k') { if (Math.abs(rr - r) <= 1 && Math.abs(cc - c) <= 1 && (rr !== r || cc !== c)) return true; continue; }
    if (pseudo(s, rr, cc).some(([a,b]) => a === r && b === c)) return true;
  }
  return false;
}
function chk(s, white) { const k = findK(s, white); return k ? atk(s, k[0], k[1], !white) : false; }
function apply(s, from, to) {
  const c = { b: s.b.map(r => r.slice()), turn: s.turn, cast: s.cast, ep: s.ep };
  const [fr, fc] = from, [tr, tc] = to, p = c.b[fr][fc], white = isW(p), t = p.toLowerCase();
  if (t === 'p' && c.ep) { const tgt = String.fromCharCode(97 + tc) + (8 - tr); if (c.ep === tgt && !c.b[tr][tc]) c.b[fr][tc] = null; }
  c.b[tr][tc] = p; c.b[fr][fc] = null;
  if (t === 'p' && (tr === 0 || tr === 7)) c.b[tr][tc] = white ? 'Q' : 'q';
  if (t === 'k' && Math.abs(tc - fc) === 2) { if (tc > fc) { c.b[fr][5] = c.b[fr][7]; c.b[fr][7] = null; } else { c.b[fr][3] = c.b[fr][0]; c.b[fr][0] = null; } }
  let cast = c.cast;
  if (t === 'k') cast = cast.replace(white ? /[KQ]/g : /[kq]/g, '');
  if (t === 'r') { if (fr === 7 && fc === 0) cast = cast.replace('Q', ''); if (fr === 7 && fc === 7) cast = cast.replace('K', ''); if (fr === 0 && fc === 0) cast = cast.replace('q', ''); if (fr === 0 && fc === 7) cast = cast.replace('k', ''); }
  c.cast = cast || '-';
  c.ep = (t === 'p' && Math.abs(tr - fr) === 2) ? String.fromCharCode(97 + fc) + (8 - (fr + (tr - fr) / 2)) : '-';
  c.turn = white ? 'b' : 'w';
  return c;
}
function legal(s, r, c) { const p = s.b[r][c]; if (!p) return []; const w = isW(p); return pseudo(s, r, c).filter(([a,b]) => !chk(apply(s, [r,c], [a,b]), w)); }
function allLegal(s, white) { const res = []; for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) { const p = s.b[r][c]; if (!p || isW(p) !== white) continue; for (const [a,b] of legal(s, r, c)) res.push([[r,c],[a,b]]); } return res; }
function endCheck(s) { const w = s.turn === 'w'; if (!allLegal(s, w).length) return chk(s, w) ? { result: w ? 'b' : 'w', reason: 'Мат' } : { result: 'draw', reason: 'Пат' }; return null; }
function toSAN(s, from, to) {
  const [fr, fc] = from, [tr, tc] = to, p = s.b[fr][fc]; if (!p) return '';
  const t = p.toLowerCase(), isCap = !!s.b[tr][tc] || (t === 'p' && fc !== tc);
  const dest = String.fromCharCode(97 + tc) + (8 - tr);
  if (t === 'k' && Math.abs(tc - fc) === 2) return tc > fc ? 'O-O' : 'O-O-O';
  let san = '';
  if (t === 'p') { if (isCap) san += String.fromCharCode(97 + fc) + 'x'; san += dest; }
  else {
    san += t === 'n' ? 'N' : t.toUpperCase();
    let amb = false, sf = false, sr = false;
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      if (r === fr && c === fc) continue;
      const q = s.b[r][c]; if (!q || q !== p) continue;
      if (legal(s, r, c).some(([a,b]) => a === tr && b === tc)) { amb = true; if (c === fc) sf = true; if (r === fr) sr = true; }
    }
    if (amb) { if (!sf) san += String.fromCharCode(97 + fc); else if (!sr) san += (8 - fr); else san += String.fromCharCode(97 + fc) + (8 - fr); }
    if (isCap) san += 'x';
    san += dest;
  }
  const next = apply(s, from, to);
  const nw = next.turn === 'w';
  if (chk(next, nw)) san += allLegal(next, nw).length ? '+' : '#';
  return san;
}

// ============================================================
//  БОТЫ
// ============================================================
const BOTS = [
  { name: 'BotEasy',   level: 1, rating: 800,  title: 'Лёгкий',   desc: 'для новичков' },
  { name: 'BotMedium', level: 2, rating: 1200, title: 'Средний',  desc: 'подумает' },
  { name: 'BotHard',   level: 3, rating: 1600, title: 'Сложный',  desc: 'тактика' },
  { name: 'BotMaster', level: 4, rating: 2000, title: 'Мастер',   desc: 'сильный' }
];
const BOT_NAMES = new Set(BOTS.map(b => b.name));
const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

function botPickMove(fenStr, level) {
  const s = parse(fenStr);
  const w = s.turn === 'w';
  const moves = allLegal(s, w);
  if (!moves.length) return null;
  if (level === 1) return moves[(Math.random() * moves.length) | 0];
  let best = null, bestScore = -Infinity;
  for (const [from, to] of moves) {
    let score = 0;
    const cap = s.b[to[0]][to[1]];
    if (cap) score += (VAL[cap.toLowerCase()] || 0) * 10;
    if (level >= 3) {
      const ns = apply(s, from, to);
      if (atk(ns, to[0], to[1], !w)) score -= (VAL[s.b[from[0]][from[1]].toLowerCase()] || 0) * 8;
    }
    score += Math.random() * (level === 2 ? 5 : level === 3 ? 2 : 0.5);
    if (score > bestScore) { bestScore = score; best = [from, to]; }
  }
  return best;
}

function ensureBots() {
  for (const b of BOTS) {
    if (!db.users[b.name]) {
      db.users[b.name] = {
        passwordHash: '', salt: '', rating: b.rating,
        wins: 0, losses: 0, draws: 0, games: 0,
        createdAt: Date.now(), mutedUntil: 0, isBot: true
      };
    }
  }
}

// ============================================================
//  ХРАНИЛИЩЕ ИГР
// ============================================================
const online = new Map();
const lobbies = new Map();
const sockToLobby = new Map();
const arenas = new Map();

function genId() { return Math.random().toString(36).slice(2, 10); }
function publicUser(name) {
  const u = db.users[name]; if (!u) return null;
  return { username: name, rating: u.rating, wins: u.wins, losses: u.losses, draws: u.draws, games: u.games,
    isBot: !!u.isBot, isAdmin: isAdmin(name), isMod: isMod(name), mutedUntil: u.mutedUntil || 0, createdAt: u.createdAt };
}
function countActive() { let n = 0; for (const l of lobbies.values()) if (!l.finished && l.started) n++; return n; }
function countOnline() { return online.size + BOTS.length; }
function broadcast() {
  io.emit('stats', { online: countOnline(), games: db.totalGames, active: countActive() });
}
function pushLobbies() {
  const list = [];
  for (const [id, l] of lobbies) {
    if (l.finished || l.arenaId || !l.started && l.guest) continue;
    if (l.arenaId) continue;
    list.push({ id, host: l.host, time: l.time, inc: l.inc, status: l.guest ? 'playing' : 'waiting', isBot: !!l.isBot, hostRating: db.users[l.host]?.rating || 0 });
  }
  io.emit('lobbies', list);
  broadcast();
}

// ============================================================
//  ФИНАЛИЗАЦИЯ
// ============================================================
async function finishGame(lid, result, reason) {
  const l = lobbies.get(lid);
  if (!l || l.finished) return;
  l.finished = true;

  const whiteName = l.hostColor === 'w' ? l.host : l.guest;
  const blackName = l.hostColor === 'b' ? l.host : l.guest;
  const wu = db.users[whiteName], bu = db.users[blackName];
  if (!wu || !bu) { lobbies.delete(lid); return; }

  const expW = 1 / (1 + Math.pow(10, (bu.rating - wu.rating) / 400));
  const sW = result === 'w' ? 1 : result === 'b' ? 0 : 0.5;
  const dW = Math.round(32 * (sW - expW));
  const wAfter = wu.rating + dW, bAfter = bu.rating - dW;

  const cat = l.time < 3 ? 'bullet' : l.time < 10 ? 'blitz' : l.time < 30 ? 'rapid' : 'classical';
  wu.rating = wAfter; wu.games++;
  if (result === 'w') wu.wins++; else if (result === 'b') wu.losses++; else wu.draws++;
  bu.rating = bAfter; bu.games++;
  if (result === 'b') bu.wins++; else if (result === 'w') bu.losses++; else bu.draws++;

  // Не меняем рейтинг ботов
  if (wu.isBot) wu.rating = wu.rating - dW;
  if (bu.isBot) bu.rating = bu.rating + dW;

  await saveUser(whiteName);
  await saveUser(blackName);
  await saveGame({
    white: whiteName, black: blackName, result, reason,
    timeControl: l.time, increment: l.inc,
    whiteBefore: wu.rating - dW, blackBefore: bu.rating + dW,
    whiteAfter: wAfter, blackAfter: bAfter,
    finishedAt: Date.now(), category: cat,
    isArena: !!l.arenaId, arenaName: l.arenaName || null, isBot: !!l.isBot
  });

  io.to(lid).emit('end', { result, reason, whiteDelta: dW, blackDelta: -dW });
  if (l.arenaId) handleArenaEnd(l.arenaId, lid, result, whiteName, blackName);

  setTimeout(() => {
    const cur = lobbies.get(lid);
    if (cur) {
      io.to(lid).socketsLeave(lid);
      lobbies.delete(lid);
      pushLobbies();
    }
  }, 3000);
}

// ============================================================
//  АРЕНЫ
// ============================================================
const ARENA_TEMPLATES = [
  { id: 'blitz-hourly', name: 'Ежечасный блиц', timeControl: 3, increment: 2, durationMin: 50, repeat: 'hourly', color: 'blitz', botFriendly: false },
  { id: 'rapid-2h', name: 'Двухчасовой рапид', timeControl: 10, increment: 0, durationMin: 110, repeat: 'every2h', color: 'rapid', botFriendly: false },
  { id: 'bot-blitz', name: 'Блиц с ботами', timeControl: 3, increment: 2, durationMin: 50, repeat: 'hourly', color: 'blitz', botFriendly: true }
];

function nextStart(tpl, now) {
  const d = new Date(now);
  const h = d.getHours(), mi = d.getMinutes();
  const msk = new Date(now + 3 * 3600 * 1000);
  const mh = msk.getUTCHours(), mmi = msk.getUTCMinutes();
  if (tpl.repeat === 'hourly') {
    const base = Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate(), mh + 1, 0, 0) - 3 * 3600 * 1000;
    return base;
  }
  if (tpl.repeat === 'every2h') {
    const nextH = mh % 2 === 0 ? mh + 2 : mh + 1;
    return Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate(), nextH, 0, 0) - 3 * 3600 * 1000;
  }
  return now + 3600000;
}
function stepFor(tpl) { return tpl.repeat === 'hourly' ? 3600000 : 7200000; }

function getOrCreateArena(inst) {
  const now = Date.now();
  let st = arenas.get(inst.id);
  if (st) { st.startsAt = inst.startsAt; st.endsAt = inst.endsAt; return st; }
  st = {
    id: inst.id, name: inst.name, timeControl: inst.timeControl, increment: inst.increment,
    startsAt: inst.startsAt, endsAt: inst.endsAt, color: inst.color, botFriendly: !!inst.botFriendly,
    phase: 'waiting', participants: new Map(), finished: false, top3: null,
    pairingInterval: null, activeLobbies: new Set(), chat: [], chatViewers: new Set(),
    finishedGames: [], pairingNow: null
  };
  arenas.set(inst.id, st);
  scheduleArena(st);
  return st;
}
function scheduleArena(st) {
  const now = Date.now();
  const sd = Math.max(0, st.startsAt - now), ed = Math.max(0, st.endsAt - now);
  if (sd > 0) setTimeout(() => {
    if (st.finished) return;
    st.phase = 'live';
    if (st.botFriendly) joinBots(st);
    io.emit('arenaUpdate', { arenaId: st.id });
    io.emit('arenaStarted', { arenaId: st.id });
    const sys = { id: 'sys' + Date.now(), system: true, text: `Арена "${st.name}" началась!`, ts: Date.now(), arenaId: st.id };
    st.chat.push(sys);
    io.emit('arenaChatMessage', sys);
    st.pairingInterval = setInterval(() => tryPair(st), 3000);
    tryPair(st);
  }, sd);
  else if (now < st.endsAt && !st.finished) {
    st.phase = 'live';
    if (st.botFriendly) joinBots(st);
    st.pairingInterval = setInterval(() => tryPair(st), 3000);
    tryPair(st);
  }
  if (ed > 0) setTimeout(() => finishArena(st), ed);
  else finishArena(st);
}
function joinBots(st) {
  if (!st.botFriendly) return;
  for (const bot of BOTS) {
    if (st.participants.has(bot.name)) continue;
    if (Math.random() < 0.5) continue;
    const u = db.users[bot.name];
    st.participants.set(bot.name, {
      username: bot.name, rating: u.rating, score: 0, wins: 0, draws: 0, losses: 0,
      winStreak: 0, drawStreak: 0, isPlaying: false, paused: false, isBot: true, waitingSince: Date.now()
    });
  }
}

// Ограничения на ботов
const MAX_BOT_GAMES_PER_ARENA = 2;
const MAX_PAIRS_PER_TICK = 2;
const MAX_ACTIVE_IN_ARENA = 6;

function botBusy(name) {
  let n = 0;
  for (const l of lobbies.values()) {
    if (l.finished || !l.isBot) continue;
    if (l.botName === name || l.botName2 === name) n++;
  }
  return n >= 1;
}
function botsInArena(aid) {
  let n = 0;
  for (const l of lobbies.values()) if (!l.finished && l.isBot && l.arenaId === aid) n++;
  return n;
}

function tryPair(st) {
  if (st.finished || st.phase !== 'live') return;
  if (st.activeLobbies.size >= MAX_ACTIVE_IN_ARENA) return;
  const hasHumans = [...st.participants.values()].some(p => !p.isBot);
  if (!hasHumans && Math.random() > 0.35) return;

  const avail = [];
  for (const p of st.participants.values()) {
    if (p.isPlaying || p.paused) continue;
    if (p.isBot && botBusy(p.username)) continue;
    if (p.isBot && botsInArena(st.id) >= MAX_BOT_GAMES_PER_ARENA) continue;
    avail.push(p);
  }
  if (avail.length < 2) { st.pairingNow = avail[0]?.username || null; return; }
  st.pairingNow = null;
  avail.sort((a, b) => a.waitingSince - b.waitingSince);
  const used = new Set();
  let created = 0;
  for (let i = 0; i < avail.length && created < MAX_PAIRS_PER_TICK; i++) {
    const a = avail[i]; if (used.has(a.username)) continue;
    let best = null, bestDiff = Infinity;
    for (let j = 0; j < avail.length; j++) {
      if (i === j) continue;
      const b = avail[j]; if (used.has(b.username)) continue;
      if (a.isBot && b.isBot) {
        const humansWaiting = avail.some(p => !p.isBot && !used.has(p.username));
        if (humansWaiting) continue;
        if (Math.random() < 0.7) continue;
        if (botsInArena(st.id) >= MAX_BOT_GAMES_PER_ARENA) continue;
      }
      const d = Math.abs((a.score || 0) - (b.score || 0));
      if (d < bestDiff) { bestDiff = d; best = b; }
    }
    if (!best) continue;
    createPair(st, a, best);
    used.add(a.username); used.add(best.username);
    a.waitingSince = null; best.waitingSince = null;
    created++;
  }
}

function createPair(st, a, b) {
  const lid = genId();
  const hw = Math.random() < 0.5;
  const hc = hw ? 'w' : 'b', gc = hw ? 'b' : 'w';
  const isBot = a.isBot || b.isBot;
  lobbies.set(lid, {
    id: lid, host: a.username, hostSocket: a.socketId || null,
    guest: b.username, guestSocket: b.socketId || null,
    hostColor: hc, guestColor: gc, time: st.timeControl, inc: st.increment,
    tW: st.timeControl * 60, tB: st.timeControl * 60, turn: 'w',
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    started: true, finished: false, tick: Date.now(), chat: [], isBot,
    botName: a.isBot ? a.username : (b.isBot ? b.username : null),
    botColor: a.isBot ? hc : (b.isBot ? gc : null),
    botName2: a.isBot && b.isBot ? b.username : null,
    botColor2: a.isBot && b.isBot ? gc : null,
    arenaId: st.id, arenaName: st.name, history: []
  });
  st.activeLobbies.add(lid);
  a.isPlaying = true; a.lobbyId = lid;
  b.isPlaying = true; b.lobbyId = lid;

  const aS = a.socketId ? io.sockets.sockets.get(a.socketId) : null;
  const bS = b.socketId ? io.sockets.sockets.get(b.socketId) : null;
  if (aS) {
    aS.join(lid);
    aS.emit('start', { color: hc, opponent: b.username, oppRating: db.users[b.username].rating, time: st.timeControl, inc: st.increment, fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', gameId: lid, isBot: !!b.isBot, arenaId: st.id, arenaName: st.name });
  }
  if (bS) {
    bS.join(lid);
    bS.emit('start', { color: gc, opponent: a.username, oppRating: db.users[a.username].rating, time: st.timeControl, inc: st.increment, fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', gameId: lid, isBot: !!a.isBot, arenaId: st.id, arenaName: st.name });
  }
  io.emit('arenaUpdate', { arenaId: st.id });

  if (isBot && (lobbies.get(lid).botColor === 'w' || lobbies.get(lid).botColor2 === 'w')) {
    setTimeout(() => scheduleBot(lid), 500 + Math.random() * 500);
  }
}

function calcPoints(p, res) {
  if (res === 'win') { p.winStreak = (p.winStreak || 0) + 1; p.drawStreak = 0; return p.winStreak >= 3 ? 4 : 2; }
  if (res === 'draw') { p.drawStreak = (p.drawStreak || 0) + 1; p.winStreak = 0; return p.drawStreak >= 2 ? 2 : 1; }
  p.winStreak = 0; p.drawStreak = 0; return 0;
}

function handleArenaEnd(aid, lid, result, wName, bName) {
  const st = arenas.get(aid); if (!st) return;
  st.activeLobbies.delete(lid);
  st.finishedGames.push({ white: wName, black: bName, result, finishedAt: Date.now() });
  if (st.finishedGames.length > 200) st.finishedGames.shift();

  const wp = st.participants.get(wName), bp = st.participants.get(bName);
  if (wp) { wp.isPlaying = false; wp.lobbyId = null; if (!wp.paused) wp.waitingSince = Date.now(); }
  if (bp) { bp.isPlaying = false; bp.lobbyId = null; if (!bp.paused) bp.waitingSince = Date.now(); }

  if (st.finished || !wp || !bp) { io.emit('arenaUpdate', { arenaId: aid }); return; }
  if (result === 'w') { wp.score += calcPoints(wp, 'win'); wp.wins++; bp.losses++; calcPoints(bp, 'loss'); }
  else if (result === 'b') { bp.score += calcPoints(bp, 'win'); bp.wins++; wp.losses++; calcPoints(wp, 'loss'); }
  else { wp.score += calcPoints(wp, 'draw'); bp.score += calcPoints(bp, 'draw'); wp.draws++; bp.draws++; }
  setTimeout(() => tryPair(st), 300);
  io.emit('arenaUpdate', { arenaId: aid });
}

function finishArena(st) {
  if (st.finished) return;
  st.finished = true; st.phase = 'finished';
  if (st.pairingInterval) clearInterval(st.pairingInterval);
  for (const p of st.participants.values()) { p.isPlaying = false; p.lobbyId = null; }
  const all = [...st.participants.values()].sort((a, b) => b.score - a.score || b.wins - a.wins || b.rating - a.rating);
  st.top3 = all.slice(0, 3).map(p => ({ username: p.username, score: p.score, wins: p.wins, draws: p.draws, losses: p.losses, rating: p.rating }));
  const sys = { id: 'sys' + Date.now(), system: true, text: `Арена "${st.name}" завершена!`, ts: Date.now(), arenaId: st.id };
  st.chat.push(sys);
  io.emit('arenaChatMessage', sys);
  io.emit('arenaFinished', { arenaId: st.id, top3: st.top3 });
  // Удаляем ботов из participants
  for (const [name, p] of [...st.participants.entries()]) if (p.isBot) st.participants.delete(name);
  setTimeout(() => arenas.delete(st.id), 30 * 60 * 1000);
}

function getArenaSchedule(hoursAhead) {
  hoursAhead = hoursAhead || 48;
  const now = Date.now(), end = now + hoursAhead * 3600000;
  const out = [];
  for (const tpl of ARENA_TEMPLATES) {
    let t = nextStart(tpl, now - tpl.durationMin * 60000);
    let safety = 0;
    while (t <= end && safety < 200) {
      safety++;
      const endsAt = t + tpl.durationMin * 60000;
      let status = t > now ? 'upcoming' : now < endsAt ? 'live' : 'finished';
      if (status === 'finished' && endsAt < now - 3600000) { t += stepFor(tpl); continue; }
      const inst = { id: `${tpl.id}-${t}`, name: tpl.name, timeControl: tpl.timeControl, increment: tpl.increment, startsAt: t, endsAt, status, color: tpl.color, botFriendly: tpl.botFriendly };
      out.push(inst);
      if (status === 'live' || (status === 'upcoming' && t - now < 24 * 3600000)) getOrCreateArena(inst);
      t += stepFor(tpl);
    }
  }
  return out.sort((a, b) => a.startsAt - b.startsAt);
}

// ============================================================
//  ТИКЕР
// ============================================================
setInterval(() => {
  const now = Date.now();
  for (const [id, l] of lobbies) {
    if (!l.started || l.finished) continue;
    const dt = Math.floor((now - l.tick) / 1000); if (dt <= 0) continue;
    l.tick = now;
    if (l.turn === 'w') l.tW = Math.max(0, l.tW - dt); else l.tB = Math.max(0, l.tB - dt);
    io.to(id).emit('times', { tW: l.tW, tB: l.tB });
    if (l.tW <= 0) finishGame(id, 'b', 'Время');
    else if (l.tB <= 0) finishGame(id, 'w', 'Время');
  }
}, 1000);

// ============================================================
//  ХОД БОТА
// ============================================================
function scheduleBot(lid) {
  const l = lobbies.get(lid);
  if (!l || l.finished || !l.isBot) return;
  const cur = l.turn;
  const botColor = l.botColor === cur ? l.botColor : l.botColor2 === cur ? l.botColor2 : null;
  const botName = botColor === l.botColor ? l.botName : botColor === l.botColor2 ? l.botName2 : null;
  if (!botColor || !botName) return;

  const isBotVsBot = !!l.botName2;
  const delay = isBotVsBot ? 500 + Math.random() * 800 : 300 + Math.random() * 500;

  setTimeout(() => {
    const c = lobbies.get(lid);
    if (!c || c.finished || c.turn !== botColor) return;
    const still = (c.botColor === botColor && c.botName === botName) || (c.botColor2 === botColor && c.botName2 === botName);
    if (!still) return;

    const level = BOTS.find(b => b.name === botName)?.level || 2;
    const mv = botPickMove(c.fen, level);
    if (!mv) return;
    const [from, to] = mv;
    const s = parse(c.fen);
    if (!legal(s, from[0], from[1]).some(([a,b]) => a === to[0] && b === to[1])) return;

    const next = apply(s, from, to);
    c.fen = toFen(next); c.turn = next.turn; c.tick = Date.now();
    io.to(lid).emit('board', { fen: c.fen });
    const end = endCheck(next);
    if (end) { finishGame(lid, end.result, end.reason); return; }
    if (c.isBot && ((c.botColor && c.turn === c.botColor) || (c.botColor2 && c.turn === c.botColor2))) {
      setTimeout(() => scheduleBot(lid), isBotVsBot ? 400 + Math.random() * 600 : 250 + Math.random() * 400);
    }
  }, delay);
}

// ============================================================
//  SOCKET
// ============================================================
io.on('connection', (socket) => {
  socket.emit('stats', { online: countOnline(), games: db.totalGames, active: countActive() });

  socket.on('register', async ({ username, password }, cb) => {
    if (typeof cb !== 'function') return;
    if (!username || !password) return cb({ ok: false, msg: 'Заполни поля' });
    if (BOT_NAMES.has(username)) return cb({ ok: false, msg: 'Имя занято' });
    if (username.length < 2 || username.length > 24) return cb({ ok: false, msg: 'Логин 2-24' });
    if (!/^[a-zA-Z0-9_\-а-яА-Я]+$/.test(username)) return cb({ ok: false, msg: 'Только буквы, цифры, _ -' });

    let u = db.users[username];
    if (u) {
      if (u.isBot) return cb({ ok: false, msg: 'Это бот' });
      if (!verify(password, u.salt, u.passwordHash)) return cb({ ok: false, msg: 'Неверный пароль' });
    } else {
      const salt = newSalt();
      u = { passwordHash: hash(password, salt), salt, rating: 1200, wins: 0, losses: 0, draws: 0, games: 0, createdAt: Date.now(), mutedUntil: 0, isBot: false };
      db.users[username] = u;
      await saveUser(username);
    }
    online.set(socket.id, username);
    socket.username = username;
    cb({ ok: true, user: publicUser(username) });
    broadcast();
  });

  socket.on('getProfile', ({ username }, cb) => {
    if (typeof cb !== 'function') return;
    const u = db.users[username];
    if (!u) return cb({ ok: false, msg: 'Не найден' });
    cb({ ok: true, user: publicUser(username) });
  });
  socket.on('getStats', cb => { if (typeof cb === 'function') cb({ online: countOnline(), games: db.totalGames, active: countActive() }); });
  socket.on('getBots', cb => { if (typeof cb !== 'function') return; cb(BOTS.map(b => ({ name: b.name, title: b.title, desc: b.desc, level: b.level, rating: db.users[b.name].rating }))); });
  socket.on('getLobbies', cb => { if (typeof cb !== 'function') return; const l = []; for (const [id, g] of lobbies) { if (g.finished || g.arenaId || g.started) continue; l.push({ id, host: g.host, time: g.time, inc: g.inc, isBot: !!g.isBot, hostRating: db.users[g.host]?.rating || 0 }); } cb(l); });

  socket.on('create', ({ time, inc }, cb) => {
    if (typeof cb !== 'function') return;
    if (!socket.username) return cb({ ok: false, msg: 'Не авторизован' });
    time = Math.max(1, Math.min(60, +time || 5)); inc = Math.max(0, Math.min(60, +inc || 0));
    for (const [, g] of lobbies) {
      if (g.finished || g.arenaId || g.isBot || g.guest) continue;
      if (g.host === socket.username) continue;
      if (g.time !== time || g.inc !== inc) continue;
      g.guest = socket.username; g.guestSocket = socket.id;
      const hw = Math.random() < 0.5;
      g.hostColor = hw ? 'w' : 'b'; g.guestColor = hw ? 'b' : 'w';
      g.started = true; g.tick = Date.now();
      socket.join(g.id); sockToLobby.set(socket.id, g.id);
      io.to(g.hostSocket).emit('start', { color: g.hostColor, opponent: g.guest, oppRating: db.users[g.guest].rating, time: g.time, inc: g.inc, fen: g.fen, gameId: g.id, isBot: false });
      io.to(g.guestSocket).emit('start', { color: g.guestColor, opponent: g.host, oppRating: db.users[g.host].rating, time: g.time, inc: g.inc, fen: g.fen, gameId: g.id, isBot: false });
      cb({ ok: true, matched: true }); pushLobbies(); return;
    }
    const id = genId();
    lobbies.set(id, {
      id, host: socket.username, hostSocket: socket.id, guest: null, guestSocket: null,
      hostColor: null, guestColor: null, time, inc, tW: time * 60, tB: time * 60,
      turn: 'w', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      started: false, finished: false, tick: Date.now(), isBot: false
    });
    socket.join(id); sockToLobby.set(socket.id, id);
    cb({ ok: true, id }); pushLobbies();
  });

  socket.on('join', ({ id }, cb) => {
    if (typeof cb !== 'function') return;
    if (!socket.username) return cb({ ok: false, msg: 'Не авторизован' });
    const g = lobbies.get(id);
    if (!g) return cb({ ok: false, msg: 'Не найдено' });
    if (g.guest) return cb({ ok: false, msg: 'Занято' });
    if (g.host === socket.username) return cb({ ok: false, msg: 'Ваше лобби' });
    g.guest = socket.username; g.guestSocket = socket.id;
    const hw = Math.random() < 0.5;
    g.hostColor = hw ? 'w' : 'b'; g.guestColor = hw ? 'b' : 'w';
    g.started = true; g.tick = Date.now();
    socket.join(id); sockToLobby.set(socket.id, id);
    io.to(g.hostSocket).emit('start', { color: g.hostColor, opponent: g.guest, oppRating: db.users[g.guest].rating, time: g.time, inc: g.inc, fen: g.fen, gameId: id, isBot: !!g.isBot });
    io.to(g.guestSocket).emit('start', { color: g.guestColor, opponent: g.host, oppRating: db.users[g.host].rating, time: g.time, inc: g.inc, fen: g.fen, gameId: id, isBot: !!g.isBot });
    if (g.isBot) setTimeout(() => scheduleBot(id), 500);
    cb({ ok: true }); pushLobbies();
  });

  socket.on('cancel', ({ id }) => { const g = lobbies.get(id); if (!g || g.host !== socket.username || g.started) return; lobbies.delete(id); sockToLobby.delete(socket.id); pushLobbies(); });

  socket.on('playBot', ({ time, inc, bot }, cb) => {
    if (typeof cb !== 'function') return;
    if (!socket.username) return cb({ ok: false, msg: 'Не авторизован' });
    const b = BOTS.find(x => x.name === bot);
    if (!b) return cb({ ok: false, msg: 'Бот не найден' });
    if (botBusy(bot)) return cb({ ok: false, msg: 'Бот занят' });
    time = Math.max(1, Math.min(60, +time || 5)); inc = Math.max(0, Math.min(60, +inc || 0));
    const id = genId();
    lobbies.set(id, {
      id, host: socket.username, hostSocket: socket.id, guest: bot, guestSocket: null,
      hostColor: 'w', guestColor: 'b', time, inc, tW: time * 60, tB: time * 60,
      turn: 'w', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      started: true, finished: false, tick: Date.now(), isBot: true, botName: bot, botColor: 'b'
    });
    socket.join(id); sockToLobby.set(socket.id, id);
    io.to(socket.id).emit('start', { color: 'w', opponent: bot, oppRating: db.users[bot].rating, time, inc, fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', gameId: id, isBot: true });
    cb({ ok: true }); pushLobbies();
  });

  socket.on('move', ({ gameId, fen: nf }) => {
    const g = lobbies.get(gameId);
    if (!g || g.finished || !g.started) return;
    const mc = socket.id === g.hostSocket ? g.hostColor : g.guestColor;
    if (g.turn !== mc) return;
    if (typeof nf !== 'string') return;
    const nt = nf.split(' ')[1]; if (nt === g.turn) return;
    const now = Date.now(); const dt = Math.floor((now - g.tick) / 1000);
    if (mc === 'w') g.tW = Math.max(0, g.tW - dt) + g.inc; else g.tB = Math.max(0, g.tB - dt) + g.inc;
    g.tick = now; g.fen = nf; g.turn = nt;
    io.to(gameId).emit('board', { fen: nf });
    io.to(gameId).emit('times', { tW: g.tW, tB: g.tB });
    const s = parse(nf);
    const end = endCheck(s);
    if (end) { finishGame(gameId, end.result, end.reason); return; }
    if (g.isBot && g.turn === g.botColor) scheduleBot(gameId);
  });

  socket.on('resign', ({ gameId }) => { const g = lobbies.get(gameId); if (!g || g.finished) return; const mc = socket.id === g.hostSocket ? g.hostColor : g.guestColor; finishGame(gameId, mc === 'w' ? 'b' : 'w', 'Сдача'); });
  socket.on('drawOffer', ({ gameId }) => {
    const g = lobbies.get(gameId); if (!g || g.finished) return;
    if (g.isBot) {
      const s = parse(g.fen); let sc = 0;
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) { const p = s.b[r][c]; if (!p) continue; sc += (isW(p) ? 1 : -1) * (VAL[p.toLowerCase()] || 0); }
      const bs = g.botColor === 'w' ? 1 : -1;
      setTimeout(() => { if (sc * bs <= 0) finishGame(gameId, 'draw', 'Ничья'); else socket.emit('drawNo'); }, 400);
    } else socket.to(gameId).emit('drawOffer');
  });
  socket.on('drawYes', ({ gameId }) => { if (lobbies.has(gameId)) finishGame(gameId, 'draw', 'Ничья'); });
  socket.on('drawNo', ({ gameId }) => socket.to(gameId).emit('drawNo'));

  socket.on('chat', ({ gameId, text }) => {
    const g = lobbies.get(gameId); if (!g || !socket.username) return;
    if (typeof text !== 'string') return;
    text = text.trim().slice(0, 200); if (!text) return;
    io.to(gameId).emit('chat', { user: socket.username, text, ts: Date.now() });
  });

  socket.on('getGame', ({ gameId }, cb) => {
    if (typeof cb !== 'function') return;
    const g = lobbies.get(gameId); if (!g) return cb({ ok: false });
    if (socket.username !== g.host && socket.username !== g.guest) return cb({ ok: false });
    if (socket.username === g.host) g.hostSocket = socket.id; else g.guestSocket = socket.id;
    socket.join(gameId); sockToLobby.set(socket.id, gameId);
    const mc = socket.username === g.host ? g.hostColor : g.guestColor;
    const opp = socket.username === g.host ? g.guest : g.host;
    cb({ ok: true, state: { myColor: mc, opponent: opp, time: g.time, inc: g.inc, tW: g.tW, tB: g.tB, fen: g.fen, finished: g.finished, isBot: !!g.isBot } });
  });

  // Арены
  socket.on('getArenas', cb => { if (typeof cb === 'function') cb({ list: getArenaSchedule(48), now: Date.now() }); });
  socket.on('getArenaState', ({ arenaId }, cb) => {
    if (typeof cb !== 'function') return;
    const st = arenas.get(arenaId);
    if (!st) return cb({ joined: false, paused: false, participants: [], phase: 'waiting', top3: null, pairingNow: null, startsAt: 0, endsAt: 0 });
    const parts = [...st.participants.values()].map(p => ({
      username: p.username, rating: p.rating, score: p.score, wins: p.wins, draws: p.draws, losses: p.losses,
      winStreak: p.winStreak || 0, drawStreak: p.drawStreak || 0, paused: !!p.paused,
      isAdmin: isAdmin(p.username), isMod: isMod(p.username), isBot: !!p.isBot
    })).sort((a, b) => b.score - a.score || b.rating - a.rating);
    const me = socket.username ? st.participants.get(socket.username) : null;
    cb({ joined: !!me, paused: !!(me && me.paused), participants: parts, phase: st.phase, top3: st.top3, pairingNow: st.pairingNow, startsAt: st.startsAt, endsAt: st.endsAt, now: Date.now() });
  });
  socket.on('joinArenaRoom', ({ arenaId }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    const st = arenas.get(arenaId); if (!st) return cb({ ok: false });
    socket.join('arena:' + arenaId);
    st.chatViewers.add(socket.id);
    cb({ ok: true, chat: st.chat || [] });
    tryPair(st);
  });
  socket.on('leaveArenaRoom', ({ arenaId }) => { const st = arenas.get(arenaId); socket.leave('arena:' + arenaId); if (st) st.chatViewers.delete(socket.id); });
  socket.on('joinArena', ({ arenaId }, cb) => {
    if (typeof cb !== 'function') return;
    if (!socket.username) return cb({ ok: false, msg: 'Не авторизован' });
    const st = arenas.get(arenaId); if (!st) return cb({ ok: false, msg: 'Арена не найдена' });
    if (st.finished) return cb({ ok: false, msg: 'Арена завершена' });
    if (st.participants.has(socket.username)) return cb({ ok: true });
    st.participants.set(socket.username, { username: socket.username, rating: db.users[socket.username].rating, score: 0, wins: 0, draws: 0, losses: 0, winStreak: 0, drawStreak: 0, socketId: socket.id, isPlaying: false, paused: false, waitingSince: Date.now(), isBot: false });
    const sys = { id: 'sys' + Date.now(), system: true, text: `${socket.username} присоединился`, ts: Date.now(), arenaId: st.id };
    st.chat.push(sys);
    io.to('arena:' + st.id).emit('arenaChatMessage', sys);
    io.emit('arenaUpdate', { arenaId });
    if (st.phase === 'live') tryPair(st);
    cb({ ok: true });
  });
  socket.on('pauseArena', ({ arenaId }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    const st = arenas.get(arenaId); if (!st) return cb({ ok: false });
    const p = st.participants.get(socket.username); if (!p) return cb({ ok: false });
    p.paused = !p.paused;
    if (!p.paused) p.waitingSince = Date.now();
    io.emit('arenaUpdate', { arenaId });
    cb({ ok: true, paused: p.paused });
  });
  socket.on('arenaChat', ({ arenaId, text }) => {
    const st = arenas.get(arenaId); if (!st || !socket.username) return;
    text = String(text).trim().slice(0, 200); if (!text) return;
    const msg = { id: 'a' + Date.now(), user: socket.username, text, ts: Date.now(), arenaId };
    st.chat.push(msg);
    io.to('arena:' + arenaId).emit('arenaChatMessage', msg);
  });

  socket.on('disconnect', () => {
    online.delete(socket.id);
    const gid = sockToLobby.get(socket.id);
    sockToLobby.delete(socket.id);
    if (gid) { const g = lobbies.get(gid); if (g && !g.finished && !g.started) { lobbies.delete(gid); pushLobbies(); } }
    for (const st of arenas.values()) {
      st.chatViewers.delete(socket.id);
      const p = st.participants.get(socket.username);
      if (p && p.socketId === socket.id) p.socketId = null;
    }
    broadcast();
  });
});

// ============================================================
//  СТАРТ
// ============================================================
(async () => {
  await initDB();
  ensureBots();
  saveDB();
  getArenaSchedule(48);
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log('=================================');
    console.log('  Lichess 2 на порту ' + PORT);
    console.log('=================================');
  });
})();
