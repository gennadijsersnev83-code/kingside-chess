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

// ======================= БАЗА ДАННЫХ =======================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : false
});

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
  console.log('[DB] Схема готова');
}

// Пользователи в памяти (для быстрого доступа)
let db = { users: {}, games: [] };

async function loadDB() {
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
      createdAt: Number(row.created_at)
    };
  }
  console.log(`[DB] Загружено: ${Object.keys(db.users).length} игроков`);
}

async function saveUser(username) {
  const u = db.users[username];
  if (!u) return;
  await pool.query(
    `INSERT INTO users (username, password_hash, salt, rating, wins, losses, draws, games, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (username) DO UPDATE SET
       rating = EXCLUDED.rating,
       wins = EXCLUDED.wins,
       losses = EXCLUDED.losses,
       draws = EXCLUDED.draws,
       games = EXCLUDED.games`,
    [username, u.passwordHash, u.salt, u.rating, u.wins, u.losses, u.draws, u.games, u.createdAt]
  );
}

async function saveGame(game) {
  await pool.query(
    `INSERT INTO games (white, black, result, reason, time_control, increment,
                        white_before, black_before, white_after, black_after, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [game.white, game.black, game.result, game.reason,
     game.timeControl, game.increment,
     game.whiteBefore, game.blackBefore, game.whiteAfter, game.blackAfter,
     game.finishedAt]
  );
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
    createdAt: u.createdAt
  };
}

// ======================= ХРАНИЛИЩА В ПАМЯТИ =======================
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
  io.emit('stats', {
    online: online.size,
    games: db.games.length,
    activeGames: countActiveLobbies()
  });
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

// ======================= СПИСОК ТЕКУЩИХ ПАРТИЙ =======================
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

// ======================= ФИНАЛИЗАЦИЯ ПАРТИИ =======================
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

  const whiteBefore = whiteUser.rating;
  const blackBefore = blackUser.rating;

  let whiteScore = 0.5, blackScore = 0.5;
  if (result === 'w') { whiteScore = 1; blackScore = 0; }
  else if (result === 'b') { whiteScore = 0; blackScore = 1; }

  const kWhite = kFactor(whiteBefore, whiteUser.games);
  const kBlack = kFactor(blackBefore, blackUser.games);
  const whiteDelta = eloDelta(whiteBefore, blackBefore, whiteScore, kWhite);
  const blackDelta = eloDelta(blackBefore, whiteBefore, blackScore, kBlack);
  const whiteAfter = whiteBefore + whiteDelta;
  const blackAfter = blackBefore + blackDelta;

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
    finishedAt: Date.now()
  };
  db.games.push(gameRecord);
  if (db.games.length > 10000) db.games.shift();

  try {
    await saveUser(whiteName);
    await saveUser(blackName);
    await saveGame(gameRecord);
    console.log(`[DB] Сохранено: ${whiteName} vs ${blackName} = ${result}`);
  } catch (err) {
    console.error('[DB] Ошибка сохранения партии:', err.message);
  }

  const isArena = !!l.arenaId;
  io.to(lobbyId).emit('gameEnded', {
    result, reason,
    whiteDelta, blackDelta, whiteAfter, blackAfter,
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

  io.emit('stats', {
    online: online.size,
    games: db.games.length,
    activeGames: countActiveLobbies()
  });
}

// ======================= АРЕНЫ =======================
const ARENA_TEMPLATES = [
  { id: 'bullet-halfhour', name: 'Получасовая пуля', description: '1+0 · рейтинговая',
    timeControl: 1, increment: 0, durationMin: 25, repeat: 'every30', color: 'bullet' },
  { id: 'blitz-hourly', name: 'Ежечасная блиц-арена', description: '3+2 · рейтинговая',
    timeControl: 3, increment: 2, durationMin: 50, repeat: 'hourly', color: 'blitz' },
  { id: 'rapid-daily', name: 'Ежедневная рапид-арена', description: '10+0 · рейтинговая',
    timeControl: 10, increment: 0, durationMin: 90, repeat: 'daily', startHour: 20, color: 'rapid' },
  { id: 'weekly-classical', name: 'Воскресная классика', description: '30+0 · классика',
    timeControl: 30, increment: 0, durationMin: 180, repeat: 'weekly', weekday: 0, startHour: 18, color: 'classical' }
];

function nextStartFor(tpl, now) {
  const c = new Date(now);
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
  if (tpl.repeat === 'daily') {
    c.setHours(tpl.startHour || 20, 0, 0, 0);
    if (c.getTime() <= now) c.setDate(c.getDate() + 1);
    return c.getTime();
  }
  if (tpl.repeat === 'weekly') {
    const target = tpl.weekday != null ? tpl.weekday : 0;
    let diff = target - c.getDay();
    if (diff < 0) diff += 7;
    c.setDate(c.getDate() + diff);
    c.setHours(tpl.startHour || 18, 0, 0, 0);
    if (c.getTime() <= now) c.setDate(c.getDate() + 7);
    return c.getTime();
  }
  return now + 3600000;
}

function stepFor(tpl) {
  if (tpl.repeat === 'hourly') return 3600 * 1000;
  if (tpl.repeat === 'every30') return 30 * 60 * 1000;
  if (tpl.repeat === 'daily') return 24 * 3600 * 1000;
  if (tpl.repeat === 'weekly') return 7 * 24 * 3600 * 1000;
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
  io.emit('stats', {
    online: online.size,
    games: db.games.length,
    activeGames: countActiveLobbies()
  });
}

// ======================= СИСТЕМА ОЧКОВ =======================
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

    while (t <= end && safety < 200) {
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

// ======================= ТИКЕР ТАЙМЕРОВ =======================
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

// ======================= SOCKET.IO =======================
io.on('connection', (socket) => {
  console.log(`[socket] подключён ${socket.id}`);

  socket.emit('onlineCount', online.size);
  socket.emit('stats', {
    online: online.size,
    games: db.games.length,
    activeGames: countActiveLobbies()
  });

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
      db.users[username] = {
        passwordHash, salt, rating: 1200,
        wins: 0, losses: 0, draws: 0, games: 0,
        createdAt: Date.now()
      };
      try {
        await saveUser(username);
      } catch (err) {
        console.error('[DB] Ошибка сохранения пользователя:', err.message);
      }
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
        finishedAt: Number(r.finished_at)
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
      console.error('[DB] Ошибка загрузки профиля:', err.message);
      cb({ ok: false, msg: 'Ошибка базы данных' });
    }
  });

  socket.on('getStats', (cb) => {
    if (typeof cb !== 'function') return;
    cb({ online: online.size, games: db.games.length, activeGames: countActiveLobbies() });
  });

  socket.on('getTopArenas', (cb) => {
    if (typeof cb !== 'function') return;
    cb(getTopLiveArenas());
  });

  socket.on('getLiveGames', (cb) => {
    if (typeof cb !== 'function') return;
    cb(buildGamesList());
  });

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
        timeW: l.timeW, timeB: l.timeB,
        turn: l.turn,
        timeControl: l.time, increment: l.inc,
        fen: l.fen,
        isArena: !!l.arenaId,
        arenaName: l.arenaName || null
      }
    });
  });

  socket.on('unwatchGame', ({ id }) => {
    socket.leave('watch:' + id);
  });

  socket.on('getLobbies', (cb) => {
    if (typeof cb !== 'function') return;
    const list = [];
    for (const [id, l] of lobbies.entries()) {
      if (l.finished || l.arenaId) continue;
      list.push({ id, host: l.host, time: l.time, inc: l.inc,
                  status: l.guest ? 'playing' : 'waiting' });
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
      time: l.time, inc: l.inc, lobbyId: id, fen: l.fen, chat: l.chat,
      isArena: false
    });
    io.to(l.guestSocket).emit('gameStart', {
      color: l.guestColor, opponent: l.host, opponentRating: hostRating,
      time: l.time, inc: l.inc, lobbyId: id, fen: l.fen, chat: l.chat,
      isArena: false
    });

    cb({ ok: true, id });
    broadcastLobbies();
    io.emit('stats', {
      online: online.size,
      games: db.games.length,
      activeGames: countActiveLobbies()
    });
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

  socket.on('chatMessage', ({ lobbyId, text }) => {
    const l = lobbies.get(lobbyId);
    if (!l || !socket.username) return;
    if (typeof text !== 'string') return;
    text = text.trim().slice(0, 300);
    if (!text) return;
    const msg = { user: socket.username, text, ts: Date.now() };
    l.chat.push(msg);
    if (l.chat.length > 20) l.chat.shift();
    io.to(lobbyId).emit('chatMessage', msg);
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

  socket.on('getArenas', (cb) => {
    if (typeof cb !== 'function') return;
    cb(getArenaSchedule(48));
  });

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

    io.emit('arenaChatMessage', {
      system: true,
      text: `${socket.username} присоединился к арене`,
      ts: Date.now()
    });
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
      io.emit('arenaChatMessage', {
        system: true,
        text: `${socket.username} покинул арену`,
        ts: Date.now()
      });
      io.emit('arenaUpdate', { arenaId });
    }
    cb({ ok: true });
  });

  socket.on('pauseArena', ({ arenaId }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    const state = arenas.get(arenaId);
    if (!state) return cb({ ok: false, msg: 'Арена не найдена' });
    if (state.finished || state.phase === 'finished') {
      return cb({ ok: false, msg: 'Арена завершена' });
    }
    const p = state.participants.get(socket.username);
    if (!p) return cb({ ok: false, msg: 'Вы не участвуете' });

    const activeLobby = p.lobbyId ? lobbies.get(p.lobbyId) : null;
    const reallyPlaying = activeLobby && !activeLobby.finished && activeLobby.started;

    if (reallyPlaying) {
      return cb({ ok: false, msg: 'Нельзя ставить паузу во время партии' });
    }

    if (p.isPlaying) {
      p.isPlaying = false;
      p.lobbyId = null;
    }

    p.paused = !p.paused;
    if (!p.paused) p.waitingSince = Date.now();
    io.emit('arenaUpdate', { arenaId });
    cb({ ok: true, paused: p.paused });
  });

  socket.on('arenaChat', ({ arenaId, text }) => {
    const state = arenas.get(arenaId);
    if (!state || !socket.username) return;
    if (typeof text !== 'string') return;
    text = text.trim().slice(0, 300);
    if (!text) return;
    io.emit('arenaChatMessage', { user: socket.username, text, ts: Date.now() });
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
    console.error('[DB] Не удалось инициализировать базу данных:', err.message);
    console.error('Проверь переменную DATABASE_URL в Variables сервиса.');
  }
  getArenaSchedule(48);

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log('==================================================');
    console.log('  Kingside — сервер запущен');
    console.log(`  Локально:  http://localhost:${PORT}`);
    console.log(`  Порт:      ${PORT}`);
    console.log(`  База:      PostgreSQL`);
    console.log('==================================================');
  });
})();

process.on('SIGINT', () => { process.exit(0); });
process.on('SIGTERM', () => { process.exit(0); });
process.on('uncaughtException', (err) => { console.error('[Server] Ошибка:', err); });
