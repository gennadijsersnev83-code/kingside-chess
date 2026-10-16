const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const botPool = require('./bot-pool');
const watcherLearning = require('./watcher-learning');

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

// ======================= БОТЫ =======================
const BOTS = [
  { name: 'BotEasy',   rating: 1000, strength: 800,  level: 1, title: 'Лёгкий',      desc: 'для новичков' },
  { name: 'BotMedium', rating: 1300, strength: 1300, level: 2, title: 'Средний',     desc: 'подумает' },
  { name: 'BotHard',   rating: 1600, strength: 1700, level: 3, title: 'Сложный',     desc: 'тактика' },
  { name: 'BotMaster', rating: 2000, strength: 2100, level: 4, title: 'Мастер',      desc: 'сильный соперник' },
  { name: 'Watcher',   rating: 1500, strength: 1500, level: 0, title: 'Наблюдатель', desc: 'обучаемый', hidden: true }
];
const ALL_BOT_NAMES = new Set(BOTS.map(b => b.name));
const WATCHER_NAME = 'Watcher';
const BOT_STRENGTH = {};
for (const b of BOTS) BOT_STRENGTH[b.name] = b.strength;

// ======================= GLICKO-2 =======================
const GLICKO2 = {
  TAU: 0.5, EPSILON: 1e-6, SCALE: 173.7178,
  DEFAULT_RATING: 1200, DEFAULT_RD: 350, DEFAULT_VOL: 0.06,
  MIN_RD: 30, MAX_RD: 350, MIN_RATING: 400, MAX_RATING: 3500
};
function glicko2Scale(r) { return (r - GLICKO2.DEFAULT_RATING) / GLICKO2.SCALE; }
function glicko2Unscale(mu) { return mu * GLICKO2.SCALE + GLICKO2.DEFAULT_RATING; }
function glicko2G(phi) { return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI)); }
function glicko2E(mu, muJ, phiJ) { return 1 / (1 + Math.exp(-glicko2G(phiJ) * (mu - muJ))); }
function updateGlicko2(rating, rd, vol, results) {
  if (!results || results.length === 0) {
    const phi = rd / GLICKO2.SCALE;
    const newPhi = Math.sqrt(phi * phi + vol * vol);
    return { rating, rd: Math.max(GLICKO2.MIN_RD, Math.min(GLICKO2.MAX_RD, newPhi * GLICKO2.SCALE)), vol };
  }
  const mu = glicko2Scale(rating);
  const phi = rd / GLICKO2.SCALE;
  const sigma = vol;
  let v = 0, deltaSum = 0;
  for (const res of results) {
    const muJ = glicko2Scale(res.rating);
    const phiJ = res.rd / GLICKO2.SCALE;
    const gPhiJ = glicko2G(phiJ);
    const e = glicko2E(mu, muJ, phiJ);
    v += gPhiJ * gPhiJ * e * (1 - e);
    deltaSum += gPhiJ * (res.score - e);
  }
  if (v === 0) v = GLICKO2.EPSILON;
  const delta = deltaSum / v;
  const a = Math.log(sigma * sigma);
  const f = (x) => {
    const ex = Math.exp(x);
    const num = ex * (delta * delta - phi * phi - v - ex);
    const den = 2 * Math.pow(phi * phi + v + ex, 2);
    return num / den - (x - a) / (GLICKO2.TAU * GLICKO2.TAU);
  };
  let A = a, B;
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v);
  else { let k = 1; while (f(a - k * GLICKO2.TAU) < 0 && k < 100) k++; B = a - k * GLICKO2.TAU; }
  let fA = f(A), fB = f(B), iter = 0;
  while (Math.abs(B - A) > GLICKO2.EPSILON && iter < 100) {
    const C = A + (A - B) * fA / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; } else { fA = fA / 2; }
    B = C; fB = fC; iter++;
  }
  const newSigma = Math.exp(A / 2);
  const phiStar = Math.sqrt(phi * phi + newSigma * newSigma);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = mu + newPhi * newPhi * deltaSum;
  return {
    rating: Math.round(Math.max(GLICKO2.MIN_RATING, Math.min(GLICKO2.MAX_RATING, glicko2Unscale(newMu)))),
    rd: Math.max(GLICKO2.MIN_RD, Math.min(GLICKO2.MAX_RD, newPhi * GLICKO2.SCALE)),
    vol: newSigma
  };
}

// ======================= БАЗА =======================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

let db = { users: {}, totalGames: 0 };

async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, salt TEXT NOT NULL,
    rating INTEGER NOT NULL DEFAULT 1200, rd REAL NOT NULL DEFAULT 350, vol REAL NOT NULL DEFAULT 0.06,
    wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, draws INTEGER NOT NULL DEFAULT 0,
    games INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL);`);
  const cols = [
    ['rd','REAL DEFAULT 350'],['vol','REAL DEFAULT 0.06'],
    ['rating_classical','INTEGER'],['rating_rapid','INTEGER'],['rating_blitz','INTEGER'],['rating_bullet','INTEGER'],
    ['rd_classical','REAL DEFAULT 350'],['rd_rapid','REAL DEFAULT 350'],['rd_blitz','REAL DEFAULT 350'],['rd_bullet','REAL DEFAULT 350'],
    ['vol_classical','REAL DEFAULT 0.06'],['vol_rapid','REAL DEFAULT 0.06'],['vol_blitz','REAL DEFAULT 0.06'],['vol_bullet','REAL DEFAULT 0.06'],
    ['wins_classical','INTEGER DEFAULT 0'],['wins_rapid','INTEGER DEFAULT 0'],['wins_blitz','INTEGER DEFAULT 0'],['wins_bullet','INTEGER DEFAULT 0'],
    ['losses_classical','INTEGER DEFAULT 0'],['losses_rapid','INTEGER DEFAULT 0'],['losses_blitz','INTEGER DEFAULT 0'],['losses_bullet','INTEGER DEFAULT 0'],
    ['games_classical','INTEGER DEFAULT 0'],['games_rapid','INTEGER DEFAULT 0'],['games_blitz','INTEGER DEFAULT 0'],['games_bullet','INTEGER DEFAULT 0'],
    ['muted_until','BIGINT DEFAULT 0'],['is_bot','BOOLEAN DEFAULT FALSE']
  ];
  for (const [name, type] of cols) await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${name} ${type};`);
  await pool.query(`UPDATE users SET rating_classical = rating WHERE rating_classical IS NULL;`);
  await pool.query(`UPDATE users SET rating_rapid = rating WHERE rating_rapid IS NULL;`);
  await pool.query(`UPDATE users SET rating_blitz = rating WHERE rating_blitz IS NULL;`);
  await pool.query(`UPDATE users SET rating_bullet = rating WHERE rating_bullet IS NULL;`);
  await pool.query(`CREATE TABLE IF NOT EXISTS games (
    id SERIAL PRIMARY KEY, white TEXT NOT NULL, black TEXT NOT NULL, result TEXT NOT NULL, reason TEXT,
    time_control REAL, increment INTEGER, white_before INTEGER, black_before INTEGER,
    white_after INTEGER, black_after INTEGER, finished_at BIGINT NOT NULL);`);
  await pool.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'blitz';`);
  await pool.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS is_arena BOOLEAN DEFAULT FALSE;`);
  await pool.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS arena_name TEXT;`);
  await pool.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS is_bot BOOLEAN DEFAULT FALSE;`);
  await pool.query(`CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY, from_user TEXT NOT NULL, to_user TEXT NOT NULL, text TEXT NOT NULL,
    created_at BIGINT NOT NULL, read_at BIGINT DEFAULT 0, hidden_for TEXT DEFAULT '');`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages (from_user, to_user, created_at);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_to ON messages (to_user, read_at);`);
  const cnt = await pool.query('SELECT COUNT(*)::int AS n FROM games');
  db.totalGames = cnt.rows[0].n || 0;
}

function emptyRatingBlock(base) {
  return { rating: base, rd: GLICKO2.DEFAULT_RD, vol: GLICKO2.DEFAULT_VOL, wins: 0, losses: 0, games: 0 };
}

async function loadDB() {
  const res = await pool.query('SELECT * FROM users');
  db.users = {};
  for (const row of res.rows) {
    db.users[row.username] = {
      passwordHash: row.password_hash, salt: row.salt,
      rating: row.rating, rd: row.rd != null ? row.rd : GLICKO2.DEFAULT_RD,
      vol: row.vol != null ? row.vol : GLICKO2.DEFAULT_VOL,
      wins: row.wins, losses: row.losses, draws: row.draws, games: row.games,
      createdAt: Number(row.created_at), mutedUntil: Number(row.muted_until || 0), isBot: !!row.is_bot,
      categories: {
        classical: { rating: row.rating_classical != null ? row.rating_classical : row.rating, rd: row.rd_classical != null ? row.rd_classical : GLICKO2.DEFAULT_RD, vol: row.vol_classical != null ? row.vol_classical : GLICKO2.DEFAULT_VOL, wins: row.wins_classical || 0, losses: row.losses_classical || 0, games: row.games_classical || 0 },
        rapid:     { rating: row.rating_rapid     != null ? row.rating_rapid     : row.rating, rd: row.rd_rapid     != null ? row.rd_rapid     : GLICKO2.DEFAULT_RD, vol: row.vol_rapid     != null ? row.vol_rapid     : GLICKO2.DEFAULT_VOL, wins: row.wins_rapid     || 0, losses: row.losses_rapid     || 0, games: row.games_rapid     || 0 },
        blitz:     { rating: row.rating_blitz     != null ? row.rating_blitz     : row.rating, rd: row.rd_blitz     != null ? row.rd_blitz     : GLICKO2.DEFAULT_RD, vol: row.vol_blitz     != null ? row.vol_blitz     : GLICKO2.DEFAULT_VOL, wins: row.wins_blitz     || 0, losses: row.losses_blitz     || 0, games: row.games_blitz     || 0 },
        bullet:    { rating: row.rating_bullet    != null ? row.rating_bullet    : row.rating, rd: row.rd_bullet    != null ? row.rd_bullet    : GLICKO2.DEFAULT_RD, vol: row.vol_bullet    != null ? row.vol_bullet    : GLICKO2.DEFAULT_VOL, wins: row.wins_bullet    || 0, losses: row.losses_bullet    || 0, games: row.games_bullet    || 0 }
      }
    };
  }
  const cnt = await pool.query('SELECT COUNT(*)::int AS n FROM games');
  db.totalGames = cnt.rows[0].n || 0;
  for (const bot of BOTS) {
    const existing = db.users[bot.name];
    if (!existing) {
      const startRating = bot.name === WATCHER_NAME ? 1500 : bot.rating;
      db.users[bot.name] = {
        passwordHash: '', salt: '', rating: startRating, rd: GLICKO2.DEFAULT_RD, vol: GLICKO2.DEFAULT_VOL,
        wins: 0, losses: 0, draws: 0, games: 0, createdAt: Date.now(), mutedUntil: 0, isBot: true,
        categories: { classical: emptyRatingBlock(startRating), rapid: emptyRatingBlock(startRating), blitz: emptyRatingBlock(startRating), bullet: emptyRatingBlock(startRating) }
      };
      try {
        await pool.query(
          `INSERT INTO users (username, password_hash, salt, rating, rd, vol, wins, losses, draws, games, created_at,
                              rating_classical, rating_rapid, rating_blitz, rating_bullet,
                              rd_classical, rd_rapid, rd_blitz, rd_bullet,
                              vol_classical, vol_rapid, vol_blitz, vol_bullet,
                              wins_classical, wins_rapid, wins_blitz, wins_bullet,
                              losses_classical, losses_rapid, losses_blitz, losses_bullet,
                              games_classical, games_rapid, games_blitz, games_bullet,
                              muted_until, is_bot)
           VALUES ($1,$2,$3,$4,$5,$6,0,0,0,0,$7,$4,$4,$4,$4,$5,$5,$5,$5,$6,$6,$6,$6,0,0,0,0,0,0,0,0,0,0,0,0,0,TRUE)`,
          [bot.name, '', '', startRating, GLICKO2.DEFAULT_RD, GLICKO2.DEFAULT_VOL, Date.now()]
        );
      } catch (e) {}
    } else existing.isBot = true;
  }
}

async function saveUser(username) {
  const u = db.users[username]; if (!u) return;
  const c = u.categories || {};
  const get = (k, f) => (c[k] ? c[k][f] : 0);
  await pool.query(
    `INSERT INTO users (username, password_hash, salt, rating, rd, vol, wins, losses, draws, games, created_at,
                        rating_classical, rating_rapid, rating_blitz, rating_bullet,
                        rd_classical, rd_rapid, rd_blitz, rd_bullet,
                        vol_classical, vol_rapid, vol_blitz, vol_bullet,
                        wins_classical, wins_rapid, wins_blitz, wins_bullet,
                        losses_classical, losses_rapid, losses_blitz, losses_bullet,
                        games_classical, games_rapid, games_blitz, games_bullet,
                        muted_until, is_bot)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37)
     ON CONFLICT (username) DO UPDATE SET
       rating = EXCLUDED.rating, rd = EXCLUDED.rd, vol = EXCLUDED.vol,
       wins = EXCLUDED.wins, losses = EXCLUDED.losses, draws = EXCLUDED.draws, games = EXCLUDED.games,
       rating_classical = EXCLUDED.rating_classical, rating_rapid = EXCLUDED.rating_rapid,
       rating_blitz = EXCLUDED.rating_blitz, rating_bullet = EXCLUDED.rating_bullet,
       rd_classical = EXCLUDED.rd_classical, rd_rapid = EXCLUDED.rd_rapid,
       rd_blitz = EXCLUDED.rd_blitz, rd_bullet = EXCLUDED.rd_bullet,
       vol_classical = EXCLUDED.vol_classical, vol_rapid = EXCLUDED.vol_rapid,
       vol_blitz = EXCLUDED.vol_blitz, vol_bullet = EXCLUDED.vol_bullet,
       wins_classical = EXCLUDED.wins_classical, wins_rapid = EXCLUDED.wins_rapid,
       wins_blitz = EXCLUDED.wins_blitz, wins_bullet = EXCLUDED.wins_bullet,
       losses_classical = EXCLUDED.losses_classical, losses_rapid = EXCLUDED.losses_rapid,
       losses_blitz = EXCLUDED.losses_blitz, losses_bullet = EXCLUDED.losses_bullet,
       games_classical = EXCLUDED.games_classical, games_rapid = EXCLUDED.games_rapid,
       games_blitz = EXCLUDED.games_blitz, games_bullet = EXCLUDED.games_bullet,
       muted_until = EXCLUDED.muted_until, is_bot = EXCLUDED.is_bot`,
    [username, u.passwordHash, u.salt, u.rating, u.rd || GLICKO2.DEFAULT_RD, u.vol || GLICKO2.DEFAULT_VOL,
     u.wins, u.losses, u.draws, u.games, u.createdAt,
     c.classical ? c.classical.rating : u.rating, c.rapid ? c.rapid.rating : u.rating,
     c.blitz ? c.blitz.rating : u.rating, c.bullet ? c.bullet.rating : u.rating,
     c.classical ? c.classical.rd : GLICKO2.DEFAULT_RD, c.rapid ? c.rapid.rd : GLICKO2.DEFAULT_RD,
     c.blitz ? c.blitz.rd : GLICKO2.DEFAULT_RD, c.bullet ? c.bullet.rd : GLICKO2.DEFAULT_RD,
     c.classical ? c.classical.vol : GLICKO2.DEFAULT_VOL, c.rapid ? c.rapid.vol : GLICKO2.DEFAULT_VOL,
     c.blitz ? c.blitz.vol : GLICKO2.DEFAULT_VOL, c.bullet ? c.bullet.vol : GLICKO2.DEFAULT_VOL,
     get('classical','wins'), get('rapid','wins'), get('blitz','wins'), get('bullet','wins'),
     get('classical','losses'), get('rapid','losses'), get('blitz','losses'), get('bullet','losses'),
     get('classical','games'), get('rapid','games'), get('blitz','games'), get('bullet','games'),
     u.mutedUntil || 0, !!u.isBot]
  );
}

async function saveGame(game) {
  await pool.query(
    `INSERT INTO games (white, black, result, reason, time_control, increment,
                        white_before, black_before, white_after, black_after, finished_at,
                        category, is_arena, arena_name, is_bot)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [game.white, game.black, game.result, game.reason, game.timeControl, game.increment,
     game.whiteBefore, game.blackBefore, game.whiteAfter, game.blackAfter,
     game.finishedAt, game.category || 'blitz', !!game.isArena, game.arenaName || null, !!game.isBot]
  );
  db.totalGames++;
}

function hashPassword(password, salt) { return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex'); }
function newSalt() { return crypto.randomBytes(16).toString('hex'); }
function verifyPassword(password, salt, hash) {
  try { return crypto.timingSafeEqual(Buffer.from(hashPassword(password, salt), 'hex'), Buffer.from(hash, 'hex')); }
  catch (e) { return false; }
}

function categoryOf(timeMin) {
  if (timeMin < 3) return 'bullet';
  if (timeMin < 10) return 'blitz';
  if (timeMin < 30) return 'rapid';
  return 'classical';
}

function genId() { return Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6); }
function pairKeyFor(a, b) { if (!a || !b) return null; return 'pair:' + [a, b].sort().join(':'); }
function publicUser(name) {
  const u = db.users[name]; if (!u) return null;
  return {
    username: name, rating: u.rating, rd: Math.round(u.rd || GLICKO2.DEFAULT_RD),
    wins: u.wins, losses: u.losses, draws: u.draws, games: u.games,
    createdAt: u.createdAt, role: roleOf(name), isAdmin: isAdmin(name), isMod: isMod(name), isDev: isDev(name),
    mutedUntil: u.mutedUntil || 0, categories: u.categories || null,
    isBot: !!u.isBot && name !== WATCHER_NAME
  };
}
function isUserOnline(username) { for (const [, name] of online.entries()) if (name === username) return true; return false; }
function socketsOfUser(username) { const list = []; for (const [sid, name] of online.entries()) if (name === username) list.push(sid); return list; }

const online = new Map();
const lobbies = new Map();
const socketToLobby = new Map();
const arenas = new Map();
const finishedLobbyIds = new Set();
const finishedGamesInfo = new Map();

// ============================================================
// ЛИМИТЫ ЗАЛА ОЖИДАНИЯ (мягкие, только для ботов и статистики)
// ============================================================
const SOFT_HUMAN_LIMIT = 15;  // после этого Watcher не лезет в зал
const MAX_BOT_WAITING  = 3;   // сколько вызовов от Watcher максимум
const ARENA_COOLDOWN_MS = 10 * 1000;

const FINISHED_INFO_TTL_MS = 24 * 60 * 60 * 1000;
const FINISHED_INFO_MAX = 5000;
setInterval(() => {
  const cutoff = Date.now() - FINISHED_INFO_TTL_MS;
  for (const [id, info] of finishedGamesInfo.entries()) if (info.finishedAt < cutoff) finishedGamesInfo.delete(id);
  if (finishedGamesInfo.size > FINISHED_INFO_MAX) {
    const entries = [...finishedGamesInfo.entries()].sort((a, b) => a[1].finishedAt - b[1].finishedAt);
    for (let i = 0; i < finishedGamesInfo.size - FINISHED_INFO_MAX; i++) finishedGamesInfo.delete(entries[i][0]);
  }
}, 5 * 60 * 1000);

function countActiveLobbies() { let n = 0; for (const l of lobbies.values()) { if (l.finished) continue; if (l.started) n++; } return n; }

// Считает отдельно живые вызовы людей и ботов. Только для UI/статистики.
function countWaitingLobbies() {
  let human = 0, bot = 0;
  const now = Date.now();
  for (const [id, l] of lobbies.entries()) {
    if (!l || l.finished || l.arenaId || l.started || l.guest) continue;
    const isBotLobby = !!l.isBot;
    const hostOnline = isBotLobby || (l.hostSocket && io.sockets.sockets.has(l.hostSocket));
    if (!hostOnline) continue;
    if (l.createdAt && now - l.createdAt > 2 * 60 * 60 * 1000) continue;
    if (isBotLobby) bot++; else human++;
  }
  return { human, bot, total: human + bot };
}

function onlinePlayersList() {
  const byName = new Map();
  for (const username of online.values()) if (db.users[username]) byName.set(username, { ...publicUser(username), online: true });
  for (const bot of BOTS) if (db.users[bot.name]) byName.set(bot.name, { ...publicUser(bot.name), online: true, isBot: true });
  if (db.users[WATCHER_NAME]) byName.set(WATCHER_NAME, { ...publicUser(WATCHER_NAME), online: true, isBot: true });
  return [...byName.values()].sort((a, b) => Number(b.isBot) - Number(a.isBot) || b.rating - a.rating || a.username.localeCompare(b.username));
}
function countOnline() { return onlinePlayersList().length; }
function broadcastOnline() {
  const players = onlinePlayersList();
  const counts = countWaitingLobbies();
  io.emit('stats', {
    online: players.length,
    games: db.totalGames,
    activeGames: countActiveLobbies(),
    waitingLobbies: counts.human,
    waitingBotLobbies: counts.bot,
    waitingMax: SOFT_HUMAN_LIMIT
  });
  io.emit('communityOnline', players);
}
function broadcastLobbies() { io.emit('lobbiesUpdate'); }

function watchersCountOf(l) {
  if (!l || !l.watchers) return 0;
  const names = new Set();
  for (const socketId of [...l.watchers]) {
    const viewerSocket = io.sockets.sockets.get(socketId);
    if (!viewerSocket || !viewerSocket.connected) { l.watchers.delete(socketId); continue; }
    names.add(viewerSocket.username || socketId);
  }
  return names.size;
}
function broadcastWatchers(lobbyId) {
  const l = lobbies.get(lobbyId); if (!l) return;
  const count = watchersCountOf(l);
  io.emit('watchersUpdate', { lobbyId, count });
}
function emitToGameAndWatchers(lobbyId, event, payload) {
  const withId = Object.assign({}, payload, { lobbyId });
  io.to(lobbyId).emit(event, withId);
  io.to('watch:' + lobbyId).emit(event, withId);
}

function cleanupStuckPlaying() {
  for (const state of arenas.values()) {
    for (const p of state.participants.values()) {
      if (p.isPlaying) {
        const l = p.lobbyId ? lobbies.get(p.lobbyId) : null;
        if (!l || l.finished) {
          p.isPlaying = false; p.lobbyId = null;
          if (!p.paused) { p.waitingSince = Date.now(); p.cooldownUntil = Date.now() + ARENA_COOLDOWN_MS; }
          if (p.isBot && p.username !== WATCHER_NAME) {
            const beh = botInitBehavior(p.username);
            if (beh.state === 'playing') { beh.state = 'in_arena'; beh.activityId = state.id; beh.lastChange = Date.now(); }
          }
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
    const whiteU = db.users[whiteName]; const blackU = db.users[blackName];
    const whiteIsBot = !!(whiteU && whiteU.isBot);
    const blackIsBot = !!(blackU && blackU.isBot);
    const lastHist = (l.history && l.history.length) ? l.history[l.history.length - 1] : null;
    list.push({
      id, white: whiteName, black: blackName,
      whiteRating: whiteU ? whiteU.rating : null, blackRating: blackU ? blackU.rating : null,
      whiteIsAdmin: isAdmin(whiteName), blackIsAdmin: isAdmin(blackName),
      whiteIsMod: isMod(whiteName), blackIsMod: isMod(blackName),
      whiteIsBot, blackIsBot, isBotGame: whiteIsBot || blackIsBot,
      timeW: l.timeW, timeB: l.timeB, turn: l.turn,
      timeControl: l.time, increment: l.inc,
      isArena: !!l.arenaId, arenaName: l.arenaName || null,
      fen: l.fen,
      lastMove: lastHist && lastHist.from && lastHist.to ? { from: lastHist.from, to: lastHist.to } : null,
      watchersCount: watchersCountOf(l)
    });
  }
  list.sort((a, b) => {
    const aBot = a.isBotGame ? 1 : 0, bBot = b.isBotGame ? 1 : 0;
    if (aBot !== bBot) return aBot - bBot;
    return (b.isArena ? 1 : 0) - (a.isArena ? 1 : 0);
  });
  return list;
}
function broadcastLiveGames() { try { io.emit('liveGamesUpdate', buildGamesList()); } catch (e) {} }
setInterval(broadcastLiveGames, 3000);

const PIECE_VALUES = { 'p': 100, 'n': 320, 'b': 330, 'r': 500, 'q': 900, 'k': 20000 };
function botParseFen(fen) {
  const parts = fen.split(' ');
  const board = Array.from({length:8}, () => Array(8).fill(null));
  parts[0].split('/').forEach((row, r) => { let f = 0; for (const ch of row) { if (/\d/.test(ch)) f += +ch; else board[r][f++] = ch; } });
  return { board, turn: parts[1], castling: parts[2], ep: parts[3], half: +parts[4] || 0, full: +parts[5] || 1 };
}
function botToFen(state) {
  const rows = state.board.map(r => { let s = '', e = 0; for (const c of r) { if (c) { if (e) { s += e; e = 0; } s += c; } else e++; } if (e) s += e; return s; }).join('/');
  return [rows, state.turn, state.castling, state.ep, state.half, state.full].join(' ');
}
const botIsWhite = p => !!p && p === p.toUpperCase();
const botInBoard = (r,c) => r >= 0 && r < 8 && c >= 0 && c < 8;
function botPseudoMoves(state, r, c) {
  const p = state.board[r][c]; if (!p) return [];
  const moves = []; const white = botIsWhite(p); const type = p.toLowerCase();
  const dir = white ? -1 : 1;
  const add = (rr, cc) => { if (!botInBoard(rr, cc)) return false; const t = state.board[rr][cc]; if (t && botIsWhite(t) === white) return false; moves.push([rr, cc]); return !t; };
  if (type === 'p') {
    const startRow = white ? 6 : 1, oneR = r + dir;
    if (botInBoard(oneR, c) && !state.board[oneR][c]) { moves.push([oneR, c]); const twoR = r + 2 * dir; if (r === startRow && botInBoard(twoR, c) && !state.board[twoR][c]) moves.push([twoR, c]); }
    for (const dc of [-1, 1]) { const rr = r + dir, cc = c + dc; if (!botInBoard(rr, cc)) continue; const t = state.board[rr][cc]; if (t && botIsWhite(t) !== white) moves.push([rr, cc]); const epTarget = String.fromCharCode(97 + cc) + (8 - rr); if (state.ep && state.ep === epTarget && !t) moves.push([rr, cc]); }
  } else if (type === 'n') { [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]].forEach(([dr,dc]) => add(r+dr, c+dc)); }
  else if (type === 'k') {
    [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]].forEach(([dr,dc]) => add(r+dr, c+dc));
    if (white && r === 7 && c === 4) {
      if (state.castling.includes('K') && !state.board[7][5] && !state.board[7][6] && state.board[7][7] === 'R') moves.push([7, 6]);
      if (state.castling.includes('Q') && !state.board[7][3] && !state.board[7][2] && !state.board[7][1] && state.board[7][0] === 'R') moves.push([7, 2]);
    }
    if (!white && r === 0 && c === 4) {
      if (state.castling.includes('k') && !state.board[0][5] && !state.board[0][6] && state.board[0][7] === 'r') moves.push([0, 6]);
      if (state.castling.includes('q') && !state.board[0][3] && !state.board[0][2] && !state.board[0][1] && state.board[0][0] === 'r') moves.push([0, 2]);
    }
  } else {
    const dirs = [];
    if (type === 'r' || type === 'q') dirs.push([-1,0],[1,0],[0,-1],[0,1]);
    if (type === 'b' || type === 'q') dirs.push([-1,-1],[-1,1],[1,-1],[1,1]);
    for (const [dr, dc] of dirs) { let rr = r + dr, cc = c + dc; while (add(rr, cc)) { rr += dr; cc += dc; } }
  }
  return moves;
}
function botFindKing(state, white) { const k = white ? 'K' : 'k'; for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (state.board[r][c] === k) return [r, c]; return null; }
function botIsAttacked(state, r, c, byWhite) {
  for (let rr = 0; rr < 8; rr++) for (let cc = 0; cc < 8; cc++) {
    const p = state.board[rr][cc]; if (!p || botIsWhite(p) !== byWhite) continue;
    const t = p.toLowerCase();
    if (t === 'p') { const dir = byWhite ? -1 : 1; if (rr + dir === r && (cc - 1 === c || cc + 1 === c)) return true; continue; }
    if (t === 'k') { if (Math.abs(rr - r) <= 1 && Math.abs(cc - c) <= 1 && (rr !== r || cc !== c)) return true; continue; }
    if (botPseudoMoves(state, rr, cc).some(([mr, mc]) => mr === r && mc === c)) return true;
  }
  return false;
}
function botInCheck(state, white) { const k = botFindKing(state, white); if (!k) return false; return botIsAttacked(state, k[0], k[1], !white); }
function botApplyMove(state, from, to) {
  const copy = { board: state.board.map(row => row.slice()), turn: state.turn, castling: state.castling, ep: state.ep, half: state.half, full: state.full };
  const [fr, fc] = from, [tr, tc] = to;
  const p = copy.board[fr][fc]; const white = botIsWhite(p); const type = p.toLowerCase();
  if (type === 'p' && copy.ep) { const target = String.fromCharCode(97 + tc) + (8 - tr); if (copy.ep === target && !copy.board[tr][tc]) copy.board[fr][tc] = null; }
  copy.board[tr][tc] = p; copy.board[fr][fc] = null;
  if (type === 'p' && (tr === 0 || tr === 7)) copy.board[tr][tc] = white ? 'Q' : 'q';
  if (type === 'k' && Math.abs(tc - fc) === 2) { const row = fr; if (tc > fc) { copy.board[row][5] = copy.board[row][7]; copy.board[row][7] = null; } else { copy.board[row][3] = copy.board[row][0]; copy.board[row][0] = null; } }
  let cast = copy.castling;
  if (type === 'k') cast = cast.replace(white ? /[KQ]/g : /[kq]/g, '');
  if (type === 'r') { if (fr === 7 && fc === 0) cast = cast.replace('Q', ''); if (fr === 7 && fc === 7) cast = cast.replace('K', ''); if (fr === 0 && fc === 0) cast = cast.replace('q', ''); if (fr === 0 && fc === 7) cast = cast.replace('k', ''); }
  if (!cast) cast = '-';
  let ep = '-'; if (type === 'p' && Math.abs(tr - fr) === 2) ep = String.fromCharCode(97 + fc) + (8 - (fr + (tr - fr) / 2));
  const wasCapture = !!state.board[tr][tc] || (type === 'p' && fc !== tc);
  const half = (type === 'p' || wasCapture) ? 0 : (state.half + 1);
  copy.castling = cast; copy.ep = ep; copy.turn = white ? 'b' : 'w'; copy.half = half;
  if (!white) copy.full += 1;
  return copy;
}
function botLegalMovesFor(state, r, c) {
  const p = state.board[r][c]; if (!p) return [];
  const white = botIsWhite(p);
  return botPseudoMoves(state, r, c).filter(([rr, cc]) => !botInCheck(botApplyMove(state, [r, c], [rr, cc]), white));
}
function botAllLegalMoves(state, white) {
  const res = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p || botIsWhite(p) !== white) continue;
    for (const [rr, cc] of botLegalMovesFor(state, r, c)) res.push([[r,c],[rr,cc]]);
  }
  return res;
}
function botEval(state) {
  let score = 0, whiteBishops = 0, blackBishops = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p) continue;
    const white = botIsWhite(p); const t = p.toLowerCase();
    const v = PIECE_VALUES[t] || 0;
    score += white ? v : -v;
    if (t === 'b') { if (white) whiteBishops++; else blackBishops++; }
  }
  if (whiteBishops >= 2) score += 30;
  if (blackBishops >= 2) score -= 30;
  return score;
}
function botEvalMaterial(state, white) {
  let m = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p) continue;
    if (botIsWhite(p) === white) m += PIECE_VALUES[p.toLowerCase()] || 0;
  }
  return m;
}
function evaluateCurrentPosition(fen) { return botEval(botParseFen(fen)); }

function positionKey(fen) { const parts = fen.split(' '); return parts.slice(0, 4).join(' '); }
function isInsufficientMaterial(state) {
  const pieces = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p) continue;
    const t = p.toLowerCase(); if (t === 'k') continue;
    pieces.push({ type: t, color: botIsWhite(p) ? 'w' : 'b', r, c });
  }
  if (pieces.length === 0) return true;
  if (pieces.length === 1) { const t = pieces[0].type; return t === 'n' || t === 'b'; }
  if (pieces.length === 2) {
    const [a, b] = pieces;
    if (a.type === 'b' && b.type === 'b' && a.color !== b.color) {
      const aColor = (a.r + a.c) % 2, bColor = (b.r + b.c) % 2;
      if (aColor === bColor) return true;
    }
  }
  return false;
}
function registerPosition(lobby) {
  const key = positionKey(lobby.fen);
  if (!lobby.positionCounts) lobby.positionCounts = new Map();
  const cnt = (lobby.positionCounts.get(key) || 0) + 1;
  lobby.positionCounts.set(key, cnt);
  return cnt;
}
function checkAutoDraw(lobbyId) {
  const l = lobbies.get(lobbyId); if (!l || l.finished) return false;
  const key = positionKey(l.fen);
  const cnt = l.positionCounts ? (l.positionCounts.get(key) || 0) : 0;
  if (cnt >= 3) { finishGame(lobbyId, 'draw', 'Троекратное повторение'); return true; }
  const state = botParseFen(l.fen);
  if (isInsufficientMaterial(state)) { finishGame(lobbyId, 'draw', 'Недостаточно материала'); return true; }
  if (state.half >= 100) { finishGame(lobbyId, 'draw', '50 ходов без прогресса'); return true; }
  return false;
}

async function finishGame(lobbyId, result, reason) {
  const l = lobbies.get(lobbyId);
  if (!l || l.finished || finishedLobbyIds.has(lobbyId)) return;
  finishedLobbyIds.add(lobbyId);
  l.finished = true; l.started = false;

  if (l.arenaId) {
    const st = arenas.get(l.arenaId);
    if (st) {
      st.activeLobbies.delete(lobbyId);
      const whiteName = l.hostColor === 'w' ? l.host : l.guest;
      const blackName = l.hostColor === 'b' ? l.host : l.guest;
      const wP = st.participants.get(whiteName);
      const bP = st.participants.get(blackName);
      const now = Date.now();
      if (wP) { wP.isPlaying = false; wP.lobbyId = null; wP.cooldownUntil = now + ARENA_COOLDOWN_MS; wP.awaitingNextPair = !wP.isBot; }
      if (bP) { bP.isPlaying = false; bP.lobbyId = null; bP.cooldownUntil = now + ARENA_COOLDOWN_MS; bP.awaitingNextPair = !bP.isBot; }
    }
  }

  const whiteName = l.hostColor === 'w' ? l.host : l.guest;
  const blackName = l.hostColor === 'b' ? l.host : l.guest;
  const whiteUser = db.users[whiteName]; const blackUser = db.users[blackName];
  if (!whiteUser || !blackUser) { lobbies.delete(lobbyId); broadcastLiveGames(); return; }
  const infoRec = {
    host: l.host, guest: l.guest, hostSocket: l.hostSocket, guestSocket: l.guestSocket,
    hostColor: l.hostColor, guestColor: l.guestColor, time: l.time, inc: l.inc, isBot: !!l.isBot,
    botName: l.botName || l.botName2 || null, arenaId: l.arenaId || null,
    result, reason, finishedAt: Date.now(), lastLobbyId: lobbyId, rematch: {}
  };
  finishedGamesInfo.set(lobbyId, infoRec);
  const pk = pairKeyFor(l.host, l.guest); if (pk) finishedGamesInfo.set(pk, infoRec);
  const isBotGame = !!l.isBot;
  const cat = categoryOf(l.time);
  if (!whiteUser.categories) whiteUser.categories = {};
  if (!blackUser.categories) blackUser.categories = {};
  if (!whiteUser.categories[cat]) whiteUser.categories[cat] = emptyRatingBlock(whiteUser.rating);
  if (!blackUser.categories[cat]) blackUser.categories[cat] = emptyRatingBlock(blackUser.rating);
  const wc = whiteUser.categories[cat]; const bc = blackUser.categories[cat];
  const whiteBefore = wc.rating; const blackBefore = bc.rating;
  let whiteScore = 0.5, blackScore = 0.5;
  if (result === 'w') { whiteScore = 1; blackScore = 0; } else if (result === 'b') { whiteScore = 0; blackScore = 1; }
  const wRd = (typeof wc.rd === 'number' && wc.rd > 0) ? wc.rd : GLICKO2.DEFAULT_RD;
  const wVol = (typeof wc.vol === 'number' && wc.vol > 0) ? wc.vol : GLICKO2.DEFAULT_VOL;
  const bRd = (typeof bc.rd === 'number' && bc.rd > 0) ? bc.rd : GLICKO2.DEFAULT_RD;
  const bVol = (typeof bc.vol === 'number' && bc.vol > 0) ? bc.vol : GLICKO2.DEFAULT_VOL;
  let whiteRes, blackRes;
  try {
    whiteRes = updateGlicko2(wc.rating, wRd, wVol, [{ rating: bc.rating, rd: bRd, score: whiteScore }]);
    blackRes = updateGlicko2(bc.rating, bRd, bVol, [{ rating: wc.rating, rd: wRd, score: blackScore }]);
  } catch (e) { whiteRes = { rating: wc.rating, rd: wRd, vol: wVol }; blackRes = { rating: bc.rating, rd: bRd, vol: bVol }; }
  const whiteAfter = whiteRes.rating; const blackAfter = blackRes.rating;
  const whiteIsWatcher = whiteName === WATCHER_NAME; const blackIsWatcher = blackName === WATCHER_NAME;
  wc.rating = whiteAfter; wc.rd = whiteRes.rd; wc.vol = whiteRes.vol;
  if (result === 'w') wc.wins++; else if (result === 'b') wc.losses++; else wc.draws++;
  wc.games++;
  bc.rating = blackAfter; bc.rd = blackRes.rd; bc.vol = blackRes.vol;
  if (result === 'b') bc.wins++; else if (result === 'w') bc.losses++; else bc.draws++;
  bc.games++;
  whiteUser.rating = whiteAfter; whiteUser.rd = whiteRes.rd; whiteUser.vol = whiteRes.vol;
  if (result === 'w') whiteUser.wins++; else if (result === 'b') whiteUser.losses++; else whiteUser.draws++;
  whiteUser.games++;
  blackUser.rating = blackAfter; blackUser.rd = blackRes.rd; blackUser.vol = blackRes.vol;
  if (result === 'b') blackUser.wins++; else if (result === 'w') blackUser.losses++; else blackUser.draws++;
  blackUser.games++;
  const gameRecord = {
    white: whiteName, black: blackName, result, reason,
    timeControl: l.time, increment: l.inc,
    whiteBefore, blackBefore, whiteAfter, blackAfter,
    finishedAt: Date.now(), category: cat,
    isArena: !!l.arenaId, arenaName: l.arenaName || null, isBot: isBotGame
  };
  if (whiteIsWatcher || blackIsWatcher) {
    try { watcherLearning.finishEpisode(result, whiteIsWatcher ? 'w' : 'b'); watcherLearning.saveWeights(); } catch (e) {}
    try { const beh = botInitBehavior(WATCHER_NAME); if (beh.state === 'playing') { beh.state = 'idle'; beh.activityId = null; beh.lastChange = Date.now(); } } catch (e) {}
  }
  try { await saveUser(whiteName); } catch (e) {}
  try { await saveUser(blackName); } catch (e) {}
  try { await saveGame(gameRecord); } catch (e) {}
  emitToGameAndWatchers(lobbyId, 'gameEnded', {
    result, reason,
    whiteDelta: whiteAfter - whiteBefore, blackDelta: blackAfter - blackBefore,
    whiteAfter, blackAfter, category: cat,
    isArena: !!l.arenaId, arenaId: l.arenaId || null, arenaName: l.arenaName || null, isBot: isBotGame
  });
  if (l.arenaId) { try { handleArenaGameEnd(l.arenaId, lobbyId, result, whiteName, blackName); } catch (e) {} }
  setTimeout(() => {
    const cur = lobbies.get(lobbyId);
    if (cur) {
      io.to(lobbyId).socketsLeave(lobbyId);
      io.to('watch:' + lobbyId).socketsLeave('watch:' + lobbyId);
      lobbies.delete(lobbyId);
      broadcastLobbies(); broadcastLiveGames();
    }
    setTimeout(() => finishedLobbyIds.delete(lobbyId), 10000);
  }, 2000);
  broadcastOnline(); broadcastLiveGames();
}

// (арены — без изменений; см. server (8).js, блок ARENA_TEMPLATES … handleArenaGameEnd)

// ============================================================
// ХОД БОТА
// ============================================================
function scheduleBotMove(lobbyId) {
  const l = lobbies.get(lobbyId);
  if (!l || l.finished || !l.isBot) return;
  const currentTurn = l.turn;
  const botColor = (l.botColor === currentTurn) ? l.botColor : (l.botColor2 === currentTurn ? l.botColor2 : null);
  const botName = (botColor === l.botColor) ? l.botName : (botColor === l.botColor2 ? l.botName2 : null);
  if (!botColor || !botName) return;
  const botTimeLeft = botColor === 'w' ? l.timeW : l.timeB;
  const inc = l.inc || 0;
  const state = botParseFen(l.fen);
  const botIsWhiteTurn = botColor === 'w';
  const botMoves = botAllLegalMoves(state, botIsWhiteTurn);
  const isBotVsBot = !!l.botName2;
  if (botMoves.length === 0) {
    if (botInCheck(state, botIsWhiteTurn)) finishGame(lobbyId, botIsWhiteTurn ? 'b' : 'w', 'Мат');
    else finishGame(lobbyId, 'draw', 'Пат');
    return;
  }
  // ... (полностью как в server (8).js — тут ничего не менялось)
}

// ============================================================
// SOCKET.IO
// ============================================================
io.on('connection', (socket) => {
  socket.emit('stats', {
    online: countOnline(), games: db.totalGames, activeGames: countActiveLobbies(),
    waitingLobbies: countWaitingLobbies().human,
    waitingBotLobbies: countWaitingLobbies().bot,
    waitingMax: SOFT_HUMAN_LIMIT
  });
  socket.emit('liveGamesUpdate', buildGamesList());

  socket.on('register', async ({ username, password }, cb) => {
    if (typeof cb !== 'function') return;
    if (!username || !password) return cb({ ok: false, msg: 'Заполните поля' });
    if (ALL_BOT_NAMES.has(username)) return cb({ ok: false, msg: 'Это имя зарезервировано' });
    if (typeof username !== 'string' || username.length < 2 || username.length > 32) return cb({ ok: false, msg: 'Логин 2–32 символа' });
    if (!/^[a-zA-Zа-яА-Я0-9_\-]+$/.test(username)) return cb({ ok: false, msg: 'Логин: буквы, цифры, _ и -' });
    if (password.length < 3) return cb({ ok: false, msg: 'Пароль минимум 3 символа' });
    if (password.length > 128) return cb({ ok: false, msg: 'Пароль слишком длинный' });
    let user = db.users[username];
    if (user) {
      if (!verifyPassword(password, user.salt, user.passwordHash)) return cb({ ok: false, msg: 'Неверный пароль' });
    } else {
      const salt = newSalt(); const passwordHash = hashPassword(password, salt);
      const base = 1200;
      db.users[username] = {
        passwordHash, salt, rating: base, rd: GLICKO2.DEFAULT_RD, vol: GLICKO2.DEFAULT_VOL,
        wins: 0, losses: 0, draws: 0, games: 0,
        createdAt: Date.now(), mutedUntil: 0, isBot: false,
        categories: { classical: emptyRatingBlock(base), rapid: emptyRatingBlock(base), blitz: emptyRatingBlock(base), bullet: emptyRatingBlock(base) }
      };
      try { await saveUser(username); } catch (err) {}
    }
    online.set(socket.id, username);
    socket.username = username;
    cb({ ok: true, user: publicUser(username) });
    broadcastOnline();
    const un = await unreadCount(username);
    socket.emit('msgUnread', { count: un });
  });

  // ... (getProfile, getStats, getCommunityOnline, getPlayerCard, getTopArenas, getLiveGames, getBots, getGameState, watchGame, unwatchGame — без изменений)

  socket.on('getLobbies', (cb) => {
    if (typeof cb !== 'function') return;
    const list = [];
    for (const [id, l] of lobbies.entries()) {
      if (l.finished || l.arenaId) continue;
      if (l.isBot && !l.isWatcher) continue;
      list.push({ id, host: l.host, time: l.time, inc: l.inc, hostIsAdmin: isAdmin(l.host), hostIsMod: isMod(l.host), status: l.guest ? 'playing' : 'waiting', isBot: l.isWatcher });
    }
    const counts = countWaitingLobbies();
    cb({ list, max: SOFT_HUMAN_LIMIT, current: counts.human, botCurrent: counts.bot, botMax: MAX_BOT_WAITING });
  });

  // ============================================================
  // ГЛАВНОЕ ИСПРАВЛЕНИЕ: createLobby больше НЕ блокируется лимитом.
  // ============================================================
  socket.on('createLobby', ({ time, inc }, cb) => {
    if (typeof cb !== 'function') return;
    if (!socket.username) return cb({ ok: false, msg: 'Не авторизован' });
    time = Math.max(0.5, Math.min(60, +time || 5));
    inc  = Math.max(0, Math.min(60, +inc || 0));

    // 1. Если у игрока уже есть своё живое ожидающее лобби — переиспользуем.
    let myWaiting = null;
    for (const [, l] of lobbies.entries()) {
      if (l.finished || l.arenaId) continue;
      if (l.started || l.guest) continue;
      if (l.host !== socket.username) continue;
      if (l.hostSocket && !io.sockets.sockets.has(l.hostSocket)) {
        lobbies.delete(l.id);
        continue;
      }
      myWaiting = l;
      break;
    }

    // 2. Чистим мёртвые лобби (хост отключился и сокета нет).
    //    Ботские лобби НЕ трогаем — они «живые» (Watcher).
    //    Лимит НЕ применяем — зал работает без ограничений.
    if (!myWaiting) {
      for (const [id, l] of lobbies.entries()) {
        if (!l || l.finished || l.arenaId || l.started || l.guest) continue;
        if (l.isBot) continue;
        if (l.hostSocket && !io.sockets.sockets.has(l.hostSocket)) {
          lobbies.delete(id);
        }
      }
      // Лимит отключён намеренно: чтобы вызов всегда выставлялся.
    }

    // 3. Ищем мгновенного соперника с теми же time/inc.
    let matched = null;
    for (const [, l] of lobbies.entries()) {
      if (l.finished || l.arenaId || (l.isBot && !l.isWatcher) || l.guest) continue;
      if (l.host === socket.username || l.hostSocket === socket.id) continue;
      if (Number(l.time) !== time || Number(l.inc) !== inc) continue;
      matched = l; break;
    }
    if (matched) {
      matched.guest = socket.username; matched.guestSocket = socket.id;
      const hostIsWhite = Math.random() < 0.5;
      matched.hostColor = hostIsWhite ? 'w' : 'b';
      matched.guestColor = hostIsWhite ? 'b' : 'w';
      matched.started = true; matched.lastTick = Date.now();
      if (!matched.positionCounts) matched.positionCounts = new Map();
      registerPosition(matched);
      if (matched.isWatcher) { matched.botColor = matched.hostColor; matched.botColor2 = null; matched.botName = WATCHER_NAME; matched.botName2 = null; }
      socket.join(matched.id); socketToLobby.set(socket.id, matched.id); socket.lobbyId = matched.id;
      const hostRating = db.users[matched.host] ? db.users[matched.host].rating : null;
      const guestRating = db.users[socket.username] ? db.users[socket.username].rating : null;
      const hostIsWatcher = matched.host === WATCHER_NAME;
      io.to(matched.hostSocket).emit('gameStart', { color: matched.hostColor, opponent: matched.guest, opponentRating: guestRating, opponentIsAdmin: isAdmin(matched.guest), opponentIsMod: isMod(matched.guest), opponentOnline: true, time: matched.time, inc: matched.inc, lobbyId: matched.id, fen: matched.fen, chat: matched.chat, isArena: false, isBot: matched.isBot && !hostIsWatcher });
      io.to(matched.guestSocket).emit('gameStart', { color: matched.guestColor, opponent: matched.host, opponentRating: hostRating, opponentIsAdmin: isAdmin(matched.host), opponentIsMod: isMod(matched.host), opponentOnline: true, time: matched.time, inc: matched.inc, lobbyId: matched.id, fen: matched.fen, chat: matched.chat, isArena: false, isBot: matched.isBot && !hostIsWatcher });
      if (matched.isBot) setTimeout(() => scheduleBotMove(matched.id), 800);
      cb({ ok: true, id: matched.id, matched: true });
      broadcastLobbies(); broadcastOnline(); broadcastLiveGames();
      return;
    }

    // 4. Создаём своё лобби — всегда, без блокировки.
    const id = genId();
    const newLobby = {
      id, host: socket.username, hostSocket: socket.id, guest: null, guestSocket: null,
      hostColor: null, guestColor: null, time, inc, timeW: time * 60, timeB: time * 60,
      turn: 'w', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      started: false, finished: false, lastTick: Date.now(), chat: [], drawOffer: null,
      createdAt: Date.now(), rematch: null, isBot: false, history: [], positionCounts: new Map()
    };
    lobbies.set(id, newLobby); registerPosition(newLobby);
    socket.join(id); socketToLobby.set(socket.id, id); socket.lobbyId = id;
    cb({ ok: true, id });
    broadcastLobbies(); broadcastOnline();
  });

  // ... (playWithBot, cancelLobby, joinLobby, move, resign, gameOver, chatMessage, модерация, drawOffer/Accept/Decline, rematch, арены, сообщения — без изменений; они есть в server (8).js и работают корректно)

  socket.on('disconnect', () => {
    online.delete(socket.id);
    if (socket.username) {
      for (const state of arenas.values()) {
        const p = state.participants.get(socket.username);
        if (p && p.socketId === socket.id) p.socketId = null;
        state.chatViewers.delete(socket.id);
        if (p && !p.isPlaying) p.inArenaRoom = false;
        if (p && p.isBot && p.isPlaying) {
          p.isPlaying = false; p.lobbyId = null;
          if (p.username !== WATCHER_NAME) {
            const beh = botInitBehavior(p.username);
            if (beh.state === 'playing') { beh.state = 'in_arena'; beh.activityId = state.id; beh.lastChange = Date.now(); }
          }
        }
      }
    }
    for (const l of lobbies.values()) {
      if (l.watchers) if (l.watchers.delete(socket.id)) broadcastWatchers(l.id);
    }
    const lid = socketToLobby.get(socket.id);
    socketToLobby.delete(socket.id);
    if (lid) {
      const l = lobbies.get(lid);
      if (l && !l.finished && !l.started) {
        io.to(lid).emit('opponentLeft');
        lobbies.delete(lid);
        io.emit('lobbiesUpdate');
        broadcastLiveGames();
      }
    }
    broadcastOnline();
  });
});

(async () => {
  try { await initDB(); await loadDB(); }
  catch (err) { console.error('[DB] Ошибка инициализации:', err.message); }
  watcherLearning.loadWeights();
  watcherLearning.startAutoSave();
  getArenaSchedule(48);
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log('==================================================');
    console.log('  Kingside — сервер запущен');
    console.log(`  Порт: ${PORT}`);
    console.log(`  CPU ядер: ${require('os').cpus().length}`);
    console.log('==================================================');
  });
})();

process.on('SIGINT', async () => { try { await botPool.terminate(); watcherLearning.saveWeights(); } catch (e) {} process.exit(0); });
process.on('SIGTERM', async () => { try { await botPool.terminate(); watcherLearning.saveWeights(); } catch (e) {} process.exit(0); });
process.on('uncaughtException', (err) => { console.error('[Server] Ошибка:', err); });
