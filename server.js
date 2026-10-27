const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const botPool = require('./bot-pool');
const watcherLearning = require('./watcher-learning');
const watcherPool = require('./watcher-pool');
const { sendVerificationEmail, sendPasswordResetEmail, sendAccountDeletionEmail } = require('./mailer');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));

const MSK_OFFSET_MS = 3 * 3600 * 1000;
function mskParts(ts) {
  const d = new Date(ts + MSK_OFFSET_MS);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
}
function fromMsk(y, mo, d, h, mi, s) { return Date.UTC(y, mo, d, h, mi, s || 0) - MSK_OFFSET_MS; }
function fmtMskHM(ts) { const p = mskParts(ts); return String(p.h).padStart(2, '0') + ':' + String(p.mi).padStart(2, '0'); }
function roundToMinute(ts) { return Math.round(ts / 60000) * 60000; }

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
    const gPhiJ = glicko2PhiJ(phiJ);
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
function glicko2PhiJ(phi) { return glicko2G(phi); }

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

let watcherDbPool = null;
if (process.env.DATABASE_URL_WATCHER) {
  watcherDbPool = new Pool({
    connectionString: process.env.DATABASE_URL_WATCHER,
    ssl: { rejectUnauthorized: false }
  });
  console.log('[WatcherDB] Подключено отдельное хранилище весов');
} else {
  console.warn('[WatcherDB] DATABASE_URL_WATCHER не задан — веса НЕ сохранятся!');
}

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
    ['muted_until','BIGINT DEFAULT 0'],['is_bot','BOOLEAN DEFAULT FALSE'],
    ['email','TEXT'], ['email_verified','BOOLEAN DEFAULT FALSE'], ['verify_token','TEXT'], ['verify_token_expires','BIGINT DEFAULT 0'],
    ['bio','TEXT DEFAULT \'\''], ['delete_token','TEXT'], ['delete_requested_at','BIGINT DEFAULT 0'], ['show_subseconds','BOOLEAN DEFAULT FALSE'],
    ['is_banned','BOOLEAN DEFAULT FALSE'], ['banned_until','BIGINT DEFAULT 0']
  ];
  for (const [name, type] of cols) await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${name} ${type};`);

  await pool.query(`CREATE TABLE IF NOT EXISTS password_resets (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at BIGINT NOT NULL,
    used BOOLEAN DEFAULT FALSE
  );`);

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
  
  await pool.query(`CREATE TABLE IF NOT EXISTS reports (
    id SERIAL PRIMARY KEY, reporter TEXT NOT NULL, target TEXT NOT NULL, reason TEXT NOT NULL, created_at BIGINT NOT NULL, resolved BOOLEAN DEFAULT FALSE
  );`);

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
      email: row.email,
      emailVerified: !!row.email_verified,
      verifyToken: row.verify_token,
      verifyExpires: Number(row.verify_token_expires || 0),
      bio: row.bio || '',
      deleteToken: row.delete_token,
      deleteRequestedAt: Number(row.delete_requested_at || 0),
      showSubseconds: !!row.show_subseconds,
      isBanned: !!row.is_banned,
      bannedUntil: Number(row.banned_until || 0),
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
        email: null, emailVerified: true, verifyToken: null, verifyExpires: 0, bio: '', deleteToken: null, deleteRequestedAt: 0, showSubseconds: false, isBanned: false, bannedUntil: 0,
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
                              muted_until, is_bot, email_verified)
           VALUES ($1,$2,$3,$4,$5,$6,0,0,0,0,$7,$4,$4,$4,$4,$5,$5,$5,$5,$6,$6,$6,$6,0,0,0,0,0,0,0,0,0,0,0,0,0,TRUE,TRUE)`,
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
                        muted_until, is_bot, email, email_verified, verify_token, verify_token_expires,
                        bio, delete_token, delete_requested_at, show_subseconds, is_banned, banned_until)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46,$47,$48)
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
       muted_until = EXCLUDED.muted_until, is_bot = EXCLUDED.is_bot,
       email = EXCLUDED.email, email_verified = EXCLUDED.email_verified,
       verify_token = EXCLUDED.verify_token, verify_token_expires = EXCLUDED.verify_token_expires,
       bio = EXCLUDED.bio, delete_token = EXCLUDED.delete_token, delete_requested_at = EXCLUDED.delete_requested_at,
       show_subseconds = EXCLUDED.show_subseconds, is_banned = EXCLUDED.is_banned, banned_until = EXCLUDED.banned_until`,
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
     u.mutedUntil || 0, !!u.isBot,
     u.email || null, !!u.emailVerified, u.verifyToken || null, u.verifyExpires || 0,
     u.bio || '', u.deleteToken || null, u.deleteRequestedAt || 0, !!u.showSubseconds, !!u.isBanned, u.bannedUntil || 0]
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
    isBot: !!u.isBot && name !== WATCHER_NAME,
    bio: u.bio || '',
    showSubseconds: !!u.showSubseconds,
    isBanned: !!u.isBanned,
    bannedUntil: u.bannedUntil || 0
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

const MAX_HUMAN_WAITING = 15;
const MAX_BOT_WAITING   = 3;
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

const SELF_PLAY_BOT_ID = 'WatcherSelfPlay';
const selfPlayLobbies = new Map();

function createSelfPlayLobby(moveLog) {
  if (!moveLog || !moveLog.length) return null;
  const id = 'sp_' + genId();
  const firstFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const last = moveLog[moveLog.length - 1];
  const lastHist = { from: last.from, to: last.to, byColor: (moveLog.length - 1) % 2 === 0 ? 'w' : 'b', ts: Date.now() };

  const timeBase = 180;
  const moveCount = moveLog.length;
  const timePerSide = Math.max(5, timeBase - Math.floor(moveCount * 0.5));

  const lobby = {
    id,
    host: SELF_PLAY_BOT_ID,
    hostSocket: 'BOT:' + SELF_PLAY_BOT_ID,
    guest: SELF_PLAY_BOT_ID,
    guestSocket: 'BOT:' + SELF_PLAY_BOT_ID,
    hostColor: 'w',
    guestColor: 'b',
    time: timeBase,
    inc: 0,
    timeW: timePerSide,
    timeB: timePerSide,
    turn: last.fenAfter ? last.fenAfter.split(' ')[1] : 'w',
    fen: last.fenAfter || firstFen,
    started: true,
    finished: false,
    lastTick: Date.now(),
    chat: [],
    drawOffer: null,
    createdAt: Date.now(),
    arenaId: null,
    arenaName: null,
    rematch: null,
    isBot: true,
    botColor: 'w',
    botName: SELF_PLAY_BOT_ID,
    botColor2: 'b',
    botName2: SELF_PLAY_BOT_ID,
    history: [lastHist],
    positionCounts: new Map(),
    isSelfPlay: true,
    selfPlayHistory: moveLog
  };
  lobbies.set(id, lobby);
  selfPlayLobbies.set(id, { lastEmitAt: Date.now() });
  return lobby;
}

function finishSelfPlayLobby(lobby, result) {
  if (!lobby) return;
  lobby.finished = true;
  lobby.finishedAt = Date.now();
  lobby.result = result;
  setTimeout(() => {
    lobbies.delete(lobby.id);
    selfPlayLobbies.delete(lobby.id);
    broadcastLiveGames();
  }, 30000);
}

function countActiveLobbies() { let n = 0; for (const l of lobbies.values()) { if (l.finished) continue; if (l.started) n++; } return n; }

function countWaitingLobbies() {
  let human = 0, bot = 0;
  const now = Date.now();
  for (const [id, l] of lobbies.entries()) {
    if (!l || l.finished || l.arenaId || l.started || l.guest) continue;
    if (l.isSelfPlay) continue;
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
    waitingMax: MAX_HUMAN_WAITING
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

    if (l.isSelfPlay) {
      const whiteName = SELF_PLAY_BOT_ID;
      const blackName = SELF_PLAY_BOT_ID;
      const lastHist = (l.history && l.history.length) ? l.history[l.history.length - 1] : null;
      list.push({
        id, white: whiteName, black: blackName,
        whiteRating: db.users[WATCHER_NAME] ? db.users[WATCHER_NAME].rating : 1500,
        blackRating: db.users[WATCHER_NAME] ? db.users[WATCHER_NAME].rating : 1500,
        whiteIsAdmin: false, blackIsAdmin: false,
        whiteIsMod: false, blackIsMod: false,
        whiteIsBot: true, blackIsBot: true,
        isBotGame: true,
        isSelfPlay: true,
        timeW: l.timeW, timeB: l.timeB, turn: l.turn,
        timeControl: l.time, increment: l.inc,
        isArena: false, arenaName: null,
        fen: l.fen,
        lastMove: lastHist && lastHist.from && lastHist.to ? { from: lastHist.from, to: lastHist.to } : null,
        watchersCount: watchersCountOf(l),
        finished: l.finished
      });
      continue;
    }

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
      watchersCount: watchersCountOf(l),
      finished: !!l.finished
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

  if (l.isSelfPlay) {
    l.finished = true;
    l.started = false;
    finishedLobbyIds.add(lobbyId);
    return;
  }

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

const ARENA_TEMPLATES = [
  { id: 'bullet1_human', name: 'Пуля 1+0', description: '1+0 · рейтинговая', timeControl: 1, increment: 0, durationMin: 27, repeat: 'bullet1_human', color: 'bullet', botFriendly: false, lane: 0 },
  { id: 'bullet1_bots', name: 'Пуля 1+0 (Боты)', description: '1+0 · люди и боты', timeControl: 1, increment: 0, durationMin: 27, repeat: 'bullet1_bots', color: 'bullet', botFriendly: true, lane: 0 },
  { id: 'blitz32_human', name: 'Блиц 3+2', description: '3+2 · рейтинговая', timeControl: 3, increment: 2, durationMin: 57, repeat: 'blitz32_human', color: 'blitz', botFriendly: false, lane: 1 },
  { id: 'blitz32_bots', name: 'Блиц 3+2 (Боты)', description: '3+2 · люди и боты', timeControl: 3, increment: 2, durationMin: 57, repeat: 'blitz32_bots', color: 'blitz', botFriendly: true, lane: 1 },
  { id: 'classical30_human', name: 'Классика 30+0', description: '30+0 · классика', timeControl: 30, increment: 0, durationMin: 237, repeat: 'classical30', color: 'classical', botFriendly: false, lane: 2 },
  { id: 'rapid10_human', name: 'Рапид 10+0', description: '10+0 · рейтинговая', timeControl: 10, increment: 0, durationMin: 117, repeat: 'rapid10_human', color: 'rapid', botFriendly: false, lane: 3 },
  { id: 'rapid10_bots', name: 'Рапид 10+0 (Боты)', description: '10+0 · люди и боты', timeControl: 10, increment: 0, durationMin: 117, repeat: 'rapid10_bots', color: 'rapid', botFriendly: true, lane: 3 },
  { id: 'bullet21_human', name: 'Пуля 2+1', description: '2+1 · рейтинговая', timeControl: 2, increment: 1, durationMin: 57, repeat: 'bullet21_human', color: 'bullet', botFriendly: false, lane: 4 },
  { id: 'bullet21_bots', name: 'Пуля 2+1 (Боты)', description: '2+1 · люди и боты', timeControl: 2, increment: 1, durationMin: 57, repeat: 'bullet21_bots', color: 'bullet', botFriendly: true, lane: 4 }
];

function nextStartFor(tpl, now) {
  const CYCLE_30 = 30 * 60 * 1000;
  const CYCLE_60 = 60 * 60 * 1000;
  const CYCLE_120 = 120 * 60 * 1000;
  const isOnePlusZero = (tpl.repeat === 'bullet1_human' || tpl.repeat === 'bullet1_bots');
  const isBlitzOrBullet21 = (
    tpl.repeat === 'bullet21_human' || tpl.repeat === 'bullet21_bots' ||
    tpl.repeat === 'blitz32_human' || tpl.repeat === 'blitz32_bots'
  );
  const isRapid10 = (tpl.repeat === 'rapid10_human' || tpl.repeat === 'rapid10_bots');

  if (isOnePlusZero) {
    const slot = Math.floor(now / CYCLE_30);
    const isBotVariant = tpl.repeat.endsWith('_bots');
    const slotIsBot = (slot % 2 === 1);
    if (slotIsBot === isBotVariant) return slot * CYCLE_30;
    return (slot + 1) * CYCLE_30;
  }
  if (isBlitzOrBullet21) {
    const slot = Math.floor(now / CYCLE_60);
    const isBotVariant = tpl.repeat.endsWith('_bots');
    const slotIsBot = (slot % 2 === 1);
    if (slotIsBot === isBotVariant) return slot * CYCLE_60;
    return (slot + 1) * CYCLE_60;
  }
  if (isRapid10) {
    const slot = Math.floor(now / CYCLE_120);
    const isBotVariant = tpl.repeat.endsWith('_bots');
    const slotIsBot = (slot % 2 === 1);
    if (slotIsBot === isBotVariant) return slot * CYCLE_120;
    return (slot + 1) * CYCLE_120;
  }
  if (tpl.repeat === 'classical30') {
    const slot = Math.floor(now / (4 * 60 * 60 * 1000));
    return slot * 4 * 60 * 60 * 1000;
  }
  return roundToMinute(now + 3600000);
}

function stepFor(tpl) {
  const isOnePlusZero = (tpl.repeat === 'bullet1_human' || tpl.repeat === 'bullet1_bots');
  const isBlitzOrBullet21 = (
    tpl.repeat === 'bullet21_human' || tpl.repeat === 'bullet21_bots' ||
    tpl.repeat === 'blitz32_human' || tpl.repeat === 'blitz32_bots'
  );
  const isRapid10 = (tpl.repeat === 'rapid10_human' || tpl.repeat === 'rapid10_bots');

  if (isOnePlusZero) return 60 * 60 * 1000;
  if (isBlitzOrBullet21) return 120 * 60 * 1000;
  if (isRapid10) return 240 * 60 * 1000;
  if (tpl.repeat === 'classical30') return 4 * 3600 * 1000;
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
    botsJoined: false, tryPairRunning: false
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
      username: bot.name, rating: botUser ? botUser.rating : bot.rating,
      score: 0, wins: 0, draws: 0, losses: 0, winStreak: 0, drawStreak: 0,
      socketId: 'BOT:' + bot.name, lobbyId: null, isPlaying: false, paused: false,
      waitingSince: Date.now(), isBot: true, botLevel: bot.level,
      inArenaRoom: true, cooldownUntil: 0, awaitingNextPair: false,
      history: []
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
const MAX_BOT_GAMES_PER_ARENA = 6;
const MAX_HUMAN_GAMES_PER_ARENA = 20;
const MAX_WATCHER_ACTIVE_LOBBIES = 1;

function botActiveGamesCount(botName) {
  let n = 0;
  for (const l of lobbies.values()) {
    if (l.finished || !l.isBot) continue;
    if (l.isSelfPlay) continue;
    if (l.botName === botName || l.botName2 === botName) n++;
  }
  return n;
}
function botIsBusy(botName) {
  if (botName === WATCHER_NAME) {
    for (const l of lobbies.values()) if (!l.finished && !l.isSelfPlay && (l.host === WATCHER_NAME || l.guest === WATCHER_NAME)) return true;
    return false;
  }
  return botActiveGamesCount(botName) >= MAX_BOT_GAMES;
}
function botGamesInArena(arenaId) {
  let n = 0;
  for (const l of lobbies.values()) if (!l.finished && l.isBot && l.arenaId === arenaId) n++;
  return n;
}
function humanGamesInArena(arenaId) {
  let n = 0;
  for (const l of lobbies.values()) if (!l.finished && !l.isBot && l.arenaId === arenaId) n++;
  return n;
}
function watcherGamesInArena(arenaId) {
  let n = 0;
  for (const l of lobbies.values()) {
    if (l.finished || !l.isBot || l.arenaId !== arenaId) continue;
    if (l.botName === WATCHER_NAME || l.botName2 === WATCHER_NAME) n++;
  }
  return n;
}
function watcherHasActiveLobby() {
  for (const l of lobbies.values()) if (!l.finished && !l.isSelfPlay && l.started && (l.host === WATCHER_NAME || l.guest === WATCHER_NAME)) return true;
  return false;
}
function watcherInAnyArena() {
  for (const state of arenas.values()) if (!state.finished && state.participants.has(WATCHER_NAME) && state.participants.get(WATCHER_NAME).isPlaying) return true;
  return false;
}

function isAvailableForPairing(p, arenaId) {
  if (!p) return false;
  if (p.isPlaying || p.lobbyId) return false;
  if (!p.inArenaRoom) return false;
  if (p.cooldownUntil && Date.now() < p.cooldownUntil) return false;
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
  for (const [id, l] of lobbies.entries()) if (!l.finished && !l.started && l.host === botName && l.isBot) { lobbies.delete(id); closed = true; }
  if (closed) { broadcastLobbies(); broadcastLiveGames(); }
  return closed;
}
function botLeaveArena(botName, arenaId) {
  const state = arenas.get(arenaId); if (!state) return;
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
    username: botName, rating: botUser ? botUser.rating : 1200,
    score: 0, wins: 0, draws: 0, losses: 0, winStreak: 0, drawStreak: 0,
    socketId: 'BOT:' + botName, lobbyId: null, isPlaying: false, paused: false,
    waitingSince: Date.now(), isBot: true,
    inArenaRoom: true, cooldownUntil: 0, awaitingNextPair: false,
    history: []
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
      const candidates = [...arenas.values()].filter(s => !s.finished && s.botFriendly && (s.phase === 'live' || s.phase === 'waiting') && !s.participants.has(bot.name));
      if (candidates.length) {
        candidates.sort((a, b) => {
          const aLive = a.phase === 'live' ? 0 : 1, bLive = b.phase === 'live' ? 0 : 1;
          if (aLive !== bLive) return aLive - bLive;
          return a.startsAt - b.startsAt;
        });
        const chosen = candidates[0];
        if (botJoinArena(bot.name, chosen.id)) {
          beh.state = 'in_arena'; beh.activityId = chosen.id; beh.lastChange = now;
        }
      }
    }
  }
}
setInterval(botBehaviorTick, 5000);
setTimeout(botBehaviorTick, 3000);

function watcherTick() {
  const now = Date.now();
  const beh = botInitBehavior(WATCHER_NAME);

  if (beh.state === 'playing' || watcherHasActiveLobby()) return;
  if (watcherInAnyArena()) return;
  for (const l of lobbies.values()) {
    if (!l.finished && !l.isSelfPlay && (l.host === WATCHER_NAME || l.guest === WATCHER_NAME)) return;
  }

  if (Math.random() < 0.4 || !beh.watchingLobbyId) {
    const liveGames = [];
    for (const [id, l] of lobbies.entries()) {
      if (l.finished || !l.started) continue;
      if (l.isSelfPlay) continue;
      if (l.host === WATCHER_NAME || l.guest === WATCHER_NAME) continue;
      liveGames.push(id);
    }
    beh.watchingLobbyId = liveGames.length > 0 ? liveGames[Math.floor(Math.random() * liveGames.length)] : null;
  }
  if (beh.state !== 'in_arena' && Math.random() < 0.4) {
    const candidates = [...arenas.values()].filter(s => !s.finished && s.botFriendly && (s.phase === 'live' || s.phase === 'waiting') && !s.participants.has(WATCHER_NAME));
    if (candidates.length) {
      candidates.sort((a, b) => {
        const aLive = a.phase === 'live' ? 0 : 1, bLive = b.phase === 'live' ? 0 : 1;
        if (aLive !== bLive) return aLive - bLive;
        return a.startsAt - b.startsAt;
      });
      const chosen = candidates[0];
      const wu = db.users[WATCHER_NAME];
      chosen.participants.set(WATCHER_NAME, {
        username: WATCHER_NAME, rating: wu ? wu.rating : 1500,
        score: 0, wins: 0, draws: 0, losses: 0, winStreak: 0, drawStreak: 0,
        socketId: 'BOT:' + WATCHER_NAME, lobbyId: null, isPlaying: false, paused: false,
        waitingSince: Date.now(), isBot: true,
        inArenaRoom: true, cooldownUntil: 0, awaitingNextPair: false,
        history: []
      });
      beh.state = 'in_arena'; beh.activityId = chosen.id; beh.lastChange = now;
      const sysMsg = { id: 'sys' + Date.now(), system: true, text: `${WATCHER_NAME} присоединился к арене`, ts: Date.now(), arenaId: chosen.id };
      chosen.chat.push(sysMsg); if (chosen.chat.length > 300) chosen.chat.shift();
      io.to('arena:' + chosen.id).emit('arenaChatMessage', sysMsg);
      io.emit('arenaUpdate', { arenaId: chosen.id });
      return;
    }
  }
  if (beh.state === 'idle' && Math.random() < 0.35) {
    let hasOwnLobby = false;
    for (const [id, l] of lobbies.entries()) if (!l.finished && !l.started && !l.isSelfPlay && l.host === WATCHER_NAME) { hasOwnLobby = true; break; }
    if (!hasOwnLobby) {
      const counts = countWaitingLobbies();
      if (counts.bot >= MAX_BOT_WAITING) return;
      if (counts.human >= MAX_HUMAN_WAITING) return;
      const times = [{t:1,i:0},{t:3,i:0},{t:3,i:2},{t:5,i:0},{t:10,i:0}];
      const pick = times[Math.floor(Math.random() * times.length)];
      const id = genId();
      const lobby = {
        id, host: WATCHER_NAME, hostSocket: 'BOT:' + WATCHER_NAME,
        guest: null, guestSocket: null, hostColor: null, guestColor: null,
        time: pick.t, inc: pick.i, timeW: pick.t * 60, timeB: pick.t * 60,
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
      broadcastLobbies(); broadcastLiveGames();
    }
  }
}
setInterval(watcherTick, 15000);
setTimeout(watcherTick, 5000);

function tryPair(state) {
  if (state.finished || state.phase !== 'live') return;
  if (state.tryPairRunning) return;
  state.tryPairRunning = true;
  try {
    const hasViewers = state.chatViewers.size > 0;
    const hasHumans = [...state.participants.values()].some(p => !p.isBot);
    if (!hasHumans && !hasViewers && Math.random() > 0.5) return;

    const available = [];
    for (const [, p] of state.participants.entries()) {
      if (!isAvailableForPairing(p, state.id)) continue;
      if (!p.waitingSince) p.waitingSince = Date.now();
      available.push(p);
    }
    if (available.length < 2) {
      state.pairingNow = available.length === 1 ? available[0].username : null;
      return;
    }
    available.sort((a, b) => a.waitingSince - b.waitingSince);

    const used = new Set();
    let pairsCreated = 0;
    const hasWatcher = available.some(p => p.username === WATCHER_NAME);
    const MAX_PAIRS_PER_TICK = hasWatcher ? 2 : 4;
    let watcherPairsThisTick = 0;

    for (let i = 0; i < available.length && pairsCreated < MAX_PAIRS_PER_TICK; i++) {
      const a = available[i];
      if (used.has(a.username) || a.isPlaying || a.lobbyId) continue;
      let best = null, bestDiff = Infinity;
      for (let j = 0; j < available.length; j++) {
        if (i === j) continue;
        const b = available[j];
        if (used.has(b.username) || b.isPlaying || b.lobbyId) continue;
        if (a.username === b.username) continue;

        if (a.username === WATCHER_NAME && b.username === WATCHER_NAME) continue;

        const aWatcher = a.username === WATCHER_NAME;
        const bWatcher = b.username === WATCHER_NAME;
        if (aWatcher || bWatcher) {
          if (watcherPairsThisTick >= 1) continue;
          if (watcherHasActiveLobby()) continue;
          if (watcherGamesInArena(state.id) >= MAX_WATCHER_ACTIVE_LOBBIES) continue;
        }

        const aIsBot = !!a.isBot, bIsBot = !!b.isBot;
        if (aIsBot && bIsBot) {
          if (botGamesInArena(state.id) >= MAX_BOT_GAMES_PER_ARENA) continue;
          if (state.chatViewers.size === 0 && !hasHumans && Math.random() > 0.5) continue;
        }
        if (!aIsBot && !bIsBot) {
          if (humanGamesInArena(state.id) >= MAX_HUMAN_GAMES_PER_ARENA) continue;
        }
        const diff = Math.abs((a.score || 0) - (b.score || 0));
        if (diff < bestDiff) { bestDiff = diff; best = b; }
      }
      if (!best) continue;

      if (a.isPlaying || a.lobbyId || best.isPlaying || best.lobbyId) continue;
      if (!a.inArenaRoom || !best.inArenaRoom) continue;
      if (a.cooldownUntil && Date.now() < a.cooldownUntil) continue;
      if (best.cooldownUntil && Date.now() < best.cooldownUntil) continue;

      createArenaPairing(state, a, best);
      used.add(a.username); used.add(best.username);
      a.waitingSince = null; best.waitingSince = null;
      pairsCreated++;
      if (a.username === WATCHER_NAME || best.username === WATCHER_NAME) watcherPairsThisTick++;
    }

    if (pairsCreated === 0) {
      const free = [...state.participants.values()].filter(p => isAvailableForPairing(p, state.id));
      state.pairingNow = free.length === 1 ? free[0].username : null;
    } else {
      state.pairingNow = null;
    }
  } finally {
    state.tryPairRunning = false;
  }
}

function createArenaPairing(state, a, b) {
  if (!a || !b) return;
  if (a.username === b.username) return;
  if (a.username === WATCHER_NAME && b.username === WATCHER_NAME) return;
  if (a.isPlaying || a.lobbyId || b.isPlaying || b.lobbyId) return;
  if (!a.inArenaRoom || !b.inArenaRoom) return;
  if (a.cooldownUntil && Date.now() < a.cooldownUntil) return;
  if (b.cooldownUntil && Date.now() < b.cooldownUntil) return;

  const lobbyId = genId();
  const hostIsWhite = Math.random() < 0.5;
  const hostColor = hostIsWhite ? 'w' : 'b';
  const guestColor = hostIsWhite ? 'b' : 'w';
  const time = state.timeControl;
  const inc = state.increment;
  const aIsBot = !!a.isBot; const bIsBot = !!b.isBot;
  const isBotGame = aIsBot || bIsBot;

  const aSocketId = a.isBot ? null : a.socketId;
  const bSocketId = b.isBot ? null : b.socketId;

  lobbies.set(lobbyId, {
    id: lobbyId, host: a.username, hostSocket: aSocketId, guest: b.username, guestSocket: bSocketId,
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

  const aUser = db.users[a.username]; const bUser = db.users[b.username];
  if (aSocketId) {
    const s = io.sockets.sockets.get(aSocketId);
    if (s && s.username === a.username) {
      s.join(lobbyId);
      s.emit('gameStart', { color: hostColor, opponent: b.username, opponentRating: bUser ? bUser.rating : null, opponentIsAdmin: isAdmin(b.username), opponentIsMod: isMod(b.username), opponentIsBot: !!b.isBot && b.username !== WATCHER_NAME, opponentOnline: true, time, inc, lobbyId, fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', chat: [], arenaId: state.id, arenaName: state.name, isBot: isBotGame });
    }
  }
  if (bSocketId) {
    const s = io.sockets.sockets.get(bSocketId);
    if (s && s.username === b.username) {
      s.join(lobbyId);
      s.emit('gameStart', { color: guestColor, opponent: a.username, opponentRating: aUser ? aUser.rating : null, opponentIsAdmin: isAdmin(a.username), opponentIsMod: isMod(a.username), opponentIsBot: !!a.isBot && a.username !== WATCHER_NAME, opponentOnline: true, time, inc, lobbyId, fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', chat: [], arenaId: state.id, arenaName: state.name, isBot: isBotGame });
    }
  }
  io.to('arena:' + state.id).emit('arenaUpdate', { arenaId: state.id });
  broadcastOnline(); broadcastLiveGames();
  if (isBotGame && lobbyId) setTimeout(() => scheduleBotMove(lobbyId), 500 + Math.random() * 500);
}

function calcArenaPoints(p, result) {
  if (result === 'win') { const s = (p.winStreak || 0) + 1; p.winStreak = s; p.drawStreak = 0; return s >= 3 ? 4 : 2; }
  if (result === 'draw') { const s = (p.drawStreak || 0) + 1; p.drawStreak = s; p.winStreak = 0; return s >= 2 ? 2 : 1; }
  p.winStreak = 0; p.drawStreak = 0; return 0;
}
function handleArenaGameEnd(arenaId, lobbyId, result, whiteName, blackName) {
  const state = arenas.get(arenaId); if (!state) return;
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
  
  if (!whiteP.history) whiteP.history = [];
  if (!blackP.history) blackP.history = [];

  if (result === 'w') {
    const ptsW = calcArenaPoints(whiteP, 'win');
    const ptsB = calcArenaPoints(blackP, 'loss');
    whiteP.score += ptsW; whiteP.wins++; blackP.losses++;
    whiteP.history.push(ptsW); blackP.history.push(ptsB);
  } else if (result === 'b') {
    const ptsB = calcArenaPoints(blackP, 'win');
    const ptsW = calcArenaPoints(whiteP, 'loss');
    blackP.score += ptsB; blackP.wins++; whiteP.losses++;
    blackP.history.push(ptsB); whiteP.history.push(ptsW);
  } else {
    const ptsW = calcArenaPoints(whiteP, 'draw');
    const ptsB = calcArenaPoints(blackP, 'draw');
    whiteP.score += ptsW; blackP.score += ptsB; whiteP.draws++; blackP.draws++;
    whiteP.history.push(ptsW); blackP.history.push(ptsB);
  }

  const now = Date.now();
  whiteP.isPlaying = false; blackP.isPlaying = false;
  whiteP.lobbyId = null; blackP.lobbyId = null;
  whiteP.cooldownUntil = now + ARENA_COOLDOWN_MS;
  blackP.cooldownUntil = now + ARENA_COOLDOWN_MS;
  whiteP.awaitingNextPair = !whiteP.isBot;
  blackP.awaitingNextPair = !blackP.isBot;
  if (whiteP.isBot && whiteName !== WATCHER_NAME) { const bh = botInitBehavior(whiteName); bh.state = 'in_arena'; bh.activityId = arenaId; bh.lastChange = now; }
  else if (whiteName === WATCHER_NAME) { const bh = botInitBehavior(WATCHER_NAME); bh.state = 'in_arena'; bh.activityId = arenaId; bh.lastChange = now; }
  if (blackP.isBot && blackName !== WATCHER_NAME) { const bh = botInitBehavior(blackName); bh.state = 'in_arena'; bh.activityId = arenaId; bh.lastChange = now; }
  else if (blackName === WATCHER_NAME) { const bh = botInitBehavior(WATCHER_NAME); bh.state = 'in_arena'; bh.activityId = arenaId; bh.lastChange = now; }
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
  state.top3 = all.slice(0, 3).map(p => ({
    username: p.username, rating: p.rating,
    score: p.score || 0,
    wins: p.wins || 0, draws: p.draws || 0, losses: p.losses || 0,
    games: (p.wins || 0) + (p.draws || 0) + (p.losses || 0),
    winStreak: p.winStreak || 0, drawStreak: p.drawStreak || 0
  }));
  const sysMsg = { id: 'sys' + Date.now(), system: true, text: `🏆 Арена "${state.name}" завершена!`, ts: Date.now(), arenaId: state.id };
  state.chat.push(sysMsg); if (state.chat.length > 300) state.chat.shift();
  io.emit('arenaChatMessage', sysMsg);
  io.emit('arenaFinished', { arenaId: state.id, arenaName: state.name, top3: state.top3 });
  io.emit('arenaUpdate', { arenaId: state.id });
  for (const [name, p] of [...state.participants.entries()]) {
    if (p.isBot) {
      const bh = botInitBehavior(name);
      if (bh.state === 'in_arena' && bh.activityId === state.id) { bh.state = 'idle'; bh.activityId = null; bh.lastChange = Date.now(); }
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
      const instance = { id: `${tpl.id}-${t}`, templateId: tpl.id, name: tpl.name, description: tpl.description, timeControl: tpl.timeControl, increment: tpl.increment, durationMin: tpl.durationMin, color: tpl.color, startsAt: t, endsAt, status, botFriendly: !!tpl.botFriendly, lane: tpl.lane };
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

setInterval(() => {
  const now = Date.now();
  for (const [id, lobby] of lobbies.entries()) {
    if (!lobby.started || lobby.finished) continue;
    if (lobby.isSelfPlay) continue;
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

function uciFromSquares(from, to) {
  if (!from || !to) return null;
  return String.fromCharCode(97 + from[1]) + (8 - from[0])
       + String.fromCharCode(97 + to[1]) + (8 - to[0]);
}
function buildUciHistoryLine(lobby, maxMoves) {
  if (!lobby || !Array.isArray(lobby.history)) return '';
  const hist = maxMoves ? lobby.history.slice(-maxMoves) : lobby.history;
  const parts = [];
  for (const h of hist) {
    const uci = uciFromSquares(h.from, h.to);
    if (uci) parts.push(uci);
  }
  return parts.join(' ');
}

function scheduleBotMove(lobbyId) {
  const l = lobbies.get(lobbyId);
  if (!l || l.finished || !l.isBot) return;
  if (l.isSelfPlay) return;
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
  if (botMoves.length === 1) {
    const delay = 150 + Math.random() * 200;
    setTimeout(() => {
      const cur = lobbies.get(lobbyId);
      if (!cur || cur.finished || cur.turn !== botColor) return;
      const stillBot = (cur.botColor === botColor && cur.botName === botName) || (cur.botColor2 === botColor && cur.botName2 === botName);
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
      if (cur.history.length > 40) cur.history.shift();
      const now = Date.now();
      const elapsed = Math.floor((now - cur.lastTick) / 1000);
      if (botColor === 'w') cur.timeW = Math.max(0, cur.timeW - elapsed) + cur.inc;
      else cur.timeB = Math.max(0, cur.timeB - elapsed) + cur.inc;
      cur.lastTick = now;
      cur.fen = botToFen(nextState); cur.turn = nextState.turn; cur.drawOffer = null;
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
  let delay;
  if (botName === WATCHER_NAME) {
    const remainMs = botTimeLeft * 1000;
    if (remainMs < 2000) delay = 30 + Math.random() * 40;
    else if (remainMs < 5000) delay = 50 + Math.random() * 100;
    else if (remainMs < 10000) delay = 100 + Math.random() * 200;
    else if (remainMs < 30000) delay = 150 + Math.random() * 300;
    else delay = 300 + Math.random() * 500;
  } else {
    const remainMs = botTimeLeft * 1000;
    if (remainMs < 2000) delay = 30 + Math.random() * 40;
    else if (remainMs < 5000) delay = 50 + Math.random() * 100;
    else if (remainMs < 10000) delay = 100 + Math.random() * 200;
    else {
      let frac;
      if (remainMs < 30000) frac = 0.020;
      else if (remainMs < 60000) frac = 0.025;
      else if (remainMs < 180000) frac = 0.030;
      else if (remainMs < 600000) frac = 0.025;
      else frac = 0.020;
      const incBoostMs = Math.min(inc * 1000 * 0.6, remainMs * 0.05);
      let thinkMs = remainMs * frac + incBoostMs;
      thinkMs = Math.max(80, Math.min(3000, thinkMs));
      thinkMs = Math.min(thinkMs, remainMs / 15);
      const jitter = 0.7 + Math.random() * 0.5;
      delay = thinkMs * jitter;
      if (botInCheck(state, botIsWhiteTurn)) delay *= 1.2;
      let hasCapture = false;
      for (const [from, to] of botMoves) if (state.board[to[0]][to[1]]) { hasCapture = true; break; }
      if (hasCapture) delay *= 1.1;
      const maxThinkMs = Math.max(80, Math.min(3000, Math.floor(remainMs * 0.20)));
      if (delay > maxThinkMs) delay = maxThinkMs;
      if (delay < 80) delay = 80;
      if (isBotVsBot) delay = Math.max(delay, 250);
    }
  }
  const botRating = BOT_STRENGTH[botName] || 1500;
  setTimeout(async () => {
    const cur = lobbies.get(lobbyId);
    if (!cur || cur.finished || cur.turn !== botColor) return;
    const stillBot = (cur.botColor === botColor && cur.botName === botName) || (cur.botColor2 === botColor && cur.botName2 === botName);
    if (!stillBot) return;
    const st = botParseFen(cur.fen);
    const myEval = evaluateCurrentPosition(cur.fen) * (botColor === 'w' ? 1 : -1);
    let resignThreshold;
    if (botName === WATCHER_NAME) resignThreshold = -3000;
    else if (botRating < 1100) resignThreshold = -2500;
    else if (botRating < 1350) resignThreshold = -3000;
    else if (botRating < 1600) resignThreshold = -3500;
    else if (botRating < 1850) resignThreshold = -4000;
    else if (botRating < 2000) resignThreshold = -4500;
    else resignThreshold = -5000;
    const minMovesBeforeResign = botName === WATCHER_NAME ? 40 : (botRating < 1500 ? 30 : 40);
    const myMaterial = botEvalMaterial(st, botColor === 'w');
    const oppMaterial = botEvalMaterial(st, botColor !== 'w');
    const materialDiff = myMaterial - oppMaterial;
    const myQueen = (() => { const q = botColor === 'w' ? 'Q' : 'q'; for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (st.board[r][c] === q) return true; return false; })();
    const oppQueen = (() => { const q = botColor === 'w' ? 'q' : 'Q'; for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (st.board[r][c] === q) return true; return false; })();
    if (myEval < resignThreshold && st.full > minMovesBeforeResign && materialDiff < -900 && !myQueen && oppQueen) {
      const myMoves = botAllLegalMoves(st, botColor === 'w');
      let hasMateIn1 = false, hasAnyCounterplay = false;
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
        finishGame(lobbyId, botColor === 'w' ? 'b' : 'w', 'Сдача');
        return;
      }
    }
    if (Math.abs(myEval) < 15 && st.full > 60 && !cur.drawOffer && !cur.botDrawOffered && Math.abs(materialDiff) < 100) {
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
          const otherRating = BOT_STRENGTH[otherName] || 1500;
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
      const line = buildUciHistoryLine(cur, 40);
      const posCounts = cur.positionCounts || new Map();
      try {
        mv = watcherLearning.pickMove(
          cur.fen,
          botColor,
          { timeLeft: botTimeLeft, inc: inc, total: cur.time },
          null,
          line,
          posCounts
        );
      } catch (e) {
        console.error('[Watcher] pickMove error:', e.message);
        mv = null;
      }
      if (!mv) {
        const legal = botAllLegalMoves(st, botColor === 'w');
        if (legal.length > 0) {
          const pick = legal[Math.floor(Math.random() * legal.length)];
          mv = { from: pick[0], to: pick[1] };
          console.warn('[Watcher] pickMove вернул null, играю fallback:', mv);
        } else {
          return;
        }
      }
    } else {
      const historyLine = buildUciHistoryLine(cur, 40);
      const safeTimeLeft = Math.max(botTimeLeft, 3); // <--- ФИКС: гарантируем минимум 3 секунды
      try { mv = await botPool.getMove(cur.fen, botRating, cur.time, safeTimeLeft, inc, historyLine); }
      catch (err) { return; }
    }
    if (!mv) {
      const legal = botAllLegalMoves(st, botColor === 'w');
      if (legal.length > 0) {
        const pick = legal[Math.floor(Math.random() * legal.length)];
        mv = { from: pick[0], to: pick[1] };
      } else return;
    }
    const from = Array.isArray(mv.from) ? mv.from : (Array.isArray(mv[0]) ? mv[0] : null);
    const to = Array.isArray(mv.to) ? mv.to : (Array.isArray(mv[1]) ? mv[1] : null);
    if (!from || !to || from.length !== 2 || to.length !== 2) return;
    const cur2 = lobbies.get(lobbyId);
    if (!cur2 || cur2.finished || cur2.turn !== botColor) return;
    const stillBot2 = (cur2.botColor === botColor && cur2.botName === botName) || (cur2.botColor2 === botColor && cur2.botName2 === botName);
    if (!stillBot2 || cur2.fen !== cur.fen) return;
    const st2 = botParseFen(cur2.fen);
    const legal = botLegalMovesFor(st2, from[0], from[1]);
    if (!legal.some(([r, c]) => r === to[0] && c === to[1])) {
      const allLegal = botAllLegalMoves(st2, botColor === 'w');
      if (allLegal.length === 0) return;
      const pick = allLegal[Math.floor(Math.random() * allLegal.length)];
      const fromFb = pick[0], toFb = pick[1];
      const capturedFb = st2.board[toFb[0]][toFb[1]];
      const nextStateFb = botApplyMove(st2, fromFb, toFb);
      if (!cur2.history) cur2.history = [];
      cur2.history.push({ from: fromFb, to: toFb, captured: capturedFb || null, byColor: botColor, ts: Date.now() });
      if (cur2.history.length > 40) cur2.history.shift();
      const nowFb = Date.now();
      const elapsedFb = Math.floor((nowFb - cur2.lastTick) / 1000);
      if (botColor === 'w') cur2.timeW = Math.max(0, cur2.timeW - elapsedFb) + cur2.inc;
      else cur2.timeB = Math.max(0, cur2.timeB - elapsedFb) + cur2.inc;
      cur2.lastTick = nowFb;
      cur2.fen = botToFen(nextStateFb); cur2.turn = nextStateFb.turn;
      cur2.drawOffer = null; cur2.botDrawOffered = false;
      registerPosition(cur2);
      emitToGameAndWatchers(lobbyId, 'boardUpdate', { fen: cur2.fen, turn: cur2.turn, san: null, from: fromFb, to: toFb });
      emitToGameAndWatchers(lobbyId, 'timeUpdate', { timeW: cur2.timeW, timeB: cur2.timeB, serverNow: nowFb });
      broadcastLiveGames();
      if (checkAutoDraw(lobbyId)) return;
      const sideToMoveWhiteFb = cur2.turn === 'w';
      const hasMovesFb = botAllLegalMoves(botParseFen(cur2.fen), sideToMoveWhiteFb).length > 0;
      if (!hasMovesFb) {
        if (botInCheck(botParseFen(cur2.fen), sideToMoveWhiteFb)) finishGame(lobbyId, sideToMoveWhiteFb ? 'b' : 'w', 'Мат');
        else finishGame(lobbyId, 'draw', 'Пат');
      } else if (cur2.isBot && ((cur2.botColor && cur2.turn === cur2.botColor) || (cur2.botColor2 && cur2.turn === cur2.botColor2))) {
        const nextDelayFb = isBotVsBot ? (400 + Math.random() * 600) : (250 + Math.random() * 400);
        setTimeout(() => scheduleBotMove(lobbyId), nextDelayFb);
      }
      return;
    }
    const captured = st2.board[to[0]][to[1]];
    const prevFen = cur2.fen;
    const nextState = botApplyMove(st2, from, to);
    if (!cur2.history) cur2.history = [];
    cur2.history.push({ from, to, captured: captured || null, byColor: botColor, ts: Date.now() });
    if (cur2.history.length > 40) cur2.history.shift();
    const now = Date.now();
    const elapsed = Math.floor((now - cur2.lastTick) / 1000);
    if (botColor === 'w') cur2.timeW = Math.max(0, cur2.timeW - elapsed) + cur2.inc;
    else cur2.timeB = Math.max(0, cur2.timeB - elapsed) + cur2.inc;
    cur2.lastTick = now;
    cur2.fen = botToFen(nextState); cur2.turn = nextState.turn;
    cur2.drawOffer = null; cur2.botDrawOffered = false;
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

async function getDialogs(username) {
  const rows = await pool.query(`
    WITH pairs AS (
      SELECT CASE WHEN from_user = $1 THEN to_user ELSE from_user END AS other,
        GREATEST(from_user, to_user) AS a, LEAST(from_user, to_user) AS b, MAX(created_at) AS last_at
      FROM messages WHERE (from_user = $1 OR to_user = $1) AND NOT (hidden_for LIKE '%' || $1 || '%')
      GROUP BY other, a, b
    )
    SELECT p.other AS other, p.last_at AS last_at, m.text AS last_text, m.from_user AS last_from,
      (SELECT COUNT(*) FROM messages WHERE to_user = $1 AND from_user = p.other AND read_at = 0 AND NOT (hidden_for LIKE '%' || $1 || '%'))::int AS unread
    FROM pairs p
    LEFT JOIN messages m ON ((m.from_user = p.a AND m.to_user = p.b) OR (m.from_user = p.b AND m.to_user = p.a)) AND m.created_at = p.last_at
    ORDER BY p.last_at DESC LIMIT 100;
  `, [username]);
  return rows.rows;
}
async function getHistory(username, other, markRead) {
  const res = await pool.query(`
    SELECT id, from_user, to_user, text, created_at, read_at FROM messages
    WHERE ((from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1))
      AND NOT (hidden_for LIKE '%' || $1 || '%')
    ORDER BY created_at ASC LIMIT 500;
  `, [username, other]);
  if (markRead) await pool.query(`UPDATE messages SET read_at = $1 WHERE to_user = $2 AND from_user = $3 AND read_at = 0`, [Date.now(), username, other]);
  return res.rows;
}
async function unreadCount(username) {
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM messages WHERE to_user = $1 AND read_at = 0 AND NOT (hidden_for LIKE '%' || $1 || '%')`, [username]);
  return r.rows[0].n || 0;
}

app.get('/api/verify', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Токен не указан');

  try {
    const r = await pool.query('SELECT username, verify_token_expires FROM users WHERE verify_token = $1', [token]);
    if (!r.rows.length) return res.status(400).send('Неверный или устаревший токен');

    const { username, verify_token_expires } = r.rows[0];
    if (Date.now() > Number(verify_token_expires)) {
      return res.status(400).send('Срок действия токена истек. Зарегистрируйтесь заново.');
    }

    await pool.query(
      'UPDATE users SET email_verified = TRUE, verify_token = NULL, verify_token_expires = 0 WHERE username = $1',
      [username]
    );

    if (db.users[username]) {
      db.users[username].emailVerified = true;
    }

    res.redirect('/#/autorize?verified=1&username=' + encodeURIComponent(username));
  } catch (e) {
    console.error('[Verify] Ошибка:', e);
    res.status(500).send('Внутренняя ошибка сервера');
  }
});

app.get('/api/delete-account', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Токен не указан');
  try {
    const r = await pool.query('SELECT username FROM users WHERE delete_token = $1 AND delete_requested_at > 0', [token]);
    if (!r.rows.length) return res.status(400).send('Неверный или устаревший токен удаления');
    const username = r.rows[0].username;
    if (db.users[username]) {
      const u = db.users[username];
      if (Date.now() - u.deleteRequestedAt < 10 * 24 * 3600 * 1000) {
        return res.status(400).send('Прошло меньше 10 дней. Подождите.');
      }
      await pool.query('DELETE FROM users WHERE username = $1', [username]);
      delete db.users[username];
      console.log(`[Delete] Аккаунт ${username} удален.`);
      res.send('Аккаунт успешно удален. Вы можете закрыть эту страницу.');
    } else {
      res.status(404).send('Пользователь не найден');
    }
  } catch (e) {
    console.error('[Delete] Ошибка:', e);
    res.status(500).send('Внутренняя ошибка сервера');
  }
});

io.on('connection', (socket) => {
  socket.emit('stats', {
    online: countOnline(), games: db.totalGames, activeGames: countActiveLobbies(),
    waitingLobbies: countWaitingLobbies().human,
    waitingBotLobbies: countWaitingLobbies().bot,
    waitingMax: MAX_HUMAN_WAITING
  });
  socket.emit('liveGamesUpdate', buildGamesList());

  socket.on('checkUsername', async ({ username }, cb) => {
    if (typeof cb !== 'function') return;
    if (!username || username.length < 2) return cb({ available: false, msg: 'Минимум 2 символа' });
    if (ALL_BOT_NAMES.has(username)) return cb({ available: false, msg: 'Зарезервировано' });
    if (!/^[a-zA-Zа-яА-Я0-9_\-]+$/.test(username)) return cb({ available: false, msg: 'Только буквы, цифры, _ и -' });
    const u = db.users[username];
    if (u) return cb({ available: false, msg: 'Ник занят' });
    cb({ available: true, msg: 'Ник свободен' });
  });

  socket.on('checkEmail', async ({ email }, cb) => {
    if (typeof cb !== 'function') return;
    if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) return cb({ available: false, msg: 'Некорректный email' });
    const emailCheck = await pool.query('SELECT username FROM users WHERE email = $1', [email]);
    if (emailCheck.rows.length > 0) return cb({ available: false, msg: 'Почта уже используется' });
    cb({ available: true, msg: 'Почта свободна' });
  });

  socket.on('register', async ({ username, password, email }, cb) => {
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
      if (user.emailVerified === false && user.email) {
        try {
          if (!user.verifyToken || Number(user.verifyExpires || 0) < Date.now()) {
            user.verifyToken = crypto.randomBytes(32).toString('hex');
            user.verifyExpires = Date.now() + 24 * 60 * 60 * 1000;
            await pool.query('UPDATE users SET verify_token = $1, verify_token_expires = $2 WHERE username = $3',
              [user.verifyToken, user.verifyExpires, username]);
          }
          await sendVerificationEmail(user.email, username, user.verifyToken);
          return cb({ ok: false, msg: 'Письмо подтверждения отправлено повторно. Проверьте почту и папку «Спам».', pending: true });
        } catch (mailErr) {
          console.error('[Mail Error] Повторная отправка подтверждения:', mailErr.message);
          return cb({ ok: false, msg: 'Аккаунт ожидает подтверждения, но письмо отправить не удалось. Проверьте настройки почты на сервере.', pending: true });
        }
      }
    } else {
      if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
        return cb({ ok: false, msg: 'Укажите корректный email' });
      }
      const emailCheck = await pool.query('SELECT username FROM users WHERE email = $1', [email]);
      if (emailCheck.rows.length > 0 && emailCheck.rows[0].username !== username) {
        return cb({ ok: false, msg: 'Этот email уже используется другим аккаунтом' });
      }

      const salt = newSalt();
      const passwordHash = hashPassword(password, salt);
      const base = 1200;
      const verifyToken = crypto.randomBytes(32).toString('hex');
      const verifyExpires = Date.now() + 24 * 60 * 60 * 1000;

      db.users[username] = {
        passwordHash, salt, rating: base, rd: GLICKO2.DEFAULT_RD, vol: GLICKO2.DEFAULT_VOL,
        wins: 0, losses: 0, draws: 0, games: 0,
        createdAt: Date.now(), mutedUntil: 0, isBot: false,
        email: email, emailVerified: false, verifyToken: verifyToken, verifyExpires: verifyExpires,
        bio: '', deleteToken: null, deleteRequestedAt: 0, showSubseconds: false, isBanned: false, bannedUntil: 0,
        categories: { classical: emptyRatingBlock(base), rapid: emptyRatingBlock(base), blitz: emptyRatingBlock(base), bullet: emptyRatingBlock(base) }
      };

      try { await saveUser(username); } catch (err) { console.error(err); return cb({ ok: false, msg: 'Ошибка БД при создании' }); }
      try {
        await sendVerificationEmail(email, username, verifyToken);
        return cb({ ok: false, msg: 'Аккаунт создан! Проверьте почту и папку «Спам».', pending: true });
      } catch (mailErr) {
        console.error('[Mail Error] Подтверждение регистрации:', mailErr.message);
        return cb({ ok: false, msg: 'Аккаунт создан, но письмо не отправлено. Попробуйте войти с тем же логином и паролем после настройки почты на сервере.', pending: true });
      }
    }

    online.set(socket.id, username);
    socket.username = username;
    cb({ ok: true, user: publicUser(username) });
    broadcastOnline();
    const un = await unreadCount(username);
    socket.emit('msgUnread', { count: un });
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
      const historyRes = await pool.query(
        `SELECT white, black, white_before, black_before, white_after, black_after, finished_at, category
         FROM games WHERE white = $1 OR black = $1 ORDER BY finished_at ASC, id ASC`, [username]);
      const history = [{ ts: u.createdAt, rating: 1200 }];
      const categoryHistory = historyRes.rows.map(r => ({
        white: r.white, black: r.black,
        whiteBefore: r.white_before, blackBefore: r.black_before,
        whiteAfter: r.white_after, blackAfter: r.black_after,
        finishedAt: Number(r.finished_at), category: r.category || 'blitz'
      }));
      for (const r of historyRes.rows) history.push({ ts: Number(r.finished_at), rating: r.white === username ? r.white_after : r.black_after });
      const user = publicUser(username); user.online = isUserOnline(username) || !!u.isBot;
      cb({ ok: true, user, games, history, categoryHistory });
    } catch (err) { cb({ ok: false, msg: 'Ошибка базы данных' }); }
  });

  socket.on('getStats', (cb) => {
    if (typeof cb !== 'function') return;
    const counts = countWaitingLobbies();
    cb({ online: countOnline(), games: db.totalGames, activeGames: countActiveLobbies(), waitingLobbies: counts.human, waitingBotLobbies: counts.bot, waitingMax: MAX_HUMAN_WAITING });
  });
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
      return { name: b.name, title: b.title, desc: b.desc, level: b.level, rating: b.rating, initialRating: b.rating, games: u ? u.games : 0, wins: u ? u.wins : 0, losses: u ? u.losses : 0, draws: u ? u.draws : 0, strength: b.strength };
    }));
  });

  socket.on('getGameState', ({ lobbyId: lid }, cb) => {
    if (typeof cb !== 'function') return;
    const l = lobbies.get(lid);
    if (!l) return cb({ ok: false, msg: 'Партия не найдена' });
    if (l.isSelfPlay) return cb({ ok: false, msg: 'Это просмотр self-play партии. Используйте watchGame.' });
    if (socket.username !== l.host && socket.username !== l.guest) return cb({ ok: false, msg: 'Вы не участник' });
    if (l.host === socket.username) l.hostSocket = socket.id; else l.guestSocket = socket.id;
    if (socket.username === l.host && !l.guestSocket && !l.isBot) return cb({ ok: false, msg: 'Соперник ещё не подключился' });
    socket.join(lid); socketToLobby.set(socket.id, lid); socket.lobbyId = lid;
    const myColor = socket.username === l.host ? l.hostColor : l.guestColor;
    const opponentName = socket.username === l.host ? l.guest : l.host;
    const opponentU = db.users[opponentName];
    cb({ ok: true, state: {
      myColor, opponent: opponentName, opponentRating: opponentU ? opponentU.rating : null,
      opponentIsAdmin: isAdmin(opponentName), opponentIsMod: isMod(opponentName),
      opponentOnline: isUserOnline(opponentName) || ALL_BOT_NAMES.has(opponentName),
      time: l.time, inc: l.inc, timeW: l.timeW, timeB: l.timeB, turn: l.turn,
      fen: l.fen, chat: l.chat, arenaId: l.arenaId, arenaName: l.arenaName,
      finished: l.finished, isSelfPlay: !!l.isSelfPlay, isBot: !!l.isBot && !l.isSelfPlay && l.host !== WATCHER_NAME && l.guest !== WATCHER_NAME,
      watchersCount: watchersCountOf(l)
    }});
  });

  socket.on('watchGame', ({ id }, cb) => {
    const l = lobbies.get(id);
    if (!l || l.finished || !l.started) { if (typeof cb === 'function') cb({ ok: false, msg: 'Партия недоступна' }); return; }
    socket.join('watch:' + id);
    if (!l.watchers) l.watchers = new Set();
    l.watchers.add(socket.id);
    io.emit('lobbiesUpdate'); broadcastWatchers(id); broadcastLiveGames();
    const whiteName = l.isSelfPlay ? SELF_PLAY_BOT_ID : (l.hostColor === 'w' ? l.host : l.guest);
    const blackName = l.isSelfPlay ? SELF_PLAY_BOT_ID : (l.hostColor === 'b' ? l.host : l.guest);
    const lastHist = (l.history && l.history.length) ? l.history[l.history.length - 1] : null;
    if (typeof cb === 'function') cb({ ok: true, game: {
      id, white: whiteName, black: blackName,
      whiteRating: l.isSelfPlay ? (db.users[WATCHER_NAME] ? db.users[WATCHER_NAME].rating : 1500) : (db.users[whiteName] ? db.users[whiteName].rating : null),
      blackRating: l.isSelfPlay ? (db.users[WATCHER_NAME] ? db.users[WATCHER_NAME].rating : 1500) : (db.users[blackName] ? db.users[blackName].rating : null),
      whiteIsAdmin: false, blackIsAdmin: false,
      whiteIsMod: false, blackIsMod: false,
      whiteIsBot: l.isSelfPlay ? true : !!(db.users[whiteName] && db.users[whiteName].isBot),
      blackIsBot: l.isSelfPlay ? true : !!(db.users[blackName] && db.users[blackName].isBot),
      timeW: l.timeW, timeB: l.timeB, turn: l.turn,
      timeControl: l.time, increment: l.inc, fen: l.fen,
      lastMove: lastHist && lastHist.from && lastHist.to ? { from: lastHist.from, to: lastHist.to } : null,
      isArena: !!l.arenaId, arenaName: l.arenaName || null,
      watchersCount: watchersCountOf(l)
    }});
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
      if (l.isSelfPlay) continue;
      if (l.isBot && !l.isWatcher) continue;
      list.push({ id, host: l.host, time: l.time, inc: l.inc, hostIsAdmin: isAdmin(l.host), hostIsMod: isMod(l.host), status: l.guest ? 'playing' : 'waiting', isBot: l.isWatcher });
    }
    const counts = countWaitingLobbies();
    cb({ list, max: MAX_HUMAN_WAITING, current: counts.human, botCurrent: counts.bot, botMax: MAX_BOT_WAITING });
  });

  socket.on('createLobby', ({ time, inc }, cb) => {
    if (typeof cb !== 'function') return;
    if (!socket.username) return cb({ ok: false, msg: 'Не авторизован' });
    time = Math.max(0.5, Math.min(60, +time || 5));
    inc = Math.max(0, Math.min(60, +inc || 0));

    let myWaiting = null;
    for (const [, l] of lobbies.entries()) {
      if (l.finished || l.arenaId) continue;
      if (l.started || l.guest || l.isSelfPlay) continue;
      if (l.host !== socket.username) continue;
      if (l.hostSocket && !io.sockets.sockets.has(l.hostSocket)) {
        lobbies.delete(l.id);
        continue;
      }
      myWaiting = l;
      break;
    }
    if (!myWaiting) {
      for (const [id, l] of lobbies.entries()) {
        if (!l || l.finished || l.arenaId || l.started || l.guest || l.isSelfPlay) continue;
        if (l.isBot) continue;
        if (l.hostSocket && !io.sockets.sockets.has(l.hostSocket)) {
          lobbies.delete(id);
        }
      }
    }

    let matched = null;
    for (const [, l] of lobbies.entries()) {
      if (l.finished || l.arenaId || (l.isBot && !l.isWatcher) || l.guest || l.isSelfPlay) continue;
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

  socket.on('playWithBot', ({ time, inc, botName }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    if (!socket.username) return cb({ ok: false, msg: 'Не авторизован' });
    time = Math.max(0.5, Math.min(60, +time || 5));
    inc = Math.max(0, Math.min(60, +inc || 0));
    const bot = BOTS.find(b => b.name === botName && !b.hidden);
    if (!bot) return cb({ ok: false, msg: 'Бот не найден' });
    if (botIsBusy(bot.name)) return cb({ ok: false, msg: 'Бот занят другой партией' });
    const botRating = bot.rating;
    const id = genId();
    const newLobby = {
      id, host: socket.username, hostSocket: socket.id, guest: bot.name, guestSocket: null,
      hostColor: 'w', guestColor: 'b', time, inc, timeW: time * 60, timeB: time * 60,
      turn: 'w', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      started: true, finished: false, lastTick: Date.now(), chat: [], drawOffer: null,
      createdAt: Date.now(), rematch: null, isBot: true, botName: bot.name, botColor: 'b', history: [], positionCounts: new Map()
    };
    lobbies.set(id, newLobby); registerPosition(newLobby);
    socket.join(id); socketToLobby.set(socket.id, id); socket.lobbyId = id;
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
    broadcastLobbies(); broadcastOnline(); broadcastLiveGames();
  });

  socket.on('cancelLobby', ({ id }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    if (!socket.username) return cb({ ok: false, msg: 'Не авторизован' });
    const l = lobbies.get(id);
    if (!l) return cb({ ok: false, msg: 'Лобби не найдено' });
    if (l.host !== socket.username) return cb({ ok: false, msg: 'Это не ваше лобби' });
    if (l.started) return cb({ ok: false, msg: 'Партия уже началась' });
    io.to(id).emit('opponentLeft');
    lobbies.delete(id); socketToLobby.delete(socket.id); socket.lobbyId = null;
    broadcastLobbies(); broadcastOnline();
    cb({ ok: true });
  });

  socket.on('joinLobby', ({ id }, cb) => {
    if (typeof cb !== 'function') return;
    if (!socket.username) return cb({ ok: false, msg: 'Не авторизован' });
    const l = lobbies.get(id);
    if (!l) return cb({ ok: false, msg: 'Лобби не найдено' });
    if (l.finished) return cb({ ok: false, msg: 'Партия завершена' });
    if (l.isSelfPlay) return cb({ ok: false, msg: 'Это self-play партия. Можно только смотреть.' });
    if (l.guest) return cb({ ok: false, msg: 'Лобби занято' });
    if (l.host === socket.username) return cb({ ok: false, msg: 'Это ваше лобби' });
    if (socket.username === WATCHER_NAME && l.host === WATCHER_NAME) return cb({ ok: false, msg: 'Занято' });
    for (const [, other] of lobbies.entries()) {
      if (other.finished) continue;
      if (other.isSelfPlay) continue;
      if ((other.host === socket.username || other.guest === socket.username) && other !== l) {
        return cb({ ok: false, msg: 'Вы уже в другой партии/лобби' });
      }
    }
    l.guest = socket.username; l.guestSocket = socket.id;
    let hostIsWhite;
    if (l.isWatcher) hostIsWhite = true;
    else hostIsWhite = Math.random() < 0.5;
    l.hostColor = hostIsWhite ? 'w' : 'b';
    l.guestColor = hostIsWhite ? 'b' : 'w';
    if (l.isWatcher) { l.botColor = l.hostColor; l.botColor2 = null; l.botName = WATCHER_NAME; l.botName2 = null; }
    l.started = true; l.lastTick = Date.now();
    if (!l.positionCounts) l.positionCounts = new Map();
    registerPosition(l);
    socket.join(id); socketToLobby.set(socket.id, id); socket.lobbyId = id;
    const hostRating = db.users[l.host] ? db.users[l.host].rating : null;
    const guestRating = db.users[l.guest] ? db.users[l.guest].rating : null;
    if (l.isBot) { const beh = botInitBehavior(l.host); beh.state = 'playing'; beh.lastChange = Date.now(); }
    const hostIsWatcher = l.host === WATCHER_NAME;
    const guestIsWatcher = l.guest === WATCHER_NAME;
    io.to(l.hostSocket).emit('gameStart', { color: l.hostColor, opponent: l.guest, opponentRating: guestRating, opponentIsAdmin: isAdmin(l.guest), opponentIsMod: isMod(l.guest), opponentOnline: true, time: l.time, inc: l.inc, lobbyId: id, fen: l.fen, chat: l.chat, isArena: false, isBot: !!l.isBot && !hostIsWatcher && !guestIsWatcher, botName: l.isBot && !guestIsWatcher ? l.host : undefined });
    io.to(l.guestSocket).emit('gameStart', { color: l.guestColor, opponent: l.host, opponentRating: hostRating, opponentIsAdmin: isAdmin(l.host), opponentIsMod: isMod(l.host), opponentOnline: true, time: l.time, inc: l.inc, lobbyId: id, fen: l.fen, chat: l.chat, isArena: false, isBot: !!l.isBot && !hostIsWatcher && !guestIsWatcher, botName: l.isBot && !hostIsWatcher ? l.host : undefined });
    if (l.isBot) setTimeout(() => scheduleBotMove(l.id), l.isWatcher ? 1500 : 500);
    cb({ ok: true, id });
    broadcastLobbies(); broadcastOnline(); broadcastLiveGames();
  });

  socket.on('move', ({ lobbyId, fen, turn, san }) => {
    const l = lobbies.get(lobbyId);
    if (!l || l.finished || !l.started) return;
    if (l.isSelfPlay) return;
    if (socket.id !== l.hostSocket && socket.id !== l.guestSocket) return;
    const myColor = socket.id === l.hostSocket ? l.hostColor : l.guestColor;
    if (l.turn !== myColor) return;
    if (typeof fen !== 'string' || fen.split(' ').length < 6) return;
    const newTurn = fen.split(' ')[1];
    if (newTurn === l.turn) return;
    let fromSq = null, toSq = null;
    try {
      const oldState = botParseFen(l.fen); const newState = botParseFen(fen);
      let captured = null;
      for (let r = 0; r < 8 && !fromSq; r++) for (let c = 0; c < 8; c++) if (oldState.board[r][c] && !newState.board[r][c]) { fromSq = [r, c]; break; }
      if (fromSq) {
        const piece = oldState.board[fromSq[0]][fromSq[1]];
        for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
          const oldP = oldState.board[r][c], newP = newState.board[r][c];
          if (newP === piece && oldP !== piece && !(r === fromSq[0] && c === fromSq[1])) { toSq = [r, c]; captured = (oldP && oldP !== piece) ? oldP : null; break; }
        }
      }
      if (!l.history) l.history = [];
      l.history.push({ from: fromSq, to: toSq, captured, byColor: myColor, ts: Date.now() });
      if (l.history.length > 40) l.history.shift();
    } catch (e) {}
    const prevFenForWatcher = l.fen;
    const now = Date.now();
    const elapsed = Math.floor((now - l.lastTick) / 1000);
    if (myColor === 'w') l.timeW = Math.max(0, l.timeW - elapsed) + l.inc;
    else                 l.timeB = Math.max(0, l.timeB - elapsed) + l.inc;
    l.lastTick = now; l.fen = fen; l.turn = newTurn; l.drawOffer = null;
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
          if (moverColor !== watcherColor) watcherLearning.learnFromObservedMove(prevFenForWatcher, { from: fromSq, to: toSq }, fen, moverColor, { time: l.time, inc: l.inc }, evalAfter);
        } else if (isWatching) {
          watcherLearning.learnFromObservedMove(prevFenForWatcher, { from: fromSq, to: toSq }, fen, moverColor, { time: l.time, inc: l.inc }, evalAfter);
        }
      }
    } catch (e) {}
    if (l.isBot && ((l.botColor === l.turn) || (l.botColor2 && l.botColor2 === l.turn))) {
      scheduleBotMove(lobbyId);
    }
  });

  socket.on('resign', ({ lobbyId }) => {
    const l = lobbies.get(lobbyId);
    if (!l || l.finished) return;
    if (l.isSelfPlay) return;
    const myColor = socket.id === l.hostSocket ? l.hostColor : l.guestColor;
    finishGame(lobbyId, myColor === 'w' ? 'b' : 'w', 'Сдача');
  });

  socket.on('gameOver', ({ lobbyId, result }) => {
    const l = lobbies.get(lobbyId);
    if (!l) return;
    if (l.isSelfPlay) return;
    finishGame(lobbyId, result, 'Завершено');
  });

  socket.on('chatMessage', ({ lobbyId, text }) => {
    const l = lobbies.get(lobbyId);
    if (!l || !socket.username) return;
    if (l.isSelfPlay) return;
    const muteUntil = checkMute(socket.username);
    if (muteUntil > 0) { const mins = Math.ceil((muteUntil - Date.now()) / 60000); socket.emit('chatError', { msg: `Вы заглушены ещё ${mins} мин.` }); return; }
    if (typeof text !== 'string') return;
    text = text.trim().slice(0, 300); if (!text) return;
    const msg = { id: 'm' + Date.now() + Math.random().toString(36).slice(2, 6), user: socket.username, userIsAdmin: isAdmin(socket.username), userIsMod: isMod(socket.username), text, ts: Date.now() };
    l.chat.push(msg); if (l.chat.length > 50) l.chat.shift();
    emitToGameAndWatchers(lobbyId, 'chatMessage', msg);
  });

  socket.on('modDeleteMessage', ({ lobbyId, msgId }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    if (!isMod(socket.username)) return cb({ ok: false, msg: 'Нет прав' });
    const l = lobbies.get(lobbyId); if (!l) return cb({ ok: false, msg: 'Лобби нет' });
    const idx = l.chat.findIndex(m => m.id === msgId);
    if (idx < 0) return cb({ ok: false, msg: 'Сообщение не найдено' });
    l.chat.splice(idx, 1);
    emitToGameAndWatchers(lobbyId, 'chatMessageDeleted', { msgId, scope: 'game', lobbyId });
    cb({ ok: true });
  });

  socket.on('modMuteUser', ({ username, minutes, reason, scope, scopeId }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    if (!isMod(socket.username)) return cb({ ok: false, msg: 'Нет прав' });
    if (!db.users[username]) return cb({ ok: false, msg: 'Игрок не найден' });
    if (isAdmin(username) && !isAdmin(socket.username)) return cb({ ok: false, msg: 'Нельзя замутить админа' });
    
    minutes = Math.max(1, Math.min(7 * 24 * 60, +minutes || 10));
    setMute(username, minutes);
    const until = Date.now() + minutes * 60 * 1000;
    const reasonText = reason ? String(reason).slice(0, 100) : 'нарушение правил';

    // Системное сообщение в чат (только в тот, где замутили)
    if (scope && scopeId) {
      const sysMsg = {
        id: 'sys' + Date.now(),
        system: true,
        isMuteNotice: true,
        text: `${username} был заблокирован в чате на ${minutes} мин. Причина: ${reasonText}`,
        ts: Date.now()
      };
      
      if (scope === 'game') {
        const l = lobbies.get(scopeId);
        if (l) {
          l.chat.push(sysMsg);
          if (l.chat.length > 50) l.chat.shift();
          emitToGameAndWatchers(scopeId, 'chatMessage', sysMsg);
        }
      } else if (scope === 'arena') {
        const state = arenas.get(scopeId);
        if (state) {
          state.chat.push(sysMsg);
          if (state.chat.length > 300) state.chat.shift();
          io.to('arena:' + scopeId).emit('arenaChatMessage', sysMsg);
        }
      }
    }

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
    if (l.isSelfPlay) return;
    if (socket.id !== l.hostSocket && socket.id !== l.guestSocket) return;
    l.drawOffer = { by: socket.id, at: Date.now() };
    socket.to(lobbyId).emit('drawOffered', { from: socket.username });
    if (l.isBot) {
      const botColor = l.botColor === l.hostColor ? l.botColor : l.botColor2;
      const botName = l.botColor === l.hostColor ? l.botName : l.botName2;
      const botRating = BOT_STRENGTH[botName] || 1500;
      const myEval = evaluateCurrentPosition(l.fen) * (botColor === 'w' ? 1 : -1);
      let accept = false;
      if (botName === WATCHER_NAME) accept = Math.abs(myEval) < 50;
      else {
        if (botRating < 1100) accept = myEval < 100;
        else if (botRating < 1500) accept = myEval < 30;
        else if (botRating < 1800) accept = myEval < 0;
        else if (botRating < 2000) accept = myEval < -20;
        else accept = myEval < -50;
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
    if (l.isSelfPlay) return;
    l.drawOffer = null;
    finishGame(lobbyId, 'draw', 'Ничья по согласию');
  });
  socket.on('drawDecline', ({ lobbyId }) => {
    const l = lobbies.get(lobbyId);
    if (!l || l.finished) return;
    if (l.isSelfPlay) return;
    l.drawOffer = null;
    socket.to(lobbyId).emit('drawDeclined');
  });

  socket.on('rematchRequest', ({ lobbyId }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    let l = lobbies.get(lobbyId);
    if (l && l.isSelfPlay) return cb({ ok: false, msg: 'Нельзя' });
    let info = null;
    if (!l || l.finished) info = finishedGamesInfo.get(lobbyId);
    if (!info && socket.username) {
      const me = socket.username;
      for (const [key, rec] of finishedGamesInfo.entries()) if (key.startsWith('pair:') && rec && (rec.host === me || rec.guest === me)) { info = rec; break; }
    }
    if (!info && socket.username) {
      const me = socket.username;
      for (const [, rec] of finishedGamesInfo.entries()) if (rec && (rec.host === me || rec.guest === me)) { info = rec; break; }
    }
    if (!info && socket.username) {
      info = { host: socket.username, guest: null, hostSocket: socket.id, guestSocket: null, hostColor: 'w', guestColor: 'b', time: 5, inc: 0, isBot: false, botName: null, arenaId: null, finishedAt: Date.now(), lastLobbyId: lobbyId, rematch: {} };
      finishedGamesInfo.set('pair:unknown:' + socket.username + ':' + Date.now(), info);
    }
    if (!info) return cb({ ok: false, msg: 'Не удалось найти завершённую партию' });
    const isBotGame = l ? !!l.isBot : !!info.isBot;
    const botName = l ? (l.botName || l.botName2) : info.botName;
    if (isBotGame) {
      if (!botName) return cb({ ok: false, msg: 'Бот не найден' });
      const bot = BOTS.find(b => b.name === botName);
      if (!bot) return cb({ ok: false, msg: 'Бот не найден' });
      const hostName = l ? l.host : info.host;
      const hostSocketId = l ? l.hostSocket : info.hostSocket;
      const time = l ? l.time : info.time; const inc = l ? l.inc : info.inc;
      if (botIsBusy(bot.name)) return cb({ ok: true, started: false, declined: true });
      const botRating = bot.rating;
      let agreeChance = 0.9;
      if (bot.rating >= 1900) agreeChance = 0.35;
      else if (bot.rating >= 1700) agreeChance = 0.55;
      else if (bot.rating >= 1400) agreeChance = 0.7;
      setTimeout(() => {
        if (Math.random() > agreeChance || botIsBusy(bot.name)) { cb({ ok: true, started: false, declined: true }); return; }
        const newId = genId();
        const newLobby = {
          id: newId, host: hostName, hostSocket: hostSocketId, guest: bot.name, guestSocket: null,
          hostColor: 'w', guestColor: 'b', time, inc, timeW: time * 60, timeB: time * 60,
          turn: 'w', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          started: true, finished: false, lastTick: Date.now(), chat: [], drawOffer: null,
          createdAt: Date.now(), rematch: null, isBot: true, botName: bot.name, botColor: 'b', history: [], positionCounts: new Map()
        };
        lobbies.set(newId, newLobby); registerPosition(newLobby);
        const beh = botInitBehavior(bot.name); beh.state = 'playing'; beh.lastChange = Date.now();
        const hostSocket = io.sockets.sockets.get(hostSocketId);
        if (hostSocket) {
          if (l) hostSocket.leave(lobbyId);
          hostSocket.join(newId); socketToLobby.set(hostSocketId, newId); hostSocket.lobbyId = newId;
          hostSocket.emit('gameStart', { color: 'w', opponent: bot.name, opponentRating: botRating, opponentIsAdmin: false, opponentIsMod: false, opponentOnline: true, time, inc, lobbyId: newId, fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', chat: [], isArena: false, isBot: true, botName: bot.name });
        }
        if (l) lobbies.delete(lobbyId);
        finishedGamesInfo.delete(lobbyId);
        const pk2 = pairKeyFor(hostName, bot.name); if (pk2) finishedGamesInfo.delete(pk2);
        broadcastLobbies(); broadcastLiveGames();
        cb({ ok: true, started: true, newLobbyId: newId });
      }, 300 + Math.random() * 1000);
      return;
    }
    const host = l ? l.host : info.host; const guest = l ? l.guest : info.guest;
    const hostSocketId = l ? l.hostSocket : info.hostSocket;
    const guestSocketId = l ? l.guestSocket : info.guestSocket;
    const time = l ? l.time : info.time; const inc = l ? l.inc : info.inc;
    const hostColor = l ? l.hostColor : info.hostColor;
    const guestColor = l ? l.guestColor : info.guestColor;
    if (socket.username !== host && socket.username !== guest) return cb({ ok: false, msg: 'Вы не участник этой партии' });
    const storageKey = (info && info.lastLobbyId) ? info.lastLobbyId : lobbyId;
    if (!finishedGamesInfo.has(storageKey)) {
      finishedGamesInfo.set(storageKey, { host, guest, hostSocket: hostSocketId, guestSocket: guestSocketId, hostColor, guestColor, time, inc, isBot: false, botName: null, rematch: {}, finishedAt: Date.now() });
    }
    const rec = finishedGamesInfo.get(storageKey);
    if (!rec.rematch) rec.rematch = {};
    rec.rematch[socket.username] = true;
    const otherName = socket.username === host ? guest : host;
    let otherSocketId = socket.username === host ? guestSocketId : hostSocketId;
    if (!otherSocketId && otherName) for (const [sid, name] of online.entries()) if (name === otherName) { otherSocketId = sid; break; }
    if (socket.username === host) { rec.hostSocket = socket.id; if (otherSocketId) rec.guestSocket = otherSocketId; }
    else { rec.guestSocket = socket.id; if (otherSocketId) rec.hostSocket = otherSocketId; }
    if (rec.rematch[otherName]) {
      const newId = genId();
      const newLobby = {
        id: newId, host, hostSocket: rec.hostSocket, guest, guestSocket: rec.guestSocket,
        hostColor: guestColor, guestColor: hostColor, time, inc, timeW: time * 60, timeB: time * 60, turn: 'w',
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        started: true, finished: false, lastTick: Date.now(), chat: [], drawOffer: null,
        createdAt: Date.now(), arenaId: null, arenaName: null, rematch: null, isBot: false, history: [], positionCounts: new Map()
      };
      lobbies.set(newId, newLobby); registerPosition(newLobby);
      const hostRating = db.users[host] ? db.users[host].rating : null;
      const guestRating = db.users[guest] ? db.users[guest].rating : null;
      const hostSocket = io.sockets.sockets.get(rec.hostSocket);
      const guestSocket = io.sockets.sockets.get(rec.guestSocket);
      if (hostSocket) { if (l) hostSocket.leave(lobbyId); hostSocket.join(newId); socketToLobby.set(rec.hostSocket, newId); hostSocket.lobbyId = newId; hostSocket.emit('gameStart', { color: newLobby.hostColor, opponent: guest, opponentRating: guestRating, opponentIsAdmin: isAdmin(guest), opponentIsMod: isMod(guest), opponentOnline: isUserOnline(guest), time, inc, lobbyId: newId, fen: newLobby.fen, chat: [], isArena: false }); }
      if (guestSocket) { if (l) guestSocket.leave(lobbyId); guestSocket.join(newId); socketToLobby.set(rec.guestSocket, newId); guestSocket.lobbyId = newId; guestSocket.emit('gameStart', { color: newLobby.guestColor, opponent: host, opponentRating: hostRating, opponentIsAdmin: isAdmin(host), opponentIsMod: isMod(host), opponentOnline: isUserOnline(host), time, inc, lobbyId: newId, fen: newLobby.fen, chat: [], isArena: false }); }
      if (l) lobbies.delete(lobbyId);
      finishedGamesInfo.delete(lobbyId); finishedGamesInfo.delete(storageKey);
      const pk3 = pairKeyFor(host, guest); if (pk3) finishedGamesInfo.delete(pk3);
      broadcastLobbies(); broadcastLiveGames();
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
    const otherSocketId = l ? (socket.id === l.hostSocket ? l.guestSocket : l.hostSocket) : (rec ? (socket.username === rec.host ? rec.guestSocket : rec.hostSocket) : null);
    if (otherSocketId) io.to(otherSocketId).emit('rematchDeclined');
    cb({ ok: true });
  });

  socket.on('getArenas', (cb) => { if (typeof cb === 'function') cb({ list: getArenaSchedule(48), serverNow: Date.now() }); });

  socket.on('getMyArenaStates', (cb) => {
    if (typeof cb !== 'function') return;
    const states = {};
    for (const [id, state] of arenas.entries()) {
      const p = socket.username ? state.participants.get(socket.username) : null;
      states[id] = { joined: !!p, paused: !!(p && p.paused), participantsCount: state.participants.size, phase: state.phase, score: p ? p.score : 0, botFriendly: !!state.botFriendly, inArenaRoom: !!(p && p.inArenaRoom), cooldownUntil: p ? (p.cooldownUntil || 0) : 0 };
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
          if (!p.paused) { p.waitingSince = Date.now(); p.cooldownUntil = Date.now() + ARENA_COOLDOWN_MS; }
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
      isBot: !!p.isBot && p.username !== WATCHER_NAME,
      cooldownUntil: p.cooldownUntil || 0,
      history: p.history || []
    })).sort((a, b) => b.score - a.score || b.rating - a.rating);
    const meP = socket.username ? state.participants.get(socket.username) : null;
    cb({
      joined: !!meP, paused: !!(meP && meP.paused), participants,
      participantsCount: participants.length, phase: state.phase,
      timeLeftMs: Math.max(0, state.endsAt - Date.now()),
      timeLeftMin: Math.round(Math.max(0, state.endsAt - Date.now()) / 60000),
      top3: state.top3, pairingNow: state.pairingNow,
      startsAt: state.startsAt, endsAt: state.endsAt, serverNow: Date.now(),
      botFriendly: !!state.botFriendly, chatViewersCount: state.chatViewers.size
    });
  });

  socket.on('joinArenaRoom', ({ arenaId }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    const state = arenas.get(arenaId);
    if (!state) return cb({ ok: false, msg: 'Арена не найдена' });
    socket.join('arena:' + arenaId);
    state.chatViewers.add(socket.id);
    if (socket.username) {
      const p = state.participants.get(socket.username);
      if (p) p.inArenaRoom = true;
    }
    cb({ ok: true, chat: state.chat || [] });
    tryPair(state);
  });
  socket.on('leaveArenaRoom', ({ arenaId }) => {
    const state = arenas.get(arenaId);
    socket.leave('arena:' + arenaId);
    if (state) {
      state.chatViewers.delete(socket.id);
      if (socket.username) {
        const p = state.participants.get(socket.username);
        if (p && !p.isPlaying) p.inArenaRoom = false;
      }
    }
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
          fen: g.fen, turn: g.turn || 'w', timeW: 0, timeB: 0, finishedAt: g.finishedAt, live: false, watchersCount: 0
        });
      }
    }
    let topRating = 0;
    if (state) for (const p of state.participants.values()) if (p.rating > topRating) topRating = p.rating;
    live.sort((a, b) => Math.max(b.whiteRating||0, b.blackRating||0) - Math.max(a.whiteRating||0, a.blackRating||0));
    done.sort((a, b) => Math.max(b.whiteRating||0, b.blackRating||0) - Math.max(a.whiteRating||0, a.blackRating||0));
    cb({ live, done, topRating, featured: live[0] || done[0] || null, participantsCount: state ? state.participants.size : 0, chatViewersCount: state ? state.chatViewers.size : 0 });
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
      inArenaRoom: true, cooldownUntil: 0, awaitingNextPair: false,
      history: []
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
    p.awaitingNextPair = false;
    p.inArenaRoom = true;
    if (!p.paused) p.waitingSince = Date.now();
    io.to('arena:' + arenaId).emit('arenaUpdate', { arenaId });
    if (state.phase === 'live' && !p.paused) setTimeout(() => tryPair(state), 100);
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
    if (muteUntil > 0) { const mins = Math.ceil((muteUntil - Date.now()) / 60000); socket.emit('chatError', { msg: `Вы заглушены ещё ${mins} мин.` }); return; }
    if (typeof text !== 'string') return;
    text = text.trim().slice(0, 300); if (!text) return;
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

  socket.on('msgGetDialogs', async (cb) => {
    if (typeof cb !== 'function') return;
    if (!socket.username) return cb({ ok: false, msg: 'Не авторизован' });
    try { cb({ ok: true, dialogs: await getDialogs(socket.username) }); }
    catch (e) { cb({ ok: false, msg: 'Ошибка БД' }); }
  });
  socket.on('msgGetHistory', async ({ with: other, markRead }, cb) => {
    if (typeof cb !== 'function') return;
    if (!socket.username || !other) return cb({ ok: false, msg: 'Ошибка параметров' });
    try {
      const history = await getHistory(socket.username, other, markRead !== false);
      cb({ ok: true, history, other });
      if (markRead !== false) {
        const un = await unreadCount(socket.username);
        for (const sid of socketsOfUser(socket.username)) io.to(sid).emit('msgUnread', { count: un });
      }
    } catch (e) { cb({ ok: false, msg: 'Ошибка БД' }); }
  });
  socket.on('msgSend', async ({ to, text }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    if (!socket.username) return cb({ ok: false, msg: 'Не авторизован' });
    if (!to || typeof to !== 'string') return cb({ ok: false, msg: 'Не указан получатель' });
    if (typeof text !== 'string') return cb({ ok: false, msg: 'Пустое сообщение' });
    text = text.trim().slice(0, 2000);
    if (!text) return cb({ ok: false, msg: 'Пустое сообщение' });
    if (!db.users[to]) return cb({ ok: false, msg: 'Игрок не найден' });
    if (to === socket.username) return cb({ ok: false, msg: 'Нельзя писать самому себе' });
    const muteUntil = checkMute(socket.username);
    if (muteUntil > 0) { const mins = Math.ceil((muteUntil - Date.now()) / 60000); return cb({ ok: false, msg: `Вы заглушены ещё ${mins} мин.` }); }
    try {
      const now = Date.now();
      const r = await pool.query(
        `INSERT INTO messages (from_user, to_user, text, created_at, read_at) VALUES ($1, $2, $3, $4, 0)
         RETURNING id, from_user, to_user, text, created_at, read_at`,
        [socket.username, to, text, now]
      );
      const row = r.rows[0];
      const msgObj = { id: row.id, from: row.from_user, to: row.to_user, text: row.text, ts: Number(row.created_at), readAt: Number(row.read_at) };
      for (const sid of socketsOfUser(to)) io.to(sid).emit('msgNew', msgObj);
      for (const sid of socketsOfUser(socket.username)) io.to(sid).emit('msgNew', msgObj);
      const un = await unreadCount(to);
      for (const sid of socketsOfUser(to)) io.to(sid).emit('msgUnread', { count: un });
      cb({ ok: true, msg: msgObj });
    } catch (e) { cb({ ok: false, msg: 'Ошибка БД' }); }
  });
  socket.on('msgDeleteDialog', async ({ with: other }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    if (!socket.username || !other) return cb({ ok: false, msg: 'Ошибка параметров' });
    try {
      await pool.query(`
        UPDATE messages SET hidden_for = CASE
          WHEN hidden_for = '' OR hidden_for IS NULL THEN $1
          WHEN hidden_for LIKE '%' || $1 || '%' THEN hidden_for
          ELSE hidden_for || ',' || $1
        END
        WHERE (from_user = $2 AND to_user = $1) OR (from_user = $1 AND to_user = $2)
      `, [socket.username, other]);
      for (const sid of socketsOfUser(socket.username)) io.to(sid).emit('msgDialogDeleted', { with: other });
      const un = await unreadCount(socket.username);
      for (const sid of socketsOfUser(socket.username)) io.to(sid).emit('msgUnread', { count: un });
      cb({ ok: true });
    } catch (e) { cb({ ok: false, msg: 'Ошибка БД' }); }
  });
  socket.on('msgGetUnread', async (cb) => {
    if (typeof cb !== 'function') return;
    if (!socket.username) return cb({ count: 0 });
    try { cb({ count: await unreadCount(socket.username) }); } catch (e) { cb({ count: 0 }); }
  });

  socket.on('requestPasswordReset', async ({ email }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    if (!email) return cb({ ok: false, msg: 'Укажите email' });

    try {
      const r = await pool.query('SELECT username FROM users WHERE email = $1', [email]);
      if (!r.rows.length) {
        return cb({ ok: true, msg: 'Если email зарегистрирован, письмо отправлено' });
      }

      const username = r.rows[0].username;
      const token = crypto.randomBytes(32).toString('hex');
      const expires = Date.now() + 60 * 60 * 1000;

      await pool.query(
        'INSERT INTO password_resets (username, token, expires_at) VALUES ($1, $2, $3)',
        [username, token, expires]
      );

      try {
        await sendPasswordResetEmail(email, username, token);
        cb({ ok: true, msg: 'Если email зарегистрирован, письмо отправлено' });
      } catch (mailErr) {
        console.error('[Reset] Не удалось отправить письмо:', mailErr.message);
        cb({ ok: false, msg: 'Не удалось отправить письмо. Попробуйте позже.' });
      }
    } catch (e) {
      console.error('[Reset] Ошибка:', e);
      cb({ ok: false, msg: 'Ошибка сервера' });
    }
  });

  socket.on('resetPassword', async ({ token, newPassword }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    if (!token || !newPassword || newPassword.length < 3) {
      return cb({ ok: false, msg: 'Неверный токен или слишком короткий пароль' });
    }

    try {
      const r = await pool.query(
        'SELECT username FROM password_resets WHERE token = $1 AND used = FALSE AND expires_at > $2',
        [token, Date.now()]
      );

      if (!r.rows.length) {
        return cb({ ok: false, msg: 'Ссылка недействительна или истекла' });
      }

      const username = r.rows[0].username;
      const salt = newSalt();
      const hash = hashPassword(newPassword, salt);

      await pool.query('UPDATE users SET password_hash = $1, salt = $2 WHERE username = $3', [hash, salt, username]);
      await pool.query('UPDATE password_resets SET used = TRUE WHERE token = $1', [token]);

      if (db.users[username]) {
        db.users[username].passwordHash = hash;
        db.users[username].salt = salt;
      }

      cb({ ok: true });
    } catch (e) {
      console.error('[Reset] Ошибка:', e);
      cb({ ok: false, msg: 'Ошибка сервера' });
    }
  });

  socket.on('updateSettings', async ({ bio, showSubseconds }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    if (!socket.username) return cb({ ok: false, msg: 'Не авторизован' });
    const u = db.users[socket.username];
    if (!u) return cb({ ok: false, msg: 'Пользователь не найден' });
    u.bio = String(bio || '').slice(0, 500);
    u.showSubseconds = !!showSubseconds;
    await saveUser(socket.username);
    cb({ ok: true });
  });

  socket.on('requestAccountDeletion', async (cb) => {
    if (typeof cb !== 'function') cb = () => {};
    if (!socket.username) return cb({ ok: false, msg: 'Не авторизован' });
    const u = db.users[socket.username];
    if (!u) return cb({ ok: false, msg: 'Пользователь не найден' });
    const ageMs = Date.now() - u.createdAt;
    if (ageMs < 10 * 24 * 3600 * 1000) {
      return cb({ ok: false, msg: 'Удаление доступно только после 10 дней существования аккаунта.' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    u.deleteToken = token;
    u.deleteRequestedAt = Date.now();
    await saveUser(socket.username);
    try {
      await sendAccountDeletionEmail(u.email, socket.username, token);
      cb({ ok: true, msg: 'Письмо с подтверждением удаления отправлено на почту.' });
    } catch (e) {
      cb({ ok: false, msg: 'Ошибка отправки письма.' });
    }
  });

  socket.on('adminBan', async ({ username }, cb) => {
    if (!isAdmin(socket.username)) return cb({ ok: false, msg: 'Нет прав' });
    const u = db.users[username];
    if (!u) return cb({ ok: false, msg: 'Не найден' });
    u.isBanned = true;
    u.bannedUntil = Date.now() + 365 * 24 * 3600 * 1000;
    await saveUser(username);
    for (const [sid, name] of online.entries()) {
      if (name === username) {
        const s = io.sockets.sockets.get(sid);
        if (s) s.disconnect(true);
      }
    }
    cb({ ok: true });
  });

  socket.on('adminUnban', async ({ username }, cb) => {
    if (!isAdmin(socket.username)) return cb({ ok: false, msg: 'Нет прав' });
    const u = db.users[username];
    if (!u) return cb({ ok: false, msg: 'Не найден' });
    u.isBanned = false;
    u.bannedUntil = 0;
    await saveUser(username);
    cb({ ok: true });
  });

  socket.on('adminDeleteAccount', async ({ username }, cb) => {
    if (!isAdmin(socket.username)) return cb({ ok: false, msg: 'Нет прав' });
    if (username === 'PeshkaSasha') return cb({ ok: false, msg: 'Нельзя удалить главного админа' });
    await pool.query('DELETE FROM users WHERE username = $1', [username]);
    delete db.users[username];
    cb({ ok: true });
  });

  socket.on('disconnect', () => {
    const name = socket.username;
    if (name) {
      online.delete(socket.id);
      broadcastOnline();
    }
    for (const state of arenas.values()) {
      if (state.chatViewers.has(socket.id)) {
        state.chatViewers.delete(socket.id);
        if (name) {
          const p = state.participants.get(name);
          if (p) { p.socketId = null; if (!p.isPlaying) p.inArenaRoom = false; }
        }
        io.to('arena:' + state.id).emit('arenaUpdate', { arenaId: state.id });
      }
    }
  });
});

(async () => {
  try { await initDB(); await loadDB(); }
  catch (err) { console.error('[DB] Ошибка инициализации:', err.message); }

  if (watcherDbPool) {
    watcherLearning.setPool(watcherDbPool);
  }
  await watcherLearning.loadWeights();
  watcherLearning.startAutoSave();

  setInterval(() => {
    try { watcherLearning.reloadWeights(); } catch (e) {}
  }, 30000);

  watcherPool.handler = (msg) => {
    if (msg.type === 'ready') {
      console.log('[WatcherPool] Worker готов, self-play запущен');
    } else if (msg.type === 'gamesDone') {
      const s = msg.stats;
      if (msg.gameLog && msg.gameLog.length >= 4) {
        const spLobby = createSelfPlayLobby(msg.gameLog);
        if (spLobby) {
          broadcastLiveGames();
          setTimeout(() => {
            finishSelfPlayLobby(spLobby, msg.gameResult || 'draw');
          }, 15000);
        }
      }
      console.log(`[SelfPlay] +${msg.played} партий, всего: ${s.games}, W/L/D=${s.wins}/${s.losses}/${s.draws}`);
    } else if (msg.type === 'error') {
      console.error('[WatcherPool] Ошибка:', msg.msg);
    }
  };
  watcherPool.start();

  setInterval(() => {
    let busy = false;
    for (const l of lobbies.values()) {
      if (l.finished || l.isSelfPlay) continue;
      if (l.arenaId) continue;
      if (l.host === WATCHER_NAME || l.guest === WATCHER_NAME) { busy = true; break; }
    }
    if (!busy) watcherPool.playGames(1);
  }, 30000);

  getArenaSchedule(48);
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log('==================================================');
    console.log('  Kingside — сервер запущен');
    console.log(`  Порт: ${PORT}`);
    console.log('  Watcher: self-play в worker-потоке');
    console.log('==================================================');
  });
})();

process.on('SIGINT', async () => {
  try { watcherPool.stop(); await botPool.terminate(); watcherLearning.saveWeights(); } catch (e) {}
  process.exit(0);
});
process.on('SIGTERM', async () => {
  try { watcherPool.stop(); await botPool.terminate(); watcherLearning.saveWeights(); } catch (e) {}
  process.exit(0);
});
process.on('uncaughtException', (err) => { console.error('[Server] Ошибка:', err); });
