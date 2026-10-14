const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));

// ======================= ВРЕМЯ В МСК =======================
const MSK_OFFSET_MS = 3 * 3600 * 1000;
function mskParts(ts) {
  const d = new Date(ts + MSK_OFFSET_MS);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
}
function fromMsk(y, mo, d, h, mi, s) { return Date.UTC(y, mo, d, h, mi, s || 0) - MSK_OFFSET_MS; }
function fmtMskHM(ts) { const p = mskParts(ts); return String(p.h).padStart(2, '0') + ':' + String(p.mi).padStart(2, '0'); }
function roundToMinute(ts) { return Math.round(ts / 60000) * 60000; }

// ======================= РОЛИ =======================
const ADMINS = new Set(['PeshkaSasha']);
const MODERATORS = new Set(['Debian']);
const DEVS = new Set(['PeshkaSasha']);
function roleOf(username) {
  if (ADMINS.has(username) || DEVS.has(username)) return 'admin';
  if (MODERATORS.has(username)) return 'moderator';
  return 'user';
}
function isAdmin(username) { return ADMINS.has(username) || DEVS.has(username); }
function isMod(username) { return isAdmin(username) || MODERATORS.has(username); }
function isDev(username) { return DEVS.has(username); }

// ======================= БАЗА =======================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

let db = { users: {}, totalGames: 0 };

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      rating INTEGER NOT NULL DEFAULT 1200,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      draws INTEGER NOT NULL DEFAULT 0,
      games INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL
    );
  `);
  for (const col of [
    `rating_classical INTEGER`, `rating_rapid INTEGER`, `rating_blitz INTEGER`, `rating_bullet INTEGER`,
    `wins_classical INTEGER DEFAULT 0`, `wins_rapid INTEGER DEFAULT 0`, `wins_blitz INTEGER DEFAULT 0`, `wins_bullet INTEGER DEFAULT 0`,
    `losses_classical INTEGER DEFAULT 0`, `losses_rapid INTEGER DEFAULT 0`, `losses_blitz INTEGER DEFAULT 0`, `losses_bullet INTEGER DEFAULT 0`,
    `games_classical INTEGER DEFAULT 0`, `games_rapid INTEGER DEFAULT 0`, `games_blitz INTEGER DEFAULT 0`, `games_bullet INTEGER DEFAULT 0`,
    `muted_until BIGINT DEFAULT 0`, `is_bot BOOLEAN DEFAULT FALSE`
  ]) await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col};`);

  await pool.query(`UPDATE users SET rating_classical = rating WHERE rating_classical IS NULL;`);
  await pool.query(`UPDATE users SET rating_rapid     = rating WHERE rating_rapid     IS NULL;`);
  await pool.query(`UPDATE users SET rating_blitz     = rating WHERE rating_blitz     IS NULL;`);
  await pool.query(`UPDATE users SET rating_bullet    = rating WHERE rating_bullet    IS NULL;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS games (
      id SERIAL PRIMARY KEY,
      white TEXT NOT NULL, black TEXT NOT NULL,
      result TEXT NOT NULL, reason TEXT,
      time_control REAL, increment INTEGER,
      white_before INTEGER, black_before INTEGER,
      white_after INTEGER, black_after INTEGER,
      finished_at BIGINT NOT NULL
    );
  `);
  for (const col of [`category TEXT DEFAULT 'blitz'`, `is_arena BOOLEAN DEFAULT FALSE`, `arena_name TEXT`, `is_bot BOOLEAN DEFAULT FALSE`])
    await pool.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS ${col};`);

  const cnt = await pool.query('SELECT COUNT(*)::int AS n FROM games');
  db.totalGames = cnt.rows[0].n || 0;
  console.log(`[DB] Схема готова. Всего партий: ${db.totalGames}`);
}

function emptyRatingBlock(base) { return { rating: base, wins: 0, losses: 0, games: 0 }; }

async function loadDB() {
  const res = await pool.query('SELECT * FROM users');
  db.users = {};
  for (const row of res.rows) {
    db.users[row.username] = {
      passwordHash: row.password_hash, salt: row.salt,
      rating: row.rating, wins: row.wins, losses: row.losses,
      draws: row.draws, games: row.games,
      createdAt: Number(row.created_at),
      mutedUntil: Number(row.muted_until || 0),
      isBot: !!row.is_bot,
      categories: {
        classical: { rating: row.rating_classical ?? row.rating, wins: row.wins_classical || 0, losses: row.losses_classical || 0, games: row.games_classical || 0 },
        rapid:     { rating: row.rating_rapid     ?? row.rating, wins: row.wins_rapid     || 0, losses: row.losses_rapid     || 0, games: row.games_rapid     || 0 },
        blitz:     { rating: row.rating_blitz     ?? row.rating, wins: row.wins_blitz     || 0, losses: row.losses_blitz     || 0, games: row.games_blitz     || 0 },
        bullet:    { rating: row.rating_bullet    ?? row.rating, wins: row.wins_bullet    || 0, losses: row.losses_bullet    || 0, games: row.games_bullet    || 0 }
      }
    };
  }
  const cnt = await pool.query('SELECT COUNT(*)::int AS n FROM games');
  db.totalGames = cnt.rows[0].n || 0;

  for (const bot of BOTS) {
    if (!db.users[bot.name]) {
      db.users[bot.name] = {
        passwordHash: '', salt: '', rating: bot.rating,
        wins: 0, losses: 0, draws: 0, games: 0,
        createdAt: Date.now(), mutedUntil: 0, isBot: true,
        categories: {
          classical: emptyRatingBlock(bot.rating), rapid: emptyRatingBlock(bot.rating),
          blitz: emptyRatingBlock(bot.rating), bullet: emptyRatingBlock(bot.rating)
        }
      };
      try {
        await pool.query(
          `INSERT INTO users (username, password_hash, salt, rating, wins, losses, draws, games, created_at,
            rating_classical, rating_rapid, rating_blitz, rating_bullet,
            wins_classical, wins_rapid, wins_blitz, wins_bullet,
            losses_classical, losses_rapid, losses_blitz, losses_bullet,
            games_classical, games_rapid, games_blitz, games_bullet,
            muted_until, is_bot)
           VALUES ($1,'','',$2,0,0,0,0,$3,$2,$2,$2,$2,0,0,0,0,0,0,0,0,0,0,0,0,0,TRUE)`,
          [bot.name, bot.rating, Date.now()]
        );
      } catch (e) { console.error('[DB] bot insert:', e.message); }
    } else {
      db.users[bot.name].isBot = true;
    }
  }
  console.log(`[DB] Загружено: ${Object.keys(db.users).length} игроков`);
}

async function saveUser(username) {
  const u = db.users[username];
  if (!u) return;
  const c = u.categories || {};
  const g = (k, f) => (c[k] ? c[k][f] : 0);
  await pool.query(
    `INSERT INTO users (username, password_hash, salt, rating, wins, losses, draws, games, created_at,
      rating_classical, rating_rapid, rating_blitz, rating_bullet,
      wins_classical, wins_rapid, wins_blitz, wins_bullet,
      losses_classical, losses_rapid, losses_blitz, losses_bullet,
      games_classical, games_rapid, games_blitz, games_bullet,
      muted_until, is_bot)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
     ON CONFLICT (username) DO UPDATE SET
       rating=EXCLUDED.rating, wins=EXCLUDED.wins, losses=EXCLUDED.losses, draws=EXCLUDED.draws, games=EXCLUDED.games,
       rating_classical=EXCLUDED.rating_classical, rating_rapid=EXCLUDED.rating_rapid,
       rating_blitz=EXCLUDED.rating_blitz, rating_bullet=EXCLUDED.rating_bullet,
       wins_classical=EXCLUDED.wins_classical, wins_rapid=EXCLUDED.wins_rapid,
       wins_blitz=EXCLUDED.wins_blitz, wins_bullet=EXCLUDED.wins_bullet,
       losses_classical=EXCLUDED.losses_classical, losses_rapid=EXCLUDED.losses_rapid,
       losses_blitz=EXCLUDED.losses_blitz, losses_bullet=EXCLUDED.losses_bullet,
       games_classical=EXCLUDED.games_classical, games_rapid=EXCLUDED.games_rapid,
       games_blitz=EXCLUDED.games_blitz, games_bullet=EXCLUDED.games_bullet,
       muted_until=EXCLUDED.muted_until, is_bot=EXCLUDED.is_bot`,
    [
      username, u.passwordHash, u.salt, u.rating, u.wins, u.losses, u.draws, u.games, u.createdAt,
      c.classical?.rating ?? u.rating, c.rapid?.rating ?? u.rating, c.blitz?.rating ?? u.rating, c.bullet?.rating ?? u.rating,
      g('classical','wins'), g('rapid','wins'), g('blitz','wins'), g('bullet','wins'),
      g('classical','losses'), g('rapid','losses'), g('blitz','losses'), g('bullet','losses'),
      g('classical','games'), g('rapid','games'), g('blitz','games'), g('bullet','games'),
      u.mutedUntil || 0, !!u.isBot
    ]
  );
}

async function saveGame(game) {
  await pool.query(
    `INSERT INTO games (white, black, result, reason, time_control, increment,
                        white_before, black_before, white_after, black_after, finished_at,
                        category, is_arena, arena_name, is_bot)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [game.white, game.black, game.result, game.reason,
     game.timeControl, game.increment,
     game.whiteBefore, game.blackBefore, game.whiteAfter, game.blackAfter,
     game.finishedAt, game.category || 'blitz', !!game.isArena, game.arenaName || null, !!game.isBot]
  );
  db.totalGames++;
}

// ======================= ПАРОЛИ =======================
function hashPassword(password, salt) { return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex'); }
function newSalt() { return crypto.randomBytes(16).toString('hex'); }
function verifyPassword(password, salt, hash) {
  const test = hashPassword(password, salt);
  try { return crypto.timingSafeEqual(Buffer.from(test, 'hex'), Buffer.from(hash, 'hex')); }
  catch { return false; }
}

// ======================= ЭЛО =======================
function kFactor(rating, games) { if (games < 30) return 40; if (rating < 2400) return 20; return 10; }
function eloDelta(myRating, oppRating, score, k) {
  const expected = 1 / (1 + Math.pow(10, (oppRating - myRating) / 400));
  return Math.round(k * (score - expected));
}
function categoryOf(timeMin) {
  if (timeMin < 3) return 'bullet';
  if (timeMin < 10) return 'blitz';
  if (timeMin < 30) return 'rapid';
  return 'classical';
}

// ======================= УТИЛИТЫ =======================
function genId() { return Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6); }
function publicUser(name) {
  const u = db.users[name];
  if (!u) return null;
  return {
    username: name, rating: u.rating, wins: u.wins, losses: u.losses, draws: u.draws, games: u.games,
    createdAt: u.createdAt, role: roleOf(name), isAdmin: isAdmin(name), isMod: isMod(name), isDev: isDev(name),
    mutedUntil: u.mutedUntil || 0, categories: u.categories || null, isBot: !!u.isBot
  };
}
function isUserOnline(username) {
  for (const [, name] of online.entries()) if (name === username) return true;
  return false;
}

// ======================= ХРАНИЛИЩА =======================
const online = new Map();
const lobbies = new Map();
const socketToLobby = new Map();
const arenas = new Map();

function countActiveLobbies() {
  let n = 0;
  for (const l of lobbies.values()) { if (!l.finished && l.started) n++; }
  return n;
}
function countOnline() { return online.size; }
function broadcastOnline() {
  io.emit('stats', { online: countOnline(), games: db.totalGames, activeGames: countActiveLobbies() });
}
function broadcastLobbies() { io.emit('lobbiesUpdate'); }

function cleanupStuckPlaying() {
  for (const state of arenas.values()) {
    for (const p of state.participants.values()) {
      if (p.isPlaying) {
        const l = p.lobbyId ? lobbies.get(p.lobbyId) : null;
        if (!l || l.finished) {
          p.isPlaying = false; p.lobbyId = null;
          if (!p.paused) p.waitingSince = Date.now();
        }
      }
    }
  }
}
setInterval(cleanupStuckPlaying, 10000);

function buildGamesList() {
  const list = [];
  for (const [id, l] of lobbies.entries()) {
    if (l.finished || !l.started) continue;
    const whiteName = l.hostColor === 'w' ? l.host : l.guest;
    const blackName = l.hostColor === 'b' ? l.host : l.guest;
    const whiteU = db.users[whiteName], blackU = db.users[blackName];
    list.push({
      id, white: whiteName, black: blackName,
      whiteRating: whiteU ? whiteU.rating : null,
      blackRating: blackU ? blackU.rating : null,
      whiteIsAdmin: isAdmin(whiteName), blackIsAdmin: isAdmin(blackName),
      whiteIsMod: isMod(whiteName), blackIsMod: isMod(blackName),
      timeW: l.timeW, timeB: l.timeB, turn: l.turn,
      timeControl: l.time, increment: l.inc,
      isArena: !!l.arenaId, arenaName: l.arenaName || null, fen: l.fen
    });
  }
  list.sort((a, b) => (b.isArena ? 1 : 0) - (a.isArena ? 1 : 0));
  return list;
}

// ======================= ФИНАЛИЗАЦИЯ =======================
async function finishGame(lobbyId, result, reason) {
  const l = lobbies.get(lobbyId);
  if (!l || l.finished) return;
  l.finished = true;
  l.started = false;

  const whiteName = l.hostColor === 'w' ? l.host : l.guest;
  const blackName = l.hostColor === 'b' ? l.host : l.guest;
  const whiteUser = db.users[whiteName];
  const blackUser = db.users[blackName];
  if (!whiteUser || !blackUser) { lobbies.delete(lobbyId); return; }

  const isBotGame = !!l.isBot;
  const cat = categoryOf(l.time);
  if (!whiteUser.categories) whiteUser.categories = {};
  if (!blackUser.categories) blackUser.categories = {};
  if (!whiteUser.categories[cat]) whiteUser.categories[cat] = emptyRatingBlock(whiteUser.rating);
  if (!blackUser.categories[cat]) blackUser.categories[cat] = emptyRatingBlock(blackUser.rating);

  const wc = whiteUser.categories[cat];
  const bc = blackUser.categories[cat];
  const whiteBefore = wc.rating, blackBefore = bc.rating;

  let whiteScore = 0.5, blackScore = 0.5;
  if (result === 'w') { whiteScore = 1; blackScore = 0; }
  else if (result === 'b') { whiteScore = 0; blackScore = 1; }

  const kWhite = kFactor(whiteBefore, wc.games);
  const kBlack = kFactor(blackBefore, bc.games);
  const whiteDelta = eloDelta(whiteBefore, blackBefore, whiteScore, kWhite);
  const blackDelta = eloDelta(blackBefore, whiteBefore, blackScore, kBlack);
  let whiteAfter = whiteBefore + whiteDelta;
  let blackAfter = blackBefore + blackDelta;

  if (whiteUser.isBot) whiteAfter = Math.max(800, Math.min(3000, whiteAfter));
  if (blackUser.isBot) blackAfter = Math.max(800, Math.min(3000, blackAfter));

  wc.rating = whiteAfter;
  if (result === 'w') wc.wins++; else if (result === 'b') wc.losses++;
  wc.games++;
  bc.rating = blackAfter;
  if (result === 'b') bc.wins++; else if (result === 'w') bc.losses++;
  bc.games++;

  whiteUser.rating = whiteAfter;
  if (result === 'w') whiteUser.wins++; else if (result === 'b') whiteUser.losses++; else whiteUser.draws++;
  whiteUser.games++;
  blackUser.rating = blackAfter;
  if (result === 'b') blackUser.wins++; else if (result === 'w') blackUser.losses++; else blackUser.draws++;
  blackUser.games++;

  const gameRecord = {
    white: whiteName, black: blackName, result, reason,
    timeControl: l.time, increment: l.inc,
    whiteBefore, blackBefore, whiteAfter, blackAfter,
    finishedAt: Date.now(), category: cat,
    isArena: !!l.arenaId, arenaName: l.arenaName || null,
    isBot: isBotGame
  };

  try { await saveUser(whiteName); await saveUser(blackName); await saveGame(gameRecord); }
  catch (err) { console.error('[DB] saveGame:', err.message); }

  const isArena = !!l.arenaId;
  io.to(lobbyId).emit('gameEnded', {
    result, reason, whiteDelta, blackDelta, whiteAfter, blackAfter, category: cat,
    isArena, arenaId: l.arenaId || null, arenaName: l.arenaName || null, isBot: isBotGame
  });

  if (l.arenaId) {
    try { handleArenaGameEnd(l.arenaId, lobbyId, result, whiteName, blackName); }
    catch (e) { console.error('[arena]', e.message); }
  }

  setTimeout(() => {
    const cur = lobbies.get(lobbyId);
    if (cur) {
      io.to(lobbyId).socketsLeave(lobbyId);
      lobbies.delete(lobbyId);
      broadcastLobbies();
    }
  }, 2000);

  broadcastOnline();
}

// ======================= АРЕНЫ =======================
const ARENA_TEMPLATES = [
  { id: 'bullet-halfhour', name: 'Получасовая пуля', description: '1+0 · рейтинговая', timeControl: 1, increment: 0, durationMin: 27, repeat: 'every30', color: 'bullet', botFriendly: false },
  { id: 'blitz-hourly', name: 'Ежечасная блиц-арена', description: '3+2 · рейтинговая', timeControl: 3, increment: 2, durationMin: 57, repeat: 'hourly', color: 'blitz', botFriendly: false },
  { id: 'rapid-2h', name: 'Двухчасовая рапид-арена', description: '10+0 · рейтинговая', timeControl: 10, increment: 0, durationMin: 117, repeat: 'every2h', color: 'rapid', botFriendly: false },
  { id: 'classical-4h', name: 'Классическая арена', description: '30+0 · классика', timeControl: 30, increment: 0, durationMin: 237, repeat: 'every4h', color: 'classical', botFriendly: false },
  { id: 'bot-blitz-hourly', name: 'Блиц-арена с ботами', description: '3+2 · люди и боты', timeControl: 3, increment: 2, durationMin: 57, repeat: 'hourly', color: 'blitz', botFriendly: true },
  { id: 'bot-rapid-2h', name: 'Рапид-арена с ботами', description: '10+0 · люди и боты', timeControl: 10, increment: 0, durationMin: 117, repeat: 'every2h', color: 'rapid', botFriendly: true }
];
function nextStartFor(tpl, now) {
  const p = mskParts(now);
  if (tpl.repeat === 'every30') { if (p.mi < 30) return fromMsk(p.y, p.mo, p.d, p.h, 30, 0); return fromMsk(p.y, p.mo, p.d, p.h + 1, 0, 0); }
  if (tpl.repeat === 'hourly') { const c = fromMsk(p.y, p.mo, p.d, p.h, 0, 0); if (c >= now) return c; return fromMsk(p.y, p.mo, p.d, p.h + 1, 0, 0); }
  if (tpl.repeat === 'every2h') { const eh = p.h - (p.h % 2); const c = fromMsk(p.y, p.mo, p.d, eh, 0, 0); if (c >= now) return c; return fromMsk(p.y, p.mo, p.d, eh + 2, 0, 0); }
  if (tpl.repeat === 'every4h') { const fh = p.h - (p.h % 4); const c = fromMsk(p.y, p.mo, p.d, fh, 0, 0); if (c >= now) return c; return fromMsk(p.y, p.mo, p.d, fh + 4, 0, 0); }
  return roundToMinute(now + 3600000);
}
function stepFor(tpl) {
  if (tpl.repeat === 'hourly') return 3600 * 1000;
  if (tpl.repeat === 'every30') return 30 * 60 * 1000;
  if (tpl.repeat === 'every2h') return 2 * 3600 * 1000;
  if (tpl.repeat === 'every4h') return 4 * 3600 * 1000;
  return 3600 * 1000;
}
function getOrCreateArenaState(instance) {
  const now = Date.now();
  let state = arenas.get(instance.id);
  if (state) { state.startsAt = instance.startsAt; state.endsAt = instance.endsAt; state.botFriendly = instance.botFriendly; syncArenaPhase(state, now); return state; }
  state = {
    id: instance.id, templateId: instance.templateId, name: instance.name,
    description: instance.description, timeControl: instance.timeControl, increment: instance.increment,
    startsAt: instance.startsAt, endsAt: instance.endsAt, color: instance.color,
    botFriendly: !!instance.botFriendly,
    phase: 'waiting', participants: new Map(), finished: false, top3: null,
    pairingInterval: null, cleanupTimer: null, pairingNow: null,
    activeLobbies: new Set(), chat: [], chatViewers: new Set(), finishedGames: [],
    botsJoined: false
  };
  arenas.set(instance.id, state);
  scheduleArena(state);
  syncArenaPhase(state, now);
  return state;
}
function joinBotsToArena(state) {
  if (!state.botFriendly || state.botsJoined) return;
  state.botsJoined = true;
  for (const bot of BOTS) {
    if (state.participants.has(bot.name)) continue;
    if (Math.random() < 0.5) continue;
    const botUser = db.users[bot.name];
    state.participants.set(bot.name, {
      username: bot.name,
      rating: botUser ? botUser.rating : bot.rating,
      score: 0, wins: 0, draws: 0, losses: 0,
      winStreak: 0, drawStreak: 0,
      socketId: 'BOT:' + bot.name,
      lobbyId: null, isPlaying: false, paused: false,
      waitingSince: Date.now(), isBot: true, botLevel: bot.level
    });
  }
}
function syncArenaPhase(state, now) {
  if (state.finished) return;
  if (now >= state.endsAt) return;
  if (now >= state.startsAt && state.phase !== 'live') {
    state.phase = 'live';
    if (state.botFriendly) joinBotsToArena(state);
  }
}
function scheduleArena(state) {
  const now = Date.now();
  const startDelay = Math.max(0, state.startsAt - now);
  const endDelay = Math.max(0, state.endsAt - now);
  if (startDelay > 0) {
    setTimeout(() => {
      if (state.finished) return;
      state.phase = 'live';
      if (state.botFriendly) joinBotsToArena(state);
      io.emit('arenaUpdate', { arenaId: state.id });
      io.emit('arenaStarted', { arenaId: state.id, arenaName: state.name });
      const sysMsg = { id: 'sys' + Date.now(), system: true, text: `⚔ Арена "${state.name}" началась!`, ts: Date.now(), arenaId: state.id };
      state.chat.push(sysMsg); if (state.chat.length > 300) state.chat.shift();
      io.emit('arenaChatMessage', sysMsg);
      if (!state.pairingInterval) state.pairingInterval = setInterval(() => tryPair(state), 3000);
      tryPair(state);
    }, startDelay);
  } else if (now < state.endsAt && !state.finished) {
    state.phase = 'live';
    if (state.botFriendly) joinBotsToArena(state);
    if (!state.pairingInterval) state.pairingInterval = setInterval(() => tryPair(state), 3000);
    tryPair(state);
  }
  if (endDelay > 0) setTimeout(() => finishArena(state), endDelay);
  else finishArena(state);
}

function tryPair(state) {
  if (state.finished || state.phase !== 'live') return;

  const hasHumans = [...state.participants.values()].some(p => !p.isBot);
  const hasViewers = state.chatViewers.size > 0;
  if (!hasHumans && !hasViewers && Math.random() > 0.25) return;
  if (state.activeLobbies.size >= 6) return;

  const available = [];
  for (const p of state.participants.values()) {
    if (!p || p.paused) continue;
    if (p.isBot) continue; // упрощённо: боты не играют сами с собой в этой версии
    if (!p.socketId || !io.sockets.sockets.has(p.socketId)) continue;
    if (!p.waitingSince) p.waitingSince = Date.now();
    available.push(p);
  }
  if (available.length < 2) { state.pairingNow = available.length === 1 ? available[0].username : null; return; }
  state.pairingNow = null;
  available.sort((a, b) => a.waitingSince - b.waitingSince);
  const used = new Set();
  let pairsCreated = 0;
  for (let i = 0; i < available.length && pairsCreated < 2; i++) {
    const a = available[i];
    if (used.has(a.username)) continue;
    let best = null, bestDiff = Infinity;
    for (let j = 0; j < available.length; j++) {
      if (i === j) continue;
      const b = available[j];
      if (used.has(b.username)) continue;
      const diff = Math.abs((a.score || 0) - (b.score || 0));
      if (diff < bestDiff) { bestDiff = diff; best = b; }
    }
    if (!best) continue;
    createArenaPairing(state, a, best);
    used.add(a.username); used.add(best.username);
    a.waitingSince = null; best.waitingSince = null;
    pairsCreated++;
  }
}

function createArenaPairing(state, a, b) {
  const lobbyId = genId();
  const hostIsWhite = Math.random() < 0.5;
  const hostColor = hostIsWhite ? 'w' : 'b';
  const guestColor = hostIsWhite ? 'b' : 'w';
  const time = state.timeControl, inc = state.increment;

  lobbies.set(lobbyId, {
    id: lobbyId, host: a.username, hostSocket: a.socketId, guest: b.username, guestSocket: b.socketId,
    hostColor, guestColor, time, inc, timeW: time * 60, timeB: time * 60, turn: 'w',
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    started: true, finished: false, lastTick: Date.now(), chat: [], drawOffer: null,
    createdAt: Date.now(), arenaId: state.id, arenaName: state.name, rematch: null,
    isBot: false, history: []
  });
  state.activeLobbies.add(lobbyId);
  a.isPlaying = true; a.lobbyId = lobbyId;
  b.isPlaying = true; b.lobbyId = lobbyId;

  const aSocket = io.sockets.sockets.get(a.socketId);
  const bSocket = io.sockets.sockets.get(b.socketId);
  const aUser = db.users[a.username], bUser = db.users[b.username];
  if (aSocket) {
    aSocket.join(lobbyId);
    aSocket.emit('gameStart', { color: hostColor, opponent: b.username, opponentRating: bUser?.rating, opponentIsAdmin: isAdmin(b.username), opponentIsMod: isMod(b.username), opponentOnline: true, time, inc, lobbyId, fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', chat: [], arenaId: state.id, arenaName: state.name });
  }
  if (bSocket) {
    bSocket.join(lobbyId);
    bSocket.emit('gameStart', { color: guestColor, opponent: a.username, opponentRating: aUser?.rating, opponentIsAdmin: isAdmin(a.username), opponentIsMod: isMod(a.username), opponentOnline: true, time, inc, lobbyId, fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', chat: [], arenaId: state.id, arenaName: state.name });
  }
  io.emit('arenaUpdate', { arenaId: state.id });
  broadcastOnline();
}

function calcArenaPoints(p, result) {
  if (result === 'win') { const s = (p.winStreak || 0) + 1; p.winStreak = s; p.drawStreak = 0; return s >= 3 ? 4 : 2; }
  if (result === 'draw') { const s = (p.drawStreak || 0) + 1; p.drawStreak = s; p.winStreak = 0; return s >= 2 ? 2 : 1; }
  p.winStreak = 0; p.drawStreak = 0; return 0;
}

function handleArenaGameEnd(arenaId, lobbyId, result, whiteName, blackName) {
  const state = arenas.get(arenaId);
  if (!state) return;
  state.activeLobbies.delete(lobbyId);
  if (!state.finishedGames) state.finishedGames = [];
  const wU = db.users[whiteName], bU = db.users[blackName], l = lobbies.get(lobbyId);
  state.finishedGames.push({
    white: whiteName, black: blackName,
    whiteRating: wU?.rating ?? null, blackRating: bU?.rating ?? null,
    whiteIsAdmin: isAdmin(whiteName), blackIsAdmin: isAdmin(blackName),
    result, fen: l?.fen || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    turn: l?.turn || 'w', finishedAt: Date.now()
  });
  if (state.finishedGames.length > 200) state.finishedGames.shift();
  const whiteP = state.participants.get(whiteName);
  const blackP = state.participants.get(blackName);
  if (state.finished || !whiteP || !blackP) {
    if (whiteP) { whiteP.isPlaying = false; whiteP.lobbyId = null; }
    if (blackP) { blackP.isPlaying = false; blackP.lobbyId = null; }
    io.emit('arenaUpdate', { arenaId }); return;
  }
  if (result === 'w') { whiteP.score += calcArenaPoints(whiteP, 'win'); whiteP.wins++; blackP.losses++; calcArenaPoints(blackP, 'loss'); }
  else if (result === 'b') { blackP.score += calcArenaPoints(blackP, 'win'); blackP.wins++; whiteP.losses++; calcArenaPoints(whiteP, 'loss'); }
  else { whiteP.score += calcArenaPoints(whiteP, 'draw'); blackP.score += calcArenaPoints(blackP, 'draw'); whiteP.draws++; blackP.draws++; }
  whiteP.isPlaying = false; blackP.isPlaying = false;
  whiteP.lobbyId = null; blackP.lobbyId = null;
  if (!whiteP.paused) whiteP.waitingSince = Date.now();
  if (!blackP.paused) blackP.waitingSince = Date.now();
  setTimeout(() => tryPair(state), 300);
  io.emit('arenaUpdate', { arenaId });
}

function finishArena(state) {
  if (state.finished) return;
  state.finished = true; state.phase = 'finished';
  if (state.pairingInterval) { clearInterval(state.pairingInterval); state.pairingInterval = null; }
  for (const p of state.participants.values()) { p.isPlaying = false; p.lobbyId = null; }
  const all = [...state.participants.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.wins !== a.wins) return b.wins - a.wins;
    return b.rating - a.rating;
  });
  state.top3 = all.slice(0, 3).map(p => ({ username: p.username, score: p.score, wins: p.wins, draws: p.draws, losses: p.losses, rating: p.rating }));
  const sysMsg = { id: 'sys' + Date.now(), system: true, text: `🏆 Арена "${state.name}" завершена!`, ts: Date.now(), arenaId: state.id };
  state.chat.push(sysMsg); if (state.chat.length > 300) state.chat.shift();
  io.emit('arenaChatMessage', sysMsg);
  io.emit('arenaFinished', { arenaId: state.id, arenaName: state.name, top3: state.top3 });
  io.emit('arenaUpdate', { arenaId: state.id });
  for (const [name, p] of [...state.participants.entries()]) {
    if (p.isBot) state.participants.delete(name);
  }
  state.cleanupTimer = setTimeout(() => {
    if (state.chatViewers.size === 0) arenas.delete(state.id);
    else setTimeout(() => arenas.delete(state.id), 30 * 60 * 1000);
  }, 2 * 60 * 60 * 1000);
}

function getArenaSchedule(hoursAhead) {
  hoursAhead = hoursAhead || 48;
  const now = Date.now();
  const finishedCutoff = now - 60 * 60 * 1000;
  const end = now + hoursAhead * 3600 * 1000;
  const result = [];
  for (const tpl of ARENA_TEMPLATES) {
    const scanStart = now - tpl.durationMin * 60 * 1000 - 60 * 1000;
    let t = nextStartFor(tpl, scanStart);
    const step = stepFor(tpl);
    let safety = 0;
    while (t <= end && safety < 300) {
      safety++;
      const endsAt = roundToMinute(t + tpl.durationMin * 60 * 1000);
      let status;
      if (t > now) status = 'upcoming';
      else if (now < endsAt) status = 'live';
      else status = 'finished';
      if (status === 'finished' && endsAt < finishedCutoff) { t += step; continue; }
      const instance = { id: `${tpl.id}-${t}`, templateId: tpl.id, name: tpl.name, description: tpl.description, timeControl: tpl.timeControl, increment: tpl.increment, durationMin: tpl.durationMin, color: tpl.color, startsAt: t, endsAt, status, botFriendly: !!tpl.botFriendly };
      result.push(instance);
      const createAheadMs = 24 * 3600 * 1000;
      if (status === 'live' || (status === 'upcoming' && t - now < createAheadMs)) getOrCreateArenaState(instance);
      t += step;
    }
  }
  return result.sort((a, b) => a.startsAt - b.startsAt);
}

function getTopLiveArenas() {
  const now = Date.now();
  const list = [];
  for (const state of arenas.values()) {
    if (state.finished) continue;
    if (state.endsAt < now) continue;
    if (state.phase !== 'live' && state.phase !== 'waiting') continue;
    list.push({ id: state.id, name: state.name, phase: state.phase, color: state.color, participantsCount: state.participants.size, timeControl: state.timeControl, increment: state.increment, startsAt: state.startsAt, endsAt: state.endsAt, botFriendly: !!state.botFriendly });
  }
  list.sort((a, b) => { if (b.participantsCount !== a.participantsCount) return b.participantsCount - a.participantsCount; return a.startsAt - b.startsAt; });
  return list.slice(0, 3);
}

// ======================= ТИКЕР =======================
setInterval(() => {
  const now = Date.now();
  for (const [id, lobby] of lobbies.entries()) {
    if (!lobby.started || lobby.finished) continue;
    const side = lobby.turn;
    if (side !== 'w' && side !== 'b') continue;
    const elapsed = Math.floor((now - lobby.lastTick) / 1000);
    if (elapsed <= 0) continue;
    lobby.lastTick = now;
    if (side === 'w') lobby.timeW = Math.max(0, lobby.timeW - elapsed);
    else              lobby.timeB = Math.max(0, lobby.timeB - elapsed);
    if (!lobby.isBot) io.to(id).emit('timeUpdate', { timeW: lobby.timeW, timeB: lobby.timeB, serverNow: now });
    if (lobby.timeW <= 0) finishGame(id, 'b', 'Время');
    else if (lobby.timeB <= 0) finishGame(id, 'w', 'Время');
  }
}, 1000);

// ======================= МОДЕРАЦИЯ =======================
function checkMute(username) {
  const u = db.users[username]; if (!u) return 0;
  const until = u.mutedUntil || 0;
  return until <= Date.now() ? 0 : until;
}
function setMute(username, minutes) {
  const u = db.users[username]; if (!u) return false;
  u.mutedUntil = Date.now() + minutes * 60 * 1000;
  saveUser(username).catch(() => {});
  return true;
}
function clearMute(username) {
  const u = db.users[username]; if (!u) return false;
  u.mutedUntil = 0; saveUser(username).catch(() => {});
  return true;
}

// ======================= БОТЫ =======================
const BOTS = [
  { name: 'BotEasy',   rating: 1000, level: 1, title: 'Лёгкий',   desc: 'для новичков' },
  { name: 'BotMedium', rating: 1300, level: 2, title: 'Средний',  desc: 'подумает' },
  { name: 'BotHard',   rating: 1600, level: 3, title: 'Сложный',  desc: 'тактика' },
  { name: 'BotMaster', rating: 2000, level: 4, title: 'Мастер',   desc: 'сильный соперник' }
];
const BOT_NAMES = new Set(BOTS.map(b => b.name));

// ============================================================
//  ПРОСТОЙ ДВИЖОК ДЛЯ БОТА
// ============================================================
const PIECE_VALUES = { 'p': 100, 'n': 320, 'b': 330, 'r': 500, 'q': 900, 'k': 20000 };

function botParseFen(fen) {
  const parts = fen.split(' ');
  const board = Array.from({ length: 8 }, () => Array(8).fill(null));
  parts[0].split('/').forEach((row, r) => { let f = 0; for (const ch of row) { if (/\d/.test(ch)) f += +ch; else board[r][f++] = ch; } });
  return { board, turn: parts[1], castling: parts[2], ep: parts[3], half: +parts[4] || 0, full: +parts[5] || 1 };
}
function botToFen(s) {
  const rows = s.board.map(r => { let str = '', e = 0; for (const c of r) { if (c) { if (e) { str += e; e = 0; } str += c; } else e++; } if (e) str += e; return str; }).join('/');
  return [rows, s.turn, s.castling, s.ep, s.half, s.full].join(' ');
}
const botIsWhite = p => !!p && p === p.toUpperCase();
const botInBoard = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
function botPseudoMoves(state, r, c) {
  const p = state.board[r][c]; if (!p) return [];
  const moves = [], white = botIsWhite(p), type = p.toLowerCase(), dir = white ? -1 : 1;
  const add = (rr, cc) => { if (!botInBoard(rr, cc)) return false; const t = state.board[rr][cc]; if (t && botIsWhite(t) === white) return false; moves.push([rr, cc]); return !t; };
  if (type === 'p') {
    const sr = white ? 6 : 1, one = r + dir;
    if (botInBoard(one, c) && !state.board[one][c]) { moves.push([one, c]); const two = r + 2 * dir; if (r === sr && botInBoard(two, c) && !state.board[two][c]) moves.push([two, c]); }
    for (const dc of [-1, 1]) {
      const rr = r + dir, cc = c + dc;
      if (!botInBoard(rr, cc)) continue;
      const t = state.board[rr][cc];
      if (t && botIsWhite(t) !== white) moves.push([rr, cc]);
      const ep = String.fromCharCode(97 + cc) + (8 - rr);
      if (state.ep && state.ep === ep && !t) moves.push([rr, cc]);
    }
  } else if (type === 'n') [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]].forEach(([dr, dc]) => add(r + dr, c + dc));
  else if (type === 'k') {
    [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]].forEach(([dr, dc]) => add(r + dr, c + dc));
  } else {
    const dirs = [];
    if (type === 'r' || type === 'q') dirs.push([-1,0],[1,0],[0,-1],[0,1]);
    if (type === 'b' || type === 'q') dirs.push([-1,-1],[-1,1],[1,-1],[1,1]);
    for (const [dr, dc] of dirs) { let rr = r + dr, cc = c + dc; while (add(rr, cc)) { rr += dr; cc += dc; } }
  }
  return moves;
}
function botFindKing(s, white) { const k = white ? 'K' : 'k'; for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (s.board[r][c] === k) return [r, c]; return null; }
function botIsAttacked(s, r, c, byWhite) {
  for (let rr = 0; rr < 8; rr++) for (let cc = 0; cc < 8; cc++) {
    const p = s.board[rr][cc]; if (!p || botIsWhite(p) !== byWhite) continue;
    const t = p.toLowerCase();
    if (t === 'p') { const dir = byWhite ? -1 : 1; if (rr + dir === r && (cc - 1 === c || cc + 1 === c)) return true; continue; }
    if (t === 'k') { if (Math.abs(rr - r) <= 1 && Math.abs(cc - c) <= 1 && (rr !== r || cc !== c)) return true; continue; }
    if (botPseudoMoves(s, rr, cc).some(([mr, mc]) => mr === r && mc === c)) return true;
  }
  return false;
}
function botInCheck(s, white) { const k = botFindKing(s, white); return k ? botIsAttacked(s, k[0], k[1], !white) : false; }
function botApply(s, from, to) {
  const copy = { board: s.board.map(r => r.slice()), turn: s.turn, castling: s.castling, ep: s.ep, half: s.half, full: s.full };
  const [fr, fc] = from, [tr, tc] = to;
  const p = copy.board[fr][fc], white = botIsWhite(p), type = p.toLowerCase();
  if (type === 'p' && copy.ep) { const tgt = String.fromCharCode(97 + tc) + (8 - tr); if (copy.ep === tgt && !copy.board[tr][tc]) copy.board[fr][tc] = null; }
  copy.board[tr][tc] = p; copy.board[fr][fc] = null;
  if (type === 'p' && (tr === 0 || tr === 7)) copy.board[tr][tc] = white ? 'Q' : 'q';
  if (type === 'k' && Math.abs(tc - fc) === 2) { const row = fr; if (tc > fc) { copy.board[row][5] = copy.board[row][7]; copy.board[row][7] = null; } else { copy.board[row][3] = copy.board[row][0]; copy.board[row][0] = null; } }
  let cast = copy.castling;
  if (type === 'k') cast = cast.replace(white ? /[KQ]/g : /[kq]/g, '');
  if (type === 'r') { if (fr === 7 && fc === 0) cast = cast.replace('Q', ''); if (fr === 7 && fc === 7) cast = cast.replace('K', ''); if (fr === 0 && fc === 0) cast = cast.replace('q', ''); if (fr === 0 && fc === 7) cast = cast.replace('k', ''); }
  if (!cast) cast = '-';
  let ep = '-'; if (type === 'p' && Math.abs(tr - fr) === 2) ep = String.fromCharCode(97 + fc) + (8 - (fr + (tr - fr) / 2));
  copy.castling = cast; copy.ep = ep; copy.turn = white ? 'b' : 'w'; copy.full += 1;
  return copy;
}
function botLegal(s, r, c) {
  const p = s.board[r][c]; if (!p) return [];
  const white = botIsWhite(p);
  return botPseudoMoves(s, r, c).filter(([rr, cc]) => !botInCheck(botApply(s, [r, c], [rr, cc]), white));
}
function botAllLegal(s, white) {
  const res = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = s.board[r][c]; if (!p || botIsWhite(p) !== white) continue;
    for (const [rr, cc] of botLegal(s, r, c)) res.push([[r, c], [rr, cc]]);
  }
  return res;
}
function botEval(s) {
  let score = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = s.board[r][c]; if (!p) continue;
    const white = botIsWhite(p);
    const v = PIECE_VALUES[p.toLowerCase()] || 0;
    score += white ? v : -v;
  }
  return score;
}
function pickBotMove(fen, rating) {
  const state = botParseFen(fen);
  const white = state.turn === 'w';
  const moves = botAllLegal(state, white);
  if (!moves.length) return null;
  if (moves.length === 1) return moves[0];
  const depth = rating < 1200 ? 1 : rating < 1600 ? 2 : 3;
  const scored = moves.map(([from, to]) => {
    let s = -botEval(botApply(state, from, to));
    if (state.board[to[0]][to[1]]) s += (PIECE_VALUES[state.board[to[0]][to[1]].toLowerCase()] || 0) * 0.5;
    return { from, to, score: s };
  });
  scored.sort((a, b) => white ? b.score - a.score : a.score - b.score);
  const noise = rating < 1200 ? 0.4 : rating < 1600 ? 0.2 : 0.05;
  if (Math.random() < noise && scored.length > 1) return scored[1];
  return scored[0];
}

function scheduleBotMove(lobbyId) {
  const l = lobbies.get(lobbyId);
  if (!l || l.finished || !l.isBot) return;
  const botColor = l.botColor;
  if (l.turn !== botColor) return;
  const botUser = db.users[l.botName];
  const botRating = botUser ? botUser.rating : 1300;
  const delay = 300 + Math.random() * 700;
  setTimeout(() => {
    const cur = lobbies.get(lobbyId);
    if (!cur || cur.finished || cur.turn !== botColor) return;
    const mv = pickBotMove(cur.fen, botRating);
    if (!mv) return;
    const { from, to } = mv;
    const st = botParseFen(cur.fen);
    const legal = botLegal(st, from[0], from[1]);
    if (!legal.some(([r, c]) => r === to[0] && c === to[1])) return;
    const nextState = botApply(st, from, to);
    const now = Date.now();
    const elapsed = Math.floor((now - cur.lastTick) / 1000);
    if (botColor === 'w') cur.timeW = Math.max(0, cur.timeW - elapsed) + cur.inc;
    else cur.timeB = Math.max(0, cur.timeB - elapsed) + cur.inc;
    cur.lastTick = now;
    cur.fen = botToFen(nextState);
    cur.turn = nextState.turn;
    io.to(lobbyId).emit('boardUpdate', { fen: cur.fen, turn: cur.turn, san: null });
    const humanSocket = cur.hostSocket ? io.sockets.sockets.get(cur.hostSocket) : null;
    if (humanSocket) humanSocket.emit('timeUpdate', { timeW: cur.timeW, timeB: cur.timeB, serverNow: now });
    const sideToMoveWhite = cur.turn === 'w';
    const hasMoves = botAllLegal(botParseFen(cur.fen), sideToMoveWhite).length > 0;
    if (!hasMoves) {
      if (botInCheck(botParseFen(cur.fen), sideToMoveWhite)) finishGame(lobbyId, sideToMoveWhite ? 'b' : 'w', 'Мат');
      else finishGame(lobbyId, 'draw', 'Пат');
    }
  }, delay);
}

// ============================================================
//  SOCKET.IO
// ============================================================
io.on('connection', (socket) => {
  socket.emit('stats', { online: countOnline(), games: db.totalGames, activeGames: countActiveLobbies() });

  socket.on('register', async ({ username, password }, cb) => {
    if (typeof cb !== 'function') return;
    if (!username || !password) return cb({ ok: false, msg: 'Заполните поля' });
    if (BOT_NAMES.has(username)) return cb({ ok: false, msg: 'Имя зарезервировано' });
    if (username.length < 2 || username.length > 32) return cb({ ok: false, msg: 'Логин 2–32 символа' });
    if (!/^[a-zA-Zа-яА-Я0-9_\-]+$/.test(username)) return cb({ ok: false, msg: 'Логин: буквы, цифры, _ и -' });
    if (password.length < 3) return cb({ ok: false, msg: 'Пароль мин. 3 символа' });

    let user = db.users[username];
    if (user) {
      if (!verifyPassword(password, user.salt, user.passwordHash)) return cb({ ok: false, msg: 'Неверный пароль' });
    } else {
      const salt = newSalt();
      const passwordHash = hashPassword(password, salt);
      const base = 1200;
      db.users[username] = {
        passwordHash, salt, rating: base, wins: 0, losses: 0, draws: 0, games: 0,
        createdAt: Date.now(), mutedUntil: 0, isBot: false,
        categories: {
          classical: emptyRatingBlock(base), rapid: emptyRatingBlock(base),
          blitz: emptyRatingBlock(base), bullet: emptyRatingBlock(base)
        }
      };
      try { await saveUser(username); } catch (e) { console.error('[DB] saveUser:', e.message); }
    }
    online.set(socket.id, username);
    socket.username = username;
    cb({ ok: true, user: publicUser(username) });
    broadcastOnline();
  });

  socket.on('getProfile', async ({ username }, cb) => {
    if (typeof cb !== 'function') return;
    const u = db.users[username];
    if (!u) return cb({ ok: false, msg: 'Игрок не найден' });
    try {
      const gamesRes = await pool.query(`SELECT * FROM games WHERE white = $1 OR black = $1 ORDER BY finished_at DESC LIMIT 50`, [username]);
      const games = gamesRes.rows.map(r => ({
        white: r.white, black: r.black, result: r.result, reason: r.reason,
        timeControl: r.time_control, increment: r.increment,
        whiteBefore: r.white_before, blackBefore: r.black_before,
        whiteAfter: r.white_after, blackAfter: r.black_after,
        finishedAt: Number(r.finished_at), category: r.category || 'blitz', isBot: !!r.is_bot
      }));
      const hist = await pool.query(`SELECT white, black, white_after, black_after, finished_at FROM games WHERE white = $1 OR black = $1 ORDER BY finished_at ASC`, [username]);
      const history = [{ ts: u.createdAt, rating: 1200 }];
      for (const r of hist.rows) {
        const isWhite = r.white === username;
        history.push({ ts: Number(r.finished_at), rating: isWhite ? r.white_after : r.black_after });
      }
      const user = publicUser(username);
      user.online = isUserOnline(username) || !!u.isBot;
      cb({ ok: true, user, games, history });
    } catch (e) {
      console.error('[DB] getProfile:', e.message);
      cb({ ok: false, msg: 'Ошибка БД' });
    }
  });

  socket.on('getStats', (cb) => {
    if (typeof cb === 'function') cb({ online: countOnline(), games: db.totalGames, activeGames: countActiveLobbies() });
  });
  socket.on('getTopArenas', (cb) => { if (typeof cb === 'function') cb(getTopLiveArenas()); });
  socket.on('getLiveGames', (cb) => { if (typeof cb === 'function') cb(buildGamesList()); });

  socket.on('getBots', (cb) => {
    if (typeof cb !== 'function') return;
    cb(BOTS.map(b => {
      const u = db.users[b.name];
      return { name: b.name, title: b.title, desc: b.desc, level: b.level, rating: u ? u.rating : b.rating, games: u ? u.games : 0, initialRating: b.rating };
    }));
  });

  socket.on('getGameState', ({ lobbyId: lid }, cb) => {
    if (typeof cb !== 'function') return;
    const l = lobbies.get(lid);
    if (!l) return cb({ ok: false, msg: 'Партия не найдена' });
    if (socket.username !== l.host && socket.username !== l.guest) return cb({ ok: false, msg: 'Вы не участник' });
    if (l.host === socket.username) l.hostSocket = socket.id;
    else l.guestSocket = socket.id;
    if (socket.username === l.host && !l.guestSocket && !l.isBot) return cb({ ok: false, msg: 'Соперник ещё не подключился' });
    socket.join(lid);
    socketToLobby.set(socket.id, lid);
    socket.lobbyId = lid;
    const myColor = socket.username === l.host ? l.hostColor : l.guestColor;
    const oppName = socket.username === l.host ? l.guest : l.host;
    const oppU = db.users[oppName];
    cb({
      ok: true,
      state: {
        myColor, opponent: oppName,
        opponentRating: oppU ? oppU.rating : null,
        opponentIsAdmin: isAdmin(oppName), opponentIsMod: isMod(oppName),
        opponentOnline: isUserOnline(oppName) || BOT_NAMES.has(oppName),
        time: l.time, inc: l.inc, timeW: l.timeW, timeB: l.timeB, turn: l.turn,
        fen: l.fen, chat: l.chat, arenaId: l.arenaId, arenaName: l.arenaName,
        finished: l.finished, isBot: !!l.isBot
      }
    });
  });

  socket.on('watchGame', ({ id }, cb) => {
    const l = lobbies.get(id);
    if (!l || l.finished || !l.started) { if (typeof cb === 'function') cb({ ok: false, msg: 'Недоступно' }); return; }
    socket.join('watch:' + id);
    const wName = l.hostColor === 'w' ? l.host : l.guest;
    const bName = l.hostColor === 'b' ? l.host : l.guest;
    if (typeof cb === 'function') cb({
      ok: true,
      game: {
        id, white: wName, black: bName,
        whiteRating: db.users[wName]?.rating ?? null,
        blackRating: db.users[bName]?.rating ?? null,
        whiteIsAdmin: isAdmin(wName), blackIsAdmin: isAdmin(bName),
        whiteIsMod: isMod(wName), blackIsMod: isMod(bName),
        timeW: l.timeW, timeB: l.timeB, turn: l.turn,
        timeControl: l.time, increment: l.inc, fen: l.fen,
        isArena: !!l.arenaId, arenaName: l.arenaName || null
      }
    });
  });
  socket.on('unwatchGame', ({ id }) => socket.leave('watch:' + id));

  socket.on('getLobbies', (cb) => {
    if (typeof cb !== 'function') return;
    const list = [];
    for (const [id, l] of lobbies.entries()) {
      if (l.finished || l.arenaId) continue;
      list.push({
        id, host: l.host, time: l.time, inc: l.inc,
        hostIsAdmin: isAdmin(l.host), hostIsMod: isMod(l.host),
        hostRating: db.users[l.host]?.rating ?? 1200,
        status: l.guest ? 'playing' : 'waiting',
        isBot: !!l.isBot, mode: l.mode || 'rated'
      });
    }
    cb(list);
  });

  socket.on('createLobby', ({ time, inc, mode }, cb) => {
    if (typeof cb !== 'function') return;
    if (!socket.username) return cb({ ok: false, msg: 'Не авторизован' });
    time = Math.max(0.5, Math.min(60, +time || 5));
    inc = Math.max(0, Math.min(60, +inc || 0));
    mode = (mode === 'casual') ? 'casual' : 'rated';

    let matched = null;
    for (const [, l] of lobbies.entries()) {
      if (l.finished || l.arenaId || l.isBot || l.guest) continue;
      if (l.host === socket.username || l.hostSocket === socket.id) continue;
      if (Number(l.time) !== time || Number(l.inc) !== inc) continue;
      if ((l.mode || 'rated') !== mode) continue;
      matched = l; break;
    }
    if (matched) {
      matched.guest = socket.username;
      matched.guestSocket = socket.id;
      const hostIsWhite = Math.random() < 0.5;
      matched.hostColor = hostIsWhite ? 'w' : 'b';
      matched.guestColor = hostIsWhite ? 'b' : 'w';
      matched.started = true;
      matched.lastTick = Date.now();
      socket.join(matched.id);
      socketToLobby.set(socket.id, matched.id);
      socket.lobbyId = matched.id;
      io.to(matched.hostSocket).emit('gameStart', {
        color: matched.hostColor, opponent: matched.guest,
        opponentRating: db.users[matched.guest]?.rating,
        opponentIsAdmin: isAdmin(matched.guest), opponentIsMod: isMod(matched.guest),
        opponentOnline: true, time: matched.time, inc: matched.inc,
        lobbyId: matched.id, fen: matched.fen, chat: matched.chat, isArena: false, mode: matched.mode
      });
      io.to(matched.guestSocket).emit('gameStart', {
        color: matched.guestColor, opponent: matched.host,
        opponentRating: db.users[matched.host]?.rating,
        opponentIsAdmin: isAdmin(matched.host), opponentIsMod: isMod(matched.host),
        opponentOnline: true, time: matched.time, inc: matched.inc,
        lobbyId: matched.id, fen: matched.fen, chat: matched.chat, isArena: false, mode: matched.mode
      });
      cb({ ok: true, id: matched.id, matched: true });
      broadcastLobbies(); broadcastOnline();
      return;
    }
    const id = genId();
    lobbies.set(id, {
      id, host: socket.username, hostSocket: socket.id, guest: null, guestSocket: null,
      hostColor: null, guestColor: null, time, inc, timeW: time * 60, timeB: time * 60,
      turn: 'w', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      started: false, finished: false, lastTick: Date.now(), chat: [], drawOffer: null,
      createdAt: Date.now(), rematch: null, isBot: false, history: [], mode
    });
    socket.join(id);
    socketToLobby.set(socket.id, id);
    socket.lobbyId = id;
    cb({ ok: true, id });
    broadcastLobbies();
  });

  socket.on('playWithBot', ({ time, inc, botName }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    if (!socket.username) return cb({ ok: false, msg: 'Не авторизован' });
    time = Math.max(0.5, Math.min(60, +time || 5));
    inc = Math.max(0, Math.min(60, +inc || 0));
    const bot = BOTS.find(b => b.name === botName);
    if (!bot) return cb({ ok: false, msg: 'Бот не найден' });
    const id = genId();
    lobbies.set(id, {
      id, host: socket.username, hostSocket: socket.id, guest: bot.name, guestSocket: null,
      hostColor: 'w', guestColor: 'b', time, inc, timeW: time * 60, timeB: time * 60,
      turn: 'w', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      started: true, finished: false, lastTick: Date.now(), chat: [], drawOffer: null,
      createdAt: Date.now(), rematch: null, isBot: true, botName: bot.name, botColor: 'b', history: []
    });
    socket.join(id);
    socketToLobby.set(socket.id, id);
    socket.lobbyId = id;
    io.to(socket.id).emit('gameStart', {
      color: 'w', opponent: bot.name,
      opponentRating: db.users[bot.name]?.rating, opponentIsAdmin: false, opponentIsMod: false, opponentOnline: true,
      time, inc, lobbyId: id,
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      chat: [], isArena: false, isBot: true, botName: bot.name
    });
    cb({ ok: true, id });
    broadcastLobbies(); broadcastOnline();
  });

  socket.on('cancelLobby', ({ id }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    if (!socket.username) return cb({ ok: false });
    const l = lobbies.get(id);
    if (!l) return cb({ ok: false });
    if (l.host !== socket.username) return cb({ ok: false });
    if (l.started) return cb({ ok: false });
    io.to(id).emit('opponentLeft');
    lobbies.delete(id);
    socketToLobby.delete(socket.id);
    socket.lobbyId = null;
    broadcastLobbies();
    cb({ ok: true });
  });

  socket.on('joinLobby', ({ id }, cb) => {
    if (typeof cb !== 'function') return;
    if (!socket.username) return cb({ ok: false, msg: 'Не авторизован' });
    const l = lobbies.get(id);
    if (!l) return cb({ ok: false, msg: 'Лобби не найдено' });
    if (l.finished) return cb({ ok: false, msg: 'Завершено' });
    if (l.guest) return cb({ ok: false, msg: 'Занято' });
    if (l.host === socket.username) return cb({ ok: false, msg: 'Это ваше лобби' });
    l.guest = socket.username;
    l.guestSocket = socket.id;
    const hostIsWhite = Math.random() < 0.5;
    l.hostColor = hostIsWhite ? 'w' : 'b';
    l.guestColor = hostIsWhite ? 'b' : 'w';
    l.started = true;
    l.lastTick = Date.now();
    socket.join(id);
    socketToLobby.set(socket.id, id);
    socket.lobbyId = id;
    io.to(l.hostSocket).emit('gameStart', {
      color: l.hostColor, opponent: l.guest,
      opponentRating: db.users[l.guest]?.rating,
      opponentIsAdmin: isAdmin(l.guest), opponentIsMod: isMod(l.guest),
      opponentOnline: true, time: l.time, inc: l.inc, lobbyId: id, fen: l.fen, chat: l.chat
    });
    io.to(l.guestSocket).emit('gameStart', {
      color: l.guestColor, opponent: l.host,
      opponentRating: db.users[l.host]?.rating,
      opponentIsAdmin: isAdmin(l.host), opponentIsMod: isMod(l.host),
      opponentOnline: true, time: l.time, inc: l.inc, lobbyId: id, fen: l.fen, chat: l.chat
    });
    cb({ ok: true, id });
    broadcastLobbies(); broadcastOnline();
  });

  socket.on('move', ({ lobbyId, fen, turn, san }) => {
    const l = lobbies.get(lobbyId);
    if (!l || l.finished || !l.started) return;
    if (socket.id !== l.hostSocket && socket.id !== l.guestSocket) return;
    const myColor = socket.id === l.hostSocket ? l.hostColor : l.guestColor;
    if (l.turn !== myColor) return;
    if (typeof fen !== 'string' || fen.split(' ').length < 6) return;
    const newTurn = fen.split(' ')[1];
    if (newTurn === l.turn) return;

    const now = Date.now();
    const elapsed = Math.floor((now - l.lastTick) / 1000);
    if (myColor === 'w') l.timeW = Math.max(0, l.timeW - elapsed) + l.inc;
    else                 l.timeB = Math.max(0, l.timeB - elapsed) + l.inc;
    l.lastTick = now;
    l.fen = fen; l.turn = newTurn; l.drawOffer = null;

    io.to(lobbyId).emit('boardUpdate', { fen, turn: newTurn, san: san || null });
    io.to(lobbyId).emit('timeUpdate', { timeW: l.timeW, timeB: l.timeB, serverNow: now });
    socket.to('watch:' + lobbyId).emit('boardUpdate', { fen, turn: newTurn, san: san || null });
    socket.to('watch:' + lobbyId).emit('timeUpdate', { timeW: l.timeW, timeB: l.timeB, serverNow: now });

    if (l.isBot && l.turn === l.botColor) scheduleBotMove(lobbyId);
  });

  socket.on('resign', ({ lobbyId }) => {
    const l = lobbies.get(lobbyId);
    if (!l || l.finished) return;
    const myColor = socket.id === l.hostSocket ? l.hostColor : l.guestColor;
    finishGame(lobbyId, myColor === 'w' ? 'b' : 'w', 'Сдача');
  });

  socket.on('gameOver', ({ lobbyId, result }) => {
    if (!lobbies.has(lobbyId)) return;
    finishGame(lobbyId, result, 'Завершено');
  });

  socket.on('chatMessage', ({ lobbyId, text }) => {
    const l = lobbies.get(lobbyId);
    if (!l || !socket.username) return;
    const muteUntil = checkMute(socket.username);
    if (muteUntil > 0) { socket.emit('chatError', { msg: 'Вы заглушены' }); return; }
    if (typeof text !== 'string') return;
    text = text.trim().slice(0, 300);
    if (!text) return;
    const msg = { id: 'm' + Date.now() + Math.random().toString(36).slice(2, 6), user: socket.username, userIsAdmin: isAdmin(socket.username), userIsMod: isMod(socket.username), text, ts: Date.now() };
    l.chat.push(msg);
    if (l.chat.length > 50) l.chat.shift();
    io.to(lobbyId).emit('chatMessage', msg);
  });

  socket.on('modMuteUser', ({ username, minutes }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    if (!isMod(socket.username)) return cb({ ok: false, msg: 'Нет прав' });
    if (!db.users[username]) return cb({ ok: false, msg: 'Не найден' });
    minutes = Math.max(1, Math.min(7 * 24 * 60, +minutes || 10));
    setMute(username, minutes);
    io.emit('modAction', { action: 'mute', by: socket.username, target: username, minutes, ts: Date.now() });
    cb({ ok: true });
  });
  socket.on('modUnmuteUser', ({ username }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    if (!isMod(socket.username)) return cb({ ok: false, msg: 'Нет прав' });
    clearMute(username);
    io.emit('modAction', { action: 'unmute', by: socket.username, target: username, ts: Date.now() });
    cb({ ok: true });
  });

  socket.on('drawOffer', ({ lobbyId }) => {
    const l = lobbies.get(lobbyId);
    if (!l || l.finished || !l.started) return;
    if (socket.id !== l.hostSocket && socket.id !== l.guestSocket) return;
    l.drawOffer = { by: socket.id, at: Date.now() };
    socket.to(lobbyId).emit('drawOffered', { from: socket.username });
    if (l.isBot) {
      setTimeout(() => {
        const cur = lobbies.get(lobbyId);
        if (!cur || cur.finished || !cur.drawOffer) return;
        cur.drawOffer = null;
        const evalScore = botEval(botParseFen(cur.fen));
        const botSign = cur.botColor === 'w' ? 1 : -1;
        const accept = evalScore * botSign < 50;
        if (accept) finishGame(lobbyId, 'draw', 'Ничья по согласию');
        else socket.emit('drawDeclined');
      }, 500 + Math.random() * 800);
    }
  });
  socket.on('drawAccept', ({ lobbyId }) => {
    const l = lobbies.get(lobbyId); if (!l || l.finished) return;
    l.drawOffer = null;
    finishGame(lobbyId, 'draw', 'Ничья по согласию');
  });
  socket.on('drawDecline', ({ lobbyId }) => {
    const l = lobbies.get(lobbyId); if (!l || l.finished) return;
    l.drawOffer = null;
    socket.to(lobbyId).emit('drawDeclined');
  });

  socket.on('rematchRequest', ({ lobbyId }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    const l = lobbies.get(lobbyId);
    if (!l) return cb({ ok: false, msg: 'Не найдено' });
    if (!l.finished) return cb({ ok: false, msg: 'Не завершена' });
    if (l.isBot) {
      const bot = BOTS.find(b => b.name === l.botName);
      if (!bot) return cb({ ok: false });
      setTimeout(() => {
        const newId = genId();
        lobbies.set(newId, {
          id: newId, host: l.host, hostSocket: l.hostSocket,
          guest: bot.name, guestSocket: null,
          hostColor: 'w', guestColor: 'b',
          time: l.time, inc: l.inc, timeW: l.time * 60, timeB: l.time * 60,
          turn: 'w', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          started: true, finished: false, lastTick: Date.now(),
          chat: [], drawOffer: null, createdAt: Date.now(), rematch: null,
          isBot: true, botName: bot.name, botColor: 'b', history: []
        });
        const hostSocket = io.sockets.sockets.get(l.hostSocket);
        if (hostSocket) {
          hostSocket.leave(lobbyId); hostSocket.join(newId);
          socketToLobby.set(l.hostSocket, newId); hostSocket.lobbyId = newId;
          hostSocket.emit('gameStart', {
            color: 'w', opponent: bot.name,
            opponentRating: db.users[bot.name]?.rating,
            opponentIsAdmin: false, opponentIsMod: false, opponentOnline: true,
            time: l.time, inc: l.inc, lobbyId: newId,
            fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            chat: [], isArena: false, isBot: true, botName: bot.name
          });
        }
        lobbies.delete(lobbyId);
        broadcastLobbies();
        cb({ ok: true, started: true, newLobbyId: newId });
      }, 400 + Math.random() * 800);
      return;
    }
    if (l.arenaId) return cb({ ok: false, msg: 'В аренах недоступно' });
    if (socket.id !== l.hostSocket && socket.id !== l.guestSocket) return cb({ ok: false });
    if (!l.rematch) l.rematch = {};
    l.rematch[socket.username] = true;
    const otherName = socket.username === l.host ? l.guest : l.host;
    const otherSocket = socket.username === l.host ? l.guestSocket : l.hostSocket;
    if (l.rematch[otherName]) {
      const newId = genId();
      lobbies.set(newId, {
        id: newId, host: l.host, hostSocket: l.hostSocket, guest: l.guest, guestSocket: l.guestSocket,
        hostColor: l.guestColor, guestColor: l.hostColor, time: l.time, inc: l.inc,
        timeW: l.time * 60, timeB: l.time * 60, turn: 'w',
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        started: true, finished: false, lastTick: Date.now(),
        chat: [], drawOffer: null, createdAt: Date.now(), rematch: null, isBot: false, history: []
      });
      const hostSocket = io.sockets.sockets.get(l.hostSocket);
      const guestSocket = io.sockets.sockets.get(l.guestSocket);
      if (hostSocket) {
        hostSocket.leave(lobbyId); hostSocket.join(newId); socketToLobby.set(l.hostSocket, newId); hostSocket.lobbyId = newId;
        hostSocket.emit('gameStart', { color: l.guestColor, opponent: l.guest, opponentRating: db.users[l.guest]?.rating, opponentOnline: true, time: l.time, inc: l.inc, lobbyId: newId, fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', chat: [] });
      }
      if (guestSocket) {
        guestSocket.leave(lobbyId); guestSocket.join(newId); socketToLobby.set(l.guestSocket, newId); guestSocket.lobbyId = newId;
        guestSocket.emit('gameStart', { color: l.hostColor, opponent: l.host, opponentRating: db.users[l.host]?.rating, opponentOnline: true, time: l.time, inc: l.inc, lobbyId: newId, fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', chat: [] });
      }
      lobbies.delete(lobbyId);
      broadcastLobbies();
      return cb({ ok: true, started: true, newLobbyId: newId });
    }
    if (otherSocket) io.to(otherSocket).emit('rematchOffered', { from: socket.username });
    cb({ ok: true, started: false });
  });
  socket.on('rematchDecline', ({ lobbyId }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    const l = lobbies.get(lobbyId);
    if (!l) return cb({ ok: false });
    l.rematch = null;
    const otherSocket = socket.id === l.hostSocket ? l.guestSocket : l.hostSocket;
    if (otherSocket) io.to(otherSocket).emit('rematchDeclined');
    cb({ ok: true });
  });

  // ======================= АРЕНЫ =======================
  socket.on('getArenas', (cb) => {
    if (typeof cb === 'function') cb({ list: getArenaSchedule(48), serverNow: Date.now() });
  });

  socket.on('getMyArenaStates', (cb) => {
    if (typeof cb !== 'function') return;
    const states = {};
    for (const [id, state] of arenas.entries()) {
      const p = socket.username ? state.participants.get(socket.username) : null;
      states[id] = { joined: !!p, paused: !!(p && p.paused), participantsCount: state.participants.size, phase: state.phase, score: p ? p.score : 0, botFriendly: !!state.botFriendly };
    }
    cb({ states, serverNow: Date.now() });
  });

  socket.on('getArenaState', ({ arenaId }, cb) => {
    if (typeof cb !== 'function') return;
    const state = arenas.get(arenaId);
    if (!state) return cb({ joined: false, participants: [], phase: 'waiting', startsAt: 0, endsAt: 0, serverNow: Date.now() });
    const participants = [...state.participants.values()].map(p => ({
      username: p.username, rating: p.rating, score: p.score,
      wins: p.wins, draws: p.draws, losses: p.losses,
      winStreak: p.winStreak || 0, drawStreak: p.drawStreak || 0,
      paused: !!p.paused, isPlaying: !!p.isPlaying,
      isAdmin: isAdmin(p.username), isMod: isMod(p.username),
      online: p.isBot ? true : (p.socketId && io.sockets.sockets.has(p.socketId)),
      isBot: !!p.isBot
    })).sort((a, b) => b.score - a.score || b.rating - a.rating);
    const meP = socket.username ? state.participants.get(socket.username) : null;
    cb({
      joined: !!meP, paused: !!(meP && meP.paused), participants,
      participantsCount: participants.length, phase: state.phase,
      top3: state.top3, pairingNow: state.pairingNow,
      startsAt: state.startsAt, endsAt: state.endsAt, serverNow: Date.now(),
      botFriendly: !!state.botFriendly
    });
  });

  socket.on('joinArenaRoom', ({ arenaId }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    const state = arenas.get(arenaId);
    if (!state) return cb({ ok: false, msg: 'Арена не найдена' });
    socket.join('arena:' + arenaId);
    state.chatViewers.add(socket.id);
    cb({ ok: true, chat: state.chat || [] });
    tryPair(state);
  });
  socket.on('leaveArenaRoom', ({ arenaId }) => {
    const state = arenas.get(arenaId);
    socket.leave('arena:' + arenaId);
    if (state) state.chatViewers.delete(socket.id);
  });

  socket.on('getArenaGames', ({ arenaId }, cb) => {
    if (typeof cb !== 'function') return;
    const state = arenas.get(arenaId);
    const live = [], done = [];
    if (state) {
      for (const [id, l] of lobbies.entries()) {
        if (l.arenaId !== arenaId || l.finished) continue;
        const wN = l.hostColor === 'w' ? l.host : l.guest;
        const bN = l.hostColor === 'b' ? l.host : l.guest;
        live.push({
          lobbyId: id, white: wN, black: bN,
          whiteIsAdmin: isAdmin(wN), blackIsAdmin: isAdmin(bN),
          whiteIsMod: isMod(wN), blackIsMod: isMod(bN),
          whiteRating: db.users[wN]?.rating ?? null, blackRating: db.users[bN]?.rating ?? null,
          timeW: l.timeW, timeB: l.timeB, turn: l.turn, fen: l.fen, live: true
        });
      }
    }
    if (state?.finishedGames) {
      for (const g of state.finishedGames.slice().reverse()) {
        done.push({
          white: g.white, black: g.black,
          whiteIsAdmin: g.whiteIsAdmin, blackIsAdmin: g.blackIsAdmin,
          whiteRating: g.whiteRating, blackRating: g.blackRating,
          result: g.result, fen: g.fen, turn: g.turn || 'w',
          finishedAt: g.finishedAt, live: false
        });
      }
    }
    cb({ live, done });
  });

  socket.on('joinArena', ({ arenaId }, cb) => {
    if (typeof cb !== 'function') return;
    if (!socket.username) return cb({ ok: false, msg: 'Не авторизован' });
    const state = arenas.get(arenaId);
    if (!state) return cb({ ok: false, msg: 'Не найдена' });
    if (state.finished || state.phase === 'finished') return cb({ ok: false, msg: 'Завершена' });
    if (state.participants.has(socket.username)) return cb({ ok: true });
    state.participants.set(socket.username, {
      username: socket.username,
      rating: db.users[socket.username]?.rating ?? 1200,
      score: 0, wins: 0, draws: 0, losses: 0, winStreak: 0, drawStreak: 0,
      socketId: socket.id, lobbyId: null, isPlaying: false, paused: false,
      waitingSince: Date.now(), isBot: false
    });
    const sysMsg = { id: 'sys' + Date.now(), system: true, text: `${socket.username} присоединился к арене`, ts: Date.now(), arenaId: state.id };
    state.chat.push(sysMsg); if (state.chat.length > 300) state.chat.shift();
    io.to('arena:' + state.id).emit('arenaChatMessage', sysMsg);
    io.emit('arenaUpdate', { arenaId });
    if (state.phase === 'live') tryPair(state);
    cb({ ok: true });
  });

  socket.on('leaveArena', ({ arenaId }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    const state = arenas.get(arenaId);
    if (!state) return cb({ ok: false });
    if (state.phase !== 'waiting') return cb({ ok: false, msg: 'Нельзя сняться после старта' });
    const p = state.participants.get(socket.username);
    if (p && !p.isPlaying) {
      state.participants.delete(socket.username);
      io.emit('arenaUpdate', { arenaId });
    }
    cb({ ok: true });
  });

  socket.on('pauseArena', ({ arenaId }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    const state = arenas.get(arenaId);
    if (!state) return cb({ ok: false });
    const p = state.participants.get(socket.username);
    if (!p) return cb({ ok: false });
    p.paused = !p.paused;
    if (!p.paused) p.waitingSince = Date.now();
    io.emit('arenaUpdate', { arenaId });
    cb({ ok: true, paused: p.paused });
  });

  socket.on('arenaChat', ({ arenaId, text }) => {
    const state = arenas.get(arenaId);
    if (!state || !socket.username) return;
    if (checkMute(socket.username) > 0) { socket.emit('chatError', { msg: 'Вы заглушены' }); return; }
    if (typeof text !== 'string') return;
    text = text.trim().slice(0, 300);
    if (!text) return;
    const msg = { id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6), user: socket.username, userIsAdmin: isAdmin(socket.username), userIsMod: isMod(socket.username), text, ts: Date.now(), arenaId };
    state.chat.push(msg); if (state.chat.length > 300) state.chat.shift();
    io.to('arena:' + arenaId).emit('arenaChatMessage', msg);
  });

  socket.on('disconnect', () => {
    online.delete(socket.id);
    if (socket.username) {
      for (const state of arenas.values()) {
        const p = state.participants.get(socket.username);
        if (p && p.socketId === socket.id) p.socketId = null;
        state.chatViewers.delete(socket.id);
      }
    }
    const lid = socketToLobby.get(socket.id);
    socketToLobby.delete(socket.id);
    if (lid) {
      const l = lobbies.get(lid);
      if (l && !l.finished && !l.started) {
        io.to(lid).emit('opponentLeft');
        lobbies.delete(lid);
        io.emit('lobbiesUpdate');
      }
    }
    broadcastOnline();
  });
});

// ======================= ЗАПУСК =======================
(async () => {
  try { await initDB(); await loadDB(); }
  catch (err) { console.error('[DB] init error:', err.message); }
  getArenaSchedule(48);
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log('==================================================');
    console.log('  KingSide — сервер запущен');
    console.log(`  Порт: ${PORT}`);
    console.log('==================================================');
  });
})();

process.on('uncaughtException', (err) => console.error('[Server]', err));
