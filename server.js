const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { transports: ['websocket'] });
app.use(express.static(path.join(__dirname, 'public')));

// ---------- ХРАНИЛИЩЕ ----------
const DATA_FILE = path.join(__dirname, 'data.json');
let db = { users: {} };
try { if (fs.existsSync(DATA_FILE)) db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
function save() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) {} }

// ---------- БОТЫ ----------
const BOTS = [
  { name: 'Bot1', title: 'Легко',  level: 1, rating: 800 },
  { name: 'Bot2', title: 'Средне', level: 2, rating: 1200 },
  { name: 'Bot3', title: 'Сложно', level: 3, rating: 1600 },
  { name: 'Bot4', title: 'Мастер', level: 4, rating: 2000 }
];
BOTS.forEach(b => {
  if (!db.users[b.name]) {
    db.users[b.name] = { password: '', rating: b.rating, wins: 0, losses: 0, draws: 0, games: 0, isBot: true, created: Date.now() };
  }
});
save();

// ---------- ШАХМАТЫ (минимум для валидации и бота) ----------
function parse(fen) {
  const p = fen.split(' ');
  const b = Array.from({ length: 8 }, () => Array(8).fill(null));
  p[0].split('/').forEach((row, r) => { let f = 0; for (const ch of row) { if (/\d/.test(ch)) f += +ch; else b[r][f++] = ch; } });
  return { b, turn: p[1], cast: p[2], ep: p[3] };
}
function fen(s) {
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
  else if (t === 'k') { [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]].forEach(([a,b]) => add(r+a, c+b)); }
  else { const dirs = []; if (t === 'r' || t === 'q') dirs.push([-1,0],[1,0],[0,-1],[0,1]); if (t === 'b' || t === 'q') dirs.push([-1,-1],[-1,1],[1,-1],[1,1]); for (const [a,b] of dirs) { let rr = r + a, cc = c + b; while (add(rr, cc)) { rr += a; cc += b; } } }
  return m;
}
function findK(s, white) { const k = white ? 'K' : 'k'; for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (s.b[r][c] === k) return [r, c]; return null; }
function atk(s, r, c, byWhite) {
  for (let rr = 0; rr < 8; rr++) for (let cc = 0; cc < 8; cc++) {
    const p = s.b[rr][cc]; if (!p || isW(p) !== byWhite) continue;
    const t = p.toLowerCase();
    if (t === 'p') { const d = byWhite ? -1 : 1; if (rr + d === r && (cc - 1 === c || cc + 1 === c)) return true; continue; }
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

// ---------- БОТ: выбор хода ----------
const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
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
    // проверка: не подставляемся ли под удар
    if (level >= 3) {
      const ns = apply(s, from, to);
      const attacker = isW(s.b[from[0]][from[1]]) ? false : true;
      if (atk(ns, to[0], to[1], !w)) score -= (VAL[s.b[from[0]][from[1]].toLowerCase()] || 0) * 8;
    }
    if (level === 2) score += Math.random() * 5;
    else if (level === 3) score += Math.random() * 2;
    if (score > bestScore) { bestScore = score; best = [from, to]; }
  }
  return best;
}

// ---------- ИГРОВОЕ СОСТОЯНИЕ ----------
const online = new Map(); // socketId -> username
const games = new Map();  // gameId -> game
const socketGame = new Map(); // socketId -> gameId

function genId() { return Math.random().toString(36).slice(2, 10); }

function stats() {
  return {
    online: online.size + BOTS.length,
    games: Object.values(db.users).reduce((s, u) => s + u.games, 0) / 2 | 0,
    active: [...games.values()].filter(g => g.started && !g.finished).length
  };
}
function pushLobbies() {
  const list = [];
  for (const [id, g] of games) {
    if (g.finished || g.arena || g.started) continue;
    list.push({ id, host: g.host, time: g.time, inc: g.inc, isBot: !!g.isBot });
  }
  io.emit('lobbies', list);
  io.emit('stats', stats());
}

function finish(gid, result, reason) {
  const g = games.get(gid);
  if (!g || g.finished) return;
  g.finished = true;
  const wName = g.hostColor === 'w' ? g.host : g.guest;
  const bName = g.hostColor === 'b' ? g.host : g.guest;
  const wu = db.users[wName], bu = db.users[bName];
  if (wu && bu) {
    const expW = 1 / (1 + Math.pow(10, (bu.rating - wu.rating) / 400));
    const sW = result === 'w' ? 1 : result === 'b' ? 0 : 0.5;
    const sB = 1 - sW;
    const dW = Math.round(32 * (sW - expW));
    const dB = Math.round(32 * (sB - (1 - expW)));
    if (!wu.isBot) { wu.rating += dW; wu.games++; if (result === 'w') wu.wins++; else if (result === 'b') wu.losses++; else wu.draws++; }
    else { wu.games++; if (result === 'w') wu.wins++; else if (result === 'b') wu.losses++; else wu.draws++; }
    if (!bu.isBot) { bu.rating += dB; bu.games++; if (result === 'b') bu.wins++; else if (result === 'w') bu.losses++; else bu.draws++; }
    else { bu.games++; if (result === 'b') bu.wins++; else if (result === 'w') bu.losses++; else bu.draws++; }
    save();
  }
  io.to(gid).emit('end', { result, reason });
  setTimeout(() => { games.delete(gid); pushLobbies(); }, 5000);
}

// Таймер часов
setInterval(() => {
  const now = Date.now();
  for (const [id, g] of games) {
    if (!g.started || g.finished) continue;
    const dt = Math.floor((now - g.tick) / 1000);
    if (dt <= 0) continue;
    g.tick = now;
    if (g.turn === 'w') g.tW = Math.max(0, g.tW - dt); else g.tB = Math.max(0, g.tB - dt);
    io.to(id).emit('times', { tW: g.tW, tB: g.tB });
    if (g.tW <= 0) finish(id, 'b', 'Время');
    else if (g.tB <= 0) finish(id, 'w', 'Время');
  }
}, 1000);

// Ход бота
function botTurn(gid) {
  const g = games.get(gid);
  if (!g || g.finished || !g.isBot) return;
  if (g.turn !== g.botColor) return;
  const delay = 200 + Math.random() * 400;
  setTimeout(() => {
    const cur = games.get(gid);
    if (!cur || cur.finished || cur.turn !== cur.botColor) return;
    const level = BOTS.find(b => b.name === cur.bot)?.level || 2;
    const mv = botMove(cur.fen, level);
    if (!mv) return;
    const [from, to] = mv;
    const s = parse(cur.fen);
    const next = apply(s, from, to);
    cur.fen = fen(next);
    cur.turn = next.turn;
    cur.tick = Date.now();
    io.to(gid).emit('board', { fen: cur.fen });
    const end = endCheck(next);
    if (end) finish(gid, end.result, end.reason);
  }, delay);
}

// ---------- SOCKET ----------
io.on('connection', (socket) => {
  socket.on('register', ({ username, password }, cb) => {
    if (typeof cb !== 'function') return;
    if (!username || !password) return cb({ ok: false, msg: 'Заполни поля' });
    if (BOTS.some(b => b.name === username)) return cb({ ok: false, msg: 'Имя занято' });
    if (username.length < 2 || username.length > 20) return cb({ ok: false, msg: 'Логин 2-20' });
    if (!/^[a-zA-Z0-9_\-а-яА-Я]+$/.test(username)) return cb({ ok: false, msg: 'Только буквы, цифры, _ -' });
    let u = db.users[username];
    if (u) {
      if (u.isBot) return cb({ ok: false, msg: 'Это бот' });
      if (u.password !== password) return cb({ ok: false, msg: 'Неверный пароль' });
    } else {
      u = { password, rating: 1200, wins: 0, losses: 0, draws: 0, games: 0, isBot: false, created: Date.now() };
      db.users[username] = u;
      save();
    }
    online.set(socket.id, username);
    socket.username = username;
    cb({ ok: true, user: { username, rating: u.rating, wins: u.wins, losses: u.losses, draws: u.draws, games: u.games } });
    pushLobbies();
  });

  socket.on('getStats', (cb) => { if (typeof cb === 'function') cb(stats()); });
  socket.on('getLobbies', (cb) => {
    if (typeof cb !== 'function') return;
    const list = [];
    for (const [id, g] of games) {
      if (g.finished || g.started) continue;
      list.push({ id, host: g.host, time: g.time, inc: g.inc, isBot: !!g.isBot });
    }
    cb(list);
  });
  socket.on('getBots', (cb) => {
    if (typeof cb !== 'function') return;
    cb(BOTS.map(b => ({ name: b.name, title: b.title, rating: db.users[b.name].rating })));
  });

  // Создать лобби
  socket.on('create', ({ time, inc }, cb) => {
    if (typeof cb !== 'function') return;
    if (!socket.username) return cb({ ok: false, msg: 'Не авторизован' });
    time = Math.max(1, Math.min(30, +time || 5));
    inc = Math.max(0, Math.min(30, +inc || 0));
    // ищем совпадение
    for (const [, g] of games) {
      if (g.finished || g.started || g.isBot || g.guest) continue;
      if (g.host === socket.username) continue;
      if (g.time !== time || g.inc !== inc) continue;
      // матч
      g.guest = socket.username;
      g.guestSock = socket.id;
      const hw = Math.random() < 0.5;
      g.hostColor = hw ? 'w' : 'b';
      g.guestColor = hw ? 'b' : 'w';
      g.started = true;
      g.tick = Date.now();
      socket.join(g.id);
      socketGame.set(socket.id, g.id);
      io.to(g.hostSock).emit('start', { color: g.hostColor, opponent: g.guest, oppRating: db.users[g.guest].rating, time: g.time, inc: g.inc, fen: g.fen, gameId: g.id });
      io.to(g.guestSock).emit('start', { color: g.guestColor, opponent: g.host, oppRating: db.users[g.host].rating, time: g.time, inc: g.inc, fen: g.fen, gameId: g.id });
      cb({ ok: true, matched: true });
      pushLobbies();
      return;
    }
    const id = genId();
    games.set(id, {
      id, host: socket.username, hostSock: socket.id, guest: null, guestSock: null,
      hostColor: null, guestColor: null, time, inc, tW: time * 60, tB: time * 60,
      turn: 'w', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      started: false, finished: false, tick: Date.now(), isBot: false
    });
    socket.join(id);
    socketGame.set(socket.id, id);
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
    g.guest = socket.username;
    g.guestSock = socket.id;
    const hw = Math.random() < 0.5;
    g.hostColor = hw ? 'w' : 'b';
    g.guestColor = hw ? 'b' : 'w';
    g.started = true;
    g.tick = Date.now();
    socket.join(id);
    socketGame.set(socket.id, id);
    io.to(g.hostSock).emit('start', { color: g.hostColor, opponent: g.guest, oppRating: db.users[g.guest].rating, time: g.time, inc: g.inc, fen: g.fen, gameId: id });
    io.to(g.guestSock).emit('start', { color: g.guestColor, opponent: g.host, oppRating: db.users[g.host].rating, time: g.time, inc: g.inc, fen: g.fen, gameId: id });
    cb({ ok: true });
    pushLobbies();
  });

  socket.on('cancel', ({ id }) => {
    const g = games.get(id);
    if (!g || g.host !== socket.username || g.started) return;
    games.delete(id);
    socketGame.delete(socket.id);
    pushLobbies();
  });

  // С ботом
  socket.on('playBot', ({ time, inc, bot }, cb) => {
    if (typeof cb !== 'function') return;
    if (!socket.username) return cb({ ok: false, msg: 'Не авторизован' });
    if (!BOTS.some(b => b.name === bot)) return cb({ ok: false, msg: 'Бот не найден' });
    time = Math.max(1, Math.min(30, +time || 5));
    inc = Math.max(0, Math.min(30, +inc || 0));
    const id = genId();
    games.set(id, {
      id, host: socket.username, hostSock: socket.id, guest: bot, guestSock: null,
      hostColor: 'w', guestColor: 'b', time, inc, tW: time * 60, tB: time * 60,
      turn: 'w', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      started: true, finished: false, tick: Date.now(), isBot: true, bot, botColor: 'b'
    });
    socket.join(id);
    socketGame.set(socket.id, id);
    io.to(socket.id).emit('start', { color: 'w', opponent: bot, oppRating: db.users[bot].rating, time, inc, fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', gameId: id, isBot: true });
    cb({ ok: true });
    pushLobbies();
  });

  // Ход
  socket.on('move', ({ gameId, fen: newFen }) => {
    const g = games.get(gameId);
    if (!g || g.finished || !g.started) return;
    const myColor = socket.id === g.hostSock ? g.hostColor : g.guestColor;
    if (g.turn !== myColor) return;
    if (typeof newFen !== 'string') return;
    const nt = newFen.split(' ')[1];
    if (nt === g.turn) return;
    const now = Date.now();
    const dt = Math.floor((now - g.tick) / 1000);
    if (myColor === 'w') g.tW = Math.max(0, g.tW - dt) + g.inc;
    else g.tB = Math.max(0, g.tB - dt) + g.inc;
    g.tick = now;
    g.fen = newFen;
    g.turn = nt;
    io.to(gameId).emit('board', { fen: newFen });
    io.to(gameId).emit('times', { tW: g.tW, tB: g.tB });
    const s = parse(newFen);
    const end = endCheck(s);
    if (end) { finish(gameId, end.result, end.reason); return; }
    if (g.isBot && g.turn === g.botColor) botTurn(gameId);
  });

  socket.on('resign', ({ gameId }) => {
    const g = games.get(gameId);
    if (!g || g.finished) return;
    const myColor = socket.id === g.hostSock ? g.hostColor : g.guestColor;
    finish(gameId, myColor === 'w' ? 'b' : 'w', 'Сдача');
  });

  socket.on('drawOffer', ({ gameId }) => {
    const g = games.get(gameId);
    if (!g || g.finished) return;
    if (g.isBot) {
      // бот согласен, если материал примерно равен
      const s = parse(g.fen);
      let score = 0;
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        const p = s.b[r][c]; if (!p) continue;
        score += (isW(p) ? 1 : -1) * (VAL[p.toLowerCase()] || 0);
      }
      const botSign = g.botColor === 'w' ? 1 : -1;
      setTimeout(() => {
        if (score * botSign <= 0) finish(gameId, 'draw', 'Ничья');
        else socket.emit('drawNo');
      }, 400);
    } else {
      socket.to(gameId).emit('drawOffer');
    }
  });

  socket.on('drawYes', ({ gameId }) => { if (games.has(gameId)) finish(gameId, 'draw', 'Ничья'); });
  socket.on('drawNo', ({ gameId }) => { socket.to(gameId).emit('drawNo'); });

  socket.on('getGame', ({ gameId }, cb) => {
    if (typeof cb !== 'function') return;
    const g = games.get(gameId);
    if (!g) return cb({ ok: false });
    if (socket.username !== g.host && socket.username !== g.guest) return cb({ ok: false });
    if (socket.username === g.host) g.hostSock = socket.id;
    else g.guestSock = socket.id;
    socket.join(gameId);
    socketGame.set(socket.id, gameId);
    const myColor = socket.username === g.host ? g.hostColor : g.guestColor;
    const opp = socket.username === g.host ? g.guest : g.host;
    cb({ ok: true, state: { myColor, opponent: opp, time: g.time, inc: g.inc, tW: g.tW, tB: g.tB, fen: g.fen, finished: g.finished, isBot: !!g.isBot } });
  });

  socket.on('disconnect', () => {
    online.delete(socket.id);
    const gid = socketGame.get(socket.id);
    socketGame.delete(socket.id);
    if (gid) {
      const g = games.get(gid);
      if (g && !g.finished && !g.started) { games.delete(gid); pushLobbies(); }
    }
    pushLobbies();
  });
});

// ---------- СТАРТ ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log('Kingside Lite on ' + PORT));
