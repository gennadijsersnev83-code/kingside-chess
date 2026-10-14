const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket', 'polling'],
  pingTimeout: 30000,
  pingInterval: 10000
});

app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
//  ХРАНИЛИЩЕ (JSON-файл, без БД)
// ============================================================
const DATA_FILE = path.join(__dirname, 'data.json');
let db = { users: {} };

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) { console.error('loadData:', e.message); }
}
function saveData() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }
  catch (e) { console.error('saveData:', e.message); }
}
loadData();

// ============================================================
//  БОТЫ (простой движок, без лагов)
// ============================================================
const BOTS = [
  { name: 'BotEasy',   rating: 800,  level: 1, title: 'Легко' },
  { name: 'BotMedium', rating: 1200, level: 2, title: 'Средне' },
  { name: 'BotHard',   rating: 1600, level: 3, title: 'Сложно' },
  { name: 'BotMaster', rating: 2000, level: 4, title: 'Мастер' }
];
const BOT_NAMES = new Set(BOTS.map(b => b.name));

// Простой бот: random для level 1, material+capture для 2-4
function pickBotMove(fen, level) {
  const state = parseFen(fen);
  const white = state.turn === 'w';
  const moves = allLegalMoves(state, white);
  if (!moves.length) return null;
  if (level === 1) return moves[Math.floor(Math.random() * moves.length)];

  // Оцениваем каждый ход: материал + бонус за захват
  let best = null, bestScore = -Infinity;
  for (const [from, to] of moves) {
    const captured = state.board[to[0]][to[1]];
    let score = 0;
    if (captured) {
      const v = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }[captured.toLowerCase()] || 0;
      score += v * 10;
    }
    // Небольшой рандом, чтобы не играл одинаково
    score += Math.random() * (level === 2 ? 3 : level === 3 ? 1.5 : 0.5);
    // Центр
    score += (3.5 - Math.abs(to[1] - 3.5)) * 0.1;
    if (score > bestScore) { bestScore = score; best = [from, to]; }
  }
  return best;
}

// ============================================================
//  ШАХМАТНЫЙ ДВИЖОК (для бота и валидации)
// ============================================================
function parseFen(fen) {
  const parts = fen.split(' ');
  const board = Array.from({ length: 8 }, () => Array(8).fill(null));
  parts[0].split('/').forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) f += +ch;
      else board[r][f++] = ch;
    }
  });
  return { board, turn: parts[1], castling: parts[2], ep: parts[3], half: +parts[4] || 0, full: +parts[5] || 1 };
}
function toFen(s) {
  const rows = s.board.map(r => {
    let str = '', e = 0;
    for (const c of r) { if (c) { if (e) { str += e; e = 0; } str += c; } else e++; }
    if (e) str += e;
    return str;
  }).join('/');
  return [rows, s.turn, s.castling, s.ep, s.half, s.full].join(' ');
}
const isWhite = p => !!p && p === p.toUpperCase();
const inB = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;

function pseudoMoves(state, r, c) {
  const p = state.board[r][c];
  if (!p) return [];
  const moves = [];
  const white = isWhite(p);
  const type = p.toLowerCase();
  const dir = white ? -1 : 1;
  const add = (rr, cc) => {
    if (!inB(rr, cc)) return false;
    const t = state.board[rr][cc];
    if (t && isWhite(t) === white) return false;
    moves.push([rr, cc]);
    return !t;
  };
  if (type === 'p') {
    const startRow = white ? 6 : 1;
    const oneR = r + dir;
    if (inB(oneR, c) && !state.board[oneR][c]) {
      moves.push([oneR, c]);
      const twoR = r + 2 * dir;
      if (r === startRow && inB(twoR, c) && !state.board[twoR][c]) moves.push([twoR, c]);
    }
    for (const dc of [-1, 1]) {
      const rr = r + dir, cc = c + dc;
      if (!inB(rr, cc)) continue;
      const t = state.board[rr][cc];
      if (t && isWhite(t) !== white) moves.push([rr, cc]);
      const epT = String.fromCharCode(97 + cc) + (8 - rr);
      if (state.ep && state.ep === epT && !t) moves.push([rr, cc]);
    }
  } else if (type === 'n') {
    [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]].forEach(([dr,dc]) => add(r+dr, c+dc));
  } else if (type === 'k') {
    [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]].forEach(([dr,dc]) => add(r+dr, c+dc));
    if (white && r === 7 && c === 4 && !isAttacked(state, 7, 4, false)) {
      if (state.castling.includes('K') && !state.board[7][5] && !state.board[7][6] && state.board[7][7] === 'R'
        && !isAttacked(state, 7, 5, false) && !isAttacked(state, 7, 6, false)) moves.push([7, 6]);
      if (state.castling.includes('Q') && !state.board[7][3] && !state.board[7][2] && !state.board[7][1] && state.board[7][0] === 'R'
        && !isAttacked(state, 7, 3, false) && !isAttacked(state, 7, 2, false)) moves.push([7, 2]);
    }
    if (!white && r === 0 && c === 4 && !isAttacked(state, 0, 4, true)) {
      if (state.castling.includes('k') && !state.board[0][5] && !state.board[0][6] && state.board[0][7] === 'r'
        && !isAttacked(state, 0, 5, true) && !isAttacked(state, 0, 6, true)) moves.push([0, 6]);
      if (state.castling.includes('q') && !state.board[0][3] && !state.board[0][2] && !state.board[0][1] && state.board[0][0] === 'r'
        && !isAttacked(state, 0, 3, true) && !isAttacked(state, 0, 2, true)) moves.push([0, 2]);
    }
  } else {
    const dirs = [];
    if (type === 'r' || type === 'q') dirs.push([-1,0],[1,0],[0,-1],[0,1]);
    if (type === 'b' || type === 'q') dirs.push([-1,-1],[-1,1],[1,-1],[1,1]);
    for (const [dr, dc] of dirs) {
      let rr = r + dr, cc = c + dc;
      while (add(rr, cc)) { rr += dr; cc += dc; }
    }
  }
  return moves;
}
function findKing(state, white) {
  const k = white ? 'K' : 'k';
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (state.board[r][c] === k) return [r, c];
  return null;
}
function isAttacked(state, r, c, byWhite) {
  for (let rr = 0; rr < 8; rr++) for (let cc = 0; cc < 8; cc++) {
    const p = state.board[rr][cc];
    if (!p || isWhite(p) !== byWhite) continue;
    const t = p.toLowerCase();
    if (t === 'p') {
      const dir = byWhite ? -1 : 1;
      if (rr + dir === r && (cc - 1 === c || cc + 1 === c)) return true;
      continue;
    }
    if (t === 'k') {
      if (Math.abs(rr - r) <= 1 && Math.abs(cc - c) <= 1 && (rr !== r || cc !== c)) return true;
      continue;
    }
    if (pseudoMoves(state, rr, cc).some(([mr, mc]) => mr === r && mc === c)) return true;
  }
  return false;
}
function inCheck(state, white) {
  const k = findKing(state, white);
  if (!k) return false;
  return isAttacked(state, k[0], k[1], !white);
}
function applyMove(state, from, to) {
  const copy = {
    board: state.board.map(row => row.slice()),
    turn: state.turn, castling: state.castling, ep: state.ep,
    half: state.half, full: state.full
  };
  const [fr, fc] = from, [tr, tc] = to;
  const p = copy.board[fr][fc];
  const white = isWhite(p);
  const type = p.toLowerCase();
  if (type === 'p' && copy.ep) {
    const target = String.fromCharCode(97 + tc) + (8 - tr);
    if (copy.ep === target && !copy.board[tr][tc]) copy.board[fr][tc] = null;
  }
  copy.board[tr][tc] = p;
  copy.board[fr][fc] = null;
  if (type === 'p' && (tr === 0 || tr === 7)) copy.board[tr][tc] = white ? 'Q' : 'q';
  if (type === 'k' && Math.abs(tc - fc) === 2) {
    const row = fr;
    if (tc > fc) { copy.board[row][5] = copy.board[row][7]; copy.board[row][7] = null; }
    else { copy.board[row][3] = copy.board[row][0]; copy.board[row][0] = null; }
  }
  let cast = copy.castling;
  if (type === 'k') cast = cast.replace(white ? /[KQ]/g : /[kq]/g, '');
  if (type === 'r') {
    if (fr === 7 && fc === 0) cast = cast.replace('Q', '');
    if (fr === 7 && fc === 7) cast = cast.replace('K', '');
    if (fr === 0 && fc === 0) cast = cast.replace('q', '');
    if (fr === 0 && fc === 7) cast = cast.replace('k', '');
  }
  if (!cast) cast = '-';
  let ep = '-';
  if (type === 'p' && Math.abs(tr - fr) === 2) {
    ep = String.fromCharCode(97 + fc) + (8 - (fr + (tr - fr) / 2));
  }
  copy.castling = cast;
  copy.ep = ep;
  copy.turn = white ? 'b' : 'w';
  copy.full += 1;
  return copy;
}
function legalMovesFor(state, r, c) {
  const p = state.board[r][c];
  if (!p) return [];
  const white = isWhite(p);
  return pseudoMoves(state, r, c).filter(([rr, cc]) => !inCheck(applyMove(state, [r, c], [rr, cc]), white));
}
function allLegalMoves(state, white) {
  const res = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c];
    if (!p || isWhite(p) !== white) continue;
    for (const [rr, cc] of legalMovesFor(state, r, c)) res.push([[r, c], [rr, cc]]);
  }
  return res;
}
function hasAnyLegalMove(state, white) {
  return allLegalMoves(state, white).length > 0;
}
function toSAN(state, from, to) {
  const [fr, fc] = from, [tr, tc] = to;
  const p = state.board[fr][fc];
  if (!p) return '';
  const t = p.toLowerCase();
  const isCap = !!state.board[tr][tc] || (t === 'p' && fc !== tc);
  const dest = String.fromCharCode(97 + tc) + (8 - tr);
  if (t === 'k' && Math.abs(tc - fc) === 2) return tc > fc ? 'O-O' : 'O-O-O';
  let san = '';
  if (t === 'p') {
    if (isCap) san += String.fromCharCode(97 + fc) + 'x';
    san += dest;
  } else {
    san += t === 'n' ? 'N' : t.toUpperCase();
    let amb = false, sameFile = false, sameRank = false;
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      if (r === fr && c === fc) continue;
      const q = state.board[r][c];
      if (!q || q !== p) continue;
      if (legalMovesFor(state, r, c).some(([mr, mc]) => mr === tr && mc === tc)) {
        amb = true;
        if (c === fc) sameFile = true;
        if (r === fr) sameRank = true;
      }
    }
    if (amb) {
      if (!sameFile) san += String.fromCharCode(97 + fc);
      else if (!sameRank) san += (8 - fr);
      else san += String.fromCharCode(97 + fc) + (8 - fr);
    }
    if (isCap) san += 'x';
    san += dest;
  }
  const next = applyMove(state, from, to);
  const nextWhite = next.turn === 'w';
  const isChk = inCheck(next, nextWhite);
  const hasM = hasAnyLegalMove(next, nextWhite);
  if (isChk && !hasM) san += '#';
  else if (isChk) san += '+';
  return san;
}
function checkEnd(state) {
  const white = state.turn === 'w';
  if (!hasAnyLegalMove(state, white)) {
    if (inCheck(state, white)) return { result: white ? 'b' : 'w', reason: 'Мат' };
    return { result: 'draw', reason: 'Пат' };
  }
  return null;
}

// ============================================================
//  ПОЛЬЗОВАТЕЛИ
// ============================================================
function hash(pw, salt) {
  return crypto.pbkdf2Sync(pw, salt, 50000, 32, 'sha256').toString('hex');
}
function newSalt() { return crypto.randomBytes(16).toString('hex'); }

function publicUser(name) {
  const u = db.users[name];
  if (!u) return null;
  return {
    username: name, rating: u.rating, wins: u.wins, losses: u.losses, draws: u.draws, games: u.games,
    isBot: !!u.isBot, createdAt: u.createdAt
  };
}
function ensureBotUser(bot) {
  if (!db.users[bot.name]) {
    db.users[bot.name] = {
      passwordHash: '', salt: '', rating: bot.rating,
      wins: 0, losses: 0, draws: 0, games: 0,
      isBot: true, createdAt: Date.now()
    };
  }
}
BOTS.forEach(ensureBotUser);
saveData();

// ============================================================
//  ЛОББИ И АРЕНЫ
// ============================================================
const online = new Map();        // socketId -> username
const lobbies = new Map();       // id -> lobby
const socketToLobby = new Map(); // socketId -> lobbyId

function genId() { return Math.random().toString(36).slice(2, 10); }

function broadcastLobbies() {
  const list = [];
  for (const [id, l] of lobbies) {
    if (l.finished || l.arenaId) continue;
    list.push({
      id, host: l.host, time: l.time, inc: l.inc,
      status: l.guest ? 'playing' : 'waiting',
      isBot: !!l.isBot
    });
  }
  io.emit('lobbies', list);
  io.emit('stats', {
    online: online.size + BOTS.length,
    games: Object.values(db.users).reduce((s, u) => s + u.games, 0) / 2 | 0,
    active: [...lobbies.values()].filter(l => l.started && !l.finished).length
  });
}

function finishGame(lobbyId, result, reason) {
  const l = lobbies.get(lobbyId);
  if (!l || l.finished) return;
  l.finished = true;

  const whiteName = l.hostColor === 'w' ? l.host : l.guest;
  const blackName = l.hostColor === 'b' ? l.host : l.guest;
  const wu = db.users[whiteName], bu = db.users[blackName];
  if (!wu || !bu) { lobbies.delete(lobbyId); return; }

  // ELO
  const k = 32;
  const expW = 1 / (1 + Math.pow(10, (bu.rating - wu.rating) / 400));
  const expB = 1 - expW;
  let sW = 0.5, sB = 0.5;
  if (result === 'w') { sW = 1; sB = 0; }
  else if (result === 'b') { sW = 0; sB = 1; }
  const dW = Math.round(k * (sW - expW));
  const dB = Math.round(k * (sB - expB));
  wu.rating += dW; bu.rating += dB;
  wu.games++; bu.games++;
  if (result === 'w') { wu.wins++; bu.losses++; }
  else if (result === 'b') { bu.wins++; wu.losses++; }
  else { wu.draws++; bu.draws++; }

  // Обновляем статистику ботов, но рейтинг не трогаем
  if (wu.isBot) wu.rating -= dW;
  if (bu.isBot) bu.rating -= dB;
  saveData();

  io.to(lobbyId).emit('gameEnded', { result, reason, whiteDelta: dW, blackDelta: dB });
  io.to(lobbyId).emit('timeUpdate', { timeW: l.timeW, timeB: l.timeB });

  setTimeout(() => {
    if (lobbies.has(lobbyId)) {
      io.to(lobbyId).socketsLeave(lobbyId);
      lobbies.delete(lobbyId);
      broadcastLobbies();
    }
  }, 3000);
}

// ============================================================
//  ТИКЕР ЧАСОВ
// ============================================================
setInterval(() => {
  const now = Date.now();
  for (const [id, l] of lobbies) {
    if (!l.started || l.finished) continue;
    const elapsed = Math.floor((now - l.lastTick) / 1000);
    if (elapsed <= 0) continue;
    l.lastTick = now;
    if (l.turn === 'w') l.timeW = Math.max(0, l.timeW - elapsed);
    else l.timeB = Math.max(0, l.timeB - elapsed);
    io.to(id).emit('timeUpdate', { timeW: l.timeW, timeB: l.timeB });
    if (l.timeW <= 0) finishGame(id, 'b', 'Время');
    else if (l.timeB <= 0) finishGame(id, 'w', 'Время');
  }
}, 1000);

// ============================================================
//  ХОД БОТА
// ============================================================
function scheduleBotMove(lobbyId) {
  const l = lobbies.get(lobbyId);
  if (!l || l.finished || !l.isBot) return;
  const botColor = l.botColor;
  if (l.turn !== botColor) return;

  const delay = 300 + Math.random() * 500;
  setTimeout(() => {
    const cur = lobbies.get(lobbyId);
    if (!cur || cur.finished || cur.turn !== botColor) return;
    const bot = db.users[l.botName];
    const level = (BOTS.find(b => b.name === l.botName) || {}).level || 2;
    const mv = pickBotMove(cur.fen, level);
    if (!mv) return;
    const [from, to] = mv;
    const state = parseFen(cur.fen);
    const legal = legalMovesFor(state, from[0], from[1]);
    if (!legal.some(([r, c]) => r === to[0] && c === to[1])) return;

    const san = toSAN(state, from, to);
    const next = applyMove(state, from, to);
    cur.fen = toFen(next);
    cur.turn = next.turn;
    cur.lastTick = Date.now();

    io.to(lobbyId).emit('boardUpdate', { fen: cur.fen, san });

    const end = checkEnd(next);
    if (end) finishGame(lobbyId, end.result, end.reason);
  }, delay);
}

// ============================================================
//  SOCKET.IO
// ============================================================
io.on('connection', (socket) => {
  socket.on('register', ({ username, password }, cb) => {
    if (typeof cb !== 'function') return;
    if (!username || !password) return cb({ ok: false, msg: 'Заполните поля' });
    if (BOT_NAMES.has(username)) return cb({ ok: false, msg: 'Имя занято' });
    if (username.length < 2 || username.length > 24) return cb({ ok: false, msg: 'Логин 2-24' });
    if (!/^[a-zA-Z0-9_\-а-яА-Я]+$/.test(username)) return cb({ ok: false, msg: 'Только буквы, цифры, _ -' });

    let u = db.users[username];
    if (u) {
      if (!u.salt || u.isBot) return cb({ ok: false, msg: 'Это бот' });
      const h = hash(password, u.salt);
      if (h !== u.passwordHash) return cb({ ok: false, msg: 'Неверный пароль' });
    } else {
      const salt = newSalt();
      u = {
        passwordHash: hash(password, salt), salt,
        rating: 1200, wins: 0, losses: 0, draws: 0, games: 0,
        isBot: false, createdAt: Date.now()
      };
      db.users[username] = u;
      saveData();
    }
    online.set(socket.id, username);
    socket.username = username;
    cb({ ok: true, user: publicUser(username) });
    broadcastLobbies();
  });

  socket.on('getStats', (cb) => {
    if (typeof cb !== 'function') return;
    cb({
      online: online.size + BOTS.length,
      games: Object.values(db.users).reduce((s, u) => s + u.games, 0) / 2 | 0,
      active: [...lobbies.values()].filter(l => l.started && !l.finished).length
    });
  });

  socket.on('getLobbies', (cb) => {
    if (typeof cb !== 'function') return;
    const list = [];
    for (const [id, l] of lobbies) {
      if (l.finished || l.arenaId) continue;
      list.push({ id, host: l.host, time: l.time, inc: l.inc, status: l.guest ? 'playing' : 'waiting', isBot: !!l.isBot });
    }
    cb(list);
  });

  socket.on('getBots', (cb) => {
    if (typeof cb !== 'function') return;
    cb(BOTS.map(b => ({ name: b.name, title: b.title, level: b.level, rating: db.users[b.name].rating })));
  });

  socket.on('getProfile', ({ username }, cb) => {
    if (typeof cb !== 'function') return;
    const u = db.users[username];
    if (!u) return cb({ ok: false, msg: 'Не найден' });
    cb({ ok: true, user: publicUser(username) });
  });

  // Создать лобби (человек-человек)
  socket.on('createLobby', ({ time, inc }, cb) => {
    if (typeof cb !== 'function') return;
    if (!socket.username) return cb({ ok: false, msg: 'Не авторизован' });
    time = Math.max(1, Math.min(60, +time || 5));
    inc = Math.max(0, Math.min(60, +inc || 0));

    // Ищем совпадение
    for (const [, l] of lobbies) {
      if (l.finished || l.arenaId || l.isBot || l.guest) continue;
      if (l.host === socket.username) continue;
      if (l.time !== time || l.inc !== inc) continue;
      // Нашли — присоединяемся
      l.guest = socket.username;
      l.guestSocket = socket.id;
      const hostIsWhite = Math.random() < 0.5;
      l.hostColor = hostIsWhite ? 'w' : 'b';
      l.guestColor = hostIsWhite ? 'b' : 'w';
      l.started = true;
      l.lastTick = Date.now();
      socket.join(l.id);
      socketToLobby.set(socket.id, l.id);
      io.to(l.hostSocket).emit('gameStart', {
        color: l.hostColor, opponent: l.guest, opponentRating: db.users[l.guest].rating,
        time: l.time, inc: l.inc, lobbyId: l.id, fen: l.fen, isBot: false
      });
      io.to(l.guestSocket).emit('gameStart', {
        color: l.guestColor, opponent: l.host, opponentRating: db.users[l.host].rating,
        time: l.time, inc: l.inc, lobbyId: l.id, fen: l.fen, isBot: false
      });
      cb({ ok: true, id: l.id, matched: true });
      broadcastLobbies();
      return;
    }
    // Создаём новое
    const id = genId();
    lobbies.set(id, {
      id, host: socket.username, hostSocket: socket.id,
      guest: null, guestSocket: null,
      hostColor: null, guestColor: null,
      time, inc, timeW: time * 60, timeB: time * 60,
      turn: 'w', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      started: false, finished: false, lastTick: Date.now(),
      isBot: false
    });
    socket.join(id);
    socketToLobby.set(socket.id, id);
    cb({ ok: true, id });
    broadcastLobbies();
  });

  socket.on('joinLobby', ({ id }, cb) => {
    if (typeof cb !== 'function') return;
    if (!socket.username) return cb({ ok: false, msg: 'Не авторизован' });
    const l = lobbies.get(id);
    if (!l) return cb({ ok: false, msg: 'Лобби не найдено' });
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
    io.to(l.hostSocket).emit('gameStart', {
      color: l.hostColor, opponent: l.guest, opponentRating: db.users[l.guest].rating,
      time: l.time, inc: l.inc, lobbyId: id, fen: l.fen, isBot: !!l.isBot
    });
    io.to(l.guestSocket).emit('gameStart', {
      color: l.guestColor, opponent: l.host, opponentRating: db.users[l.host].rating,
      time: l.time, inc: l.inc, lobbyId: id, fen: l.fen, isBot: !!l.isBot
    });
    if (l.isBot) setTimeout(() => scheduleBotMove(id), 500);
    cb({ ok: true });
    broadcastLobbies();
  });

  socket.on('cancelLobby', ({ id }) => {
    const l = lobbies.get(id);
    if (!l || l.host !== socket.username || l.started) return;
    lobbies.delete(id);
    socketToLobby.delete(socket.id);
    broadcastLobbies();
  });

  // Игра с ботом
  socket.on('playWithBot', ({ time, inc, botName }, cb) => {
    if (typeof cb !== 'function') return;
    if (!socket.username) return cb({ ok: false, msg: 'Не авторизован' });
    const bot = BOTS.find(b => b.name === botName);
    if (!bot) return cb({ ok: false, msg: 'Бот не найден' });
    time = Math.max(1, Math.min(60, +time || 5));
    inc = Math.max(0, Math.min(60, +inc || 0));
    const id = genId();
    lobbies.set(id, {
      id, host: socket.username, hostSocket: socket.id,
      guest: botName, guestSocket: null,
      hostColor: 'w', guestColor: 'b',
      time, inc, timeW: time * 60, timeB: time * 60,
      turn: 'w', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      started: true, finished: false, lastTick: Date.now(),
      isBot: true, botName, botColor: 'b'
    });
    socket.join(id);
    socketToLobby.set(socket.id, id);
    io.to(socket.id).emit('gameStart', {
      color: 'w', opponent: botName, opponentRating: db.users[botName].rating,
      time, inc, lobbyId: id, fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      isBot: true
    });
    cb({ ok: true, id });
    broadcastLobbies();
  });

  socket.on('move', ({ lobbyId, fen, san }) => {
    const l = lobbies.get(lobbyId);
    if (!l || l.finished || !l.started) return;
    const myColor = socket.id === l.hostSocket ? l.hostColor : l.guestColor;
    if (l.turn !== myColor) return;
    if (typeof fen !== 'string') return;
    const newTurn = fen.split(' ')[1];
    if (newTurn === l.turn) return;

    // Обновляем часы
    const now = Date.now();
    const elapsed = Math.floor((now - l.lastTick) / 1000);
    if (myColor === 'w') l.timeW = Math.max(0, l.timeW - elapsed) + l.inc;
    else l.timeB = Math.max(0, l.timeB - elapsed) + l.inc;
    l.lastTick = now;

    l.fen = fen;
    l.turn = newTurn;
    io.to(lobbyId).emit('boardUpdate', { fen, san });
    io.to(lobbyId).emit('timeUpdate', { timeW: l.timeW, timeB: l.timeB });

    const state = parseFen(fen);
    const end = checkEnd(state);
    if (end) { finishGame(lobbyId, end.result, end.reason); return; }

    if (l.isBot && l.turn === l.botColor) scheduleBotMove(lobbyId);
  });

  socket.on('resign', ({ lobbyId }) => {
    const l = lobbies.get(lobbyId);
    if (!l || l.finished) return;
    const myColor = socket.id === l.hostSocket ? l.hostColor : l.guestColor;
    finishGame(lobbyId, myColor === 'w' ? 'b' : 'w', 'Сдача');
  });

  socket.on('drawOffer', ({ lobbyId }) => {
    const l = lobbies.get(lobbyId);
    if (!l || l.finished) return;
    socket.to(lobbyId).emit('drawOffered');
    if (l.isBot) {
      // Бот соглашается, если материал примерно равен
      const state = parseFen(l.fen);
      let score = 0;
      const vals = { p: 1, n: 3, b: 3, r: 5, q: 9 };
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        const p = state.board[r][c];
        if (!p) continue;
        const v = vals[p.toLowerCase()] || 0;
        score += isWhite(p) ? v : -v;
      }
      const botSign = l.botColor === 'w' ? 1 : -1;
      if (score * botSign < 1) {
        setTimeout(() => finishGame(lobbyId, 'draw', 'Ничья'), 500);
      } else {
        setTimeout(() => socket.emit('drawDeclined'), 500);
      }
    }
  });

  socket.on('drawAccept', ({ lobbyId }) => {
    if (!lobbies.has(lobbyId)) return;
    finishGame(lobbyId, 'draw', 'Ничья');
  });

  socket.on('drawDecline', ({ lobbyId }) => {
    socket.to(lobbyId).emit('drawDeclined');
  });

  socket.on('getGameState', ({ lobbyId }, cb) => {
    if (typeof cb !== 'function') return;
    const l = lobbies.get(lobbyId);
    if (!l) return cb({ ok: false, msg: 'Нет партии' });
    if (socket.username !== l.host && socket.username !== l.guest) return cb({ ok: false, msg: 'Не участник' });
    if (socket.username === l.host) l.hostSocket = socket.id;
    else l.guestSocket = socket.id;
    socket.join(lobbyId);
    socketToLobby.set(socket.id, lobbyId);
    const myColor = socket.username === l.host ? l.hostColor : l.guestColor;
    const opp = socket.username === l.host ? l.guest : l.host;
    cb({
      ok: true,
      state: {
        myColor, opponent: opp, opponentRating: db.users[opp] ? db.users[opp].rating : null,
        time: l.time, inc: l.inc, timeW: l.timeW, timeB: l.timeB, turn: l.turn,
        fen: l.fen, finished: l.finished, isBot: !!l.isBot
      }
    });
  });

  socket.on('disconnect', () => {
    online.delete(socket.id);
    const lobbyId = socketToLobby.get(socket.id);
    socketToLobby.delete(socket.id);
    if (lobbyId) {
      const l = lobbies.get(lobbyId);
      if (l && !l.finished && !l.started) {
        lobbies.delete(lobbyId);
        broadcastLobbies();
      }
    }
    broadcastLobbies();
  });
});

// ============================================================
//  ЗАПУСК
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('=================================');
  console.log('  Kingside v2 запущен');
  console.log('  http://localhost:' + PORT);
  console.log('=================================');
});
