'use strict';

/**
 * watcher-learning.js — простой RL-бот.
 * - Линейная модель: 768 весов (12 фигур × 64 клетки)
 * - Обучение: self-play + reward по итогу партии
 * - Не учится у людей и ботов
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'watcher-data.json');

// ============================================================
// ДАННЫЕ
// ============================================================
let DATA = {
  version: 3,
  weights: {},          // 'P_e4': 0.5, 'N_f3': 1.2, ...
  games: 0,             // сколько self-play партий сыграно
  wins: 0, losses: 0, draws: 0,
  lastUpdate: 0,
};

function initWeights() {
  const pieces = ['P','N','B','R','Q','K','p','n','b','r','q','k'];
  const files = 'abcdefgh';
  for (const p of pieces) {
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const sq = `${files[c]}${8 - r}`;
      DATA.weights[`${p}_${sq}`] = 0;
    }
  }
}

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      // Если версия не та — пересоздаём
      if (parsed.version !== 3) {
        console.log('[Watcher] Старая версия, создаю новую базу v3');
        DATA = { version: 3, weights: {}, games: 0, wins: 0, losses: 0, draws: 0, lastUpdate: 0 };
        initWeights();
        saveData();
      } else {
        DATA = parsed;
        // Проверка, что все веса на месте
        for (const p of ['P','N','B','R','Q','K','p','n','b','r','q','k']) {
          for (const f of 'abcdefgh') {
            for (let n = 1; n <= 8; n++) {
              if (typeof DATA.weights[`${p}_${f}${n}`] !== 'number') DATA.weights[`${p}_${f}${n}`] = 0;
            }
          }
        }
        console.log(`[Watcher] База загружена: ${DATA.games} партий, W/L/D = ${DATA.wins}/${DATA.losses}/${DATA.draws}`);
      }
    } else {
      DATA = { version: 3, weights: {}, games: 0, wins: 0, losses: 0, draws: 0, lastUpdate: 0 };
      initWeights();
      saveData();
      console.log('[Watcher] Создал новую базу v3');
    }
  } catch (e) {
    console.error('[Watcher] Ошибка загрузки:', e.message);
    DATA = { version: 3, weights: {}, games: 0, wins: 0, losses: 0, draws: 0, lastUpdate: 0 };
    initWeights();
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

let autoSaveTimer = null;
function startAutoSave() {
  if (autoSaveTimer) return;
  autoSaveTimer = setInterval(saveData, 2 * 60 * 1000);
}

// ============================================================
// ШАХМАТНЫЕ ХЕЛПЕРЫ
// ============================================================
const PIECE_VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };
const isWhite = p => !!p && p === p.toUpperCase();
const inBoard = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;

function parseFen(fen) {
  const parts = fen.split(' ');
  const board = Array.from({ length: 8 }, () => Array(8).fill(null));
  parts[0].split('/').forEach((row, r) => {
    let f = 0;
    for (const ch of row) { if (/\d/.test(ch)) f += +ch; else board[r][f++] = ch; }
  });
  return { board, turn: parts[1], castling: parts[2], ep: parts[3], half: +parts[4] || 0, full: +parts[5] || 1 };
}

function toFen(state) {
  const rows = state.board.map(r => {
    let s = '', e = 0;
    for (const c of r) { if (c) { if (e) { s += e; e = 0; } s += c; } else e++; }
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
    const p = state.board[rr][cc]; if (!p || isWhite(p) !== byWhite) continue;
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
  const p = copy.board[fr][fc]; const white = isWhite(p); const type = p.toLowerCase();
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
// ОЦЕНКА ПОЗИЦИИ (по весам)
// ============================================================
function sqName(r, c) {
  return String.fromCharCode(97 + c) + (8 - r);
}

function evaluate(state, forWhite) {
  let score = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p) continue;
    const isW = isWhite(p);
    const material = PIECE_VALUES[p.toLowerCase()] || 0;
    const w = DATA.weights[`${p}_${sqName(r, c)}`] || 0;
    const total = material + w * 100;
    score += isW ? total : -total;
  }
  return forWhite ? score : -score;
}

// ============================================================
// ВЫБОР ХОДА
// ============================================================
function pickMove(state, isWhiteTurn, epsilon = 0.2) {
  const legal = allLegalMoves(state, isWhiteTurn);
  if (legal.length === 0) return null;
  if (legal.length === 1) return legal[0];
  if (Math.random() < epsilon) {
    return legal[Math.floor(Math.random() * legal.length)];
  }
  let best = null, bestScore = -Infinity;
  for (const [from, to] of legal) {
    const next = applyMove(state, from, to);
    const score = evaluate(next, isWhiteTurn);
    if (score > bestScore) { bestScore = score; best = [from, to]; }
  }
  return best;
}

// ============================================================
// SELF-PLAY
// ============================================================
function playSelfPlayGame() {
  let state = parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  const history = [];
  let result = 0;
  const maxMoves = 200;

  for (let move = 0; move < maxMoves; move++) {
    const legal = allLegalMoves(state, state.turn === 'w');
    if (legal.length === 0) {
      if (inCheck(state, state.turn === 'w')) result = state.turn === 'w' ? -1 : 1;
      else result = 0;
      break;
    }
    if (state.half >= 100) { result = 0; break; }

    const isW = state.turn === 'w';
    const mv = pickMove(state, isW, 0.3);
    if (!mv) break;

    const pieceMoved = state.board[mv[0][0]][mv[0][1]];
    const sqFrom = sqName(mv[0][0], mv[0][1]);
    const sqTo = sqName(mv[1][0], mv[1][1]);

    history.push({
      white: isW,
      pieceMoved,
      sqFrom,
      sqTo,
    });

    state = applyMove(state, mv[0], mv[1]);
  }

  // Обучение
  trainOnHistory(history, result);

  DATA.games++;
  if (result === 1) DATA.wins++;
  else if (result === -1) DATA.losses++;
  else DATA.draws++;

  return result;
}

function trainOnHistory(history, result) {
  if (history.length === 0) return;

  // Если белые выиграли (result=1) — бонус всем ходам белых, штраф чёрным
  // Если ничья — маленький бонус за «сложные» ходы (взятия)
  const lr = 0.01;

  for (const move of history) {
    // Знак: белые → +1, чёрные → -1
    const side = move.white ? 1 : -1;

    let reward;
    if (result === 1) reward = move.white ? 1 : -1;
    else if (result === -1) reward = move.white ? -1 : 1;
    else reward = 0;

    // Обновляем веса "откуда" и "куда"
    const keyFrom = `${move.pieceMoved}_${move.sqFrom}`;
    const keyTo = `${move.pieceMoved}_${move.sqTo}`;

    // Если ход хороший — ценим клетку "куда"
    // Если плохой — ценим клетку "откуда" (хотели уйти, но не помогло)
    if (typeof DATA.weights[keyTo] !== 'number') DATA.weights[keyTo] = 0;
    if (typeof DATA.weights[keyFrom] !== 'number') DATA.weights[keyFrom] = 0;

    DATA.weights[keyTo] += lr * side * reward;
    DATA.weights[keyFrom] -= lr * side * reward * 0.5;

    // Ограничим веса, чтобы не разлетались
    DATA.weights[keyTo] = Math.max(-1, Math.min(1, DATA.weights[keyTo]));
    DATA.weights[keyFrom] = Math.max(-1, Math.min(1, DATA.weights[keyFrom]));
  }
}

// ============================================================
// ПУБЛИЧНЫЙ API
// ============================================================
function getStats() {
  return {
    games: DATA.games,
    wins: DATA.wins,
    losses: DATA.losses,
    draws: DATA.draws,
    episodeActive: false,
  };
}

/**
 * Используется сервером, когда Watcher играет с человеком/ботом.
 * НЕ обновляет веса.
 */
function pickMoveForServer(fen, color, timeInfo, availableMoves, line) {
  const state = parseFen(fen);
  const isWhiteTurn = color === 'w';
  const move = pickMove(state, isWhiteTurn, 0.05);
  if (!move) return null;
  return { from: move[0], to: move[1] };
}

// Заглушки для совместимости с server.js
function startEpisode() {}
function recordTransition() {}
function learnFromObservedMove() {} // ← не учимся у людей и ботов!
function finishEpisode() {}          // ← не записываем партии из сервера
function loadWeights() { loadData(); }
function saveWeights() { saveData(); }

module.exports = {
  pickMove: pickMoveForServer,
  startEpisode,
  recordTransition,
  learnFromObservedMove,
  finishEpisode,
  getStats,
  loadWeights,
  saveWeights,
  startAutoSave,
  // для тренера:
  playSelfPlayGame,
  saveData,
};
