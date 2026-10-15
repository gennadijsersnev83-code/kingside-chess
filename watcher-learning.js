// watcher-learning.js
// Q-learning для Watcher: Double Q + Replay + терминальная награда.
// Watcher НЕ играет сам с собой — только с людьми и другими ботами.
//
// Вся логика Watcher'а здесь:
//   - encodeState / encodeAction
//   - evalPosition (простая оценка, O(64))
//   - isHanging / filterBlunders (фильтр подстав, O(N))
//   - computeReward (reward shaping)
//   - pickMove (Q + эвристика + 1-ply lookahead для top-K)
//   - recordTransition / startEpisode / finishEpisode
//   - learnFromObservedMove

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

// Сколько лучших ходов просматриваем через 1-ply lookahead.
const LOOKAHEAD_TOP_K = 8;

const PIECE_VALUES = { 'p': 100, 'n': 320, 'b': 330, 'r': 500, 'q': 900, 'k': 20000 };

// ============================================================
//  ШАХМАТНЫЕ ХЕЛПЕРЫ
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

function applyMove(state, from, to) {
  const copy = { board: state.board.map(row => row.slice()), turn: state.turn, castling: state.castling, ep: state.ep, half: state.half, full: state.full };
  const [fr, fc] = from, [tr, tc] = to;
  const p = copy.board[fr][fc]; if (!p) return copy;
  const white = isWhitePiece(p); const type = p.toLowerCase();
  if (type === 'p' && copy.ep) { const target = String.fromCharCode(97 + tc) + (8 - tr); if (copy.ep === target && !copy.board[tr][tc]) copy.board[fr][tc] = null; }
  copy.board[tr][tc] = p; copy.board[fr][fc] = null;
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
  if (type === 'p' && Math.abs(tr - fr) === 2) ep = String.fromCharCode(97 + fc) + (8 - (fr + (tr - fr) / 2));
  copy.castling = cast; copy.ep = ep; copy.turn = white ? 'b' : 'w'; copy.full += 1;
  return copy;
}

function allLegalMoves(state, white) {
  const res = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p || isWhitePiece(p) !== white) continue;
    for (const [rr, cc] of pseudoMoves(state, r, c)) {
      const next = applyMove(state, [r, c], [rr, cc]);
      if (!inCheck(next, white)) res.push([[r, c], [rr, cc]]);
    }
  }
  return res;
}

// Простая оценка: материал + пара слонов + бонус за атаку на короля.
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
  if (inCheck(state, true))  score -= 25;
  if (inCheck(state, false)) score += 25;
  return score;
}

function evalPosition(fen) {
  try { return evalPositionFromState(parseFen(fen)); }
  catch (e) { return 0; }
}

// Проверяем: если бот пойдёт from→to, потеряет ли он материал немедленно?
function isHanging(stateBefore, from, to, botColor) {
  const botWhite = botColor === 'w';
  const movedPiece = stateBefore.board[from[0]][from[1]];
  if (!movedPiece) return false;
  const movedValue = PIECE_VALUES[movedPiece.toLowerCase()] || 0;

  const target = stateBefore.board[to[0]][to[1]];
  const capturedValue = target ? (PIECE_VALUES[target.toLowerCase()] || 0) : 0;

  if (capturedValue >= movedValue) return false;

  const oppWhite = !botWhite;
  let attackers = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = stateBefore.board[r][c];
    if (!p || isWhitePiece(p) !== oppWhite) continue;
    if (pseudoMoves(stateBefore, r, c).some(([ar, ac]) => ar === to[0] && ac === to[1])) attackers++;
  }
  if (attackers === 0) return false;

  let defenders = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    if (r === to[0] && c === to[1]) continue;
    const p = stateBefore.board[r][c];
    if (!p || isWhitePiece(p) !== botWhite) continue;
    if (pseudoMoves(stateBefore, r, c).some(([ar, ac]) => ar === to[0] && ac === to[1])) defenders++;
  }

  if (attackers > defenders && movedValue - capturedValue > 150) return true;
  if (defenders === 0 && movedValue - capturedValue > 200) return true;
  return false;
}

function filterBlunders(stateBefore, normalizedMoves, botColor) {
  const safe = [];
  for (const mv of normalizedMoves) {
    if (isHanging(stateBefore, mv.from, mv.to, botColor)) continue;
    safe.push(mv);
  }
  return safe.length ? safe : normalizedMoves;
}

function rankMoves(stateBefore, normalizedMoves, botColor) {
  const botWhite = botColor === 'w';
  return normalizedMoves.map(mv => {
    const { from, to } = mv;
    let score = 0;

    const target = stateBefore.board[to[0]][to[1]];
    const piece = stateBefore.board[from[0]][from[1]];
    if (target && piece) {
      const tv = PIECE_VALUES[target.toLowerCase()] || 0;
      const pv = PIECE_VALUES[piece.toLowerCase()] || 0;
      score += (tv - pv * 0.3) * 0.5;
    }

    const centerDist = Math.abs(to[0] - 3.5) + Math.abs(to[1] - 3.5);
    score += (7 - centerDist) * 3;

    if (stateBefore.full <= 10) {
      const back = botWhite ? 7 : 0;
      if (from[0] === back) score += 8;
    }

    return { from, to, score };
  });
}

// 1-ply lookahead: для хода (from, to) смотрит лучший ответ соперника и
// возвращает оценку с точки зрения бота.
function lookahead1Score(stateBefore, from, to, botColor) {
  const next = applyMove(stateBefore, from, to);
  const oppColor = next.turn;
  const oppMoves = allLegalMoves(next, oppColor === 'w');
  const botWhite = botColor === 'w';

  if (oppMoves.length === 0) {
    // Мат или пат.
    if (inCheck(next, oppColor === 'w')) {
      return botWhite ? 99999 : -99999;
    }
    return 0;
  }

  let worst = botWhite ? Infinity : -Infinity;
  for (const [of, ot] of oppMoves) {
    const after = applyMove(next, of, ot);
    const e = botWhite ? evalPositionFromState(after) : -evalPositionFromState(after);
    if (botWhite) worst = Math.min(worst, e);
    else worst = Math.max(worst, e);
  }
  return worst;
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
  for (const p of pieces) pieceKeys[p] = Array.from({ length: 64 }, () => rand32());
  const turnKey = rand32();
  const castleKeys = Array.from({ length: 16 }, () => rand32());
  const epKeys = Array.from({ length: 8 }, () => rand32());
  return { pieceKeys, turnKey, castleKeys, epKeys };
})();

function zobristHash(board, turn, castling, ep) {
  let h = 0 >>> 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = board[r][c];
    if (!p) continue;
    const key = ZOBRIST.pieceKeys[p];
    if (key) h = (h ^ key[r * 8 + c]) >>> 0;
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

// Расширенное состояние: Zobrist + материал + счётчики + пешечная структура +
// король под шахом + сколько наших фигур под боем.
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
    const wPawnFiles = [0,0,0,0,0,0,0,0];
    const bPawnFiles = [0,0,0,0,0,0,0,0];
    let wMat = 0, bMat = 0;
    for (let rr = 0; rr < 8; rr++) for (let cc = 0; cc < 8; cc++) {
      const p = board[rr][cc];
      switch (p) {
        case 'P': wp++; wMat += 1; wPawnFiles[cc]++; break;
        case 'N': wn++; wMat += 3; break;
        case 'B': wb++; wMat += 3; break;
        case 'R': wr++; wMat += 5; break;
        case 'Q': wq++; wMat += 9; break;
        case 'p': bp++; bMat += 1; bPawnFiles[cc]++; break;
        case 'n': bn++; bMat += 3; break;
        case 'b': bb++; bMat += 3; break;
        case 'r': br++; bMat += 5; break;
        case 'q': bq++; bMat += 9; break;
      }
    }
    const wCount = wp+wn+wb+wr+wq;
    const bCount = bp+bn+bb+br+bq;

    let wDoubled = 0, bDoubled = 0, wIsolated = 0, bIsolated = 0;
    for (let f = 0; f < 8; f++) {
      if (wPawnFiles[f] > 1) wDoubled++;
      if (bPawnFiles[f] > 1) bDoubled++;
      const wl = f > 0 ? wPawnFiles[f-1] : 0, wrp = f < 7 ? wPawnFiles[f+1] : 0;
      if (wPawnFiles[f] > 0 && wl === 0 && wrp === 0) wIsolated++;
      const bl = f > 0 ? bPawnFiles[f-1] : 0, brp = f < 7 ? bPawnFiles[f+1] : 0;
      if (bPawnFiles[f] > 0 && bl === 0 && brp === 0) bIsolated++;
    }

    const state = { board, turn, castling, ep, half: +parts[4] || 0, full: fullmove };
    const botWhite = botColor === 'w';
    const botInChk = inCheck(state, botWhite) ? 'K' : 'k';
    const oppInChk = inCheck(state, !botWhite) ? 'A' : 'a';

    // Сколько наших фигур (кроме короля) под боем?
    let hangingCount = 0;
    for (let rr = 0; rr < 8; rr++) for (let cc = 0; cc < 8; cc++) {
      const p = board[rr][cc];
      if (!p || isWhitePiece(p) !== botWhite) continue;
      if (p.toLowerCase() === 'k') continue;
      if (isAttacked(state, rr, cc, !botWhite)) hangingCount++;
    }
    const hangBucket = hangingCount >= 4 ? 'H' : (hangingCount >= 2 ? 'h' : (hangingCount >= 1 ? 'm' : 'n'));

    const matBucket = (m) => m>=30?'A' : m>=20?'B' : m>=12?'C' : m>=6?'D' : m>=3?'E':'F';
    const cntBucket = (c) => c>=12?'a' : c>=8?'b' : c>=5?'c' : c>=3?'d':'e';
    const phase = fullmove < 10 ? 'O' : (fullmove < 25 ? 'M' : 'E');
    const turnSign = turn === botColor ? 'T' : 't';
    const tc = timeControlCode(timeControl && timeControl.time ? timeControl.time : 5, timeControl ? timeControl.inc : 0);
    const zh = zobristHash(board, turn, castling, ep).toString(36);

    return `${tc}${zh}${matBucket(wMat)}${matBucket(bMat)}${cntBucket(wCount)}${cntBucket(bCount)}${turnSign}${phase}${botInChk}${oppInChk}${hangBucket}`;
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
    const obj = { qa: {}, qb: {}, totalGames, totalSteps, savedAt: Date.now(), version: 8 };
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
//  REWARD SHAPING
// ============================================================

// Считаем reward для хода Watcher'а:
//   - дельта оценки с нашей точки зрения (нормализовано /400)
//   - бонус за съеденную фигуру (/400)
//   - штраф за подставу (если соперник бьёт нашу фигуру дороже, чем мы съели)
function computeReward(prevFen, newFen, botColor, capturedPiece) {
  try {
    const evalBefore = evalPosition(prevFen);
    const evalAfter = evalPosition(newFen);
    const myBefore = botColor === 'w' ? evalBefore : -evalBefore;
    const myAfter = botColor === 'w' ? evalAfter : -evalAfter;
    const delta = myAfter - myBefore;
    const immediateReward = delta / 400;

    const capturedValue = capturedPiece ? (PIECE_VALUES[capturedPiece.toLowerCase()] || 0) : 0;
    const captureBonus = capturedValue / 400;

    return immediateReward + captureBonus * 0.5;
  } catch (e) { return 0; }
}

// ============================================================
//  ВЫБОР ХОДА
// ============================================================

// moves — массив [[fromR,fromC],[toR,toC]] (как botAllLegalMoves в server.js).
// Возвращаем всегда { from: [r,c], to: [r,c] } или null.
function pickMove(fen, botColor, timeControl, moves) {
  if (!moves || moves.length === 0) return null;

  const normalized = [];
  for (const mv of moves) {
    if (Array.isArray(mv) && mv.length === 2 && Array.isArray(mv[0]) && Array.isArray(mv[1]) && mv[0].length === 2 && mv[1].length === 2) {
      normalized.push({ from: [mv[0][0], mv[0][1]], to: [mv[1][0], mv[1][1]] });
    } else if (mv && Array.isArray(mv.from) && Array.isArray(mv.to)) {
      normalized.push({ from: [mv.from[0], mv.from[1]], to: [mv.to[0], mv.to[1]] });
    }
  }
  if (!normalized.length) return null;
  if (normalized.length === 1) return normalized[0];

  const state = parseFen(fen);

  // 1. Фильтр подстав (дешёвый, O(N)).
  const filtered = filterBlunders(state, normalized, botColor);

  // 2. Ранжирование по эвристике.
  const ranked = rankMoves(state, filtered, botColor);
  ranked.sort((a, b) => b.score - a.score);

  // 3. 1-ply lookahead для top-K ходов.
  const K = Math.min(LOOKAHEAD_TOP_K, ranked.length);
  for (let i = 0; i < K; i++) {
    const mv = ranked[i];
    mv.eval = lookahead1Score(state, mv.from, mv.to, botColor);
  }
  // Ходы вне top-K получают оценку по эвристике (нормализованную).
  for (let i = K; i < ranked.length; i++) {
    const mv = ranked[i];
    mv.eval = mv.score / 200;
  }

  // Пересортируем top-K по реальной оценке (для исследования).
  const topK = ranked.slice(0, K).sort((a, b) => (botColor === 'w' ? b.eval - a.eval : a.eval - b.eval));
  const rest = ranked.slice(K);

  const encodedState = encodeState(fen, botColor, timeControl);
  const eps = getEpsilon();

  // 4. Исследование: из top-3 лучших по eval.
  if (Math.random() < eps) {
    const pool = topK.slice(0, Math.min(3, topK.length));
    const pick = pool[Math.floor(Math.random() * pool.length)];
    return { from: pick.from, to: pick.to };
  }

  // 5. Использование: Q-значение + нормализованная эвристика.
  const qActionsA = QA.get(encodedState);
  const qActionsB = QB.get(encodedState);

  let best = null, bestScore = -Infinity;
  const allMoves = topK.concat(rest);
  for (const mv of allMoves) {
    const act = encodeAction(mv.from, mv.to);
    const qa = qActionsA && qActionsA.get(act) ? qActionsA.get(act).q : 0;
    const qb = qActionsB && qActionsB.get(act) ? qActionsB.get(act).q : 0;
    const qAvg = (qa + qb) / 2;
    const heuristic = Math.max(-2, Math.min(2, mv.eval / 400));
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
  console.log(`[Watcher] Эпизод начат: цвет=${botColor}, tc=${timeControl.time}+${timeControl.inc}`);
}

// prevFen, newFen — позиции до/после хода Watcher'а.
// from, to — координаты хода Watcher'а.
// captured — символ съеденной фигуры или null.
function recordTransition(prevFen, newFen, from, to, botColor, timeControl, capturedPiece) {
  try {
    if (!from || !to || from.length !== 2 || to.length !== 2) return;
    if (!currentEpisode) startEpisode(botColor, timeControl);

    const stateBefore = encodeState(prevFen, botColor, timeControl);
    const stateAfter = encodeState(newFen, botColor, timeControl);
    const actionStr = encodeAction(from, to);

    const reward = computeReward(prevFen, newFen, botColor, capturedPiece);
    const evalAfter = evalPosition(newFen);

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

    // Дельта оценки с точки зрения ходящего (а не абсолютное значение).
    const evalBefore = evalPosition(prevFen);
    const myBefore = moverColor === 'w' ? evalBefore : -evalBefore;
    const myAfter = moverColor === 'w' ? evalAfter : -evalAfter;
    const reward = (myAfter - myBefore) / 400;

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
  evalPosition,
  computeReward
};
