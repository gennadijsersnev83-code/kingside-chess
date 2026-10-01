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

// ======================= РОЛИ =======================
const ADMINS = new Set(['admin']);        // ← поменяй на свой ник
const MODERATORS = new Set([]);           // ← ники модераторов
const DEVS = new Set(['admin']);          // ← разрабы

function roleOf(username) {
  if (ADMINS.has(username) || DEVS.has(username)) return 'admin';
  if (MODERATORS.has(username)) return 'moderator';
  return 'user';
}
function isAdmin(username) { return ADMINS.has(username) || DEVS.has(username); }
function isMod(username) { return isAdmin(username) || MODERATORS.has(username); }

// ======================= БАЗА ДАННЫХ =======================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  try {
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
    // Миграции (обратная совместимость)
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS rating_classical INTEGER;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS rating_rapid INTEGER;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS rating_blitz INTEGER;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS rating_bullet INTEGER;`);
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

    // Заполняем новые рейтинги для старых аккаунтов
    await pool.query(`UPDATE users SET rating_classical = rating WHERE rating_classical IS NULL;`);
    await pool.query(`UPDATE users SET rating_rapid     = rating WHERE rating_rapid     IS NULL;`);
    await pool.query(`UPDATE users SET rating_blitz     = rating WHERE rating_blitz     IS NULL;`);
    await pool.query(`UPDATE users SET rating_bullet    = rating WHERE rating_bullet    IS NULL;`);

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

    console.log('[DB] Схема готова');
  } catch (err) {
    console.error('[DB] Ошибка создания схемы:', err.message || err.code || err);
    throw err;
  }
}

let db = { users: {}, games: [] };

function emptyRatingBlock(base) {
  return { rating: base, wins: 0, losses: 0, games: 0 };
}

async function loadDB() {
  try {
    const res = await pool.query('SELECT * FROM users');
    db.users = {};
    for (const row of res.rows) {
      db.users[row.username] = {
        passwordHash: row.password_hash,
        salt: row.salt,
        rating: row.rating,
        wins: row.wins,
        losses: row.losses,
        draws: row.draws,
        games: row.games,
        createdAt: Number(row.created_at),
        mutedUntil: Number(row.muted_until || 0),
        categories: {
          classical: {
            rating: row.rating_classical != null ? row.rating_classical : row.rating,
            wins: row.wins_classical || 0,
            losses: row.losses_classical || 0,
            games: row.games_classical || 0
          },
          rapid: {
            rating: row.rating_rapid != null ? row.rating_rapid : row.rating,
            wins: row.wins_rapid || 0,
            losses: row.losses_rapid || 0,
            games: row.games_rapid || 0
          },
          blitz: {
            rating: row.rating_blitz != null ? row.rating_blitz : row.rating,
            wins: row.wins_blitz || 0,
            losses: row.losses_blitz || 0,
            games: row.games_blitz || 0
          },
          bullet: {
            rating: row.rating_bullet != null ? row.rating_bullet : row.rating,
            wins: row.wins_bullet || 0,
            losses: row.losses_bullet || 0,
            games: row.games_bullet || 0
          }
        }
      };
    }
    console.log(`[DB] Загружено: ${Object.keys(db.users).length} игроков`);
  } catch (err) {
    console.error('[DB] Ошибка загрузки игроков:', err.message || err.code || err);
  }
}

async function saveUser(username) {
  const u = db.users[username];
  if (!u) return;
  const c = u.categories || {};
  const get = (k, f) => (c[k] ? c[k][f] : 0);
  try {
    await pool.query(
      `INSERT INTO users (username, password_hash, salt, rating, wins, losses, draws, games, created_at,
                          rating_classical, rating_rapid, rating_blitz, rating_bullet,
                          wins_classical, wins_rapid, wins_blitz, wins_bullet,
                          losses_classical, losses_rapid, losses_blitz, losses_bullet,
                          games_classical, games_rapid, games_blitz, games_bullet,
                          muted_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
       ON CONFLICT (username) DO UPDATE SET
         rating = EXCLUDED.rating,
         wins = EXCLUDED.wins,
         losses = EXCLUDED.losses,
         draws = EXCLUDED.draws,
         games = EXCLUDED.games,
         rating_classical = EXCLUDED.rating_classical,
         rating_rapid = EXCLUDED.rating_rapid,
         rating_blitz = EXCLUDED.rating_blitz,
         rating_bullet = EXCLUDED.rating_bullet,
         wins_classical = EXCLUDED.wins_classical,
         wins_rapid = EXCLUDED.wins_rapid,
         wins_blitz = EXCLUDED.wins_blitz,
         wins_bullet = EXCLUDED.wins_bullet,
         losses_classical = EXCLUDED.losses_classical,
         losses_rapid = EXCLUDED.losses_rapid,
         losses_blitz = EXCLUDED.losses_blitz,
         losses_bullet = EXCLUDED.losses_bullet,
         games_classical = EXCLUDED.games_classical,
         games_rapid = EXCLUDED.games_rapid,
         games_blitz = EXCLUDED.games_blitz,
         games_bullet = EXCLUDED.games_bullet,
         muted_until = EXCLUDED.muted_until`,
      [
        username, u.passwordHash, u.salt, u.rating, u.wins, u.losses, u.draws, u.games, u.createdAt,
        c.classical ? c.classical.rating : u.rating,
        c.rapid ? c.rapid.rating : u.rating,
        c.blitz ? c.blitz.rating : u.rating,
        c.bullet ? c.bullet.rating : u.rating,
        get('classical','wins'), get('rapid','wins'), get('blitz','wins'), get('bullet','wins'),
        get('classical','losses'), get('rapid','losses'), get('blitz','losses'), get('bullet','losses'),
        get('classical','games'), get('rapid','games'), get('blitz','games'), get('bullet','games'),
        u.mutedUntil || 0
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
                          category, is_arena, arena_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [game.white, game.black, game.result, game.reason,
       game.timeControl, game.increment,
       game.whiteBefore, game.blackBefore, game.whiteAfter, game.blackAfter,
       game.finishedAt, game.category || 'blitz', !!game.isArena, game.arenaName || null]
    );
  } catch (err) {
    console.error('[DB] saveGame ошибка:', err.message || err.code || err);
    throw err;
  }
}

// ======================= ПАРОЛИ =======================
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');
}
function newSalt() { return crypto.randomBytes(16).toString('hex'); }
function verifyPassword(password, salt, hash) {
  const test = hashPassword(password, salt);
  try { return crypto.timingSafeEqual(Buffer.from(test, 'hex'), Buffer.from(hash, 'hex')); }
  catch (e) { return false; }
}

// ======================= ЭЛО =======================
function kFactor(rating, games) {
  if (games < 30) return 40;
  if (rating < 2400) return 20;
  return 10;
}
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
function genId() {
  return Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6);
}
function publicUser(name) {
  const u = db.users[name];
  if (!u) return null;
  return {
    username: name,
    rating: u.rating,
    wins: u.wins,
    losses: u.losses,
    draws: u.draws,
    games: u.games,
    createdAt: u.createdAt,
    role: roleOf(name),
    isAdmin: isAdmin(name),
    isMod: isMod(name),
    mutedUntil: u.mutedUntil || 0,
    categories: u.categories || null
  };
}

// ======================= ХРАНИЛИЩА =======================
const online = new Map();
const lobbies = new Map();
const socketToLobby = new Map();
const arenas = new Map();

function countActiveLobbies() {
  let n = 0;
  for (const l of lobbies.values()) {
    if (l.finished) continue;
    if (l.started) n++;
  }
  return n;
}
function broadcastOnline() {
  io.emit('onlineCount', online.size);
  io.emit('stats', { online: online.size, games: db.games.length, activeGames: countActiveLobbies() });
}
function broadcastLobbies() { io.emit('lobbiesUpdate'); }

function cleanupStuckPlaying() {
  for (const state of arenas.values()) {
    for (const p of state.participants.values()) {
      if (p.isPlaying) {
        const l = p.lobbyId ? lobbies.get(p.lobbyId) : null;
        if (!l || l.finished) {
          p.isPlaying = false;
          p.lobbyId = null;
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
    const whiteU = db.users[whiteName];
    const blackU = db.users[blackName];
    list.push({
      id,
      white: whiteName,
      black: blackName,
      whiteRating: whiteU ? whiteU.rating : null,
      blackRating: blackU ? blackU.rating : null,
      whiteIsAdmin: whiteU ? isAdmin(whiteName) : false,
      blackIsAdmin: blackU ? isAdmin(blackName) : false,
      timeW: l.timeW, timeB: l.timeB,
      turn: l.turn,
      timeControl: l.time, increment: l.inc,
      isArena: !!l.arenaId,
      arenaName: l.arenaName || null,
      fen: l.fen
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

  const hostUser = db.users[l.host];
  const guestUser = db.users[l.guest];
  if (!hostUser || !guestUser) { lobbies.delete(lobbyId); return; }

  const whiteName = l.hostColor === 'w' ? l.host : l.guest;
  const blackName = l.hostColor === 'b' ? l.host : l.guest;
  const whiteUser = db.users[whiteName];
  const blackUser = db.users[blackName];

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

  const kWhite = kFactor(whiteBefore, wc.games);
  const kBlack = kFactor(blackBefore, bc.games);
  const whiteDelta = eloDelta(whiteBefore, blackBefore, whiteScore, kWhite);
  const blackDelta = eloDelta(blackBefore, whiteBefore, blackScore, kBlack);
  const whiteAfter = whiteBefore + whiteDelta;
  const blackAfter = blackBefore + blackDelta;

  wc.rating = whiteAfter;
  if (result === 'w') wc.wins++;
  else if (result === 'b') wc.losses++;
  wc.games++;

  bc.rating = blackAfter;
  if (result === 'b') bc.wins++;
  else if (result === 'w') bc.losses++;
  bc.games++;

  whiteUser.rating = whiteAfter;
  if (result === 'w') whiteUser.wins++;
  else if (result === 'b') whiteUser.losses++;
  else whiteUser.draws++;
  whiteUser.games++;

  blackUser.rating = blackAfter;
  if (result === 'b') blackUser.wins++;
  else if (result === 'w') blackUser.losses++;
  else blackUser.draws++;
  blackUser.games++;

  const gameRecord = {
    white: whiteName, black: blackName, result, reason,
    timeControl: l.time, increment: l.inc,
    whiteBefore, blackBefore, whiteAfter, blackAfter,
    finishedAt: Date.now(),
    category: cat,
    isArena: !!l.arenaId,
    arenaName: l.arenaName || null
  };
  db.games.push(gameRecord);
  if (db.games.length > 10000) db.games.shift();

  try {
    await saveUser(whiteName);
    await saveUser(blackName);
    await saveGame(gameRecord);
    console.log(`[DB] Сохранено (${cat}): ${whiteName} vs ${blackName} = ${result}`);
  } catch (err) {
    console.error('[DB] Ошибка сохранения партии:', err.message || err.code || err);
  }

  const isArena = !!l.arenaId;
  io.to(lobbyId).emit('gameEnded', {
    result, reason,
    whiteDelta, blackDelta, whiteAfter, blackAfter,
    category: cat,
    isArena,
    arenaId: l.arenaId || null,
    arenaName: l.arenaName || null
  });

  if (l.arenaId) {
    try { handleArenaGameEnd(l.arenaId, lobbyId, result, whiteName, blackName); }
    catch (e) { console.error('[arena] handleArenaGameEnd ошибка:', e.message); }
  }

  setTimeout(() => {
    io.to(lobbyId).socketsLeave(lobbyId);
    lobbies.delete(lobbyId);
    broadcastLobbies();
  }, 5000);

  io.emit('stats', { online: online.size, games: db.games.length, activeGames: countActiveLobbies() });
}

// ======================= АРЕНЫ =======================
// durationMin = период - 3 → между турнирами одного типа всегда ровно 3 минуты паузы.
const ARENA_TEMPLATES = [
  {
    id: 'bullet-halfhour',
    name: 'Получасовая пуля',
    description: '1+0 · рейтинговая',
    timeControl: 1, increment: 0,
    durationMin: 27,          // :00 → :27, пауза до :30
    repeat: 'every30',
    color: 'bullet'
  },
  {
    id: 'blitz-hourly',
    name: 'Ежечасная блиц-арена',
    description: '3+2 · рейтинговая',
    timeControl: 3, increment: 2,
    durationMin: 57,          // :00 → :57, пауза до следующего :00
    repeat: 'hourly',
    color: 'blitz'
  },
  {
    id: 'rapid-2h',
    name: 'Двухчасовая рапид-арена',
    description: '10+0 · рейтинговая',
    timeControl: 10, increment: 0,
    durationMin: 117,         // :00 → :117 (1:57), пауза до следующего чётного часа
    repeat: 'every2h',
    color: 'rapid'
  },
  {
    id: 'classical-4h',
    name: 'Классическая арена',
    description: '30+0 · классика',
    timeControl: 30, increment: 0,
    durationMin: 237,         // :00 → :237 (3:57), пауза до следующего 4-го часа
    repeat: 'every4h',
    color: 'classical'
  }
];

function nextStartFor(tpl, now) {
  const c = new Date(now);
  c.setSeconds(0, 0);
  if (tpl.repeat === 'hourly') {
    c.setMinutes(0, 0, 0);
    if (c.getTime() <= now) c.setHours(c.getHours() + 1);
    return c.getTime();
  }
  if (tpl.repeat === 'every30') {
    const m = c.getMinutes();
    if (m < 30) c.setMinutes(30, 0, 0);
    else { c.setHours(c.getHours() + 1); c.setMinutes(0, 0, 0); }
    if (c.getTime() <= now) c.setMinutes(c.getMinutes() + 30);
    return c.getTime();
  }
  if (tpl.repeat === 'every2h') {
    c.setMinutes(0, 0, 0);
    const h = c.getHours();
    let nextH = (Math.floor(h / 2) + 1) * 2;
    if (h % 2 === 0 && c.getTime() > now) nextH = h;
    if (nextH >= 24) {
      const d = new Date(c); d.setDate(d.getDate() + 1); d.setHours(nextH - 24, 0, 0, 0);
      return d.getTime();
    }
    c.setHours(nextH, 0, 0, 0);
    if (c.getTime() <= now) c.setHours(c.getHours() + 2);
    return c.getTime();
  }
  if (tpl.repeat === 'every4h') {
    c.setMinutes(0, 0, 0);
    const h = c.getHours();
    let nextH = (Math.floor(h / 4) + 1) * 4;
    if (h % 4 === 0 && c.getTime() > now) nextH = h;
    if (nextH >= 24) {
      const d = new Date(c); d.setDate(d.getDate() + 1); d.setHours(nextH - 24, 0, 0, 0);
      return d.getTime();
    }
    c.setHours(nextH, 0, 0, 0);
    if (c.getTime() <= now) c.setHours(c.getHours() + 4);
    return c.getTime();
  }
  return now + 3600000;
}

function stepFor(tpl) {
  if (tpl.repeat === 'hourly') return 3600 * 1000;
  if (tpl.repeat === 'every30') return 30 * 60 * 1000;
  if (tpl.repeat === 'every2h') return 2 * 3600 * 1000;
  if (tpl.repeat === 'every4h') return 4 * 3600 * 1000;
  return 3600 * 1000;
}

function getOrCreateArenaState(instance) {
  if (arenas.has(instance.id)) return arenas.get(instance.id);
  const state = {
    id: instance.id,
    templateId: instance.templateId,
    name: instance.name,
    description: instance.description,
    timeControl: instance.timeControl,
    increment: instance.increment,
    startsAt: instance.startsAt,
    endsAt: instance.endsAt,
    color: instance.color,
    phase: 'waiting',
    participants: new Map(),
    finished: false,
    top3: null,
    pairingInterval: null,
    cleanupTimer: null,
    pairingNow: null,
    activeLobbies: new Set()
  };
  arenas.set(instance.id, state);
  scheduleArena(state);
  return state;
}

function scheduleArena(state) {
  const now = Date.now();
  const startDelay = Math.max(0, state.startsAt - now);
  const endDelay = Math.max(0, state.endsAt - now);

  if (startDelay > 0) {
    setTimeout(() => {
      if (state.finished) return;
      state.phase = 'live';
      console.log(`[arena] СТАРТ ${state.name}`);
      io.emit('arenaUpdate', { arenaId: state.id });
      io.emit('arenaStarted', { arenaId: state.id, arenaName: state.name });
      io.emit('arenaChatMessage', {
        system: true,
        text: `⚔ Арена "${state.name}" началась!`,
        ts: Date.now()
      });
      state.pairingInterval = setInterval(() => tryPair(state), 5000);
      tryPair(state);
    }, startDelay);
  } else if (now < state.endsAt && !state.finished) {
    state.phase = 'live';
    console.log(`[arena] ПОДХВАТ идущей арены ${state.name}`);
    state.pairingInterval = setInterval(() => tryPair(state), 5000);
    tryPair(state);
  }

  if (endDelay > 0) setTimeout(() => finishArena(state), endDelay);
  else finishArena(state);
}

function isAvailableForPairing(p) {
  if (!p) return false;
  if (p.isPlaying) return false;
  if (p.paused) return false;
  if (!p.socketId) return false;
  if (!io.sockets.sockets.has(p.socketId)) return false;
  return true;
}

function tryPair(state) {
  if (state.finished || state.phase !== 'live') return;

  const waiting = [];
  for (const [username, p] of state.participants.entries()) {
    if (!isAvailableForPairing(p)) continue;
    if (!p.waitingSince) p.waitingSince = Date.now();
    waiting.push(p);
  }

  if (waiting.length < 2) {
    state.pairingNow = waiting.length === 1 ? waiting[0].username : null;
    return;
  }
  state.pairingNow = null;

  waiting.sort((a, b) => a.waitingSince - b.waitingSince);

  const now = Date.now();
  const used = new Set();

  for (let i = 0; i < waiting.length; i++) {
    const a = waiting[i];
    if (used.has(a.username)) continue;

    let best = null;
    let bestDiff = Infinity;
    for (let j = 0; j < waiting.length; j++) {
      if (i === j) continue;
      const b = waiting[j];
      if (used.has(b.username)) continue;
      const diff = Math.abs((a.score || 0) - (b.score || 0));
      if (diff < bestDiff) { bestDiff = diff; best = b; }
    }
    if (!best) continue;

    const aWaited = now - (a.waitingSince || now);
    const bWaited = now - (best.waitingSince || now);
    const maxWaited = Math.max(aWaited, bWaited);

    if (bestDiff <= 1 || maxWaited >= 10000) {
      createArenaPairing(state, a, best);
      used.add(a.username);
      used.add(best.username);
      a.waitingSince = null;
      best.waitingSince = null;
    }
  }
}

function createArenaPairing(state, a, b) {
  const lobbyId = genId();
  const hostIsWhite = Math.random() < 0.5;
  const hostColor = hostIsWhite ? 'w' : 'b';
  const guestColor = hostIsWhite ? 'b' : 'w';
  const time = state.timeControl;
  const inc = state.increment;

  lobbies.set(lobbyId, {
    id: lobbyId,
    host: a.username, hostSocket: a.socketId,
    guest: b.username, guestSocket: b.socketId,
    hostColor, guestColor,
    time, inc,
    timeW: time * 60, timeB: time * 60,
    turn: 'w',
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    started: true, finished: false,
    lastTick: Date.now(),
    chat: [], drawOffer: null,
    createdAt: Date.now(),
    arenaId: state.id,
    arenaName: state.name
  });
  state.activeLobbies.add(lobbyId);

  a.isPlaying = true; a.lobbyId = lobbyId;
  b.isPlaying = true; b.lobbyId = lobbyId;

  const aSocket = io.sockets.sockets.get(a.socketId);
  const bSocket = io.sockets.sockets.get(b.socketId);

  if (aSocket) {
    aSocket.join(lobbyId);
    aSocket.emit('gameStart', {
      color: hostColor, opponent: b.username, opponentRating: b.rating,
      time, inc, lobbyId,
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      chat: [], arenaId: state.id, arenaName: state.name
    });
  }
  if (bSocket) {
    bSocket.join(lobbyId);
    bSocket.emit('gameStart', {
      color: guestColor, opponent: a.username, opponentRating: a.rating,
      time, inc, lobbyId,
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      chat: [], arenaId: state.id, arenaName: state.name
    });
  }
  io.emit('arenaUpdate', { arenaId: state.id });
  io.emit('stats', { online: online.size, games: db.games.length, activeGames: countActiveLobbies() });
}

// ======================= ОЧКИ АРЕНЫ =======================
function calcArenaPoints(p, result) {
  if (result === 'win') {
    const streak = (p.winStreak || 0) + 1;
    p.winStreak = streak;
    p.drawStreak = 0;
    return streak >= 3 ? 4 : 2;
  }
  if (result === 'draw') {
    const streak = (p.drawStreak || 0) + 1;
    p.drawStreak = streak;
    p.winStreak = 0;
    return streak >= 2 ? 2 : 1;
  }
  p.winStreak = 0;
  p.drawStreak = 0;
  return 0;
}

function handleArenaGameEnd(arenaId, lobbyId, result, whiteName, blackName) {
  const state = arenas.get(arenaId);
  if (!state) return;
  state.activeLobbies.delete(lobbyId);

  const whiteP = state.participants.get(whiteName);
  const blackP = state.participants.get(blackName);

  if (state.finished || !whiteP || !blackP) {
    if (whiteP) { whiteP.isPlaying = false; whiteP.lobbyId = null; }
    if (blackP) { blackP.isPlaying = false; blackP.lobbyId = null; }
    return;
  }

  if (result === 'w') {
    whiteP.score += calcArenaPoints(whiteP, 'win');
    whiteP.wins++; blackP.losses++;
    calcArenaPoints(blackP, 'loss');
  } else if (result === 'b') {
    blackP.score += calcArenaPoints(blackP, 'win');
    blackP.wins++; whiteP.losses++;
    calcArenaPoints(whiteP, 'loss');
  } else {
    whiteP.score += calcArenaPoints(whiteP, 'draw');
    blackP.score += calcArenaPoints(blackP, 'draw');
    whiteP.draws++; blackP.draws++;
  }

  whiteP.isPlaying = false; blackP.isPlaying = false;
  whiteP.lobbyId = null; blackP.lobbyId = null;
  if (!whiteP.paused) whiteP.waitingSince = Date.now();
  if (!blackP.paused) blackP.waitingSince = Date.now();

  setTimeout(() => tryPair(state), 1000);
  io.emit('arenaUpdate', { arenaId });
}

function finishArena(state) {
  if (state.finished) return;
  state.finished = true;
  state.phase = 'finished';
  if (state.pairingInterval) clearInterval(state.pairingInterval);

  for (const p of state.participants.values()) {
    p.isPlaying = false;
    p.lobbyId = null;
  }

  const all = [...state.participants.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.wins !== a.wins) return b.wins - a.wins;
    return b.rating - a.rating;
  });

  state.top3 = all.slice(0, 3).map(p => ({
    username: p.username, score: p.score,
    wins: p.wins, draws: p.draws, losses: p.losses, rating: p.rating
  }));

  io.emit('arenaChatMessage', {
    system: true,
    text: `🏆 Арена "${state.name}" завершена!`,
    ts: Date.now()
  });
  io.emit('arenaFinished', { arenaId: state.id, arenaName: state.name, top3: state.top3 });
  io.emit('arenaUpdate', { arenaId: state.id });

  state.cleanupTimer = setTimeout(() => arenas.delete(state.id), 2 * 60 * 60 * 1000);
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
      const endsAt = t + tpl.durationMin * 60 * 1000;
      let status;
      if (t > now) status = 'upcoming';
      else if (now < endsAt) status = 'live';
      else status = 'finished';

      if (status === 'finished' && endsAt < finishedCutoff) { t += step; continue; }

      const instance = {
        id: `${tpl.id}-${t}`,
        templateId: tpl.id,
        name: tpl.name,
        description: tpl.description,
        timeControl: tpl.timeControl,
        increment: tpl.increment,
        durationMin: tpl.durationMin,
        color: tpl.color,
        startsAt: t, endsAt, status
      };
      result.push(instance);

      if (status === 'live' || (status === 'upcoming' && t - now < 24 * 3600 * 1000)) {
        getOrCreateArenaState(instance);
      }
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
    list.push({
      id: state.id,
      name: state.name,
      phase: state.phase,
      color: state.color,
      participantsCount: state.participants.size,
      timeControl: state.timeControl,
      increment: state.increment,
      startsAt: state.startsAt,
      endsAt: state.endsAt
    });
  }
  list.sort((a, b) => {
    if (b.participantsCount !== a.participantsCount) return b.participantsCount - a.participantsCount;
    return a.startsAt - b.startsAt;
  });
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
    io.to(id).emit('timeUpdate', { timeW: lobby.timeW, timeB: lobby.timeB });
    if (lobby.timeW <= 0) finishGame(id, 'b', 'Время');
    else if (lobby.timeB <= 0) finishGame(id, 'w', 'Время');
  }
}, 1000);

// ======================= МОДЕРАЦИЯ =======================
function checkMute(username) {
  const u = db.users[username];
  if (!u) return 0;
  const until = u.mutedUntil || 0;
  if (until <= Date.now()) return 0;
  return until;
}
function setMute(username, minutes) {
  const u = db.users[username];
  if (!u) return false;
  u.mutedUntil = Date.now() + minutes * 60 * 1000;
  saveUser(username).catch(() => {});
  return true;
}
function clearMute(username) {
  const u = db.users[username];
  if (!u) return false;
  u.mutedUntil = 0;
  saveUser(username).catch(() => {});
  return true;
}

// ======================= SOCKET.IO =======================
io.on('connection', (socket) => {
  console.log(`[socket] подключён ${socket.id}`);

  socket.emit('onlineCount', online.size);
  socket.emit('stats', { online: online.size, games: db.games.length, activeGames: countActiveLobbies() });

  socket.on('register', async ({ username, password }, cb) => {
    if (typeof cb !== 'function') return;
    if (!username || !password) return cb({ ok: false, msg: 'Заполните поля' });
    if (typeof username !== 'string' || username.length < 2 || username.length > 32) {
      return cb({ ok: false, msg: 'Логин 2–32 символа' });
    }
    if (!/^[a-zA-Zа-яА-Я0-9_\-]+$/.test(username)) {
      return cb({ ok: false, msg: 'Логин: буквы, цифры, _ и -' });
    }
    if (password.length < 3) return cb({ ok: false, msg: 'Пароль минимум 3 символа' });
    if (password.length > 128) return cb({ ok: false, msg: 'Пароль слишком длинный' });

    let user = db.users[username];
    if (user) {
      if (!verifyPassword(password, user.salt, user.passwordHash)) {
        return cb({ ok: false, msg: 'Неверный пароль' });
      }
    } else {
      const salt = newSalt();
      const passwordHash = hashPassword(password, salt);
      const base = 1200;
      db.users[username] = {
        passwordHash, salt, rating: base,
        wins: 0, losses: 0, draws: 0, games: 0,
        createdAt: Date.now(),
        mutedUntil: 0,
        categories: {
          classical: emptyRatingBlock(base),
          rapid: emptyRatingBlock(base),
          blitz: emptyRatingBlock(base),
          bullet: emptyRatingBlock(base)
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
      const gamesRes = await pool.query(
        `SELECT * FROM games WHERE white = $1 OR black = $1 ORDER BY finished_at DESC LIMIT 50`,
        [username]
      );
      const games = gamesRes.rows.map(r => ({
        white: r.white, black: r.black, result: r.result, reason: r.reason,
        timeControl: r.time_control, increment: r.increment,
        whiteBefore: r.white_before, blackBefore: r.black_before,
        whiteAfter: r.white_after, blackAfter: r.black_after,
        finishedAt: Number(r.finished_at),
        category: r.category || 'blitz'
      }));

      const historyRes = await pool.query(
        `SELECT white, black, white_after, black_after, finished_at FROM games
         WHERE white = $1 OR black = $1 ORDER BY finished_at ASC`,
        [username]
      );
      const history = [{ ts: u.createdAt, rating: 1200 }];
      for (const r of historyRes.rows) {
        const isWhite = r.white === username;
        history.push({
          ts: Number(r.finished_at),
          rating: isWhite ? r.white_after : r.black_after
        });
      }

      cb({ ok: true, user: publicUser(username), games, history });
    } catch (err) {
      console.error('[DB] Ошибка загрузки профиля:', err.message || err.code || err);
      cb({ ok: false, msg: 'Ошибка базы данных' });
    }
  });

  socket.on('getStats', (cb) => {
    if (typeof cb !== 'function') return;
    cb({ online: online.size, games: db.games.length, activeGames: countActiveLobbies() });
  });
  socket.on('getTopArenas', (cb) => { if (typeof cb === 'function') cb(getTopLiveArenas()); });
  socket.on('getLiveGames', (cb) => { if (typeof cb === 'function') cb(buildGamesList()); });

  socket.on('watchGame', ({ id }, cb) => {
    const l = lobbies.get(id);
    if (!l || l.finished || !l.started) {
      if (typeof cb === 'function') cb({ ok: false, msg: 'Партия недоступна' });
      return;
    }
    socket.join('watch:' + id);
    const whiteName = l.hostColor === 'w' ? l.host : l.guest;
    const blackName = l.hostColor === 'b' ? l.host : l.guest;
    if (typeof cb === 'function') cb({
      ok: true,
      game: {
        id,
        white: whiteName, black: blackName,
        whiteRating: db.users[whiteName] ? db.users[whiteName].rating : null,
        blackRating: db.users[blackName] ? db.users[blackName].rating : null,
        whiteIsAdmin: db.users[whiteName] ? isAdmin(whiteName) : false,
        blackIsAdmin: db.users[blackName] ? isAdmin(blackName) : false,
        timeW: l.timeW, timeB: l.timeB,
        turn: l.turn,
        timeControl: l.time, increment: l.inc,
        fen: l.fen,
        isArena: !!l.arenaId,
        arenaName: l.arenaName || null
      }
    });
  });

  socket.on('unwatchGame', ({ id }) => { socket.leave('watch:' + id); });

  socket.on('getLobbies', (cb) => {
    if (typeof cb !== 'function') return;
    const list = [];
    for (const [id, l] of lobbies.entries()) {
      if (l.finished || l.arenaId) continue;
      list.push({ id, host: l.host, time: l.time, inc: l.inc, status: l.guest ? 'playing' : 'waiting' });
    }
    cb(list);
  });

  socket.on('createLobby', ({ time, inc }, cb) => {
    if (typeof cb !== 'function') return;
    if (!socket.username) return cb({ ok: false, msg: 'Не авторизован' });
    time = Math.max(0.5, Math.min(60, +time || 5));
    inc  = Math.max(0, Math.min(60, +inc || 0));
    const id = genId();
    lobbies.set(id, {
      id, host: socket.username, hostSocket: socket.id,
      guest: null, guestSocket: null,
      hostColor: null, guestColor: null,
      time, inc,
      timeW: time * 60, timeB: time * 60,
      turn: 'w',
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      started: false, finished: false,
      lastTick: Date.now(),
      chat: [], drawOffer: null,
      createdAt: Date.now()
    });
    socket.join(id);
    socketToLobby.set(socket.id, id);
    socket.lobbyId = id;
    cb({ ok: true, id });
    broadcastLobbies();
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

    const hostRating = db.users[l.host] ? db.users[l.host].rating : null;
    const guestRating = db.users[l.guest] ? db.users[l.guest].rating : null;

    io.to(l.hostSocket).emit('gameStart', {
      color: l.hostColor, opponent: l.guest, opponentRating: guestRating,
      time: l.time, inc: l.inc, lobbyId: id, fen: l.fen, chat: l.chat, isArena: false
    });
    io.to(l.guestSocket).emit('gameStart', {
      color: l.guestColor, opponent: l.host, opponentRating: hostRating,
      time: l.time, inc: l.inc, lobbyId: id, fen: l.fen, chat: l.chat, isArena: false
    });

    cb({ ok: true, id });
    broadcastLobbies();
    io.emit('stats', { online: online.size, games: db.games.length, activeGames: countActiveLobbies() });
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
    l.fen = fen;
    l.turn = newTurn;
    l.drawOffer = null;

    io.to(lobbyId).emit('boardUpdate', { fen, turn: newTurn, san: san || null });
    io.to(lobbyId).emit('timeUpdate', { timeW: l.timeW, timeB: l.timeB });
    socket.to('watch:' + lobbyId).emit('boardUpdate', { fen, turn: newTurn, san: san || null });
    socket.to('watch:' + lobbyId).emit('timeUpdate', { timeW: l.timeW, timeB: l.timeB });
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

  // === ЧАТ ПАРТИИ ===
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
    const msg = {
      id: 'm' + Date.now() + Math.random().toString(36).slice(2, 6),
      user: socket.username,
      text,
      ts: Date.now()
    };
    l.chat.push(msg);
    if (l.chat.length > 50) l.chat.shift();
    io.to(lobbyId).emit('chatMessage', msg);
  });

  // === МОДЕРАЦИЯ ===
  socket.on('modDeleteMessage', ({ lobbyId, msgId }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    if (!isMod(socket.username)) return cb({ ok: false, msg: 'Нет прав' });
    const l = lobbies.get(lobbyId);
    if (!l) return cb({ ok: false, msg: 'Лобби нет' });
    const idx = l.chat.findIndex(m => m.id === msgId);
    if (idx < 0) return cb({ ok: false, msg: 'Сообщение не найдено' });
    l.chat.splice(idx, 1);
    io.to(lobbyId).emit('chatMessageDeleted', { msgId, scope: 'game', lobbyId });
    cb({ ok: true });
  });

  socket.on('modMuteUser', ({ username, minutes }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    if (!isMod(socket.username)) return cb({ ok: false, msg: 'Нет прав' });
    if (!db.users[username]) return cb({ ok: false, msg: 'Игрок не найден' });
    if (isAdmin(username) && !isAdmin(socket.username)) {
      return cb({ ok: false, msg: 'Нельзя замутить админа' });
    }
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
    socket.emit('drawOfferSent');
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

  socket.on('getArenas', (cb) => { if (typeof cb === 'function') cb(getArenaSchedule(48)); });

  socket.on('getMyArenaStates', (cb) => {
    if (typeof cb !== 'function') return;
    const states = {};
    for (const [id, state] of arenas.entries()) {
      const p = socket.username ? state.participants.get(socket.username) : null;
      states[id] = {
        joined: !!p,
        paused: !!(p && p.paused),
        participantsCount: state.participants.size,
        phase: state.phase,
        score: p ? p.score : 0
      };
    }
    cb(states);
  });

  socket.on('getArenaState', ({ arenaId }, cb) => {
    if (typeof cb !== 'function') return;
    const state = arenas.get(arenaId);
    if (!state) {
      return cb({ joined: false, paused: false, participants: [], participantsCount: 0,
                  phase: 'waiting', timeLeftMin: 0, timeLeftMs: 0, top3: null, pairingNow: null });
    }

    for (const p of state.participants.values()) {
      if (p.isPlaying) {
        const l = p.lobbyId ? lobbies.get(p.lobbyId) : null;
        if (!l || l.finished) {
          p.isPlaying = false;
          p.lobbyId = null;
          if (!p.paused) p.waitingSince = Date.now();
        }
      }
    }

    const participants = [...state.participants.values()].map(p => ({
      username: p.username, rating: p.rating, score: p.score,
      wins: p.wins, draws: p.draws, losses: p.losses,
      winStreak: p.winStreak || 0,
      drawStreak: p.drawStreak || 0,
      paused: !!p.paused,
      isPlaying: !!p.isPlaying,
      isAdmin: isAdmin(p.username),
      online: p.socketId && io.sockets.sockets.has(p.socketId)
    })).sort((a, b) => b.score - a.score || b.rating - a.rating);

    const meP = socket.username ? state.participants.get(socket.username) : null;
    const joined = !!meP;
    const paused = !!(meP && meP.paused);
    const timeLeftMs = Math.max(0, state.endsAt - Date.now());

    cb({
      joined, paused, participants,
      participantsCount: participants.length,
      phase: state.phase,
      timeLeftMs,
      timeLeftMin: Math.round(timeLeftMs / 60000),
      top3: state.top3,
      pairingNow: state.pairingNow
    });
  });

  socket.on('getArenaGames', ({ arenaId }, cb) => {
    if (typeof cb !== 'function') return;
    const list = [];
    for (const [id, l] of lobbies.entries()) {
      if (l.arenaId !== arenaId || l.finished) continue;
      list.push({
        lobbyId: id,
        white: l.hostColor === 'w' ? l.host : l.guest,
        black: l.hostColor === 'b' ? l.host : l.guest,
        whiteIsAdmin: isAdmin(l.hostColor === 'w' ? l.host : l.guest),
        blackIsAdmin: isAdmin(l.hostColor === 'b' ? l.host : l.guest),
        timeW: l.timeW, timeB: l.timeB,
        moveCount: l.fen ? (+l.fen.split(' ')[5] || 1) : 1
      });
    }
    cb(list);
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
      score: 0, wins: 0, draws: 0, losses: 0,
      winStreak: 0, drawStreak: 0,
      socketId: socket.id,
      lobbyId: null,
      isPlaying: false,
      paused: false,
      waitingSince: Date.now()
    });

    io.emit('arenaChatMessage', { system: true, text: `${socket.username} присоединился к арене`, ts: Date.now() });
    io.emit('arenaUpdate', { arenaId });
    cb({ ok: true });
  });

  socket.on('leaveArena', ({ arenaId }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    const state = arenas.get(arenaId);
    if (!state) return cb({ ok: false, msg: 'Арена не найдена' });
    if (state.phase !== 'waiting') {
      return cb({ ok: false, msg: 'Нельзя сняться после старта арены — используйте паузу' });
    }
    const p = state.participants.get(socket.username);
    if (p && !p.isPlaying) {
      state.participants.delete(socket.username);
      io.emit('arenaChatMessage', { system: true, text: `${socket.username} покинул арену`, ts: Date.now() });
      io.emit('arenaUpdate', { arenaId });
    }
    cb({ ok: true });
  });

  socket.on('pauseArena', ({ arenaId }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    const state = arenas.get(arenaId);
    if (!state) return cb({ ok: false, msg: 'Арена не найдена' });
    if (state.finished || state.phase === 'finished') return cb({ ok: false, msg: 'Арена завершена' });
    const p = state.participants.get(socket.username);
    if (!p) return cb({ ok: false, msg: 'Вы не участвуете' });

    const activeLobby = p.lobbyId ? lobbies.get(p.lobbyId) : null;
    const reallyPlaying = activeLobby && !activeLobby.finished && activeLobby.started;
    if (reallyPlaying) return cb({ ok: false, msg: 'Нельзя ставить паузу во время партии' });

    if (p.isPlaying) { p.isPlaying = false; p.lobbyId = null; }
    p.paused = !p.paused;
    if (!p.paused) p.waitingSince = Date.now();
    io.emit('arenaUpdate', { arenaId });
    cb({ ok: true, paused: p.paused });
  });

  // === ЧАТ АРЕНЫ ===
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
    const msg = {
      id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6),
      user: socket.username,
      text,
      ts: Date.now(),
      arenaId
    };
    // Храним в истории арены, чтобы модерация могла удалять
    if (!state.chat) state.chat = [];
    state.chat.push(msg);
    if (state.chat.length > 200) state.chat.shift();
    io.emit('arenaChatMessage', msg);
  });

  // Модерация арена-чата (глобально по arenaId)
  socket.on('modDeleteArenaMessage', ({ arenaId, msgId }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    if (!isMod(socket.username)) return cb({ ok: false, msg: 'Нет прав' });
    const state = arenas.get(arenaId);
    if (!state) return cb({ ok: false, msg: 'Арена не найдена' });
    if (!state.chat) return cb({ ok: false, msg: 'Сообщение не найдено' });
    const idx = state.chat.findIndex(m => m.id === msgId);
    if (idx < 0) return cb({ ok: false, msg: 'Сообщение не найдено' });
    state.chat.splice(idx, 1);
    io.emit('chatMessageDeleted', { msgId, scope: 'arena', arenaId });
    cb({ ok: true });
  });

  socket.on('disconnect', () => {
    console.log(`[socket] отключён ${socket.id} (${socket.username || '—'})`);
    online.delete(socket.id);
    if (socket.username) {
      for (const state of arenas.values()) {
        const p = state.participants.get(socket.username);
        if (p && p.socketId === socket.id) p.socketId = null;
      }
    }
    const lobbyId = socketToLobby.get(socket.id);
    socketToLobby.delete(socket.id);
    if (lobbyId) {
      const l = lobbies.get(lobbyId);
      if (l && !l.finished) {
        if (l.started) {
          const myColor = socket.id === l.hostSocket ? l.hostColor : l.guestColor;
          const winner = myColor === 'w' ? 'b' : 'w';
          finishGame(lobbyId, winner, 'Соперник отключился');
        } else {
          io.to(lobbyId).emit('opponentLeft');
          lobbies.delete(lobbyId);
          io.emit('lobbiesUpdate');
        }
      }
    }
    broadcastOnline();
  });
});

// ======================= ЗАПУСК =======================
(async () => {
  try {
    await initDB();
    await loadDB();
  } catch (err) {
    console.error('[DB] Не удалось инициализировать базу данных:', err.message || err.code || err);
  }
  getArenaSchedule(48);

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log('==================================================');
    console.log('  Kingside — сервер запущен');
    console.log(`  Локально:  http://localhost:${PORT}`);
    console.log(`  Порт:      ${PORT}`);
    console.log('==================================================');
  });
})();

process.on('SIGINT', () => { process.exit(0); });
process.on('SIGTERM', () => { process.exit(0); });
process.on('uncaughtException', (err) => { console.error('[Server] Ошибка:', err); });
