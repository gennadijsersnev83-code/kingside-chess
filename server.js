const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { transports: ['websocket', 'polling'] });
app.use(express.static(path.join(__dirname, 'public')));

// ---------- ХРАНИЛИЩЕ ----------
const DATA = path.join(__dirname, 'data.json');
let db = { users: {}, events: [], totalGames: 0 };
try { if (fs.existsSync(DATA)) db = { ...db, ...JSON.parse(fs.readFileSync(DATA, 'utf8')) }; } catch (e) {}
function save() { try { fs.writeFileSync(DATA, JSON.stringify(db)); } catch (e) {} }

// ---------- РОЛИ ----------
const ADMINS = new Set(['PeshkaSasha']);
function isAdmin(u) { return ADMINS.has(u); }

// ---------- БОТЫ ----------
const BOTS = [
  { name: 'Stockfish level 1', level: 1, rating: 800, title: 'Уровень 1' },
  { name: 'Stockfish level 2', level: 2, rating: 1200, title: 'Уровень 2' },
  { name: 'Stockfish level 3', level: 3, rating: 1600, title: 'Уровень 3' },
  { name: 'Stockfish level 4', level: 4, rating: 2000, title: 'Уровень 4' },
  { name: 'Stockfish level 5', level: 5, rating: 2200, title: 'Уровень 5' },
  { name: 'Stockfish level 6', level: 6, rating: 2400, title: 'Уровень 6' }
];
const BOT_NAMES = new Set(BOTS.map(b => b.name));
BOTS.forEach(b => {
  if (!db.users[b.name]) db.users[b.name] = { password: '', rating: b.rating, wins: 0, losses: 0, draws: 0, games: 0, isBot: true, created: Date.now() };
});
save();

// ---------- ШАХМАТЫ ----------
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

// ---------- БОТ ----------
const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9 };
function botMove(fenStr, level) {
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
    if (level >= 4 && atk(apply(s, from, to), to[0], to[1], !w)) score -= (VAL[s.b[from[0]][from[1]].toLowerCase()] || 0) * 8;
    score += Math.random() * (6 - Math.min(level, 5));
    if (score > bestScore) { bestScore = score; best = [from, to]; }
  }
  return best;
}

// ---------- СОСТОЯНИЕ ----------
const online = new Map();
const games = new Map();
const sockGame = new Map();
function genId() { return Math.random().toString(36).slice(2, 10); }
function stats() { return { online: online.size + BOTS.length, games: db.totalGames + [...games.values()].filter(g => g.finished).length, active: [...games.values()].filter(g => g.started && !g.finished).length }; }
function pushLobbies() {
  const list = [];
  for (const [id, g] of games) {
    if (g.finished || g.started || g.isBot && g.guest) continue;
    if (g.started && !g.finished) continue;
    if (g.started || g.finished) continue;
    list.push({
      id, host: g.host, hostRating: (db.users[g.host] || {}).rating || 1200,
      time: g.time, inc: g.inc, isBot: !!g.isBot, rated: g.rated
    });
  }
  io.emit('lobbies', list);
  io.emit('stats', stats());
}
function pushEvents() {
  io.emit('events', db.events.slice(0, 20));
}
function addEvent(text) {
  db.events.unshift({ id: genId(), text, ts: Date.now() });
  if (db.events.length > 100) db.events.pop();
  save();
  pushEvents();
}

function finish(gid, result, reason) {
  const g = games.get(gid);
  if (!g || g.finished) return;
  g.finished = true;
  db.totalGames++;
  const wN = g.hostColor === 'w' ? g.host : g.guest, bN = g.hostColor === 'b' ? g.host : g.guest;
  const wu = db.users[wN], bu = db.users[bN];
  if (wu && bu) {
    const exp = 1 / (1 + Math.pow(10, (bu.rating - wu.rating) / 400));
    const sW = result === 'w' ? 1 : result === 'b' ? 0 : 0.5;
    const dW = Math.round(32 * (sW - exp));
    if (!wu.isBot) { wu.rating += dW; wu.games++; if (result === 'w') wu.wins++; else if (result === 'b') wu.losses++; else wu.draws++; }
    else { wu.games++; if (result === 'w') wu.wins++; else if (result === 'b') wu.losses++; else wu.draws++; }
    if (!bu.isBot) { bu.rating -= dW; bu.games++; if (result === 'b') bu.wins++; else if (result === 'w') bu.losses++; else bu.draws++; }
    else { bu.games++; if (result === 'b') bu.wins++; else if (result === 'w') bu.losses++; else bu.draws++; }
    save();
  }
  io.to(gid).emit('end', { result, reason });
  setTimeout(() => { games.delete(gid); pushLobbies(); }, 5000);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, g] of games) {
    if (!g.started || g.finished) continue;
    const dt = Math.floor((now - g.tick) / 1000); if (dt <= 0) continue;
    g.tick = now;
    if (g.turn === 'w') g.tW = Math.max(0, g.tW - dt); else g.tB = Math.max(0, g.tB - dt);
    io.to(id).emit('times', { tW: g.tW, tB: g.tB });
    if (g.tW <= 0) finish(id, 'b', 'Время');
    else if (g.tB <= 0) finish(id, 'w', 'Время');
  }
}, 1000);

function botTurn(gid) {
  const g = games.get(gid); if (!g || g.finished || !g.isBot) return;
  if (g.turn !== g.botColor) return;
  setTimeout(() => {
    const cur = games.get(gid); if (!cur || cur.finished || cur.turn !== cur.botColor) return;
    const lvl = BOTS.find(b => b.name === cur.bot)?.level || 2;
    const mv = botMove(cur.fen, lvl); if (!mv) return;
    const [from, to] = mv;
    const s = parse(cur.fen);
    const next = apply(s, from, to);
    cur.fen = toFen(next); cur.turn = next.turn; cur.tick = Date.now();
    io.to(gid).emit('board', { fen: cur.fen });
    const end = endCheck(next); if (end) finish(gid, end.result, end.reason);
  }, 300 + Math.random() * 500);
}

// ---------- SOCKET ----------
io.on('connection', (socket) => {
  socket.emit('stats', stats());
  socket.emit('events', db.events.slice(0, 20));
  socket.emit('lobbies', []);

  socket.on('register', ({ username, password }, cb) => {
    if (typeof cb !== 'function') return;
    if (!username || !password) return cb({ ok: false, msg: 'Заполни поля' });
    if (BOT_NAMES.has(username)) return cb({ ok: false, msg: 'Имя занято' });
    if (username.length < 2 || username.length > 20) return cb({ ok: false, msg: 'Логин 2-20' });
    let u = db.users[username];
    const isNew = !u;
    if (u) {
      if (u.isBot) return cb({ ok: false, msg: 'Это бот' });
      if (u.password !== password) return cb({ ok: false, msg: 'Неверный пароль' });
    } else {
      u = { password, rating: 1500, wins: 0, losses: 0, draws: 0, games: 0, isBot: false, created: Date.now() };
      db.users[username] = u;
      save();
    }
    online.set(socket.id, username);
    socket.username = username;
    cb({ ok: true, user: { username, rating: u.rating, wins: u.wins, losses: u.losses, draws: u.draws, games: u.games, isAdmin: isAdmin(username) } });
    if (isNew) addEvent(`${username} присоединился к Lichess 2`);
    pushLobbies();
  });

  socket.on('getStats', cb => { if (typeof cb === 'function') cb(stats()); });
  socket.on('getEvents', cb => { if (typeof cb === 'function') cb(db.events.slice(0, 20)); });
  socket.on('getLobbies', cb => {
    if (typeof cb !== 'function') return;
    const list = [];
    for (const [id, g] of games) {
      if (g.started || g.finished) continue;
      list.push({ id, host: g.host, hostRating: (db.users[g.host] || {}).rating || 1200, time: g.time, inc: g.inc, isBot: !!g.isBot, rated: g.rated });
    }
    cb(list);
  });
  socket.on('getBots', cb => {
    if (typeof cb !== 'function') return;
    cb(BOTS.map(b => ({ name: b.name, title: b.title, rating: db.users[b.name].rating, level: b.level })));
  });
  socket.on('getProfile', ({ username }, cb) => {
    if (typeof cb !== 'function') return;
    const u = db.users[username];
    if (!u) return cb({ ok: false });
    cb({ ok: true, user: { username, rating: u.rating, wins: u.wins, losses: u.losses, draws: u.draws, games: u.games, isBot: !!u.isBot, isAdmin: isAdmin(username) } });
  });

  socket.on('create', ({ time, inc, rated }, cb) => {
    if (typeof cb !== 'function') return;
    if (!socket.username) return cb({ ok: false, msg: 'Не авторизован' });
    time = Math.max(0.25, Math.min(60, +time || 5));
    inc = Math.max(0, Math.min(60, +inc || 0));
    for (const [, g] of games) {
      if (g.started || g.finished || g.isBot || g.guest) continue;
      if (g.host === socket.username) continue;
      if (g.time !== time || g.inc !== inc) continue;
      if (g.rated !== !!rated) continue;
      g.guest = socket.username; g.guestSock = socket.id;
      const hw = Math.random() < 0.5;
      g.hostColor = hw ? 'w' : 'b'; g.guestColor = hw ? 'b' : 'w';
      g.started = true; g.tick = Date.now();
      socket.join(g.id); sockGame.set(socket.id, g.id);
      io.to(g.hostSock).emit('start', { color: g.hostColor, opponent: g.guest, oppRating: db.users[g.guest].rating, time: g.time, inc: g.inc, fen: g.fen, gameId: g.id });
      io.to(g.guestSock).emit('start', { color: g.guestColor, opponent: g.host, oppRating: db.users[g.host].rating, time: g.time, inc: g.inc, fen: g.fen, gameId: g.id });
      cb({ ok: true, matched: true });
      addEvent(`${g.host} и ${g.guest} начали партию ${time}+${inc}`);
      pushLobbies();
      return;
    }
    const id = genId();
    games.set(id, {
      id, host: socket.username, hostSock: socket.id, guest: null, guestSock: null,
      hostColor: null, guestColor: null, time, inc, rated: !!rated,
      tW: time * 60, tB: time * 60, turn: 'w',
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      started: false, finished: false, tick: Date.now(), isBot: false
    });
    socket.join(id); sockGame.set(socket.id, id);
    cb({ ok: true, id });
    pushLobbies();
  });

  socket.on('join', ({ id }, cb) => {
    if (typeof cb !== 'function') return;
    if (!socket.username) return cb({ ok: false, msg: 'Не авторизован' });
    const g = games.get(id);
    if (!g) return cb({ ok: false, msg: 'Не найдено' });
    if (g.guest) return cb({ ok: false, msg: 'Занято' });
    if (g.host === socket.username) return cb({ ok: false, msg: 'Ваше лобби' });
    g.guest = socket.username; g.guestSock = socket.id;
    const hw = Math.random() < 0.5;
    g.hostColor = hw ? 'w' : 'b'; g.guestColor = hw ? 'b' : 'w';
    g.started = true; g.tick = Date.now();
    socket.join(id); sockGame.set(socket.id, id);
    io.to(g.hostSock).emit('start', { color: g.hostColor, opponent: g.guest, oppRating: db.users[g.guest].rating, time: g.time, inc: g.inc, fen: g.fen, gameId: id });
    io.to(g.guestSock).emit('start', { color: g.guestColor, opponent: g.host, oppRating: db.users[g.host].rating, time: g.time, inc: g.inc, fen: g.fen, gameId: id });
    cb({ ok: true });
    addEvent(`${g.host} и ${g.guest} начали партию ${g.time}+${g.inc}`);
    pushLobbies();
  });

  socket.on('cancel', ({ id }) => {
    const g = games.get(id);
    if (!g || g.host !== socket.username || g.started) return;
    games.delete(id); sockGame.delete(socket.id);
    pushLobbies();
  });

  socket.on('playBot', ({ time, inc, bot, color }, cb) => {
    if (typeof cb !== 'function') return;
    if (!socket.username) return cb({ ok: false, msg: 'Не авторизован' });
    const b = BOTS.find(x => x.name === bot);
    if (!b) return cb({ ok: false, msg: 'Бот не найден' });
    time = Math.max(0.25, Math.min(60, +time || 5));
    inc = Math.max(0, Math.min(60, +inc || 0));
    const humanColor = color === 'b' ? 'b' : 'w';
    const botColor = humanColor === 'w' ? 'b' : 'w';
    const id = genId();
    games.set(id, {
      id, host: socket.username, hostSock: socket.id, guest: bot, guestSock: null,
      hostColor: humanColor, guestColor: botColor, time, inc, rated: false,
      tW: time * 60, tB: time * 60, turn: 'w',
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      started: true, finished: false, tick: Date.now(), isBot: true, bot, botColor
    });
    socket.join(id); sockGame.set(socket.id, id);
    io.to(socket.id).emit('start', {
      color: humanColor, opponent: bot, oppRating: db.users[bot].rating,
      time, inc, fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      gameId: id, isBot: true
    });
    cb({ ok: true });
    if (botColor === 'w') setTimeout(() => botTurn(id), 500);
    pushLobbies();
  });

  socket.on('move', ({ gameId, fen: nf }) => {
    const g = games.get(gameId);
    if (!g || g.finished || !g.started) return;
    const mc = socket.id === g.hostSock ? g.hostColor : g.guestColor;
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
    if (end) { finish(gameId, end.result, end.reason); return; }
    if (g.isBot && g.turn === g.botColor) botTurn(gameId);
  });

  socket.on('resign', ({ gameId }) => {
    const g = games.get(gameId); if (!g || g.finished) return;
    const mc = socket.id === g.hostSock ? g.hostColor : g.guestColor;
    finish(gameId, mc === 'w' ? 'b' : 'w', 'Сдача');
  });
  socket.on('drawOffer', ({ gameId }) => {
    const g = games.get(gameId); if (!g || g.finished) return;
    if (g.isBot) {
      const s = parse(g.fen); let sc = 0;
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) { const p = s.b[r][c]; if (!p) continue; sc += (isW(p) ? 1 : -1) * (VAL[p.toLowerCase()] || 0); }
      const bs = g.botColor === 'w' ? 1 : -1;
      setTimeout(() => { if (sc * bs <= 0) finish(gameId, 'draw', 'Ничья'); else socket.emit('drawNo'); }, 400);
    } else socket.to(gameId).emit('drawOffer');
  });
  socket.on('drawYes', ({ gameId }) => { if (games.has(gameId)) finish(gameId, 'draw', 'Ничья'); });
  socket.on('drawNo', ({ gameId }) => socket.to(gameId).emit('drawNo'));

  socket.on('chat', ({ gameId, text }) => {
    const g = games.get(gameId); if (!g || !socket.username) return;
    text = String(text).trim().slice(0, 200); if (!text) return;
    io.to(gameId).emit('chat', { user: socket.username, text, ts: Date.now() });
  });

  socket.on('getGame', ({ gameId }, cb) => {
    if (typeof cb !== 'function') return;
    const g = games.get(gameId); if (!g) return cb({ ok: false });
    if (socket.username !== g.host && socket.username !== g.guest) return cb({ ok: false });
    if (socket.username === g.host) g.hostSock = socket.id; else g.guestSock = socket.id;
    socket.join(gameId); sockGame.set(socket.id, gameId);
    const mc = socket.username === g.host ? g.hostColor : g.guestColor;
    const opp = socket.username === g.host ? g.guest : g.host;
    cb({ ok: true, state: { myColor: mc, opponent: opp, time: g.time, inc: g.inc, tW: g.tW, tB: g.tB, fen: g.fen, finished: g.finished, isBot: !!g.isBot } });
  });

  socket.on('disconnect', () => {
    online.delete(socket.id);
    const gid = sockGame.get(socket.id);
    sockGame.delete(socket.id);
    if (gid) { const g = games.get(gid); if (g && !g.finished && !g.started) { games.delete(gid); pushLobbies(); } }
    pushLobbies();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log('Lichess clone on http://localhost:' + PORT));
