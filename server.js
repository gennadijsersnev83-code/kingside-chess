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
  { name: 'BotEasy',   rating: 1000, level: 1, title: 'Лёгкий',   desc: 'для новичков' },
  { name: 'BotMedium', rating: 1300, level: 2, title: 'Средний',  desc: 'подумает' },
  { name: 'BotHard',   rating: 1600, level: 3, title: 'Сложный',  desc: 'тактика' },
  { name: 'BotMaster', rating: 2000, level: 4, title: 'Мастер',   desc: 'сильный соперник' },
  { name: 'Watcher',   rating: 1500, level: 0, title: 'Наблюдатель', desc: 'обучаемый', hidden: true }
];
const BOT_NAMES = new Set(BOTS.filter(b => !b.hidden).map(b => b.name));
const ALL_BOT_NAMES = new Set(BOTS.map(b => b.name));
const WATCHER_NAME = 'Watcher';

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
  let v = 0;
  let deltaSum = 0;
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
  let A = a;
  let B;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * GLICKO2.TAU) < 0 && k < 100) k++;
    B = a - k * GLICKO2.TAU;
  }
  let fA = f(A);
  let fB = f(B);
  let iter = 0;
  while (Math.abs(B - A) > GLICKO2.EPSILON && iter < 100) {
    const C = A + (A - B) * fA / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; } else { fA = fA / 2; }
    B = C; fB = fC;
    iter++;
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
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        rating INTEGER NOT NULL DEFAULT 1200,
        rd REAL NOT NULL DEFAULT 350,
        vol REAL NOT NULL DEFAULT 0.06,
        wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        draws INTEGER NOT NULL DEFAULT 0,
        games INTEGER NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL
      );
    `);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS rd REAL DEFAULT 350;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vol REAL DEFAULT 0.06;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS rating_classical INTEGER;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS rating_rapid INTEGER;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS rating_blitz INTEGER;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS rating_bullet INTEGER;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS rd_classical REAL DEFAULT 350;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS rd_rapid REAL DEFAULT 350;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS rd_blitz REAL DEFAULT 350;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS rd_bullet REAL DEFAULT 350;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vol_classical REAL DEFAULT 0.06;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vol_rapid REAL DEFAULT 0.06;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vol_blitz REAL DEFAULT 0.06;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vol_bullet REAL DEFAULT 0.06;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS wins_classical INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS wins_rapid INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS wins_blitz INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS wins_bullet INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS losses_classical INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS losses_rapid INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS losses_blitz INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS losses_bullet INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS games_classical INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS games_rapid INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS games_blitz INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS games_bullet INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS muted_until BIGINT DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_bot BOOLEAN DEFAULT FALSE;`);
    await pool.query(`UPDATE users SET rating_classical = rating WHERE rating_classical IS NULL;`);
    await pool.query(`UPDATE users SET rating_rapid     = rating WHERE rating_rapid     IS NULL;`);
    await pool.query(`UPDATE users SET rating_blitz     = rating WHERE rating_blitz     IS NULL;`);
    await pool.query(`UPDATE users SET rating_bullet    = rating WHERE rating_bullet    IS NULL;`);
    await pool.query(`UPDATE users SET rd_classical = 350 WHERE rd_classical IS NULL;`);
    await pool.query(`UPDATE users SET rd_rapid     = 350 WHERE rd_rapid     IS NULL;`);
    await pool.query(`UPDATE users SET rd_blitz     = 350 WHERE rd_blitz     IS NULL;`);
    await pool.query(`UPDATE users SET rd_bullet    = 350 WHERE rd_bullet    IS NULL;`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS games (
        id SERIAL PRIMARY KEY,
        white TEXT NOT NULL,
        black TEXT NOT NULL,
        result TEXT NOT NULL,
        reason TEXT,
        time_control REAL,
        increment INTEGER,
        white_before INTEGER,
        black_before INTEGER,
        white_after INTEGER,
        black_after INTEGER,
        finished_at BIGINT NOT NULL
      );
    `);
    await pool.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'blitz';`);
    await pool.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS is_arena BOOLEAN DEFAULT FALSE;`);
    await pool.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS arena_name TEXT;`);
    await pool.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS is_bot BOOLEAN DEFAULT FALSE;`);

    const cnt = await pool.query('SELECT COUNT(*)::int AS n FROM games');
    db.totalGames = cnt.rows[0].n || 0;
    console.log(`[DB] Схема готова. Всего партий в БД: ${db.totalGames}`);
  } catch (err) {
    console.error('[DB] Ошибка создания схемы:', err.message || err.code || err);
    throw err;
  }
}

function emptyRatingBlock(base) {
  return { rating: base, rd: GLICKO2.DEFAULT_RD, vol: GLICKO2.DEFAULT_VOL, wins: 0, losses: 0, games: 0 };
}

async function loadDB() {
  try {
    const res = await pool.query('SELECT * FROM users');
    db.users = {};
    for (const row of res.rows) {
      db.users[row.username] = {
        passwordHash: row.password_hash, salt: row.salt,
        rating: row.rating, rd: row.rd != null ? row.rd : GLICKO2.DEFAULT_RD,
        vol: row.vol != null ? row.vol : GLICKO2.DEFAULT_VOL,
        wins: row.wins, losses: row.losses, draws: row.draws, games: row.games,
        createdAt: Number(row.created_at),
        mutedUntil: Number(row.muted_until || 0),
        isBot: !!row.is_bot,
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
          passwordHash: '', salt: '', rating: startRating,
          rd: GLICKO2.DEFAULT_RD, vol: GLICKO2.DEFAULT_VOL,
          wins: 0, losses: 0, draws: 0, games: 0,
          createdAt: Date.now(), mutedUntil: 0, isBot: true,
          categories: {
            classical: emptyRatingBlock(startRating), rapid: emptyRatingBlock(startRating),
            blitz: emptyRatingBlock(startRating), bullet: emptyRatingBlock(startRating)
          }
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
        } catch (e) { console.error('[DB] Ошибка вставки бота:', e.message); }
      } else {
        existing.isBot = true;
      }
    }
    console.log(`[DB] Загружено: ${Object.keys(db.users).length} игроков, ${db.totalGames} партий`);
  } catch (err) {
    console.error('[DB] Ошибка загрузки:', err.message || err.code || err);
  }
}

async function saveUser(username) {
  const u = db.users[username];
  if (!u) return;
  const c = u.categories || {};
  const get = (k, f) => (c[k] ? c[k][f] : 0);
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
         muted_until = EXCLUDED.muted_until,
         is_bot = EXCLUDED.is_bot`,
      [
        username, u.passwordHash, u.salt, u.rating, u.rd || GLICKO2.DEFAULT_RD, u.vol || GLICKO2.DEFAULT_VOL,
        u.wins, u.losses, u.draws, u.games, u.createdAt,
        c.classical ? c.classical.rating : u.rating,
        c.rapid ? c.rapid.rating : u.rating,
        c.blitz ? c.blitz.rating : u.rating,
        c.bullet ? c.bullet.rating : u.rating,
        c.classical ? c.classical.rd : GLICKO2.DEFAULT_RD,
        c.rapid ? c.rapid.rd : GLICKO2.DEFAULT_RD,
        c.blitz ? c.blitz.rd : GLICKO2.DEFAULT_RD,
        c.bullet ? c.bullet.rd : GLICKO2.DEFAULT_RD,
        c.classical ? c.classical.vol : GLICKO2.DEFAULT_VOL,
        c.rapid ? c.rapid.vol : GLICKO2.DEFAULT_VOL,
        c.blitz ? c.blitz.vol : GLICKO2.DEFAULT_VOL,
        c.bullet ? c.bullet.vol : GLICKO2.DEFAULT_VOL,
        get('classical','wins'), get('rapid','wins'), get('blitz','wins'), get('bullet','wins'),
        get('classical','losses'), get('rapid','losses'), get('blitz','losses'), get('bullet','losses'),
        get('classical','games'), get('rapid','games'), get('blitz','games'), get('bullet','games'),
        u.mutedUntil || 0,
        !!u.isBot
      ]
    );
  } catch (err) {
    console.error(`[DB] saveUser(${username}) ошибка:`, err.message || err.code || err);
    throw err;
  }
}

async function saveGame(game) {
  try {
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
  } catch (err) {
    console.error('[DB] saveGame ошибка:', err.message || err.code || err);
    throw err;
  }
}

// ======================= ПАРОЛИ =======================
function hashPassword(password, salt) { return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex'); }
function newSalt() { return crypto.randomBytes(16).toString('hex'); }
function verifyPassword(password, salt, hash) {
  const test = hashPassword(password, salt);
  try { return crypto.timingSafeEqual(Buffer.from(test, 'hex'), Buffer.from(hash, 'hex')); }
  catch (e) { return false; }
}

// ======================= КАТЕГОРИИ =======================
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
    username: name, rating: u.rating, rd: Math.round(u.rd || GLICKO2.DEFAULT_RD),
    wins: u.wins, losses: u.losses, draws: u.draws, games: u.games,
    createdAt: u.createdAt, role: roleOf(name), isAdmin: isAdmin(name), isMod: isMod(name), isDev: isDev(name),
    mutedUntil: u.mutedUntil || 0, categories: u.categories || null,
    isBot: !!u.isBot && name !== WATCHER_NAME
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
const finishedLobbyIds = new Set();
const finishedGamesInfo = new Map();

setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [id, info] of finishedGamesInfo.entries()) {
    if (info.finishedAt < cutoff) finishedGamesInfo.delete(id);
  }
}, 60000);

function countActiveLobbies() {
  let n = 0;
  for (const l of lobbies.values()) { if (l.finished) continue; if (l.started) n++; }
  return n;
}
function onlinePlayersList() {
  const byName = new Map();
  for (const username of online.values()) {
    if (db.users[username]) byName.set(username, { ...publicUser(username), online: true });
  }
  for (const bot of BOTS) {
    if (db.users[bot.name]) byName.set(bot.name, { ...publicUser(bot.name), online: true, isBot: true });
  }
  if (db.users[WATCHER_NAME]) byName.set(WATCHER_NAME, { ...publicUser(WATCHER_NAME), online: true, isBot: true });
  return [...byName.values()].sort((a, b) => Number(b.isBot) - Number(a.isBot) || b.rating - a.rating || a.username.localeCompare(b.username));
}
function countOnline() { return onlinePlayersList().length; }
function broadcastOnline() {
  const players = onlinePlayersList();
  io.emit('stats', { online: players.length, games: db.totalGames, activeGames: countActiveLobbies() });
  io.emit('communityOnline', players);
}
function broadcastLobbies() { io.emit('lobbiesUpdate'); }

function watchersCountOf(l) {
  if (!l || !l.watchers) return 0;
  const names = new Set();
  for (const socketId of [...l.watchers]) {
    const viewerSocket = io.sockets.sockets.get(socketId);
    if (!viewerSocket || !viewerSocket.connected) {
      l.watchers.delete(socketId);
      continue;
    }
    names.add(viewerSocket.username || socketId);
  }
  return names.size;
}
function broadcastWatchers(lobbyId) {
  const l = lobbies.get(lobbyId);
  if (!l) return;
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
          if (!p.paused) p.waitingSince = Date.now();
          if (p.isBot && p.username !== WATCHER_NAME) {
            const beh = botInitBehavior(p.username);
            if (beh.state === 'playing') {
              beh.state = 'in_arena'; beh.activityId = state.id; beh.lastChange = Date.now();
            }
          }
        }
      }
    }
  }
}
setInterval(cleanupStuckPlaying, 10000);

// ============================================================
//  СПИСОК ЖИВЫХ ПАРТИЙ
// ============================================================

function buildGamesList() {
  const list = [];
  for (const [id, l] of lobbies.entries()) {
    if (l.finished || !l.started) continue;
    const whiteName = l.hostColor === 'w' ? l.host : l.guest;
    const blackName = l.hostColor === 'b' ? l.host : l.guest;
    const whiteU = db.users[whiteName];
    const blackU = db.users[blackName];
    const whiteIsBot = !!(whiteU && whiteU.isBot);
    const blackIsBot = !!(blackU && blackU.isBot);
    const lastHist = (l.history && l.history.length) ? l.history[l.history.length - 1] : null;
    list.push({
      id, white: whiteName, black: blackName,
      whiteRating: whiteU ? whiteU.rating : null,
      blackRating: blackU ? blackU.rating : null,
      whiteIsAdmin: isAdmin(whiteName), blackIsAdmin: isAdmin(blackName),
      whiteIsMod: isMod(whiteName), blackIsMod: isMod(blackName),
      whiteIsBot, blackIsBot,
      isBotGame: whiteIsBot || blackIsBot,
      timeW: l.timeW, timeB: l.timeB, turn: l.turn,
      timeControl: l.time, increment: l.inc,
      isArena: !!l.arenaId, arenaName: l.arenaName || null,
      fen: l.fen,
      lastMove: lastHist && lastHist.from && lastHist.to ? { from: lastHist.from, to: lastHist.to } : null,
      watchersCount: watchersCountOf(l)
    });
  }
  // Сортировка: сначала партии людей, потом партии с ботами; внутри — турнирные выше обычных.
  list.sort((a, b) => {
    const aBot = a.isBotGame ? 1 : 0;
    const bBot = b.isBotGame ? 1 : 0;
    if (aBot !== bBot) return aBot - bBot;
    return (b.isArena ? 1 : 0) - (a.isArena ? 1 : 0);
  });
  return list;
}

function broadcastLiveGames() {
  try {
    io.emit('liveGamesUpdate', buildGamesList());
  } catch (e) { /* ignore */ }
}

// Периодическая рассылка (страховка).
setInterval(broadcastLiveGames, 3000);

// ======================= ПРАВИЛА ШАХМАТ =======================
function positionKey(fen) {
  const parts = fen.split(' ');
  return parts.slice(0, 4).join(' ');
}

function isInsufficientMaterial(state) {
  const pieces = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c];
    if (!p) continue;
    const t = p.toLowerCase();
    if (t === 'k') continue;
    pieces.push({ type: t, color: botIsWhite(p) ? 'w' : 'b', r, c });
  }
  if (pieces.length === 0) return true;
  if (pieces.length === 1) {
    const t = pieces[0].type;
    if (t === 'n' || t === 'b') return true;
    return false;
  }
  if (pieces.length === 2) {
    const [a, b] = pieces;
    if (a.type === 'b' && b.type === 'b' && a.color !== b.color) {
      const aColor = (a.r + a.c) % 2;
      const bColor = (b.r + b.c) % 2;
      if (aColor === bColor) return true;
    }
    return false;
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
  const l = lobbies.get(lobbyId);
  if (!l || l.finished) return false;

  const key = positionKey(l.fen);
  const cnt = l.positionCounts ? (l.positionCounts.get(key) || 0) : 0;
  if (cnt >= 3) {
    finishGame(lobbyId, 'draw', 'Троекратное повторение');
    return true;
  }

  const state = botParseFen(l.fen);
  if (isInsufficientMaterial(state)) {
    finishGame(lobbyId, 'draw', 'Недостаточно материала');
    return true;
  }

  if (state.half >= 100) {
    finishGame(lobbyId, 'draw', '50 ходов без прогресса');
    return true;
  }

  return false;
}

// ======================= ФИНАЛИЗАЦИЯ =======================
async function finishGame(lobbyId, result, reason) {
  const l = lobbies.get(lobbyId);
  if (!l || l.finished) return;
  if (finishedLobbyIds.has(lobbyId)) return;
  finishedLobbyIds.add(lobbyId);
  l.finished = true;
  l.started = false;

  const whiteName = l.hostColor === 'w' ? l.host : l.guest;
  const blackName = l.hostColor === 'b' ? l.host : l.guest;
  const whiteUser = db.users[whiteName];
  const blackUser = db.users[blackName];
  if (!whiteUser || !blackUser) { lobbies.delete(lobbyId); broadcastLiveGames(); return; }

  finishedGamesInfo.set(lobbyId, {
    host: l.host, guest: l.guest,
    hostSocket: l.hostSocket, guestSocket: l.guestSocket,
    hostColor: l.hostColor, guestColor: l.guestColor,
    time: l.time, inc: l.inc, isBot: !!l.isBot,
    botName: l.botName || l.botName2 || null,
    arenaId: l.arenaId || null,
    finishedAt: Date.now()
  });

  const isBotGame = !!l.isBot;
  const cat = categoryOf(l.time);

  if (!whiteUser.categories) whiteUser.categories = {};
  if (!blackUser.categories) blackUser.categories = {};
  if (!whiteUser.categories[cat]) whiteUser.categories[cat] = emptyRatingBlock(whiteUser.rating);
  if (!blackUser.categories[cat]) blackUser.categories[cat] = emptyRatingBlock(blackUser.rating);

  const wc = whiteUser.categories[cat];
  const bc = blackUser.categories[cat];
  const whiteBefore = wc.rating;
  const blackBefore = bc.rating;

  let whiteScore = 0.5, blackScore = 0.5;
  if (result === 'w') { whiteScore = 1; blackScore = 0; }
  else if (result === 'b') { whiteScore = 0; blackScore = 1; }

  const wRd = (typeof wc.rd === 'number' && wc.rd > 0) ? wc.rd : GLICKO2.DEFAULT_RD;
  const wVol = (typeof wc.vol === 'number' && wc.vol > 0) ? wc.vol : GLICKO2.DEFAULT_VOL;
  const bRd = (typeof bc.rd === 'number' && bc.rd > 0) ? bc.rd : GLICKO2.DEFAULT_RD;
  const bVol = (typeof bc.vol === 'number' && bc.vol > 0) ? bc.vol : GLICKO2.DEFAULT_VOL;

  let whiteRes, blackRes;
  try {
    whiteRes = updateGlicko2(wc.rating, wRd, wVol, [{ rating: bc.rating, rd: bRd, score: whiteScore }]);
    blackRes = updateGlicko2(bc.rating, bRd, bVol, [{ rating: wc.rating, rd: wRd, score: blackScore }]);
  } catch (e) {
    console.error('[finishGame] Glicko ошибка:', e.message);
    whiteRes = { rating: wc.rating, rd: wRd, vol: wVol };
    blackRes = { rating: bc.rating, rd: bRd, vol: bVol };
  }

  let whiteAfter = whiteRes.rating;
  let blackAfter = blackRes.rating;

  const whiteIsWatcher = whiteName === WATCHER_NAME;
  const blackIsWatcher = blackName === WATCHER_NAME;

  wc.rating = whiteAfter; wc.rd = whiteRes.rd; wc.vol = whiteRes.vol;
  if (result === 'w') wc.wins++; else if (result === 'b') wc.losses++; else wc.draws++;
  wc.games++;
  bc.rating = blackAfter; bc.rd = blackRes.rd; bc.vol = blackRes.vol;
  if (result === 'b') bc.wins++; else if (result === 'w') bc.losses++; else bc.draws++;
  bc.games++;

  whiteUser.rating = whiteAfter;
  whiteUser.rd = whiteRes.rd;
  whiteUser.vol = whiteRes.vol;
  if (result === 'w') whiteUser.wins++; else if (result === 'b') whiteUser.losses++; else whiteUser.draws++;
  whiteUser.games++;
  blackUser.rating = blackAfter;
  blackUser.rd = blackRes.rd;
  blackUser.vol = blackRes.vol;
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

  if (whiteIsWatcher || blackIsWatcher) {
    try {
      const watcherColor = whiteIsWatcher ? 'w' : 'b';
      watcherLearning.finishEpisode(result, watcherColor);
      watcherLearning.saveWeights();
    } catch (e) { console.error('[Watcher] Ошибка завершения эпизода:', e.message); }
    try {
      const beh = botInitBehavior(WATCHER_NAME);
      if (beh.state === 'playing') { beh.state = 'idle'; beh.activityId = null; beh.lastChange = Date.now(); }
    } catch (e) { /* ignore */ }
  }

  try { await saveUser(whiteName); } catch (e) { console.error('[DB] saveUser white fail:', e.message); }
  try { await saveUser(blackName); } catch (e) { console.error('[DB] saveUser black fail:', e.message); }
  try { await saveGame(gameRecord); } catch (e) { console.error('[DB] saveGame fail:', e.message); }

  const isArena = !!l.arenaId;
  emitToGameAndWatchers(lobbyId, 'gameEnded', {
    result, reason,
    whiteDelta: whiteAfter - whiteBefore,
    blackDelta: blackAfter - blackBefore,
    whiteAfter, blackAfter, category: cat,
    isArena, arenaId: l.arenaId || null, arenaName: l.arenaName || null,
    isBot: isBotGame
  });

  if (l.arenaId) {
    try { handleArenaGameEnd(l.arenaId, lobbyId, result, whiteName, blackName); }
    catch (e) { console.error('[arena] handleArenaGameEnd ошибка:', e.message); }
  }

  setTimeout(() => {
    const cur = lobbies.get(lobbyId);
    if (cur) {
      io.to(lobbyId).socketsLeave(lobbyId);
      io.to('watch:' + lobbyId).socketsLeave('watch:' + lobbyId);
      lobbies.delete(lobbyId);
      broadcastLobbies();
      broadcastLiveGames();
    }
    setTimeout(() => finishedLobbyIds.delete(lobbyId), 10000);
  }, 2000);

  broadcastOnline();
  broadcastLiveGames();
}

// ======================= АРЕНЫ =======================
const ARENA_TEMPLATES = [
  { id: 'bullet-halfhour', name: 'Получасовая пуля', description: '1+0 · рейтинговая', timeControl: 1, increment: 0, durationMin: 27, repeat: 'every30', color: 'bullet', botFriendly: false },
  { id: 'blitz-hourly', name: 'Ежечасная блиц-арена', description: '3+2 · рейтинговая', timeControl: 3, increment: 2, durationMin: 57, repeat: 'hourly', color: 'blitz', botFriendly: false },
  { id: 'rapid-2h', name: 'Двухчасовая рапид-арена', description: '10+0 · рейтинговая', timeControl: 10, increment: 0, durationMin: 117, repeat: 'every2h', color: 'rapid', botFriendly: false },
  { id: 'classical-4h', name: 'Классическая арена', description: '30+0 · классика', timeControl: 30, increment: 0, durationMin: 237, repeat: 'every4h', color: 'classical', botFriendly: false },
  { id: 'bot-blitz-hourly', name: 'Блиц-арена с ботами', description: '3+2 · люди и боты', timeControl: 3, increment: 2, durationMin: 57, repeat: 'hourly', color: 'blitz', botFriendly: true },
  { id: 'bot-rapid-2h', name: 'Рапид-арена с ботами', description: '10+0 · люди и боты', timeControl: 10, increment: 0, durationMin: 117, repeat: 'every2h', color: 'rapid', botFriendly: true },
  { id: 'bot-bullet-halfhour', name: 'Пуля-арена с ботами', description: '1+0 · люди и боты', timeControl: 1, increment: 0, durationMin: 27, repeat: 'every30', color: 'bullet', botFriendly: true },
  { id: 'bot-bullet-2h', name: 'Пуля-арена с ботами (2+1)', description: '2+1 · люди и боты', timeControl: 2, increment: 1, durationMin: 57, repeat: 'hourly', color: 'bullet', botFriendly: true }
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
  for (const bot of BOTS.filter(b => !b.hidden)) {
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
    const beh = botInitBehavior(bot.name);
    beh.state = 'in_arena'; beh.activityId = state.id; beh.lastChange = Date.now();
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

const MAX_BOT_GAMES = 1;
const MAX_BOT_GAMES_PER_ARENA = 3;
const MAX_WATCHER_ACTIVE_LOBBIES = 1;

function botActiveGamesCount(botName) {
  let n = 0;
  for (const l of lobbies.values()) {
    if (l.finished) continue;
    if (!l.isBot) continue;
    if (l.botName === botName || l.botName2 === botName) n++;
  }
  return n;
}
function botIsBusy(botName) {
  if (botName === WATCHER_NAME) {
    for (const l of lobbies.values()) {
      if (l.finished) continue;
      if (l.host === WATCHER_NAME || l.guest === WATCHER_NAME) return true;
    }
    return false;
  }
  return botActiveGamesCount(botName) >= MAX_BOT_GAMES;
}
function botGamesInArena(arenaId) {
  let n = 0;
  for (const l of lobbies.values()) {
    if (l.finished) continue;
    if (!l.isBot) continue;
    if (l.arenaId === arenaId) n++;
  }
  return n;
}
function watcherGamesInArena(arenaId) {
  let n = 0;
  for (const l of lobbies.values()) {
    if (l.finished) continue;
    if (!l.isBot) continue;
    if (l.arenaId !== arenaId) continue;
    if (l.botName === WATCHER_NAME || l.botName2 === WATCHER_NAME) n++;
  }
  return n;
}
function watcherHasActiveLobby() {
  for (const l of lobbies.values()) {
    if (l.finished || !l.started) continue;
    if (l.host === WATCHER_NAME || l.guest === WATCHER_NAME) return true;
  }
  return false;
}
function watcherInAnyArena() {
  for (const state of arenas.values()) {
    if (state.finished) continue;
    if (state.participants.has(WATCHER_NAME) && state.participants.get(WATCHER_NAME).isPlaying) return true;
  }
  return false;
}
function isAvailableForPairing(p, arenaId) {
  if (!p) return false;
  if (p.username === WATCHER_NAME) {
    if (p.paused) return false;
    if (watcherHasActiveLobby()) return false;
    if (watcherGamesInArena(arenaId) >= MAX_WATCHER_ACTIVE_LOBBIES) return false;
    return true;
  }
  if (p.paused) return false;
  if (!p.isBot && p.awaitingNextPair) return false;
  if (p.isBot) {
    if (botIsBusy(p.username)) return false;
    if (arenaId && botGamesInArena(arenaId) >= MAX_BOT_GAMES_PER_ARENA) return false;
    return true;
  }
  if (!p.socketId) return false;
  if (!io.sockets.sockets.has(p.socketId)) return false;
  return true;
}

// ============================================================
//  ЖИВОЕ ПОВЕДЕНИЕ БОТОВ
// ============================================================
const BOT_BEHAVIOR = new Map();
function botInitBehavior(botName) {
  if (!BOT_BEHAVIOR.has(botName)) {
    BOT_BEHAVIOR.set(botName, {
      state: 'idle', activityId: null, lastChange: Date.now(),
      nextDecision: Date.now() + 2000 + Math.random() * 5000,
      pendingDrawOffer: null, pendingDrawResponse: null,
      watchingLobbyId: null, pendingLobbyId: null
    });
  }
  return BOT_BEHAVIOR.get(botName);
}
function botCloseOwnWaitingLobby(botName) {
  let closed = false;
  for (const [id, l] of lobbies.entries()) {
    if (!l.finished && !l.started && l.host === botName && l.isBot) { lobbies.delete(id); closed = true; }
  }
  if (closed) { broadcastLobbies(); broadcastLiveGames(); }
  return closed;
}
function botLeaveArena(botName, arenaId) {
  const state = arenas.get(arenaId);
  if (!state) return;
  const p = state.participants.get(botName);
  if (p && !p.isPlaying) {
    state.participants.delete(botName);
    const sysMsg = { id: 'sys' + Date.now(), system: true, text: `${botName} покинул арену`, ts: Date.now(), arenaId };
    state.chat.push(sysMsg); if (state.chat.length > 300) state.chat.shift();
    io.to('arena:' + arenaId).emit('arenaChatMessage', sysMsg);
    io.emit('arenaUpdate', { arenaId });
  }
}
function botJoinArena(botName, arenaId) {
  const state = arenas.get(arenaId);
  if (!state || state.finished || state.phase === 'finished') return false;
  if (state.participants.has(botName)) return false;
  const botUser = db.users[botName];
  state.participants.set(botName, {
    username: botName,
    rating: botUser ? botUser.rating : 1200,
    score: 0, wins: 0, draws: 0, losses: 0, winStreak: 0, drawStreak: 0,
    socketId: 'BOT:' + botName,
    lobbyId: null, isPlaying: false, paused: false,
    waitingSince: Date.now(), isBot: true
  });
  const sysMsg = { id: 'sys' + Date.now(), system: true, text: `${botName} присоединился к арене`, ts: Date.now(), arenaId };
  state.chat.push(sysMsg); if (state.chat.length > 300) state.chat.shift();
  io.to('arena:' + arenaId).emit('arenaChatMessage', sysMsg);
  io.emit('arenaUpdate', { arenaId });
  return true;
}

function botBehaviorTick() {
  const now = Date.now();
  for (const bot of BOTS) {
    if (bot.name === WATCHER_NAME) continue;
    const beh = botInitBehavior(bot.name);
    if (now < beh.nextDecision) continue;
    beh.nextDecision = now + 3000 + Math.random() * 6000;

    if (beh.pendingDrawResponse) {
      const { lobbyId, accept, botName } = beh.pendingDrawResponse;
      beh.pendingDrawResponse = null;
      const l = lobbies.get(lobbyId);
      if (l && !l.finished && l.drawOffer) {
        l.drawOffer = null;
        if (accept) finishGame(lobbyId, 'draw', 'Ничья по согласию');
        else {
          const otherSocket = l.host === botName ? l.guestSocket : l.hostSocket;
          if (otherSocket) io.to(otherSocket).emit('drawDeclined');
        }
      }
    }

    if (botIsBusy(bot.name)) {
      if (beh.state !== 'playing') { beh.state = 'playing'; beh.lastChange = now; botCloseOwnWaitingLobby(bot.name); }
      continue;
    }
    if (beh.state === 'playing') { beh.state = 'idle'; beh.activityId = null; beh.lastChange = now; }

    if (beh.state === 'in_arena') {
      const state = arenas.get(beh.activityId);
      if (!state || state.finished || state.phase === 'finished') { beh.state = 'idle'; beh.activityId = null; }
      else {
        const p = state.participants.get(bot.name);
        if (p && p.isPlaying) { beh.state = 'playing'; beh.lastChange = now; continue; }
        if (p && Math.random() < 0.03) {
          p.paused = !p.paused;
          if (!p.paused) p.waitingSince = Date.now();
          io.emit('arenaUpdate', { arenaId: beh.activityId });
        }
        if (Math.random() < 0.04) {
          botLeaveArena(bot.name, beh.activityId);
          beh.state = 'idle'; beh.activityId = null; beh.lastChange = now;
        }
      }
      continue;
    }
    if (beh.state === 'in_lobby') {
      const l = lobbies.get(beh.activityId);
      if (!l || l.finished || l.started) { beh.state = 'idle'; beh.activityId = null; }
      else if (now - beh.lastChange > 40000 && Math.random() < 0.25) {
        botCloseOwnWaitingLobby(bot.name);
        beh.state = 'idle'; beh.activityId = null; beh.lastChange = now;
      }
      continue;
    }

    const r = Math.random();
    if (r < 0.7) {
      const candidates = [...arenas.values()].filter(s =>
        !s.finished && s.botFriendly && (s.phase === 'live' || s.phase === 'waiting') && !s.participants.has(bot.name)
      );
      if (candidates.length) {
        candidates.sort((a, b) => {
          const aLive = a.phase === 'live' ? 0 : 1, bLive = b.phase === 'live' ? 0 : 1;
          if (aLive !== bLive) return aLive - bLive;
          return a.startsAt - b.startsAt;
        });
        const chosen = candidates[0];
        if (botJoinArena(bot.name, chosen.id)) {
          beh.state = 'in_arena'; beh.activityId = chosen.id; beh.lastChange = now; continue;
        }
      }
    }
  }
}
setInterval(botBehaviorTick, 5000);
setTimeout(botBehaviorTick, 3000);

// ============================================================
//  WATCHER TICK
// ============================================================
function watcherTick() {
  const now = Date.now();
  const beh = botInitBehavior(WATCHER_NAME);

  if (beh.state === 'playing' || watcherHasActiveLobby()) return;
  if (watcherInAnyArena()) return;

  if (Math.random() < 0.4 || !beh.watchingLobbyId) {
    const liveGames = [];
    for (const [id, l] of lobbies.entries()) {
      if (l.finished || !l.started) continue;
      if (l.host === WATCHER_NAME || l.guest === WATCHER_NAME) continue;
      liveGames.push(id);
    }
    if (liveGames.length > 0) {
      beh.watchingLobbyId = liveGames[Math.floor(Math.random() * liveGames.length)];
    } else {
      beh.watchingLobbyId = null;
    }
  }

  if (beh.state !== 'in_arena' && Math.random() < 0.4) {
    const candidates = [...arenas.values()].filter(s =>
      !s.finished && s.botFriendly && (s.phase === 'live' || s.phase === 'waiting')
      && !s.participants.has(WATCHER_NAME)
    );
    if (candidates.length) {
      candidates.sort((a, b) => {
        const aLive = a.phase === 'live' ? 0 : 1, bLive = b.phase === 'live' ? 0 : 1;
        if (aLive !== bLive) return aLive - bLive;
        return a.startsAt - b.startsAt;
      });
      const chosen = candidates[0];
      const wu = db.users[WATCHER_NAME];
      chosen.participants.set(WATCHER_NAME, {
        username: WATCHER_NAME,
        rating: wu ? wu.rating : 1500,
        score: 0, wins: 0, draws: 0, losses: 0, winStreak: 0, drawStreak: 0,
        socketId: 'BOT:' + WATCHER_NAME,
        lobbyId: null, isPlaying: false, paused: false,
        waitingSince: Date.now(), isBot: true
      });
      beh.state = 'in_arena'; beh.activityId = chosen.id; beh.lastChange = now;
      const sysMsg = { id: 'sys' + Date.now(), system: true, text: `${WATCHER_NAME} присоединился к арене`, ts: Date.now(), arenaId: chosen.id };
      chosen.chat.push(sysMsg); if (chosen.chat.length > 300) chosen.chat.shift();
      io.to('arena:' + chosen.id).emit('arenaChatMessage', sysMsg);
      io.emit('arenaUpdate', { arenaId: chosen.id });
      console.log(`[Watcher] Вошёл в арену ${chosen.name}`);
      return;
    }
  }

  // Создание вызова в зале ожидания.
  if (beh.state === 'idle' && Math.random() < 0.35) {
    let hasOwnLobby = false;
    for (const [id, l] of lobbies.entries()) {
      if (!l.finished && !l.started && l.host === WATCHER_NAME) { hasOwnLobby = true; break; }
    }
    if (!hasOwnLobby) {
      const times = [{t:1,i:0},{t:3,i:0},{t:3,i:2},{t:5,i:0},{t:10,i:0}];
      const pick = times[Math.floor(Math.random() * times.length)];
      const id = genId();
      const lobby = {
        id, host: WATCHER_NAME, hostSocket: 'BOT:' + WATCHER_NAME,
        guest: null, guestSocket: null,
        hostColor: null, guestColor: null,
        time: pick.t, inc: pick.i,
        timeW: pick.t * 60, timeB: pick.t * 60,
        turn: 'w', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        started: false, finished: false, lastTick: Date.now(),
        chat: [], drawOffer: null, createdAt: Date.now(),
        rematch: null, isBot: true, isWatcher: true,
        botName: WATCHER_NAME, botColor: null,
        history: [], positionCounts: new Map()
      };
      lobbies.set(id, lobby);
      registerPosition(lobby);
      beh.state = 'in_lobby'; beh.activityId = id; beh.lastChange = now;
      broadcastLobbies();
      broadcastLiveGames();
      console.log(`[Watcher] Создал вызов ${pick.t}+${pick.i}`);
    }
  }
}
setInterval(watcherTick, 15000);
setTimeout(watcherTick, 5000);

function tryPair(state) {
  if (state.finished || state.phase !== 'live') return;
  const hasViewers = state.chatViewers.size > 0;
  const hasHumans = [...state.participants.values()].some(p => !p.isBot);
  // Без зрителей и людей — играем реже, но играем (чтобы всегда были партии для просмотра).
  if (!hasHumans && !hasViewers) {
    if (Math.random() > 0.5) return;
  }
  const currentActive = state.activeLobbies.size;
  if (currentActive >= 6) return;

  const available = [];
  for (const [username, p] of state.participants.entries()) {
    if (!isAvailableForPairing(p, state.id)) continue;
    if (!p.waitingSince) p.waitingSince = Date.now();
    available.push(p);
  }
  if (available.length < 2) { state.pairingNow = available.length === 1 ? available[0].username : null; return; }
  state.pairingNow = null;
  available.sort((a, b) => a.waitingSince - b.waitingSince);
  const used = new Set();
  let pairsCreated = 0;
  const hasWatcher = available.some(p => p.username === WATCHER_NAME);
  const MAX_PAIRS_PER_TICK = hasWatcher ? 1 : 2;

  let watcherPairsThisTick = 0;

  for (let i = 0; i < available.length && pairsCreated < MAX_PAIRS_PER_TICK; i++) {
    const a = available[i];
    if (used.has(a.username)) continue;
    let best = null, bestDiff = Infinity;
    for (let j = 0; j < available.length; j++) {
      if (i === j) continue;
      const b = available[j];
      if (used.has(b.username)) continue;
      if (a.username === b.username) continue;
      if (a.username === WATCHER_NAME && b.username === WATCHER_NAME) continue;

      const aWatcher = a.username === WATCHER_NAME;
      const bWatcher = b.username === WATCHER_NAME;

      if (aWatcher || bWatcher) {
        if (watcherPairsThisTick >= 1) continue;
        if (watcherHasActiveLobby()) continue;
        if (watcherGamesInArena(state.id) >= MAX_WATCHER_ACTIVE_LOBBIES) continue;
      }

      if (a.isBot && b.isBot) {
        if (botGamesInArena(state.id) >= MAX_BOT_GAMES_PER_ARENA) continue;
        // Без зрителей — играем реже.
        if (state.chatViewers.size === 0 && Math.random() > 0.5) continue;
      }
      const diff = Math.abs((a.score || 0) - (b.score || 0));
      if (diff < bestDiff) { bestDiff = diff; best = b; }
    }
    if (!best) continue;
    createArenaPairing(state, a, best);
    used.add(a.username); used.add(best.username);
    a.waitingSince = null; best.waitingSince = null;
    pairsCreated++;
    if (a.username === WATCHER_NAME || best.username === WATCHER_NAME) watcherPairsThisTick++;
  }
}

function createArenaPairing(state, a, b) {
  if (a.username === WATCHER_NAME && b.username === WATCHER_NAME) return;
  const lobbyId = genId();
  const hostIsWhite = Math.random() < 0.5;
  const hostColor = hostIsWhite ? 'w' : 'b';
  const guestColor = hostIsWhite ? 'b' : 'w';
  const time = state.timeControl;
  const inc = state.increment;
  const aIsBot = !!a.isBot;
  const bIsBot = !!b.isBot;
  const isBotGame = aIsBot || bIsBot;

  lobbies.set(lobbyId, {
    id: lobbyId, host: a.username, hostSocket: a.socketId, guest: b.username, guestSocket: b.socketId,
    hostColor, guestColor, time, inc, timeW: time * 60, timeB: time * 60, turn: 'w',
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    started: true, finished: false, lastTick: Date.now(), chat: [], drawOffer: null,
    createdAt: Date.now(), arenaId: state.id, arenaName: state.name, rematch: null,
    isBot: isBotGame,
    botColor: aIsBot ? hostColor : (bIsBot ? guestColor : null),
    botName: aIsBot ? a.username : (bIsBot ? b.username : null),
    botColor2: bIsBot && aIsBot ? guestColor : null,
    botName2: bIsBot && aIsBot ? b.username : null,
    history: [], positionCounts: new Map()
  });
  registerPosition(lobbies.get(lobbyId));

  state.activeLobbies.add(lobbyId);
  a.isPlaying = true; a.lobbyId = lobbyId;
  b.isPlaying = true; b.lobbyId = lobbyId;

  if (aIsBot) { const bh = botInitBehavior(a.username); bh.state = 'playing'; bh.lastChange = Date.now(); }
  if (bIsBot) { const bh = botInitBehavior(b.username); bh.state = 'playing'; bh.lastChange = Date.now(); }

  const aSocket = a.isBot ? null : io.sockets.sockets.get(a.socketId);
  const bSocket = b.isBot ? null : io.sockets.sockets.get(b.socketId);
  const aUser = db.users[a.username];
  const bUser = db.users[b.username];
  if (aSocket) {
    aSocket.join(lobbyId);
    aSocket.emit('gameStart', { color: hostColor, opponent: b.username, opponentRating: bUser ? bUser.rating : null, opponentIsAdmin: isAdmin(b.username), opponentIsMod: isMod(b.username), opponentIsBot: !!b.isBot && b.username !== WATCHER_NAME, opponentOnline: true, time, inc, lobbyId, fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', chat: [], arenaId: state.id, arenaName: state.name, isBot: isBotGame });
  }
  if (bSocket) {
    bSocket.join(lobbyId);
    bSocket.emit('gameStart', { color: guestColor, opponent: a.username, opponentRating: aUser ? aUser.rating : null, opponentIsAdmin: isAdmin(a.username), opponentIsMod: isMod(a.username), opponentIsBot: !!a.isBot && a.username !== WATCHER_NAME, opponentOnline: true, time, inc, lobbyId, fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', chat: [], arenaId: state.id, arenaName: state.name, isBot: isBotGame });
  }
  io.to('arena:' + state.id).emit('arenaUpdate', { arenaId: state.id });
  broadcastOnline();
  broadcastLiveGames();

  if (isBotGame && lobbyId) setTimeout(() => scheduleBotMove(lobbyId), 500 + Math.random() * 500);
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
  const wU = db.users[whiteName]; const bU = db.users[blackName]; const l = lobbies.get(lobbyId);
  state.finishedGames.push({
    white: whiteName, black: blackName, whiteRating: wU ? wU.rating : null, blackRating: bU ? bU.rating : null,
    whiteIsAdmin: isAdmin(whiteName), blackIsAdmin: isAdmin(blackName), whiteIsMod: isMod(whiteName), blackIsMod: isMod(blackName),
    result, fen: l ? l.fen : 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    turn: l ? l.turn : 'w', finishedAt: Date.now()
  });
  if (state.finishedGames.length > 200) state.finishedGames.shift();
  const whiteP = state.participants.get(whiteName);
  const blackP = state.participants.get(blackName);
  if (state.finished || !whiteP || !blackP) {
    if (whiteP) { whiteP.isPlaying = false; whiteP.lobbyId = null; }
    if (blackP) { blackP.isPlaying = false; blackP.lobbyId = null; }
    io.to('arena:' + arenaId).emit('arenaUpdate', { arenaId });
    broadcastLiveGames();
    return;
  }
  if (result === 'w') { whiteP.score += calcArenaPoints(whiteP, 'win'); whiteP.wins++; blackP.losses++; calcArenaPoints(blackP, 'loss'); }
  else if (result === 'b') { blackP.score += calcArenaPoints(blackP, 'win'); blackP.wins++; whiteP.losses++; calcArenaPoints(whiteP, 'loss'); }
  else { whiteP.score += calcArenaPoints(whiteP, 'draw'); blackP.score += calcArenaPoints(blackP, 'draw'); whiteP.draws++; blackP.draws++; }
  whiteP.isPlaying = false; blackP.isPlaying = false;
  whiteP.lobbyId = null; blackP.lobbyId = null;
  whiteP.awaitingNextPair = !whiteP.isBot;
  blackP.awaitingNextPair = !blackP.isBot;
  if (!whiteP.paused && !whiteP.awaitingNextPair) whiteP.waitingSince = Date.now();
  if (!blackP.paused && !blackP.awaitingNextPair) blackP.waitingSince = Date.now();
  if (whiteP.isBot && whiteName !== WATCHER_NAME) { const bh = botInitBehavior(whiteName); bh.state = 'in_arena'; bh.activityId = arenaId; bh.lastChange = Date.now(); }
  else if (whiteName === WATCHER_NAME) { const bh = botInitBehavior(WATCHER_NAME); bh.state = 'in_arena'; bh.activityId = arenaId; bh.lastChange = Date.now(); }
  if (blackP.isBot && blackName !== WATCHER_NAME) { const bh = botInitBehavior(blackName); bh.state = 'in_arena'; bh.activityId = arenaId; bh.lastChange = Date.now(); }
  else if (blackName === WATCHER_NAME) { const bh = botInitBehavior(WATCHER_NAME); bh.state = 'in_arena'; bh.activityId = arenaId; bh.lastChange = Date.now(); }
  setTimeout(() => tryPair(state), 300);
  io.to('arena:' + arenaId).emit('arenaUpdate', { arenaId });
  broadcastLiveGames();
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
    if (p.isBot) {
      const bh = botInitBehavior(name);
      if (bh.state === 'in_arena' && bh.activityId === state.id) {
        bh.state = 'idle'; bh.activityId = null; bh.lastChange = Date.now();
      }
      state.participants.delete(name);
    }
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
    if (!lobby.isBot) {
      if (!lobby._lastTimeEmit || now - lobby._lastTimeEmit > 2000) {
        lobby._lastTimeEmit = now;
        emitToGameAndWatchers(id, 'timeUpdate', { timeW: lobby.timeW, timeB: lobby.timeB, serverNow: now });
      }
    }
    if (lobby.timeW <= 0) finishGame(id, 'b', 'Время');
    else if (lobby.timeB <= 0) finishGame(id, 'w', 'Время');
  }
}, 1000);

// ======================= МОДЕРАЦИЯ =======================
function checkMute(username) {
  const u = db.users[username]; if (!u) return 0;
  const until = u.mutedUntil || 0;
  if (until <= Date.now()) return 0;
  return until;
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

// ============================================================
//  ЛЁГКИЙ ШАХМАТНЫЙ ДВИЖОК (для проверки правил)
// ============================================================
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
  let score = 0;
  let whiteBishops = 0, blackBishops = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p) continue;
    const white = botIsWhite(p); const t = p.toLowerCase();
    let v = PIECE_VALUES[t] || 0;
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
function evaluateCurrentPosition(fen) {
  const state = botParseFen(fen);
  return botEval(state);
}

// ============================================================
//  ХОД БОТА
// ============================================================
function scheduleBotMove(lobbyId) {
  const l = lobbies.get(lobbyId);
  if (!l || l.finished || !l.isBot) return;
  const currentTurn = l.turn;
  const botColor = (l.botColor === currentTurn) ? l.botColor : (l.botColor2 === currentTurn ? l.botColor2 : null);
  const botName = (botColor === l.botColor) ? l.botName : (botColor === l.botColor2 ? l.botName2 : null);
  if (!botColor || !botName) return;

  const botTimeLeft = botColor === 'w' ? l.timeW : l.timeB;
  const baseTime = l.time * 60;
  const state = botParseFen(l.fen);
  const botIsWhiteTurn = botColor === 'w';
  const botMoves = botAllLegalMoves(state, botIsWhiteTurn);
  const isBotVsBot = !!l.botName2;

  if (botMoves.length === 0) {
    if (botInCheck(state, botIsWhiteTurn)) finishGame(lobbyId, botIsWhiteTurn ? 'b' : 'w', 'Мат');
    else finishGame(lobbyId, 'draw', 'Пат');
    return;
  }

  if (botMoves.length === 1) {
    const delay = 150 + Math.random() * 200;
    setTimeout(() => {
      const cur = lobbies.get(lobbyId);
      if (!cur || cur.finished) return;
      if (cur.turn !== botColor) return;
      const stillBot = (cur.botColor === botColor && cur.botName === botName) ||
                       (cur.botColor2 === botColor && cur.botName2 === botName);
      if (!stillBot) return;
      const st = botParseFen(cur.fen);
      const mv = botMoves[0];
      const from = Array.isArray(mv.from) ? mv.from : mv[0];
      const to = Array.isArray(mv.to) ? mv.to : mv[1];
      if (!from || !to) return;
      const captured = st.board[to[0]][to[1]];
      const prevFen = cur.fen;
      const nextState = botApplyMove(st, from, to);
      if (!cur.history) cur.history = [];
      cur.history.push({ from, to, captured: captured || null, byColor: botColor, ts: Date.now() });
      if (cur.history.length > 10) cur.history.shift();

      if (botName === WATCHER_NAME) {
        try {
          if (!watcherLearning.getStats().episodeActive) {
            watcherLearning.startEpisode(botColor, { time: cur.time, inc: cur.inc });
          }
          watcherLearning.recordTransition(prevFen, botToFen(nextState), from, to, botColor, { time: cur.time, inc: cur.inc }, captured || null);
        } catch (e) { console.error('[Watcher] Ошибка обучения:', e.message); }
      }

      const now = Date.now();
      const elapsed = Math.floor((now - cur.lastTick) / 1000);
      if (botColor === 'w') cur.timeW = Math.max(0, cur.timeW - elapsed) + cur.inc;
      else cur.timeB = Math.max(0, cur.timeB - elapsed) + cur.inc;
      cur.lastTick = now;
      cur.fen = botToFen(nextState);
      cur.turn = nextState.turn;
      cur.drawOffer = null;

      registerPosition(cur);

      emitToGameAndWatchers(lobbyId, 'boardUpdate', { fen: cur.fen, turn: cur.turn, san: null, from, to });
      emitToGameAndWatchers(lobbyId, 'timeUpdate', { timeW: cur.timeW, timeB: cur.timeB, serverNow: now });
      broadcastLiveGames();

      if (checkAutoDraw(lobbyId)) return;

      const sideToMoveWhite = cur.turn === 'w';
      const hasMoves = botAllLegalMoves(botParseFen(cur.fen), sideToMoveWhite).length > 0;
      if (!hasMoves) {
        if (botInCheck(botParseFen(cur.fen), sideToMoveWhite)) finishGame(lobbyId, sideToMoveWhite ? 'b' : 'w', 'Мат');
        else finishGame(lobbyId, 'draw', 'Пат');
      } else if (cur.isBot && ((cur.botColor && cur.turn === cur.botColor) || (cur.botColor2 && cur.turn === cur.botColor2))) {
        const nextDelay = isBotVsBot ? (400 + Math.random() * 600) : (250 + Math.random() * 400);
        setTimeout(() => scheduleBotMove(lobbyId), nextDelay);
      }
    }, delay);
    return;
  }

  let baseDelay;
  if (botName === WATCHER_NAME) {
    baseDelay = 800 + Math.random() * 1200;
  } else {
    if (baseTime <= 60)       baseDelay = 60;
    else if (baseTime <= 120) baseDelay = 100;
    else if (baseTime <= 300) baseDelay = 200;
    else if (baseTime <= 600) baseDelay = 350;
    else if (baseTime <= 900) baseDelay = 500;
    else                      baseDelay = 800;
    if (isBotVsBot) baseDelay = Math.max(baseDelay, 250);
  }

  let complexity = 1.0;
  if (botMoves.length <= 2)       complexity *= 0.4;
  else if (botMoves.length <= 5)  complexity *= 0.7;
  else if (botMoves.length >= 25) complexity *= 1.4;
  else if (botMoves.length >= 15) complexity *= 1.2;
  if (botInCheck(state, botIsWhiteTurn)) complexity *= 1.5;

  let hasCapture = false;
  for (const [from, to] of botMoves) if (state.board[to[0]][to[1]]) { hasCapture = true; break; }
  if (hasCapture) complexity *= 1.1;

  let reactionMultiplier = 1.0;
  if (l.history && l.history.length > 0) {
    const lastMove = l.history[l.history.length - 1];
    if (lastMove && lastMove.captured && lastMove.byColor !== botColor) {
      const val = PIECE_VALUES[lastMove.captured.toLowerCase()] || 0;
      if (val >= 900)      reactionMultiplier = 2.0;
      else if (val >= 500) reactionMultiplier = 1.7;
      else if (val >= 300) reactionMultiplier = 1.3;
      else                 reactionMultiplier = 1.1;
    } else if (lastMove && lastMove.captured && lastMove.byColor === botColor) {
      reactionMultiplier = 0.8;
    }
  }
  if (botTimeLeft < 10) { baseDelay = 30; complexity = 1.0; reactionMultiplier = 1.0; }
  else if (botTimeLeft < 30) { baseDelay = Math.min(baseDelay, 80); complexity = Math.min(complexity, 1.2); reactionMultiplier = Math.min(reactionMultiplier, 1.3); }

  let delay = baseDelay * complexity * reactionMultiplier;
  const maxThinkMs = Math.max(80, Math.floor(botTimeLeft * 120));
  if (delay > maxThinkMs) delay = maxThinkMs;
  if (delay < 20) delay = 20;

  const botUser = db.users[botName];
  const botRating = botUser ? botUser.rating : 1500;

  setTimeout(async () => {
    const cur = lobbies.get(lobbyId);
    if (!cur || cur.finished) return;
    if (cur.turn !== botColor) return;
    const stillBot = (cur.botColor === botColor && cur.botName === botName) ||
                     (cur.botColor2 === botColor && cur.botName2 === botName);
    if (!stillBot) return;

    const st = botParseFen(cur.fen);
    const evalScore = evaluateCurrentPosition(cur.fen);
    const botSign = botColor === 'w' ? 1 : -1;
    const myEval = evalScore * botSign;

    let resignThreshold;
    if (botName === WATCHER_NAME) resignThreshold = -3000;
    else if (botRating < 1100)      resignThreshold = -2500;
    else if (botRating < 1350)      resignThreshold = -3000;
    else if (botRating < 1600)      resignThreshold = -3500;
    else if (botRating < 1850)      resignThreshold = -4000;
    else if (botRating < 2000)      resignThreshold = -4500;
    else                            resignThreshold = -5000;

    const minMovesBeforeResign = botName === WATCHER_NAME ? 40 : (botRating < 1500 ? 30 : 40);
    const myMaterial = botEvalMaterial(st, botColor === 'w');
    const oppMaterial = botEvalMaterial(st, botColor !== 'w');
    const materialDiff = myMaterial - oppMaterial;

    const myQueen = (() => {
      const q = botColor === 'w' ? 'Q' : 'q';
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (st.board[r][c] === q) return true;
      return false;
    })();
    const oppQueen = (() => {
      const q = botColor === 'w' ? 'q' : 'Q';
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (st.board[r][c] === q) return true;
      return false;
    })();

    if (
      myEval < resignThreshold &&
      st.full > minMovesBeforeResign &&
      materialDiff < -900 &&
      !myQueen &&
      oppQueen
    ) {
      const myMoves = botAllLegalMoves(st, botColor === 'w');
      let hasMateIn1 = false;
      let hasAnyCounterplay = false;
      for (const [from, to] of myMoves) {
        const next = botApplyMove(st, from, to);
        const oppWhite = next.turn === 'w';
        if (botInCheck(next, oppWhite) && botAllLegalMoves(next, oppWhite).length === 0) { hasMateIn1 = true; break; }
        const target = st.board[to[0]][to[1]];
        if (target && target.toLowerCase() === 'q') { hasAnyCounterplay = true; break; }
        if (!botInCheck(next, oppWhite) && botAllLegalMoves(next, oppWhite).length === 0) { hasAnyCounterplay = true; break; }
        if (botInCheck(next, oppWhite)) {
          const afterOpp = botAllLegalMoves(next, oppWhite);
          for (const [of, ot] of afterOpp) {
            const after2 = botApplyMove(next, of, ot);
            if (botInCheck(after2, botColor === 'w')) { hasAnyCounterplay = true; break; }
          }
          if (hasAnyCounterplay) break;
        }
      }
      if (!hasMateIn1 && !hasAnyCounterplay && Math.random() < 0.4) {
        const winner = botColor === 'w' ? 'b' : 'w';
        finishGame(lobbyId, winner, 'Сдача');
        return;
      }
    }

    if (
      Math.abs(myEval) < 15 &&
      st.full > 60 &&
      !cur.drawOffer &&
      !cur.botDrawOffered &&
      Math.abs(materialDiff) < 100
    ) {
      const myMoves = botAllLegalMoves(st, botColor === 'w');
      let hasMateIn1 = false;
      for (const [from, to] of myMoves) {
        const next = botApplyMove(st, from, to);
        const oppWhite = next.turn === 'w';
        if (botInCheck(next, oppWhite) && botAllLegalMoves(next, oppWhite).length === 0) { hasMateIn1 = true; break; }
      }
      if (!hasMateIn1 && Math.random() < 0.03) {
        cur.drawOffer = { by: botColor, at: Date.now(), fromBot: true };
        cur.botDrawOffered = true;
        const otherSocket = cur.host === botName ? cur.guestSocket : cur.hostSocket;
        if (otherSocket) io.to(otherSocket).emit('drawOffered', { from: botName });
        const otherName = cur.host === botName ? cur.guest : cur.host;
        if (ALL_BOT_NAMES.has(otherName)) {
          const otherBeh = botInitBehavior(otherName);
          const otherRating = db.users[otherName] ? db.users[otherName].rating : 1500;
          let acceptChance = 0.3;
          if (Math.abs(myEval) < 10) acceptChance = 0.5;
          else if (Math.abs(myEval) < 30) acceptChance = 0.2;
          else acceptChance = 0.05;
          if (otherRating >= 1900) acceptChance *= 0.5;
          otherBeh.pendingDrawResponse = { lobbyId, accept: Math.random() < acceptChance, botName: otherName };
        }
      }
    }

    let mv;
    if (botName === WATCHER_NAME) {
      const botIsWhiteMove = botColor === 'w';
      const curState = botParseFen(cur.fen);
      const availableMoves = botAllLegalMoves(curState, botIsWhiteMove);
      const line = (cur.history || []).slice(-12).map(h => {
        if (!h.from || !h.to) return '';
        return String.fromCharCode(97 + h.from[1]) + (8 - h.from[0]) + String.fromCharCode(97 + h.to[1]) + (8 - h.to[0]);
      }).join('');
      try {
        mv = watcherLearning.pickMove(cur.fen, botColor, { time: cur.time, inc: cur.inc }, availableMoves, line);
      } catch (e) {
        console.error('[Watcher] pickMove ошибка:', e.message);
        mv = null;
      }
    } else {
      try { mv = await botPool.getMove(cur.fen, botRating, cur.time); }
      catch (err) { console.error('[bot-pool] ошибка получения хода:', err.message); return; }
    }
    if (!mv) return;

    const from = Array.isArray(mv.from) ? mv.from : (Array.isArray(mv[0]) ? mv[0] : null);
    const to = Array.isArray(mv.to) ? mv.to : (Array.isArray(mv[1]) ? mv[1] : null);
    if (!from || !to || from.length !== 2 || to.length !== 2) {
      console.error('[Bot] Некорректный ход:', botName, JSON.stringify(mv));
      return;
    }

    const cur2 = lobbies.get(lobbyId);
    if (!cur2 || cur2.finished) return;
    if (cur2.turn !== botColor) return;
    const stillBot2 = (cur2.botColor === botColor && cur2.botName === botName) ||
                      (cur2.botColor2 === botColor && cur2.botName2 === botName);
    if (!stillBot2) return;
    if (cur2.fen !== cur.fen) return;

    const st2 = botParseFen(cur2.fen);
    const legal = botLegalMovesFor(st2, from[0], from[1]);
    if (!legal.some(([r, c]) => r === to[0] && c === to[1])) return;

    const captured = st2.board[to[0]][to[1]];
    const prevFen = cur2.fen;
    const nextState = botApplyMove(st2, from, to);
    if (!cur2.history) cur2.history = [];
    cur2.history.push({ from, to, captured: captured || null, byColor: botColor, ts: Date.now() });
    if (cur2.history.length > 10) cur2.history.shift();

    if (botName === WATCHER_NAME) {
      try {
        if (!watcherLearning.getStats().episodeActive) {
          watcherLearning.startEpisode(botColor, { time: cur2.time, inc: cur2.inc });
        }
        watcherLearning.recordTransition(prevFen, botToFen(nextState), from, to, botColor, { time: cur2.time, inc: cur2.inc }, captured || null);
      } catch (e) { console.error('[Watcher] Ошибка обучения:', e.message); }
    }

    const now = Date.now();
    const elapsed = Math.floor((now - cur2.lastTick) / 1000);
    if (botColor === 'w') cur2.timeW = Math.max(0, cur2.timeW - elapsed) + cur2.inc;
    else cur2.timeB = Math.max(0, cur2.timeB - elapsed) + cur2.inc;
    cur2.lastTick = now;
    cur2.fen = botToFen(nextState);
    cur2.turn = nextState.turn;
    cur2.drawOffer = null;
    cur2.botDrawOffered = false;

    registerPosition(cur2);

    emitToGameAndWatchers(lobbyId, 'boardUpdate', { fen: cur2.fen, turn: cur2.turn, san: null, from, to });
    emitToGameAndWatchers(lobbyId, 'timeUpdate', { timeW: cur2.timeW, timeB: cur2.timeB, serverNow: now });
    broadcastLiveGames();

    if (checkAutoDraw(lobbyId)) return;

    const sideToMoveWhite = cur2.turn === 'w';
    const hasMoves = botAllLegalMoves(botParseFen(cur2.fen), sideToMoveWhite).length > 0;
    if (!hasMoves) {
      if (botInCheck(botParseFen(cur2.fen), sideToMoveWhite)) finishGame(lobbyId, sideToMoveWhite ? 'b' : 'w', 'Мат');
      else finishGame(lobbyId, 'draw', 'Пат');
    } else if (cur2.isBot && ((cur2.botColor && cur2.turn === cur2.botColor) || (cur2.botColor2 && cur2.turn === cur2.botColor2))) {
      const nextDelay = isBotVsBot ? (400 + Math.random() * 600) : (250 + Math.random() * 400);
      setTimeout(() => scheduleBotMove(lobbyId), nextDelay);
    }
  }, delay);
}

// ============================================================
//  SOCKET.IO
// ============================================================
io.on('connection', (socket) => {
  socket.emit('stats', { online: countOnline(), games: db.totalGames, activeGames: countActiveLobbies() });
  // Мгновенно отправляем текущий список партий новому клиенту.
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
      const salt = newSalt();
      const passwordHash = hashPassword(password, salt);
      const base = 1200;
      db.users[username] = {
        passwordHash, salt, rating: base,
        rd: GLICKO2.DEFAULT_RD, vol: GLICKO2.DEFAULT_VOL,
        wins: 0, losses: 0, draws: 0, games: 0,
        createdAt: Date.now(), mutedUntil: 0, isBot: false,
        categories: {
          classical: emptyRatingBlock(base), rapid: emptyRatingBlock(base),
          blitz: emptyRatingBlock(base), bullet: emptyRatingBlock(base)
        }
      };
      try { await saveUser(username); }
      catch (err) { console.error('[DB] Ошибка сохранения пользователя:', err.message || err.code || err); }
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
        finishedAt: Number(r.finished_at), category: r.category || 'blitz',
        isBot: !!r.is_bot
      }));
      const historyRes = await pool.query(`SELECT white, black, white_after, black_after, finished_at FROM games WHERE white = $1 OR black = $1 ORDER BY finished_at ASC`, [username]);
      const history = [{ ts: u.createdAt, rating: 1200 }];
      for (const r of historyRes.rows) {
        const isWhite = r.white === username;
        history.push({ ts: Number(r.finished_at), rating: isWhite ? r.white_after : r.black_after });
      }
      const user = publicUser(username);
      user.online = isUserOnline(username) || !!u.isBot;
      cb({ ok: true, user, games, history });
    } catch (err) {
      console.error('[DB] Ошибка загрузки профиля:', err.message || err.code || err);
      cb({ ok: false, msg: 'Ошибка базы данных' });
    }
  });

  socket.on('getStats', (cb) => { if (typeof cb === 'function') cb({ online: countOnline(), games: db.totalGames, activeGames: countActiveLobbies() }); });
  socket.on('getCommunityOnline', (cb) => { if (typeof cb === 'function') cb(onlinePlayersList()); });
  socket.on('getPlayerCard', ({ username }, cb) => {
    if (typeof cb !== 'function') return;
    const user = publicUser(username);
    if (!user) return cb({ ok: false });
    user.online = isUserOnline(username) || !!user.isBot || username === WATCHER_NAME;
    if (username === WATCHER_NAME) user.isBot = true;
    cb({ ok: true, user });
  });
  socket.on('getTopArenas', (cb) => { if (typeof cb === 'function') cb(getTopLiveArenas()); });
  socket.on('getLiveGames', (cb) => { if (typeof cb === 'function') cb(buildGamesList()); });

  socket.on('getBots', (cb) => {
    if (typeof cb !== 'function') return;
    cb(BOTS.filter(b => !b.hidden).map(b => {
      const u = db.users[b.name];
      return { name: b.name, title: b.title, desc: b.desc, level: b.level, rating: u ? u.rating : b.rating, games: u ? u.games : 0, wins: u ? u.wins : 0, losses: u ? u.losses : 0, draws: u ? u.draws : 0, initialRating: b.rating, rd: u ? Math.round(u.rd) : 350 };
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
    const opponentName = socket.username === l.host ? l.guest : l.host;
    const opponentU = db.users[opponentName];
    cb({
      ok: true,
      state: {
        myColor, opponent: opponentName,
        opponentRating: opponentU ? opponentU.rating : null,
        opponentIsAdmin: isAdmin(opponentName), opponentIsMod: isMod(opponentName),
        opponentOnline: isUserOnline(opponentName) || ALL_BOT_NAMES.has(opponentName),
        time: l.time, inc: l.inc, timeW: l.timeW, timeB: l.timeB, turn: l.turn,
        fen: l.fen, chat: l.chat, arenaId: l.arenaId, arenaName: l.arenaName,
        finished: l.finished, isBot: !!l.isBot && l.host !== WATCHER_NAME && l.guest !== WATCHER_NAME,
        watchersCount: watchersCountOf(l)
      }
    });
  });

  socket.on('watchGame', ({ id }, cb) => {
    const l = lobbies.get(id);
    if (!l || l.finished || !l.started) { if (typeof cb === 'function') cb({ ok: false, msg: 'Партия недоступна' }); return; }
    socket.join('watch:' + id);
    if (!l.watchers) l.watchers = new Set();
    l.watchers.add(socket.id);
    io.emit('lobbiesUpdate');
    broadcastWatchers(id);
    broadcastLiveGames();
    const whiteName = l.hostColor === 'w' ? l.host : l.guest;
    const blackName = l.hostColor === 'b' ? l.host : l.guest;
    const lastHist = (l.history && l.history.length) ? l.history[l.history.length - 1] : null;
    if (typeof cb === 'function') cb({
      ok: true,
      game: {
        id, white: whiteName, black: blackName,
        whiteRating: db.users[whiteName] ? db.users[whiteName].rating : null,
        blackRating: db.users[blackName] ? db.users[blackName].rating : null,
        whiteIsAdmin: isAdmin(whiteName), blackIsAdmin: isAdmin(blackName),
        whiteIsMod: isMod(whiteName), blackIsMod: isMod(blackName),
        whiteIsBot: !!(db.users[whiteName] && db.users[whiteName].isBot),
        blackIsBot: !!(db.users[blackName] && db.users[blackName].isBot),
        timeW: l.timeW, timeB: l.timeB, turn: l.turn,
        timeControl: l.time, increment: l.inc, fen: l.fen,
        lastMove: lastHist && lastHist.from && lastHist.to ? { from: lastHist.from, to: lastHist.to } : null,
        isArena: !!l.arenaId, arenaName: l.arenaName || null,
        watchersCount: watchersCountOf(l)
      }
    });
  });

  socket.on('unwatchGame', ({ id }) => {
    socket.leave('watch:' + id);
    const l = lobbies.get(id);
    if (l && l.watchers) { l.watchers.delete(socket.id); io.emit('lobbiesUpdate'); broadcastWatchers(id); broadcastLiveGames(); }
  });

  socket.on('getLobbies', (cb) => {
    if (typeof cb !== 'function') return;
    const list = [];
    for (const [id, l] of lobbies.entries()) {
      if (l.finished || l.arenaId) continue;
      // Показываем в зале ожидания всё, кроме скрытых ботов; Watcher показываем.
      if (l.isBot && !l.isWatcher) continue;
      list.push({ id, host: l.host, time: l.time, inc: l.inc, hostIsAdmin: isAdmin(l.host), hostIsMod: isMod(l.host), status: l.guest ? 'playing' : 'waiting', isBot: l.isWatcher });
    }
    cb(list);
  });

  socket.on('createLobby', ({ time, inc }, cb) => {
    if (typeof cb !== 'function') return;
    if (!socket.username) return cb({ ok: false, msg: 'Не авторизован' });
    time = Math.max(0.5, Math.min(60, +time || 5));
    inc  = Math.max(0, Math.min(60, +inc || 0));
    let matched = null;
    for (const [, l] of lobbies.entries()) {
      if (l.finished || l.arenaId || (l.isBot && !l.isWatcher) || l.guest) continue;
      if (l.host === socket.username || l.hostSocket === socket.id) continue;
      if (Number(l.time) !== time || Number(l.inc) !== inc) continue;
      matched = l;
      break;
    }
    if (matched) {
      matched.guest = socket.username;
      matched.guestSocket = socket.id;
      const hostIsWhite = Math.random() < 0.5;
      matched.hostColor = hostIsWhite ? 'w' : 'b';
      matched.guestColor = hostIsWhite ? 'b' : 'w';
      matched.started = true;
      matched.lastTick = Date.now();
      if (!matched.positionCounts) matched.positionCounts = new Map();
      registerPosition(matched);
      if (matched.isWatcher) {
        matched.botColor = matched.hostColor;
        matched.botColor2 = null;
        matched.botName = WATCHER_NAME;
        matched.botName2 = null;
      }
      socket.join(matched.id);
      socketToLobby.set(socket.id, matched.id);
      socket.lobbyId = matched.id;
      const hostRating = db.users[matched.host] ? db.users[matched.host].rating : null;
      const guestRating = db.users[socket.username] ? db.users[socket.username].rating : null;
      const hostIsWatcher = matched.host === WATCHER_NAME;
      io.to(matched.hostSocket).emit('gameStart', { color: matched.hostColor, opponent: matched.guest, opponentRating: guestRating, opponentIsAdmin: isAdmin(matched.guest), opponentIsMod: isMod(matched.guest), opponentOnline: true, time: matched.time, inc: matched.inc, lobbyId: matched.id, fen: matched.fen, chat: matched.chat, isArena: false, isBot: matched.isBot && !hostIsWatcher });
      io.to(matched.guestSocket).emit('gameStart', { color: matched.guestColor, opponent: matched.host, opponentRating: hostRating, opponentIsAdmin: isAdmin(matched.host), opponentIsMod: isMod(matched.host), opponentOnline: true, time: matched.time, inc: matched.inc, lobbyId: matched.id, fen: matched.fen, chat: matched.chat, isArena: false, isBot: matched.isBot && !hostIsWatcher });
      if (matched.isBot) setTimeout(() => scheduleBotMove(matched.id), 800);
      cb({ ok: true, id: matched.id, matched: true });
      broadcastLobbies();
      broadcastOnline();
      broadcastLiveGames();
      return;
    }
    const id = genId();
    const newLobby = {
      id, host: socket.username, hostSocket: socket.id, guest: null, guestSocket: null,
      hostColor: null, guestColor: null, time, inc, timeW: time * 60, timeB: time * 60,
      turn: 'w', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      started: false, finished: false, lastTick: Date.now(), chat: [], drawOffer: null,
      createdAt: Date.now(), rematch: null, isBot: false, history: [], positionCounts: new Map()
    };
    lobbies.set(id, newLobby);
    registerPosition(newLobby);
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
    const bot = BOTS.find(b => b.name === botName && !b.hidden);
    if (!bot) return cb({ ok: false, msg: 'Бот не найден' });
    if (botIsBusy(bot.name)) return cb({ ok: false, msg: 'Бот занят другой партией' });
    const botUser = db.users[bot.name];
    const botRating = botUser ? botUser.rating : bot.rating;
    const id = genId();
    const newLobby = {
      id, host: socket.username, hostSocket: socket.id, guest: bot.name, guestSocket: null,
      hostColor: 'w', guestColor: 'b', time, inc, timeW: time * 60, timeB: time * 60,
      turn: 'w', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      started: true, finished: false, lastTick: Date.now(), chat: [], drawOffer: null,
      createdAt: Date.now(), rematch: null, isBot: true, botName: bot.name, botColor: 'b', history: [], positionCounts: new Map()
    };
    lobbies.set(id, newLobby);
    registerPosition(newLobby);
    socket.join(id);
    socketToLobby.set(socket.id, id);
    socket.lobbyId = id;
    const beh = botInitBehavior(bot.name);
    beh.state = 'playing'; beh.lastChange = Date.now();
    botCloseOwnWaitingLobby(bot.name);
    io.to(socket.id).emit('gameStart', {
      color: 'w', opponent: bot.name, opponentRating: botRating,
      opponentIsAdmin: false, opponentIsMod: false, opponentOnline: true,
      time, inc, lobbyId: id, fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      chat: [], isArena: false, isBot: true, botName: bot.name
    });
    cb({ ok: true, id });
    broadcastLobbies();
    broadcastOnline();
    broadcastLiveGames();
  });

  socket.on('cancelLobby', ({ id }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    if (!socket.username) return cb({ ok: false, msg: 'Не авторизован' });
    const l = lobbies.get(id);
    if (!l) return cb({ ok: false, msg: 'Лобби не найдено' });
    if (l.host !== socket.username) return cb({ ok: false, msg: 'Это не ваше лобби' });
    if (l.started) return cb({ ok: false, msg: 'Партия уже началась' });
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
    if (l.finished) return cb({ ok: false, msg: 'Партия завершена' });
    if (l.guest) return cb({ ok: false, msg: 'Лобби занято' });
    if (l.host === socket.username) return cb({ ok: false, msg: 'Это ваше лобби' });
    if (socket.username === WATCHER_NAME && l.host === WATCHER_NAME) return cb({ ok: false, msg: 'Занято' });
    l.guest = socket.username;
    l.guestSocket = socket.id;
    let hostIsWhite;
    if (l.isWatcher) {
      hostIsWhite = true;
    } else {
      hostIsWhite = Math.random() < 0.5;
    }
    l.hostColor = hostIsWhite ? 'w' : 'b';
    l.guestColor = hostIsWhite ? 'b' : 'w';
    if (l.isWatcher) {
      l.botColor = l.hostColor;
      l.botColor2 = null;
      l.botName = WATCHER_NAME;
      l.botName2 = null;
    }
    l.started = true;
    l.lastTick = Date.now();
    if (!l.positionCounts) l.positionCounts = new Map();
    registerPosition(l);
    socket.join(id);
    socketToLobby.set(socket.id, id);
    socket.lobbyId = id;
    const hostRating = db.users[l.host] ? db.users[l.host].rating : null;
    const guestRating = db.users[l.guest] ? db.users[l.guest].rating : null;
    if (l.isBot) { const beh = botInitBehavior(l.host); beh.state = 'playing'; beh.lastChange = Date.now(); }
    const hostIsWatcher = l.host === WATCHER_NAME;
    const guestIsWatcher = l.guest === WATCHER_NAME;
    io.to(l.hostSocket).emit('gameStart', { color: l.hostColor, opponent: l.guest, opponentRating: guestRating, opponentIsAdmin: isAdmin(l.guest), opponentIsMod: isMod(l.guest), opponentOnline: true, time: l.time, inc: l.inc, lobbyId: id, fen: l.fen, chat: l.chat, isArena: false, isBot: !!l.isBot && !hostIsWatcher && !guestIsWatcher, botName: l.isBot && !guestIsWatcher ? l.host : undefined });
    io.to(l.guestSocket).emit('gameStart', { color: l.guestColor, opponent: l.host, opponentRating: hostRating, opponentIsAdmin: isAdmin(l.host), opponentIsMod: isMod(l.host), opponentOnline: true, time: l.time, inc: l.inc, lobbyId: id, fen: l.fen, chat: l.chat, isArena: false, isBot: !!l.isBot && !hostIsWatcher && !guestIsWatcher, botName: l.isBot && !hostIsWatcher ? l.host : undefined });
    if (l.isBot) setTimeout(() => scheduleBotMove(l.id), l.isWatcher ? 1500 : 500);
    cb({ ok: true, id });
    broadcastLobbies();
    broadcastOnline();
    broadcastLiveGames();
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

    let fromSq = null, toSq = null;
    try {
      const oldState = botParseFen(l.fen);
      const newState = botParseFen(fen);
      let captured = null;
      for (let r = 0; r < 8 && !fromSq; r++) for (let c = 0; c < 8; c++) if (oldState.board[r][c] && !newState.board[r][c]) { fromSq = [r, c]; break; }
      if (fromSq) {
        const piece = oldState.board[fromSq[0]][fromSq[1]];
        for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
          const oldP = oldState.board[r][c], newP = newState.board[r][c];
          if (newP === piece && oldP !== piece && !(r === fromSq[0] && c === fromSq[1])) {
            toSq = [r, c]; captured = (oldP && oldP !== piece) ? oldP : null;
            break;
          }
        }
      }
      if (!l.history) l.history = [];
      l.history.push({ from: fromSq, to: toSq, captured, byColor: myColor, ts: Date.now() });
      if (l.history.length > 10) l.history.shift();
    } catch (e) {}

    const prevFenForWatcher = l.fen;
    const now = Date.now();
    const elapsed = Math.floor((now - l.lastTick) / 1000);
    if (myColor === 'w') l.timeW = Math.max(0, l.timeW - elapsed) + l.inc;
    else                 l.timeB = Math.max(0, l.timeB - elapsed) + l.inc;
    l.lastTick = now;
    l.fen = fen;
    l.turn = newTurn;
    l.drawOffer = null;

    registerPosition(l);

    emitToGameAndWatchers(lobbyId, 'boardUpdate', { fen, turn: newTurn, san: san || null, from: fromSq, to: toSq });
    emitToGameAndWatchers(lobbyId, 'timeUpdate', { timeW: l.timeW, timeB: l.timeB, serverNow: now });
    broadcastLiveGames();

    if (checkAutoDraw(lobbyId)) return;

    {
      const oppWhite = l.turn === 'w';
      const oppState = botParseFen(l.fen);
      const oppHasMoves = botAllLegalMoves(oppState, oppWhite).length > 0;
      if (!oppHasMoves) {
        if (botInCheck(oppState, oppWhite)) finishGame(lobbyId, oppWhite ? 'b' : 'w', 'Мат');
        else finishGame(lobbyId, 'draw', 'Пат');
        return;
      }
    }

    try {
      const beh = botInitBehavior(WATCHER_NAME);
      const isWatcherGame = (l.host === WATCHER_NAME || l.guest === WATCHER_NAME);
      const isWatching = beh.watchingLobbyId === lobbyId;
      if (fromSq && toSq) {
        const moverColor = newTurn === 'w' ? 'b' : 'w';
        const evalAfter = botEval(botParseFen(fen));
        if (isWatcherGame) {
          const watcherColor = l.host === WATCHER_NAME ? l.hostColor : l.guestColor;
          if (moverColor !== watcherColor) {
            watcherLearning.learnFromObservedMove(prevFenForWatcher, { from: fromSq, to: toSq }, fen, moverColor, { time: l.time, inc: l.inc }, evalAfter);
          }
        } else if (isWatching) {
          watcherLearning.learnFromObservedMove(prevFenForWatcher, { from: fromSq, to: toSq }, fen, moverColor, { time: l.time, inc: l.inc }, evalAfter);
        }
      }
    } catch (e) { /* ignore */ }

    if (l.isBot && ((l.botColor === l.turn) || (l.botColor2 && l.botColor2 === l.turn))) {
      scheduleBotMove(lobbyId);
    }
  });

  socket.on('resign', ({ lobbyId }) => {
    const l = lobbies.get(lobbyId);
    if (!l || l.finished) return;
    const myColor = socket.id === l.hostSocket ? l.hostColor : l.guestColor;
    const winner = myColor === 'w' ? 'b' : 'w';
    finishGame(lobbyId, winner, 'Сдача');
  });

  socket.on('gameOver', ({ lobbyId, result }) => {
    if (!lobbies.has(lobbyId)) return;
    finishGame(lobbyId, result, 'Завершено');
  });

  socket.on('chatMessage', ({ lobbyId, text }) => {
    const l = lobbies.get(lobbyId);
    if (!l || !socket.username) return;
    const muteUntil = checkMute(socket.username);
    if (muteUntil > 0) {
      const mins = Math.ceil((muteUntil - Date.now()) / 60000);
      socket.emit('chatError', { msg: `Вы заглушены ещё ${mins} мин.` });
      return;
    }
    if (typeof text !== 'string') return;
    text = text.trim().slice(0, 300);
    if (!text) return;
    const msg = { id: 'm' + Date.now() + Math.random().toString(36).slice(2, 6), user: socket.username, userIsAdmin: isAdmin(socket.username), userIsMod: isMod(socket.username), text, ts: Date.now() };
    l.chat.push(msg);
    if (l.chat.length > 50) l.chat.shift();
    emitToGameAndWatchers(lobbyId, 'chatMessage', msg);
  });

  socket.on('modDeleteMessage', ({ lobbyId, msgId }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    if (!isMod(socket.username)) return cb({ ok: false, msg: 'Нет прав' });
    const l = lobbies.get(lobbyId);
    if (!l) return cb({ ok: false, msg: 'Лобби нет' });
    const idx = l.chat.findIndex(m => m.id === msgId);
    if (idx < 0) return cb({ ok: false, msg: 'Сообщение не найдено' });
    l.chat.splice(idx, 1);
    emitToGameAndWatchers(lobbyId, 'chatMessageDeleted', { msgId, scope: 'game', lobbyId });
    cb({ ok: true });
  });

  socket.on('modMuteUser', ({ username, minutes }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    if (!isMod(socket.username)) return cb({ ok: false, msg: 'Нет прав' });
    if (!db.users[username]) return cb({ ok: false, msg: 'Игрок не найден' });
    if (isAdmin(username) && !isAdmin(socket.username)) return cb({ ok: false, msg: 'Нельзя замутить админа' });
    minutes = Math.max(1, Math.min(7 * 24 * 60, +minutes || 10));
    setMute(username, minutes);
    const until = Date.now() + minutes * 60 * 1000;
    io.emit('modAction', { action: 'mute', by: socket.username, target: username, minutes, until, ts: Date.now() });
    cb({ ok: true, until });
  });

  socket.on('modUnmuteUser', ({ username }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    if (!isMod(socket.username)) return cb({ ok: false, msg: 'Нет прав' });
    if (!db.users[username]) return cb({ ok: false, msg: 'Игрок не найден' });
    clearMute(username);
    io.emit('modAction', { action: 'unmute', by: socket.username, target: username, ts: Date.now() });
    cb({ ok: true });
  });

  socket.on('getMuteStatus', (cb) => {
    if (typeof cb !== 'function') return;
    if (!socket.username) return cb({ mutedUntil: 0 });
    cb({ mutedUntil: checkMute(socket.username) });
  });

  socket.on('drawOffer', ({ lobbyId }) => {
    const l = lobbies.get(lobbyId);
    if (!l || l.finished || !l.started) return;
    if (socket.id !== l.hostSocket && socket.id !== l.guestSocket) return;
    l.drawOffer = { by: socket.id, at: Date.now() };
    socket.to(lobbyId).emit('drawOffered', { from: socket.username });
    if (l.isBot) {
      const botColor = l.botColor === l.hostColor ? l.botColor : l.botColor2;
      const botName = l.botColor === l.hostColor ? l.botName : l.botName2;
      const botUser = db.users[botName];
      const botRating = botUser ? botUser.rating : 1500;
      const evalScore = evaluateCurrentPosition(l.fen);
      const botSign = botColor === 'w' ? 1 : -1;
      const myEval = evalScore * botSign;
      let accept = false;
      if (botName === WATCHER_NAME) {
        accept = Math.abs(myEval) < 50;
      } else {
        if (botRating < 1100)      accept = myEval < 100;
        else if (botRating < 1500) accept = myEval < 30;
        else if (botRating < 1800) accept = myEval < 0;
        else if (botRating < 2000) accept = myEval < -20;
        else                       accept = myEval < -50;
      }
      setTimeout(() => {
        const cur = lobbies.get(lobbyId);
        if (!cur || cur.finished || !cur.drawOffer) return;
        cur.drawOffer = null;
        if (accept) finishGame(lobbyId, 'draw', 'Ничья по согласию');
        else socket.emit('drawDeclined');
      }, 400 + Math.random() * 800);
    }
  });
  socket.on('drawAccept', ({ lobbyId }) => {
    const l = lobbies.get(lobbyId);
    if (!l || l.finished) return;
    l.drawOffer = null;
    finishGame(lobbyId, 'draw', 'Ничья по согласию');
  });
  socket.on('drawDecline', ({ lobbyId }) => {
    const l = lobbies.get(lobbyId);
    if (!l || l.finished) return;
    l.drawOffer = null;
    socket.to(lobbyId).emit('drawDeclined');
  });

  socket.on('rematchRequest', ({ lobbyId }, cb) => {
    if (typeof cb !== 'function') cb = () => {};

    let l = lobbies.get(lobbyId);
    let info = null;
    if (!l || l.finished) {
      info = finishedGamesInfo.get(lobbyId);
      if (!info) return cb({ ok: false, msg: 'Партия слишком давно завершена, реванш недоступен' });
    }

    const isBotGame = l ? !!l.isBot : info.isBot;
    const botName = l ? (l.botName || l.botName2) : info.botName;

    if (isBotGame) {
      if (!botName) return cb({ ok: false, msg: 'Бот не найден' });
      const bot = BOTS.find(b => b.name === botName);
      if (!bot) return cb({ ok: false, msg: 'Бот не найден' });
      const hostName = l ? l.host : info.host;
      const hostSocketId = l ? l.hostSocket : info.hostSocket;
      const time = l ? l.time : info.time;
      const inc = l ? l.inc : info.inc;
      if (botIsBusy(bot.name)) return cb({ ok: true, started: false, declined: true });
      const botUser = db.users[bot.name];
      const botRating = botUser ? botUser.rating : bot.rating;
      let agreeChance = 0.9;
      if (botRating >= 1900) agreeChance = 0.35;
      else if (botRating >= 1700) agreeChance = 0.55;
      else if (botRating >= 1400) agreeChance = 0.7;
      setTimeout(() => {
        if (Math.random() > agreeChance) { cb({ ok: true, started: false, declined: true }); return; }
        if (botIsBusy(bot.name)) { cb({ ok: true, started: false, declined: true }); return; }
        const newId = genId();
        const newLobby = {
          id: newId, host: hostName, hostSocket: hostSocketId,
          guest: bot.name, guestSocket: null,
          hostColor: 'w', guestColor: 'b',
          time, inc, timeW: time * 60, timeB: time * 60,
          turn: 'w', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          started: true, finished: false, lastTick: Date.now(),
          chat: [], drawOffer: null, createdAt: Date.now(),
          rematch: null, isBot: true, botName: bot.name, botColor: 'b', history: [], positionCounts: new Map()
        };
        lobbies.set(newId, newLobby);
        registerPosition(newLobby);
        const beh = botInitBehavior(bot.name);
        beh.state = 'playing'; beh.lastChange = Date.now();
        const hostSocket = io.sockets.sockets.get(hostSocketId);
        if (hostSocket) {
          if (l) hostSocket.leave(lobbyId);
          hostSocket.join(newId);
          socketToLobby.set(hostSocketId, newId);
          hostSocket.lobbyId = newId;
          hostSocket.emit('gameStart', {
            color: 'w', opponent: bot.name, opponentRating: botRating,
            opponentIsAdmin: false, opponentIsMod: false, opponentOnline: true,
            time, inc, lobbyId: newId,
            fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            chat: [], isArena: false, isBot: true, botName: bot.name
          });
        }
        if (l) lobbies.delete(lobbyId);
        finishedGamesInfo.delete(lobbyId);
        broadcastLobbies();
        broadcastLiveGames();
        cb({ ok: true, started: true, newLobbyId: newId });
      }, 300 + Math.random() * 1000);
      return;
    }

    const host = l ? l.host : info.host;
    const guest = l ? l.guest : info.guest;
    const hostSocketId = l ? l.hostSocket : info.hostSocket;
    const guestSocketId = l ? l.guestSocket : info.guestSocket;
    const time = l ? l.time : info.time;
    const inc = l ? l.inc : info.inc;

    if (socket.username !== host && socket.username !== guest) {
      return cb({ ok: false, msg: 'Вы не участник этой партии' });
    }

    if (!finishedGamesInfo.has(lobbyId)) {
      finishedGamesInfo.set(lobbyId, {
        host, guest, hostSocket: hostSocketId, guestSocket: guestSocketId,
        time, inc, isBot: false, botName: null,
        rematch: {}, finishedAt: Date.now()
      });
    }
    const rec = finishedGamesInfo.get(lobbyId);
    if (!rec.rematch) rec.rematch = {};
    rec.rematch[socket.username] = true;

    const otherName = socket.username === host ? guest : host;
    const otherSocketId = socket.username === host ? guestSocketId : hostSocketId;

    if (rec.rematch[otherName]) {
      const newId = genId();
      const newLobby = {
        id: newId, host, hostSocket: hostSocketId, guest, guestSocket: guestSocketId,
        hostColor: l ? l.guestColor : (info.hostColor === 'w' ? 'b' : 'w'),
        guestColor: l ? l.hostColor : (info.hostColor === 'w' ? 'w' : 'b'),
        time, inc, timeW: time * 60, timeB: time * 60, turn: 'w',
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        started: true, finished: false, lastTick: Date.now(), chat: [], drawOffer: null,
        createdAt: Date.now(), arenaId: null, arenaName: null, rematch: null, isBot: false, history: [], positionCounts: new Map()
      };
      lobbies.set(newId, newLobby);
      registerPosition(newLobby);
      const hostRating = db.users[host] ? db.users[host].rating : null;
      const guestRating = db.users[guest] ? db.users[guest].rating : null;
      const hostSocket = io.sockets.sockets.get(hostSocketId);
      const guestSocket = io.sockets.sockets.get(guestSocketId);
      if (hostSocket) {
        if (l) hostSocket.leave(lobbyId);
        hostSocket.join(newId); socketToLobby.set(hostSocketId, newId); hostSocket.lobbyId = newId;
        hostSocket.emit('gameStart', { color: newLobby.hostColor, opponent: guest, opponentRating: guestRating, opponentIsAdmin: isAdmin(guest), opponentIsMod: isMod(guest), opponentOnline: isUserOnline(guest), time, inc, lobbyId: newId, fen: newLobby.fen, chat: [], isArena: false });
      }
      if (guestSocket) {
        if (l) guestSocket.leave(lobbyId);
        guestSocket.join(newId); socketToLobby.set(guestSocketId, newId); guestSocket.lobbyId = newId;
        guestSocket.emit('gameStart', { color: newLobby.guestColor, opponent: host, opponentRating: hostRating, opponentIsAdmin: isAdmin(host), opponentIsMod: isMod(host), opponentOnline: isUserOnline(host), time, inc, lobbyId: newId, fen: newLobby.fen, chat: [], isArena: false });
      }
      if (l) lobbies.delete(lobbyId);
      finishedGamesInfo.delete(lobbyId);
      broadcastLobbies();
      broadcastLiveGames();
      cb({ ok: true, started: true, newLobbyId: newId });
      return;
    }

    if (otherSocketId) io.to(otherSocketId).emit('rematchOffered', { from: socket.username, lobbyId });
    cb({ ok: true, started: false });
  });

  socket.on('rematchDecline', ({ lobbyId }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    const rec = finishedGamesInfo.get(lobbyId);
    if (rec) rec.rematch = {};
    const l = lobbies.get(lobbyId);
    if (l) l.rematch = null;
    const otherSocketId = l
      ? (socket.id === l.hostSocket ? l.guestSocket : l.hostSocket)
      : (rec ? (socket.username === rec.host ? rec.guestSocket : rec.hostSocket) : null);
    if (otherSocketId) io.to(otherSocketId).emit('rematchDeclined');
    cb({ ok: true });
  });

  socket.on('getArenas', (cb) => { if (typeof cb === 'function') cb({ list: getArenaSchedule(48), serverNow: Date.now() }); });

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
    if (!state) return cb({ joined: false, paused: false, participants: [], participantsCount: 0, phase: 'waiting', timeLeftMin: 0, timeLeftMs: 0, top3: null, pairingNow: null, startsAt: 0, endsAt: 0, serverNow: Date.now(), botFriendly: false, chatViewersCount: 0 });
    for (const p of state.participants.values()) {
      if (p.isPlaying) {
        const l = p.lobbyId ? lobbies.get(p.lobbyId) : null;
        if (!l || l.finished) {
          p.isPlaying = false; p.lobbyId = null;
          if (!p.paused) p.waitingSince = Date.now();
          if (p.isBot && p.username !== WATCHER_NAME) {
            const beh = botInitBehavior(p.username);
            if (beh.state === 'playing') { beh.state = 'in_arena'; beh.activityId = state.id; beh.lastChange = Date.now(); }
          }
        }
      }
    }
    const participants = [...state.participants.values()].map(p => ({
      username: p.username, rating: p.rating, score: p.score, wins: p.wins, draws: p.draws, losses: p.losses,
      winStreak: p.winStreak || 0, drawStreak: p.drawStreak || 0,
      paused: !!p.paused, isPlaying: !!p.isPlaying,
      isAdmin: isAdmin(p.username), isMod: isMod(p.username),
      online: p.isBot ? true : (p.socketId && io.sockets.sockets.has(p.socketId)),
      isBot: !!p.isBot && p.username !== WATCHER_NAME
    })).sort((a, b) => b.score - a.score || b.rating - a.rating);
    const meP = socket.username ? state.participants.get(socket.username) : null;
    cb({
      joined: !!meP, paused: !!(meP && meP.paused), participants,
      participantsCount: participants.length, phase: state.phase,
      timeLeftMs: Math.max(0, state.endsAt - Date.now()),
      timeLeftMin: Math.round(Math.max(0, state.endsAt - Date.now()) / 60000),
      top3: state.top3, pairingNow: state.pairingNow,
      startsAt: state.startsAt, endsAt: state.endsAt, serverNow: Date.now(),
      botFriendly: !!state.botFriendly,
      chatViewersCount: state.chatViewers.size
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
        const wName = l.hostColor === 'w' ? l.host : l.guest;
        const bName = l.hostColor === 'b' ? l.host : l.guest;
        const wU = db.users[wName]; const bU = db.users[bName];
        live.push({
          lobbyId: id, white: wName, black: bName,
          whiteIsAdmin: isAdmin(wName), blackIsAdmin: isAdmin(bName),
          whiteIsMod: isMod(wName), blackIsMod: isMod(bName),
          whiteRating: wU ? wU.rating : null, blackRating: bU ? bU.rating : null,
          timeW: l.timeW, timeB: l.timeB, turn: l.turn, fen: l.fen,
          moveCount: l.fen ? (+l.fen.split(' ')[5] || 1) : 1, live: true,
          watchersCount: watchersCountOf(l)
        });
      }
    }
    if (state && Array.isArray(state.finishedGames)) {
      const arr = state.finishedGames.slice().reverse();
      for (const g of arr) {
        done.push({
          lobbyId: null, white: g.white, black: g.black,
          whiteIsAdmin: g.whiteIsAdmin, blackIsAdmin: g.blackIsAdmin,
          whiteIsMod: isMod(g.white), blackIsMod: isMod(g.black),
          whiteRating: g.whiteRating, blackRating: g.blackRating, result: g.result,
          fen: g.fen, turn: g.turn || 'w', timeW: 0, timeB: 0, finishedAt: g.finishedAt, live: false,
          watchersCount: 0
        });
      }
    }
    let topRating = 0;
    if (state) for (const p of state.participants.values()) if (p.rating > topRating) topRating = p.rating;
    live.sort((a, b) => Math.max(b.whiteRating||0, b.blackRating||0) - Math.max(a.whiteRating||0, a.blackRating||0));
    done.sort((a, b) => Math.max(b.whiteRating||0, b.blackRating||0) - Math.max(a.whiteRating||0, a.blackRating||0));
    cb({
      live, done, topRating,
      featured: live[0] || done[0] || null,
      participantsCount: state ? state.participants.size : 0,
      chatViewersCount: state ? state.chatViewers.size : 0
    });
  });

  socket.on('joinArena', ({ arenaId }, cb) => {
    if (typeof cb !== 'function') return;
    if (!socket.username) return cb({ ok: false, msg: 'Не авторизован' });
    const state = arenas.get(arenaId);
    if (!state) return cb({ ok: false, msg: 'Арена не найдена' });
    if (state.finished || state.phase === 'finished') return cb({ ok: false, msg: 'Арена завершена' });
    if (state.participants.has(socket.username)) return cb({ ok: true, msg: 'Уже участвуете' });
    state.participants.set(socket.username, {
      username: socket.username,
      rating: db.users[socket.username] ? db.users[socket.username].rating : 1200,
      score: 0, wins: 0, draws: 0, losses: 0, winStreak: 0, drawStreak: 0,
      socketId: socket.id, lobbyId: null, isPlaying: false, paused: false, waitingSince: Date.now(), isBot: false,
      awaitingNextPair: false
    });
    const sysMsg = { id: 'sys' + Date.now(), system: true, text: `${socket.username} присоединился к арене`, ts: Date.now(), arenaId: state.id };
    state.chat.push(sysMsg); if (state.chat.length > 300) state.chat.shift();
    io.to('arena:' + state.id).emit('arenaChatMessage', sysMsg);
    io.to('arena:' + state.id).emit('arenaUpdate', { arenaId });
    if (state.phase === 'live') tryPair(state);
    cb({ ok: true });
  });

  socket.on('leaveArena', ({ arenaId }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    const state = arenas.get(arenaId);
    if (!state) return cb({ ok: false, msg: 'Арена не найдена' });
    if (state.phase !== 'waiting') return cb({ ok: false, msg: 'Нельзя сняться после старта арены — используйте паузу' });
    const p = state.participants.get(socket.username);
    if (p && !p.isPlaying) {
      state.participants.delete(socket.username);
      const sysMsg = { id: 'sys' + Date.now(), system: true, text: `${socket.username} покинул арену`, ts: Date.now(), arenaId: state.id };
      state.chat.push(sysMsg); if (state.chat.length > 300) state.chat.shift();
      io.to('arena:' + state.id).emit('arenaChatMessage', sysMsg);
      io.to('arena:' + state.id).emit('arenaUpdate', { arenaId });
    }
    cb({ ok: true });
  });

  socket.on('continueArenaPairing', ({ arenaId }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    if (!socket.username) return cb({ ok: false, msg: 'Не авторизован' });
    const state = arenas.get(arenaId);
    if (!state) return cb({ ok: false, msg: 'Турнир не найден' });
    if (state.finished || state.phase === 'finished') return cb({ ok: false, msg: 'Турнир уже завершён' });
    const p = state.participants.get(socket.username);
    if (!p) return cb({ ok: false, msg: 'Вы не участвуете в этом турнире' });
    if (p.isPlaying) return cb({ ok: false, msg: 'Ваша партия ещё не завершена' });
    if (p.paused) return cb({ ok: false, msg: 'Сначала нажмите «Продолжить» в турнире' });
    p.awaitingNextPair = false;
    p.waitingSince = Date.now();
    io.to('arena:' + arenaId).emit('arenaUpdate', { arenaId });
    if (state.phase === 'live') setTimeout(() => tryPair(state), 100);
    cb({ ok: true });
  });

  socket.on('pauseArena', ({ arenaId }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    const state = arenas.get(arenaId);
    if (!state) return cb({ ok: false, msg: 'Арена не найдена' });
    if (state.finished || state.phase === 'finished') return cb({ ok: false, msg: 'Арена завершена' });
    const p = state.participants.get(socket.username);
    if (!p) return cb({ ok: false, msg: 'Вы не участвуете' });
    p.paused = !p.paused;
    if (!p.paused) p.waitingSince = Date.now();
    io.to('arena:' + arenaId).emit('arenaUpdate', { arenaId });
    cb({ ok: true, paused: p.paused });
  });

  socket.on('arenaChat', ({ arenaId, text }) => {
    const state = arenas.get(arenaId);
    if (!state || !socket.username) return;
    const muteUntil = checkMute(socket.username);
    if (muteUntil > 0) {
      const mins = Math.ceil((muteUntil - Date.now()) / 60000);
      socket.emit('chatError', { msg: `Вы заглушены ещё ${mins} мин.` });
      return;
    }
    if (typeof text !== 'string') return;
    text = text.trim().slice(0, 300);
    if (!text) return;
    const msg = { id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6), user: socket.username, userIsAdmin: isAdmin(socket.username), userIsMod: isMod(socket.username), text, ts: Date.now(), arenaId };
    state.chat.push(msg); if (state.chat.length > 300) state.chat.shift();
    io.to('arena:' + arenaId).emit('arenaChatMessage', msg);
  });

  socket.on('modDeleteArenaMessage', ({ arenaId, msgId }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    if (!isMod(socket.username)) return cb({ ok: false, msg: 'Нет прав' });
    const state = arenas.get(arenaId);
    if (!state) return cb({ ok: false, msg: 'Арена не найдена' });
    const idx = state.chat.findIndex(m => m.id === msgId);
    if (idx < 0) return cb({ ok: false, msg: 'Сообщение не найдено' });
    state.chat.splice(idx, 1);
    io.to('arena:' + arenaId).emit('chatMessageDeleted', { msgId, scope: 'arena', arenaId });
    cb({ ok: true });
  });

  socket.on('disconnect', () => {
    online.delete(socket.id);
    if (socket.username) {
      for (const state of arenas.values()) {
        const p = state.participants.get(socket.username);
        if (p && p.socketId === socket.id) p.socketId = null;
        state.chatViewers.delete(socket.id);
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
      if (l.watchers) {
        if (l.watchers.delete(socket.id)) broadcastWatchers(l.id);
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
        broadcastLiveGames();
      }
    }
    broadcastOnline();
  });
});

// ======================= ЗАПУСК =======================
(async () => {
  try { await initDB(); await loadDB(); }
  catch (err) { console.error('[DB] Не удалось инициализировать базу данных:', err.message || err.code || err); }

  watcherLearning.loadWeights();
  watcherLearning.startAutoSave();

  getArenaSchedule(48);

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log('==================================================');
    console.log('  Kingside — сервер запущен');
    console.log(`  Порт: ${PORT}`);
    console.log(`  CPU ядер доступно: ${require('os').cpus().length}`);
    console.log('  Боты работают в отдельных потоках (worker_threads)');
    console.log('  Watcher: обучаемый бот-наблюдатель (нейросеть + negamax)');
    console.log('==================================================');
  });
})();

process.on('SIGINT', async () => { try { await botPool.terminate(); watcherLearning.saveWeights(); } catch (e) {} process.exit(0); });
process.on('SIGTERM', async () => { try { await botPool.terminate(); watcherLearning.saveWeights(); } catch (e) {} process.exit(0); });
process.on('uncaughtException', (err) => { console.error('[Server] Ошибка:', err); });
