'use strict';

/**
 * watcher-learning.js — «мозг» бота Watcher.
 *
 * Стратегия:
 *  1. Дебютная книга — первые 6-8 ходов играет по теории.
 *  2. Negamax с alpha-beta, итеративное углубление.
 *  3. Адаптация глубины под остаток времени.
 *  4. Quiescence — обязательный досмотр всех взятий.
 *  5. Сохранение истории партий в watcher-data.json.
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'watcher-data.json');

// ============================================================
// ДАННЫЕ
// ============================================================
let DATA = {
  version: 1,
  games: [],            // последние 500 партий (для анализа)
  totalMoves: 0,
  wins: 0, losses: 0, draws: 0,
  lastUpdate: 0,
  weights: {},          // на будущее (нейросеть, если захочешь вернуть)
};
let autoSaveHandle = null;

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      DATA = Object.assign(DATA, parsed);
      console.log(`[Watcher] Загружено: ${DATA.games.length} партий, W/L/D = ${DATA.wins}/${DATA.losses}/${DATA.draws}`);
    } else {
      saveData();
      console.log('[Watcher] База пустая. Создаю watcher-data.json');
    }
  } catch (e) {
    console.error('[Watcher] Ошибка загрузки:', e.message);
  }
}

function saveData() {
  try {
    DATA.lastUpdate = Date.now();
    fs.writeFileSync(DATA_FILE, JSON.stringify(DATA, null, 2));
  } catch (e) {
    console.error('[Watcher] Ошибка сохранения:', e.message);
  }
}

function startAutoSave() {
  if (autoSaveHandle) return;
  autoSaveHandle = setInterval(saveData, 60 * 1000); // раз в минуту
}

function stopAutoSave() {
  if (autoSaveHandle) { clearInterval(autoSaveHandle); autoSaveHandle = null; }
}

// ============================================================
// ШАХМАТНЫЕ ХЕЛПЕРЫ (независимые от server.js)
// ============================================================
const PIECE_VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

const isWhite = p => !!p && p === p.toUpperCase();
const inBoard = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;

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

function toFen(state) {
  const rows = state.board.map(r => {
    let s = '', e = 0;
    for (const c of r) {
      if (c) { if (e) { s += e; e = 0; } s += c; } else e++;
    }
    if (e) s += e;
    return s;
  }).join('/');
  return [rows, state.turn, state.castling, state.ep, state.half, state.full].join(' ');
}

function pseudoMoves(state, r, c) {
  const p = state.board[r][c]; if (!p) return [];
  const moves = []; const white = isWhite(p); const type = p.toLowerCase();
  const dir = white ? -1 : 1;
  const add = (rr, cc) => {
    if (!inBoard(rr, cc)) return false;
    const t = state.board[rr][cc];
    if (t && isWhite(t) === white) return false;
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
      if (t && isWhite(t) !== white) moves.push([rr, cc]);
      const epTarget = String.fromCharCode(97 + cc) + (8 - rr);
      if (state.ep && state.ep === epTarget && !t) moves.push([rr, cc]);
    }
  } else if (type === 'n') {
    [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]].forEach(([dr, dc]) => add(r + dr, c + dc));
  } else if (type === 'k') {
    [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]].forEach(([dr, dc]) => add(r + dr, c + dc));
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
  const copy = { board: state.board.map(row => row.slice()), turn: state.turn, castling: state.castling, ep: state.ep, half: state.half, full: state.full };
  const [fr, fc] = from, [tr, tc] = to;
  const p = copy.board[fr][fc];
  const white = isWhite(p);
  const type = p.toLowerCase();
  if (type === 'p' && copy.ep) {
    const target = String.fromCharCode(97 + tc) + (8 - tr);
    if (copy.ep === target && !copy.board[tr][tc]) copy.board[fr][tc] = null;
  }
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
  copy.castling = cast; copy.ep = ep;
  copy.turn = white ? 'b' : 'w';
  copy.full += 1;
  return copy;
}

function legalMovesFor(state, r, c) {
  const p = state.board[r][c]; if (!p) return [];
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

// ============================================================
// ОЦЕНКА ПОЗИЦИИ (с PST)
// ============================================================
// PST — таблицы «привлекательности» клеток для каждой фигуры.
// Индексы: 0..63, где 0 = a8, 63 = h1 (для белых; для чёрных зеркалим).

const PST = {
  // Пешки: центр, продвижение, но не край.
  p: [
     0,  0,  0,  0,  0,  0,  0,  0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
     5,  5, 10, 25, 25, 10,  5,  5,
     0,  0,  0, 20, 20,  0,  0,  0,
     5, -5,-10,  0,  0,-10, -5,  5,
     5, 10, 10,-20,-20, 10, 10,  5,
     0,  0,  0,  0,  0,  0,  0,  0,
  ],
  // Кони: центр хорошо, край плохо.
  n: [
    -50,-40,-30,-30,-30,-30,-40,-50,
    -40,-20,  0,  0,  0,  0,-20,-40,
    -30,  0, 10, 15, 15, 10,  0,-30,
    -30,  5, 15, 20, 20, 15,  5,-30,
    -30,  0, 15, 20, 20, 15,  0,-30,
    -30,  5, 10, 15, 15, 10,  5,-30,
    -40,-20,  0,  5,  5,  0,-20,-40,
    -50,-40,-30,-30,-30,-30,-40,-50,
  ],
  // Слоны: диагонали, длинные диагонали.
  b: [
    -20,-10,-10,-10,-10,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5, 10, 10,  5,  0,-10,
    -10,  5,  5, 10, 10,  5,  5,-10,
    -10,  0, 10, 10, 10, 10,  0,-10,
    -10, 10, 10, 10, 10, 10, 10,-10,
    -10,  5,  0,  0,  0,  0,  5,-10,
    -20,-10,-10,-10,-10,-10,-10,-20,
  ],
  // Ладьи: открытые линии, 7-я горизонталь.
  r: [
      0,  0,  0,  0,  0,  0,  0,  0,
      5, 10, 10, 10, 10, 10, 10,  5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
      0,  0,  0,  5,  5,  0,  0,  0,
  ],
  // Ферзь: центр, избегаем ранних вылазок.
  q: [
    -20,-10,-10, -5, -5,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5,  5,  5,  5,  0,-10,
     -5,  0,  5,  5,  5,  5,  0, -5,
      0,  0,  5,  5,  5,  5,  0, -5,
    -10,  5,  5,  5,  5,  5,  0,-10,
    -10,  0,  5,  0,  0,  0,  0,-10,
    -20,-10,-10, -5, -5,-10,-10,-20,
  ],
  // Король: миттельшпиль — прячься в углу, рокируйся.
  k: [
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -20,-30,-30,-40,-40,-30,-30,-20,
    -10,-20,-20,-20,-20,-20,-20,-10,
     20, 20,  0,  0,  0,  0, 20, 20,
     20, 30, 10,  0,  0, 10, 30, 20,
  ],
};

function pstValue(type, white, r, c) {
  const table = PST[type];
  if (!table) return 0;
  // Для чёрных зеркалим вертикаль
  const idx = white ? r * 8 + c : (7 - r) * 8 + c;
  return table[idx];
}

function evaluatePosition(state) {
  let score = 0;
  let whiteBishops = 0, blackBishops = 0;
  let whiteKing = null, blackKing = null;

  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c];
    if (!p) continue;
    const white = isWhite(p);
    const type = p.toLowerCase();
    const material = PIECE_VALUES[type] || 0;
    const pst = pstValue(type, white, r, c);
    score += white ? (material + pst) : -(material + pst);
    if (type === 'b') { if (white) whiteBishops++; else blackBishops++; }
    if (type === 'k') { if (white) whiteKing = [r, c]; else blackKing = [r, c]; }
  }

  // Пара слонов
  if (whiteBishops >= 2) score += 30;
  if (blackBishops >= 2) score -= 30;

  // Безопасность короля: штраф, если враг рядом
  if (whiteKing) {
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = whiteKing[0] + dr, cc = whiteKing[1] + dc;
      if (!inBoard(rr, cc)) continue;
      if (isAttacked(state, rr, cc, false)) score -= 15;
    }
  }
  if (blackKing) {
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = blackKing[0] + dr, cc = blackKing[1] + dc;
      if (!inBoard(rr, cc)) continue;
      if (isAttacked(state, rr, cc, true)) score += 15;
    }
  }

  return score; // положительный = лучше для белых
}

// ============================================================
// ПОИСК: negamax + alpha-beta + quiescence
// ============================================================
const MATE = 100000;

function quiescence(state, alpha, beta, color, depthLeft) {
  const standPat = color * evaluatePosition(state);
  if (standPat >= beta) return beta;
  if (alpha < standPat) alpha = standPat;

  if (depthLeft <= 0) return alpha;

  // Только взятия
  const moves = allLegalMoves(state, color === 1)
    .filter(([from, to]) => state.board[to[0]][to[1]]);

  for (const [from, to] of moves) {
    const next = applyMove(state, from, to);
    const score = -quiescence(next, -beta, -alpha, -color, depthLeft - 1);
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

function negamax(state, depth, alpha, beta, color, deadline) {
  if (Date.now() >= deadline) return color * evaluatePosition(state); // тайм-аут

  const moves = allLegalMoves(state, color === 1);

  if (moves.length === 0) {
    if (inCheck(state, color === 1)) return -MATE + (10 - depth); // мат — плохо
    return 0; // пат — ничья
  }

  if (depth <= 0) return quiescence(state, alpha, beta, color, 4);

  // Сначала взятия (ускоряет alpha-beta)
  moves.sort((a, b) => {
    const capA = state.board[a[1][0]][a[1][1]];
    const capB = state.board[b[1][0]][b[1][1]];
    return (capB ? PIECE_VALUES[capB.toLowerCase()] : 0) - (capA ? PIECE_VALUES[capA.toLowerCase()] : 0);
  });

  let best = -Infinity;
  for (const [from, to] of moves) {
    const next = applyMove(state, from, to);
    const score = -negamax(next, depth - 1, -beta, -alpha, -color, deadline);
    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
    if (Date.now() >= deadline) break;
  }
  return best;
}

// Итеративное углубление: ищем depth=1,2,3... пока есть время
function searchBestMove(state, color, timeLeftSec, incSec) {
  const legal = allLegalMoves(state, color === 1);
  if (legal.length === 0) return null;
  if (legal.length === 1) return { from: legal[0][0], to: legal[0][1] };

  // Сколько времени на ход?
  let thinkMs;
  if (timeLeftSec < 3) thinkMs = 80;
  else if (timeLeftSec < 10) thinkMs = 200;
  else if (timeLeftSec < 30) thinkMs = 400;
  else if (timeLeftSec < 60) thinkMs = 800;
  else if (timeLeftSec < 180) thinkMs = 1200;
  else if (timeLeftSec < 600) thinkMs = 2000;
  else thinkMs = 3000;
  thinkMs += (incSec || 0) * 500;
  thinkMs = Math.min(thinkMs, timeLeftSec * 1000 * 0.25); // не более 25% остатка

  const deadline = Date.now() + thinkMs;

  let bestMove = legal[0];
  let maxDepth = 5;

  for (let depth = 1; depth <= maxDepth; depth++) {
    let alpha = -Infinity;
    let beta = Infinity;
    let localBest = null;
    let localBestScore = -Infinity;

    // Перестановка ходов: сначала тот, что был лучшим на прошлой итерации
    const ordered = legal.slice().sort((a, b) => {
      const aIsBest = a[0][0] === bestMove[0][0] && a[0][1] === bestMove[0][1] && a[1][0] === bestMove[1][0] && a[1][1] === bestMove[1][1];
      const bIsBest = b[0][0] === bestMove[0][0] && b[0][1] === bestMove[0][1] && b[1][0] === bestMove[1][0] && b[1][1] === bestMove[1][1];
      return (bIsBest ? 1 : 0) - (aIsBest ? 1 : 0);
    });

    for (const [from, to] of ordered) {
      if (Date.now() >= deadline) break;
      const next = applyMove(state, from, to);
      const score = -negamax(next, depth - 1, -beta, -alpha, -color, deadline);
      if (score > localBestScore) {
        localBestScore = score;
        localBest = [from, to];
      }
      if (score > alpha) alpha = score;
    }

    if (localBest && Date.now() < deadline) bestMove = localBest;
    if (Date.now() >= deadline) break;
  }

  return { from: bestMove[0], to: bestMove[1] };
}

// ============================================================
// ДЕБЮТНАЯ КНИГА (минимальная)
// ============================================================
// Ключ — FEN без счётчиков (4 части). Значение — список хороших ходов.
const OPENING_BOOK = {
  // Стартовая позиция: 1.e4, 1.d4, 1.Nf3, 1.c4
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -': [
    [[6,4],[4,4]], // e2-e4
    [[6,3],[4,3]], // d2-d4
    [[7,6],[5,5]], // Ng1-f3
    [[6,2],[4,2]], // c2-c4
  ],
  // После 1.e4 (чёрные)
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3': [
    [[1,4],[3,4]], // e7-e5
    [[1,2],[3,2]], // c7-c5 (Сицилианская)
    [[1,4],[2,4]], // e7-e6 (Французская)
    [[1,2],[2,2]], // c7-c6 (Каро-Канн)
  ],
  // После 1.e4 e5 (белые)
  'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -': [
    [[7,6],[5,5]], // Ng1-f3
    [[7,5],[4,2]], // Bf1-c4
  ],
  // После 1.d4 (чёрные)
  'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3': [
    [[0,6],[2,5]], // Ng8-f6
    [[1,3],[3,3]], // d7-d5
  ],
};

function fenKey(fen) {
  return fen.split(' ').slice(0, 4).join(' ');
}

function pickFromBook(fen) {
  const key = fenKey(fen);
  const moves = OPENING_BOOK[key];
  if (!moves || !moves.length) return null;
  return moves[Math.floor(Math.random() * moves.length)];
}

// ============================================================
// ПУБЛИЧНЫЙ API (совместим с server.js)
// ============================================================

function getStats() {
  return {
    episodeActive: false,
    games: DATA.games.length,
    wins: DATA.wins,
    losses: DATA.losses,
    draws: DATA.draws,
    totalMoves: DATA.totalMoves,
  };
}

/**
 * pickMove — главный вход. Возвращает { from, to } или null.
 */
function pickMove(fen, color, timeInfo, availableMoves, line) {
  const state = parseFen(fen);
  const isWatcherWhite = color === 'w';

  // 1. Дебютная книга
  const bookMove = pickFromBook(fen);
  if (bookMove) {
    // Проверяем, что ход действительно легален
    const legal = allLegalMoves(state, isWatcherWhite).map(([f, t]) => `${f[0]}${f[1]}${t[0]}${t[1]}`);
    const key = `${bookMove[0][0]}${bookMove[0][1]}${bookMove[1][0]}${bookMove[1][1]}`;
    if (legal.includes(key)) return { from: bookMove[0], to: bookMove[1] };
  }

  // 2. Поиск negamax с адаптацией под время
  const timeLeft = Math.max(0.5, timeInfo.time || 5);
  const inc = timeInfo.inc || 0;
  const best = searchBestMove(state, isWatcherWhite ? 1 : -1, timeLeft, inc);

  if (!best) return null;

  // Небольшая случайность: 5% — выбрать другой легальный ход
  // (чтобы не зацикливаться)
  if (Math.random() < 0.05 && availableMoves && availableMoves.length > 1) {
    const randomIdx = Math.floor(Math.random() * availableMoves.length);
    const alt = availableMoves[randomIdx];
    if (alt && alt.from && alt.to) return { from: alt.from, to: alt.to };
  }

  return best;
}

/**
 * startEpisode / recordTransition / finishEpisode — оставлены для совместимости.
 * Раньше Watcher учился нейросетью. Теперь он играет поиском, а история
 * пишется в watcher-data.json для анализа.
 */
function startEpisode(color, timeInfo) {
  // Ничего не делаем — эпизод теперь не для RL
}

function recordTransition(prevFen, nextFen, from, to, color, timeInfo, captured) {
  DATA.totalMoves++;
}

function learnFromObservedMove(prevFen, move, newFen, moverColor, timeInfo, evalAfter) {
  // Учиться у людей больше не нужно — бот играет поиском.
  // Но историю мы всё равно сохраняем (для анализа).
}

function finishEpisode(result, watcherColor) {
  // result: 'w' / 'b' / 'draw'. Для watcherColor 'w' победа — если result==='w'
  if (result === 'draw') DATA.draws++;
  else if (result === watcherColor) DATA.wins++;
  else DATA.losses++;

  if (DATA.games.length >= 500) DATA.games.shift();
  DATA.games.push({
    result, watcherColor,
    ts: Date.now(),
  });
}

function loadWeights() {
  loadData();
}

function saveWeights() {
  saveData();
}

module.exports = {
  pickMove,
  startEpisode,
  recordTransition,
  learnFromObservedMove,
  finishEpisode,
  getStats,
  loadWeights,
  saveWeights,
  startAutoSave,
};
