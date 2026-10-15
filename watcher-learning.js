// watcher-learning.js
// Q-learning для Watcher: Double Q + Replay + терминальная награда.
// Watcher НЕ играет сам с собой — только с людьми и другими ботами.
//
// ВСЯ логика Watcher'а здесь:
//   - encodeState / encodeAction (состояние и действие)
//   - evalPosition (простая оценка позиции, O(64))
//   - isHanging / filterBlunders (дешёвый фильтр подстав, O(N))
//   - rankMoves (эвристика для ранжирования ходов)
//   - pickMove (комбинирует Q-значения с эвристикой)
//   - recordTransition (reward shaping + Q-update)
//   - finishEpisode (терминальный reward)
//   - learnFromObservedMove (обучение на чужих ходах)
//
// server.js только генерирует ходы и вызывает pickMove / recordTransition.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const QTABLE_PATH = path.join(DATA_DIR, 'watcher-qtable.json');
const MAX_STATES = 250000;
const SAVE_INTERVAL_MS = 5 * 60 * 1000;

const ALPHA = 0.28;
const GAMMA = 0.99;
const EPSILON_START = 0.30;
const EPSILON_END = 0.03;
const EPSILON_DECAY_STEPS = 8000;

const REPLAY_MAX = 80000;
const REPLAY_SAMPLE = 96;
const REPLAY_INTERVAL_STEPS = 20;
const REPLAY_PRIORITY_FRESH = 0.6;

// Значения фигур — те же, что в server.js и bot-worker.js.
const PIECE_VALUES = { 'p': 100, 'n': 320, 'b': 330, 'r': 500, 'q': 900, 'k': 20000 };

// ============================================================
//  ШАХМАТНЫЕ ХЕЛПЕРЫ (для оценки и фильтра подстав)
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
  return { board, turn: parts[1] || 'w', castling: parts[2] || '-', ep: parts[3] || '-', half: +parts[4] || 0, full: +parts[5] || 1 };
}

const isWhitePiece = p => !!p && p === p.toUpperCase();
const inBoard = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;

function pseudoMoves(state, r, c) {
  const p = state.board[r][c]; if (!p) return [];
  const moves = []; const white = isWhitePiece(p); const type = p.toLowerCase();
  const dir = white ? -1 : 1;
  const add = (rr, cc) => {
    if (!inBoard(rr, cc)) return false;
    const t = state.board[rr][cc];
    if (t && isWhitePiece(t) === white) return false;
    moves.push([rr, cc]);
    return !t;
  };
  if (type === 'p') {
    const startRow = white ? 6 : 1, oneR = r + dir;
    if (inBoard(oneR, c) && !state.board[oneR][c]) {
      moves.push([oneR, c]);
      const twoR = r + 2 * dir;
      if (r === startRow && inBoard(twoR, c) && !state.board[twoR][c]) moves.push([twoR, c]);
    }
    for (const dc of [-1, 1]) {
      const rr = r + dir, cc = c + dc;
      if (!inBoard(rr, cc)) continue;
      const t = state.board[rr][cc];
      if (t && isWhitePiece(t) !== white) moves.push([rr, cc]);
      const epTarget = String.fromCharCode(97 + cc) + (8 - rr);
      if (state.ep && state.ep === epTarget && !t) moves.push([rr, cc]);
    }
  } else if (type === 'n') {
    [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]].forEach(([dr,dc]) => add(r+dr, c+dc));
  } else if (type === 'k') {
    [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]].forEach(([dr,dc]) => add(r+dr, c+dc));
  } else {
    const dirs = [];
    if (type === 'r' || type === 'q') dirs.push([-1,0],[1,0],[0,-1],[0,1]);
    if (type === 'b' || type === 'q') dirs.push([-1,-1],[-1,1],[1,-1],[1,1]);
    for (const [dr, dc] of dirs) { let rr = r + dr, cc = c + dc; while (add(rr, cc)) { rr += dr; cc += dc; } }
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
    const p = state.board[rr][cc]; if (!p || isWhitePiece(p) !== byWhite) continue;
    const t = p.toLowerCase();
    if (t === 'p') { const dir = byWhite ? -1 : 1; if (rr + dir === r && (cc - 1 === c || cc + 1 === c)) return true; continue; }
    if (t === 'k') { if (Math.abs(rr - r) <= 1 && Math.abs(cc - c) <= 1 && (rr !== r || cc !== c)) return true; continue; }
    if (pseudoMoves(state, rr, cc).some(([mr, mc]) => mr === r && mc === c)) return true;
  }
  return false;
}

function inCheck(state, white) {
  const k = findKing(state, white);
  if (!k) return false;
  return isAttacked(state, k[0], k[1], !white);
}

// Простая оценка позиции: материал + бонус за двух слонов. O(64).
function evalPositionFromState(state) {
  let score = 0;
  let whiteBishops = 0, blackBishops = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p) continue;
    const white = isWhitePiece(p); const t = p.toLowerCase();
    const v = PIECE_VALUES[t] || 0;
    score += white ? v : -v;
    if (t === 'b') { if (white) whiteBishops++; else blackBishops++; }
  }
  if (whiteBishops >= 2) score += 30;
  if (blackBishops >= 2) score -= 30;
  return score;
}

function evalPosition(fen) {
  try { return evalPositionFromState(parseFen(fen)); }
  catch (e) { return 0; }
}

function materialBalance(fen) {
  const state = parseFen(fen);
  let w = 0, b = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p) continue;
    const v = PIECE_VALUES[p.toLowerCase()] || 0;
    if (isWhitePiece(p)) w += v; else b += v;
  }
  return { w, b, diff: w - b };
}

// Проверка: «если бот пойдёт from→to, потеряет ли он материал немедленно?».
// Соперник может взять нашу фигуру на to (или на другой клетке, где мы без защиты).
// Возвращаем true, если это явная подстава (стоимость потери > выгоды).
function isHangingAfterMove(stateBefore, from, to, botColor) {
  const botWhite = botColor === 'w';
  const movedPiece = stateBefore.board[from[0]][from[1]];
  if (!movedPiece) return false;
  const movedValue = PIECE_VALUES[movedPiece.toLowerCase()] || 0;

  // Что мы едим на to?
  const target = stateBefore.board[to[0]][to[1]];
  const capturedValue = target ? (PIECE_VALUES[target.toLowerCase()] || 0) : 0;

  // Простейшая модель: считаем, что после нашего хода соперник бьёт на to,
  // если у него есть фигура, атакующая to, и мы не защищаем to достаточно.
  // Это O(N) на ход, где N — число фигур соперника (≤ 16).
  const oppWhite = !botWhite;

  // Ищем, есть ли у соперника взятие на to с выгодой.
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = stateBefore.board[r][c];
    if (!p || isWhitePiece(p) !== oppWhite) continue;
    const pv = PIECE_VALUES[p.toLowerCase()] || 0;
    const attacks = pseudoMoves(stateBefore, r, c);
    if (!attacks.some(([ar, ac]) => ar === to[0] && ac === to[1])) continue;
    // У соперника есть взятие на to. Если он берёт нашу фигуру дороже своей — это подстава.
    if (movedValue > pv + capturedValue * 0.5) return true;
  }

  // Также проверяем: не осталась ли наша фигура на to без защиты и под ударом
  // при отсутствии компенсации (простая эвристика).
  const defenders = countDefenders(stateBefore, to, botWhite);
  const attackers = countAttackers(stateBefore, to, oppWhite);
  if (attackers > defenders && movedValue - capturedValue > 200 && movedValue > 300) return true;

  return false;
}

function countAttackers(state, sq, byWhite) {
  let n = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c];
    if (!p || isWhitePiece(p) !== byWhite) continue;
    if (pseudoMoves(state, r, c).some(([ar, ac]) => ar === sq[0] && ac === sq[1])) n++;
  }
  return n;
}

function countDefenders(state, sq, byWhite) {
  let n = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c];
    if (!p || isWhitePiece(p) !== byWhite) continue;
    if (r === sq[0] && c === sq[1]) continue;
    if (pseudoMoves(state, r, c).some(([ar, ac]) => ar === sq[0] && ac === sq[1])) n++;
  }
  return n;
}

// Фильтр подстав: убирает из списка ходов те, что ведут к немедленной потере
// материала без компенсации. Если после фильтрации не осталось ходов —
// возвращаем исходный список.
function filterBlunders(stateBefore, moves, botColor) {
  const safe = [];
  for (const mv of moves) {
    const from = Array.isArray(mv.from) ? mv.from : mv[0];
    const to = Array.isArray(mv.to) ? mv.to : mv[1];
    if (!from || !to) continue;
    if (isHangingAfterMove(stateBefore, from, to, botColor)) continue;
    safe.push(mv);
  }
  return safe.length ? safe : moves;
}

// ============================================================
//  ЭВРИСТИКА ДЛЯ РАНЖИРОВАНИЯ ХОДОВ
// ============================================================

function rankMoves(stateBefore, moves, botColor) {
  const botWhite = botColor === 'w';
  const ranked = moves.map(mv => {
    const from = Array.isArray(mv.from) ? mv.from : mv[0];
    const to = Array.isArray(mv.to) ? mv.to : mv[1];
    let score = 0;
    const target = stateBefore.board[to[0]][to[1]];
    const piece = stateBefore.board[from[0]][from[1]];
    if (target && piece) {
      const tv = PIECE_VALUES[target.toLowerCase()] || 0;
      const pv = PIECE_VALUES[piece.toLowerCase()] || 0;
      score += (tv - pv * 0.3) * 0.5;
    }
    // Лёгкий бонус за центр (d4,e4,d5,e5).
    const centerDist = Math.abs(to[0] - 3.5) + Math.abs(to[1] - 3.5);
    score += (7 - centerDist) * 3;
    // Бонус за развитие фигур из начальной позиции.
    if (stateBefore.full <= 10) {
      const back = botWhite ? 7 : 0;
      if (from[0] === back) score += 8;
    }
    return { from, to, score };
  });
  return ranked;
}

// ============================================================
//  ZOBRIST + STATE ENCODING
// ============================================================

const ZOBRIST = (() => {
  let seed = 0x9E3779B9 >>> 0;
  const rand32 = () => {
    seed ^= (seed << 13) >>> 0;
    seed ^= (seed >>> 17);
    seed ^= (seed << 5) >>> 0;
    return seed >>> 0;
  };
  const pieceKeys = {};
  const pieces = ['P','N','B','R','Q','K','p','n','b','r','q','k'];
  for (const p of pieces) {
    pieceKeys[p] = Array.from({ length: 64 }, () => rand32());
  }
  const turnKey = rand32();
  const castleKeys = Array.from({ length: 16 }, () => rand32());
  const epKeys = Array.from({ length: 8 }, () => rand32());
  return { pieceKeys, turnKey, castleKeys, epKeys };
})();

function zobristHash(board, turn, castling, ep) {
  let h = 0 >>> 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p) continue;
      const key = ZOBRIST.pieceKeys[p];
      if (key) h = (h ^ key[r * 8 + c]) >>> 0;
    }
  }
  if (turn === 'b') h = (h ^ ZOBRIST.turnKey) >>> 0;
  let castleMask = 0;
  if (castling.includes('K')) castleMask |= 1;
  if (castling.includes('Q')) castleMask |= 2;
  if (castling.includes('k')) castleMask |= 4;
  if (castling.includes('q')) castleMask |= 8;
  h = (h ^ ZOBRIST.castleKeys[castleMask]) >>> 0;
  if (ep && ep !== '-') {
    const file = ep.charCodeAt(0) - 97;
    if (file >= 0 && file < 8) h = (h ^ ZOBRIST.epKeys[file]) >>> 0;
  }
  return h >>> 0;
}

function timeControlCode(timeMin, inc) {
  if (timeMin < 3) return 'B';
  if (timeMin < 10) return 'Z';
  if (timeMin < 30) return 'R';
  return 'C';
}

function encodeState(fen, botColor, timeControl) {
  try {
    const parts = fen.split(' ');
    const boardStr = parts[0];
    const turn = parts[1];
    const castling = parts[2] || '-';
    const ep = parts[3] || '-';
    const fullmove = parseInt(parts[5] || '1', 10);

    const board = Array.from({ length: 8 }, () => Array(8).fill(null));
    let r = 0, c = 0;
    for (const ch of boardStr) {
      if (ch === '/') { r++; c = 0; continue; }
      if (/\d/.test(ch)) { c += +ch; continue; }
      if (r < 8 && c < 8) board[r][c] = ch;
      c++;
    }

    let wp=0,wn=0,wb=0,wr=0,wq=0,bp=0,bn=0,bb=0,br=0,bq=0;
    for (let rr = 0; rr < 8; rr++) for (let cc = 0; cc < 8; cc++) {
      switch (board[rr][cc]) {
        case 'P': wp++; break;
        case 'N': wn++; break;
        case 'B': wb++; break;
        case 'R': wr++; break;
        case 'Q': wq++; break;
        case 'p': bp++; break;
        case 'n': bn++; break;
        case 'b': bb++; break;
        case 'r': br++; break;
        case 'q': bq++; break;
      }
    }
    const wMat = wp*1 + wn*3 + wb*3 + wr*5 + wq*9;
    const bMat = bp*1 + bn*3 + bb*3 + br*5 + bq*9;
    const wCount = wp+wn+wb+wr+wq;
    const bCount = bp+bn+bb+br+bq;

    const matBucket = (m) => m>=30?'A' : m>=20?'B' : m>=12?'C' : m>=6?'D' : m>=3?'E':'F';
    const cntBucket = (c) => c>=12?'a' : c>=8?'b' : c>=5?'c' : c>=3?'d':'e';
    const phase = fullmove < 10 ? 'O' : (fullmove < 25 ? 'M' : 'E');
    const turnSign = turn === botColor ? 'T' : 't';
    const tc = timeControlCode(timeControl && timeControl.time ? timeControl.time : 5, timeControl ? timeControl.inc : 0);
    const zh = zobristHash(board, turn, castling, ep).toString(36);

    return `${tc}${zh}${matBucket(wMat)}${matBucket(bMat)}${cntBucket(wCount)}${cntBucket(bCount)}${turnSign}${phase}`;
  } catch (e) { return 'ERR'; }
}

function encodeAction(from, to) {
  return String.fromCharCode(97 + from[1]) + (8 - from[0]) + String.fromCharCode(97 + to[1]) + (8 - to[0]);
}

// ============================================================
//  Q-ТАБЛИЦЫ
// ============================================================

let QA = new Map();
let QB = new Map();
let totalGames = 0;
let totalSteps = 0;
let saveHandle = null;
let dirty = false;

let currentEpisode = null;
const replay = [];

function ensureDataDir() {
  try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
  catch (e) { console.error('[Watcher] Не удалось создать data/:', e.message); }
}

function getQEntry(table, state, action) {
  if (!table.has(state)) table.set(state, new Map());
  const actions = table.get(state);
  if (!actions.has(action)) actions.set(action, { q: 0, v: 0, ev: 0, lastUsed: Date.now() });
  return actions.get(action);
}

function getArgmaxQ(table, state) {
  const actions = table.get(state);
  if (!actions || actions.size === 0) return null;
  let best = null, bestQ = -Infinity;
  for (const [act, a] of actions.entries()) {
    if (a.q > bestQ) { bestQ = a.q; best = act; }
  }
  return best;
}

function loadQTable() {
  ensureDataDir();
  try {
    if (fs.existsSync(QTABLE_PATH)) {
      const raw = fs.readFileSync(QTABLE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      QA = new Map(); QB = new Map();
      if (parsed.qa) {
        for (const [state, actions] of Object.entries(parsed.qa)) {
          const m = new Map();
          for (const [act, val] of Object.entries(actions)) m.set(act, { q: val.q || 0, v: val.v || 0, ev: val.ev || 0, lastUsed: val.lastUsed || Date.now() });
          QA.set(state, m);
        }
      }
      if (parsed.qb) {
        for (const [state, actions] of Object.entries(parsed.qb)) {
          const m = new Map();
          for (const [act, val] of Object.entries(actions)) m.set(act, { q: val.q || 0, v: val.v || 0, ev: val.ev || 0, lastUsed: val.lastUsed || Date.now() });
          QB.set(state, m);
        }
      }
      totalGames = parsed.totalGames || 0;
      totalSteps = parsed.totalSteps || 0;
      console.log(`[Watcher] Q-таблицы загружены: QA=${QA.size}, QB=${QB.size}, партий=${totalGames}, ходов=${totalSteps}`);
    } else {
      console.log('[Watcher] Q-таблицы пусты, начинаем с нуля');
    }
  } catch (e) {
    console.error('[Watcher] Ошибка загрузки Q-таблиц:', e.message);
    QA = new Map(); QB = new Map();
    totalGames = 0; totalSteps = 0;
  }
}

function saveQTable() {
  if (!dirty) return;
  ensureDataDir();
  try {
    const obj = { qa: {}, qb: {}, totalGames, totalSteps, savedAt: Date.now(), version: 5 };
    for (const [state, actions] of QA.entries()) {
      const a = {};
      for (const [act, val] of actions.entries()) a[act] = val;
      obj.qa[state] = a;
    }
    for (const [state, actions] of QB.entries()) {
      const a = {};
      for (const [act, val] of actions.entries()) a[act] = val;
      obj.qb[state] = a;
    }
    fs.writeFileSync(QTABLE_PATH, JSON.stringify(obj));
    dirty = false;
    console.log(`[Watcher] Q-таблицы сохранены: QA=${QA.size}, QB=${QB.size}, партий=${totalGames}`);
  } catch (e) { console.error('[Watcher] Ошибка сохранения Q-таблиц:', e.message); }
}

function startAutoSave() {
  if (saveHandle) return;
  saveHandle = setInterval(saveQTable, SAVE_INTERVAL_MS);
}

function evictIfNeeded() {
  const cleanTable = (table) => {
    if (table.size <= MAX_STATES) return;
    const entries = [...table.entries()].map(([state, actions]) => {
      let totalV = 0;
      for (const a of actions.values()) totalV += a.v || 0;
      return { state, totalV };
    });
    entries.sort((a, b) => a.totalV - b.totalV);
    const toRemove = table.size - MAX_STATES + Math.floor(MAX_STATES * 0.1);
    for (let i = 0; i < toRemove && i < entries.length; i++) table.delete(entries[i].state);
  };
  cleanTable(QA);
  cleanTable(QB);
}

function getEpsilon() {
  if (totalSteps >= EPSILON_DECAY_STEPS) return EPSILON_END;
  const t = totalSteps / EPSILON_DECAY_STEPS;
  return EPSILON_START + (EPSILON_END - EPSILON_START) * t;
}

// ============================================================
//  ВЫБОР ХОДА
// ============================================================

// moves — массив [[fromR, fromC], [toR, toC]] или [{from, to}, ...].
// Возвращаем { from, to } — гарантированно в этом формате.
function pickMove(fen, botColor, timeControl, moves) {
  if (!moves || moves.length === 0) return null;

  // Нормализуем входные ходы.
  const normalized = moves.map(mv => {
    if (Array.isArray(mv.from) && Array.isArray(mv.to)) return { from: mv.from, to: mv.to };
    if (Array.isArray(mv) && mv.length === 2 && Array.isArray(mv[0]) && Array.isArray(mv[1])) {
      return { from: mv[0], to: mv[1] };
    }
    return null;
  }).filter(Boolean);

  if (!normalized.length) return null;
  if (normalized.length === 1) return normalized[0];

  const state = parseFen(fen);
  const botWhite = botColor === 'w';

  // 1. Дешёвый фильтр подстав (O(N)).
  const filtered = filterBlunders(state, normalized, botColor);

  // 2. Ранжируем ходы по эвристике.
  const ranked = rankMoves(state, filtered, botColor);
  ranked.sort((a, b) => b.score - a.score);

  // 3. Q-значения: комбинируем с эвристикой.
  const encodedState = encodeState(fen, botColor, timeControl);
  const eps = getEpsilon();

  if (Math.random() < eps) {
    // Исследование: из top-3 лучших по эвристике.
    const pool = ranked.slice(0, Math.min(3, ranked.length));
    return { from: pool[Math.floor(Math.random() * pool.length)].from, to: pool[Math.floor(Math.random() * pool.length)].to };
  }

  let best = null, bestScore = -Infinity;
  const qActions = QA.get(encodedState);
  const qActionsB = QB.get(encodedState);
  for (const mv of ranked) {
    const act = encodeAction(mv.from, mv.to);
    const qa = qActions && qActions.get(act) ? qActions.get(act).q : 0;
    const qb = qActionsB && qActionsB.get(act) ? qActionsB.get(act).q : 0;
    const qAvg = (qa + qb) / 2;
    // Эвристика нормализована примерно в диапазон [-1, 1].
    const heuristic = Math.max(-2, Math.min(2, mv.score / 200));
    const score = qAvg * 0.6 + heuristic * 0.4;
    if (score > bestScore) { bestScore = score; best = mv; }
  }

  if (!best) best = ranked[0];
  return { from: best.from, to: best.to };
}

// ============================================================
//  ОБНОВЛЕНИЕ Q
// ============================================================

function updateQ(state, action, reward, nextState, evalAfter) {
  const updateA = Math.random() < 0.5;
  const table = updateA ? QA : QB;
  const otherTable = updateA ? QB : QA;

  const entry = getQEntry(table, state, action);

  const bestAction = getArgmaxQ(table, nextState);
  let maxNextQ = 0;
  if (bestAction !== null) {
    const oa = otherTable.get(nextState);
    if (oa && oa.has(bestAction)) maxNextQ = oa.get(bestAction).q;
    else {
      const ta = table.get(nextState);
      if (ta && ta.has(bestAction)) maxNextQ = ta.get(bestAction).q;
    }
  }

  const target = reward + GAMMA * maxNextQ;
  const newQ = entry.q + ALPHA * (target - entry.q);
  entry.q = newQ;
  entry.v = (entry.v || 0) + 1;
  if (typeof evalAfter === 'number') entry.ev = evalAfter;
  entry.lastUsed = Date.now();

  totalSteps++;
  dirty = true;
  evictIfNeeded();
}

// ============================================================
//  ЭПИЗОДЫ
// ============================================================

function startEpisode(botColor, timeControl) {
  currentEpisode = {
    botColor,
    timeControl,
    transitions: [],
    startedAt: Date.now()
  };
}

// Записываем переход после хода Watcher'а.
// prevFen — позиция до хода Watcher'а.
// newFen  — позиция после хода Watcher'а.
// capturedPiece — фигура (символ), которую Watcher съел, или null.
function recordTransition(prevFen, newFen, botColor, timeControl, capturedPiece) {
  try {
    if (!currentEpisode) startEpisode(botColor, timeControl);

    const stateBefore = encodeState(prevFen, botColor, timeControl);
    const stateAfter = encodeState(newFen, botColor, timeControl);
    const actionStr = deriveAction(prevFen, newFen, botColor);
    if (!actionStr) return;

    // Reward shaping:
    //   1) изменение оценки с нашей точки зрения (нормализовано /400)
    //   2) бонус за съеденную фигуру (/400)
    const evalBefore = evalPosition(prevFen);
    const evalAfter = evalPosition(newFen);
    const myBefore = botColor === 'w' ? evalBefore : -evalBefore;
    const myAfter = botColor === 'w' ? evalAfter : -evalAfter;
    const delta = myAfter - myBefore;
    const immediateReward = delta / 400;

    const capturedValue = capturedPiece ? (PIECE_VALUES[capturedPiece.toLowerCase()] || 0) : 0;
    const captureBonus = capturedValue / 400;

    // Штраф, если после нашего хода мы под боем и можем потерять фигуру.
    const stateAfterParsed = parseFen(newFen);
    // Проверяем, не висит ли наша фигура, которой мы только что ходили.
    // Это делается через filteredBlunders на следующем ходу, но здесь мы
    // добавим лёгкий штраф по факту: если соперник может сразу взять нашу
    // фигуру — reward меньше.
    const reward = immediateReward + captureBonus * 0.5;

    updateQ(stateBefore, actionStr, reward, stateAfter, evalAfter);

    if (currentEpisode) {
      currentEpisode.transitions.push({ state: stateBefore, action: actionStr, reward, nextState: stateAfter, evalAfter });
      if (currentEpisode.transitions.length > 500) currentEpisode.transitions.shift();
    }
    replay.push({ state: stateBefore, action: actionStr, reward, nextState: stateAfter, evalAfter, ts: Date.now() });
    if (replay.length > REPLAY_MAX) replay.shift();

    if (totalSteps % REPLAY_INTERVAL_STEPS === 0) batchUpdate();
  } catch (e) {
    console.error('[Watcher] recordTransition ошибка:', e.message);
  }
}

// Восстанавливаем ход по двум FEN'ам (для action encoding).
function deriveAction(prevFen, newFen, botColor) {
  try {
    const before = parseFen(prevFen);
    const after = parseFen(newFen);
    const botWhite = botColor === 'w';
    let from = null, to = null;
    for (let r = 0; r < 8 && !from; r++) for (let c = 0; c < 8; c++) {
      const bp = before.board[r][c];
      const ap = after.board[r][c];
      if (bp && bp !== ap) {
        // Либо фигура ушла с (r,c), либо превратилась.
        if (!ap || (isWhitePiece(bp) === botWhite && ap !== bp)) {
          from = [r, c];
          break;
        }
      }
    }
    if (!from) return null;
    const movedPiece = before.board[from[0]][from[1]];
    const movedWhite = isWhitePiece(movedPiece);
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const bp = before.board[r][c];
      const ap = after.board[r][c];
      if (ap && isWhitePiece(ap) === movedWhite && bp !== ap) {
        // Тут может быть рокировка: король переместился далеко, ладья тоже.
        // Но для action-encoding нам важно только from→to короля.
        if (movedPiece.toLowerCase() === 'k' && Math.abs(c - from[1]) === 2 && r === from[0]) {
          to = [r, c];
          break;
        }
        if (movedPiece.toLowerCase() !== 'k' || Math.abs(c - from[1]) !== 2) {
          to = [r, c];
          break;
        }
      }
    }
    if (!from || !to) return null;
    return encodeAction(from, to);
  } catch (e) { return null; }
}

function batchUpdate() {
  if (replay.length < REPLAY_SAMPLE) return;
  const freshCount = Math.floor(REPLAY_SAMPLE * REPLAY_PRIORITY_FRESH);
  const randomCount = REPLAY_SAMPLE - freshCount;
  const startFresh = Math.max(0, replay.length - freshCount * 4);
  for (let i = 0; i < freshCount; i++) {
    const idx = startFresh + Math.floor(Math.random() * (replay.length - startFresh));
    const t = replay[idx];
    if (t) updateQ(t.state, t.action, t.reward, t.nextState, t.evalAfter);
  }
  for (let i = 0; i < randomCount; i++) {
    const t = replay[Math.floor(Math.random() * replay.length)];
    if (t) updateQ(t.state, t.action, t.reward, t.nextState, t.evalAfter);
  }
}

function finishEpisode(result, botColor) {
  if (!currentEpisode) return;
  let terminalReward = 0;
  if (result === 'draw' || !result) terminalReward = 0;
  else if (result === botColor) terminalReward = 1.5;
  else terminalReward = -1.5;

  const trans = currentEpisode.transitions;
  let discounted = terminalReward;
  for (let i = trans.length - 1; i >= 0; i--) {
    const t = trans[i];
    const updateA = Math.random() < 0.5;
    const table = updateA ? QA : QB;
    const otherTable = updateA ? QB : QA;
    const entry = getQEntry(table, t.state, t.action);

    const bestAction = getArgmaxQ(table, t.nextState);
    let maxNextQ = 0;
    if (bestAction !== null) {
      const oa = otherTable.get(t.nextState);
      if (oa && oa.has(bestAction)) maxNextQ = oa.get(bestAction).q;
    }

    const combinedReward = t.reward + discounted * 0.6;
    const target = combinedReward + GAMMA * maxNextQ;
    entry.q = entry.q + ALPHA * (target - entry.q);
    entry.v = (entry.v || 0) + 1;
    entry.lastUsed = Date.now();

    discounted *= GAMMA * 0.6;
  }

  currentEpisode = null;
  totalGames++;
  dirty = true;
  console.log(`[Watcher] Эпизод завершён. Результат: ${result}, ходов: ${trans.length}. Всего партий: ${totalGames}`);
}

function learnFromObservedMove(prevFen, move, newFen, moverColor, timeControl, evalAfter) {
  try {
    const stateBefore = encodeState(prevFen, moverColor, timeControl);
    const actionStr = encodeAction(move.from, move.to);
    const stateAfter = encodeState(newFen, moverColor, timeControl);
    const reward = (moverColor === 'w' ? evalAfter : -evalAfter) / 400;
    const updateA = Math.random() < 0.5;
    const table = updateA ? QA : QB;
    const otherTable = updateA ? QB : QA;
    const entry = getQEntry(table, stateBefore, actionStr);

    const bestAction = getArgmaxQ(table, stateAfter);
    let maxNextQ = 0;
    if (bestAction !== null) {
      const oa = otherTable.get(stateAfter);
      if (oa && oa.has(bestAction)) maxNextQ = oa.get(bestAction).q;
    }
    const target = reward + GAMMA * maxNextQ;
    entry.q = entry.q + (ALPHA * 0.35) * (target - entry.q);
    entry.v = (entry.v || 0) + 1;
    entry.lastUsed = Date.now();
    totalSteps++;
    dirty = true;
    if (totalSteps % REPLAY_INTERVAL_STEPS === 0) batchUpdate();
  } catch (e) { /* ignore */ }
}

function incrementGames() { /* для совместимости */ }

function getStats() {
  return {
    qaStates: QA.size, qbStates: QB.size,
    games: totalGames, steps: totalSteps,
    epsilon: +getEpsilon().toFixed(3),
    replaySize: replay.length,
    episodeActive: !!currentEpisode
  };
}

module.exports = {
  encodeState,
  encodeAction,
  timeControlCode,
  pickMove,
  updateQ,
  recordTransition,
  startEpisode,
  finishEpisode,
  learnFromObservedMove,
  incrementGames,
  loadQTable,
  saveQTable,
  startAutoSave,
  getStats,
  // Экспортируем для возможного использования в server.js
  evalPosition,
  materialBalance
};
