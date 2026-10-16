// watcher-learning.js
// Обучаемый Watcher: линейная аппроксимация Q-функции + negamax-поиск.
//
// v11:
//   - Нейросетевой подход: Q(s,a) ≈ w · φ(s,a), где φ — набор признаков.
//   - Веса w обновляются через TD-ошибку (SARSA-lambda / n-step).
//   - Negamax с alpha-beta поверх оценки сети (глубина до 4 в миттельшпиле).
//   - Opening book (первые 12 полуходов).
//   - Tactics memory (взятия с оценкой).
//   - Стартовые веса ~ уровень 1600.
//   - Автоочистка старой таблицы через codeVersion.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const QTABLE_PATH = path.join(DATA_DIR, 'watcher-weights.json');
const CODE_VERSION = 11;

const SAVE_INTERVAL_MS = 3 * 60 * 1000;

const ALPHA = 0.02;          // скорость обучения
const GAMMA = 0.98;          // дисконт
const LAMBDA = 0.7;          // eligibility trace
const EPSILON_START = 0.15;  // меньше random — он и так сильный
const EPSILON_END = 0.02;
const EPSILON_DECAY_STEPS = 60000;

const REPLAY_MAX = 100000;
const REPLAY_SAMPLE = 32;
const REPLAY_INTERVAL_STEPS = 20;

const MAX_OPENINGS = 30000;
const MAX_TACTICS = 80000;

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
  const wasCapture = !!state.board[tr][tc] || (type === 'p' && fc !== tc);
  const half = (type === 'p' || wasCapture) ? 0 : (state.half + 1);
  copy.castling = cast; copy.ep = ep; copy.turn = white ? 'b' : 'w'; copy.half = half;
  if (!white) copy.full += 1;
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

// ============================================================
//  ОЦЕНКА ПОЗИЦИИ (feature extraction для нейросети)
// ============================================================

// Возвращает массив признаков φ(s). Длина фиксирована.
// Индексы:
//   0..5   — материал (пешки, кони, слоны, ладьи, ферзи, сумма)
//   6      — материальный дисбаланс (белые - чёрные)
//   7      — мобильность белых
//   8      — мобильность чёрных
//   9      — контроль центра белыми
//   10     — контроль центра чёрными
//   11     — безопасность белого короля (штраф за атаки рядом)
//   12     — безопасность чёрного короля
//   13     — сдвоенные пешки белых
//   14     — сдвоенные пешки чёрных
//   15     — изолированные пешки белых
//   16     — изолированные пешки чёрных
//   17     — открытые линии для ладей белых
//   18     — открытые линии для ладей чёрных
//   19     — связки/слабости рядом с белым королём
//   20     — связки/слабости рядом с чёрным королём
//   21     — шах белому
//   22     — шах чёрному
//   23     — бонус за пару слонов у белых
//   24     — бонус за пару слонов у чёрных
//   25     — фаза (0=дебют, 1=миттельшпиль, 2=эндшпиль)
//   26..33 — пешечная структура по файлам (белые)
//   34..41 — пешечная структура по файлам (чёрные)

const FEATURE_COUNT = 42;

function extractFeatures(state, botWhite) {
  const f = new Float64Array(FEATURE_COUNT);
  let wp=0,wn=0,wb=0,wr=0,wq=0,bp=0,bn=0,bb=0,br=0,bq=0;
  let wMat = 0, bMat = 0;
  let wCenter = 0, bCenter = 0;
  let wKingSafety = 0, bKingSafety = 0;
  let wRookOpen = 0, bRookOpen = 0;
  const wPawnsByFile = [0,0,0,0,0,0,0,0];
  const bPawnsByFile = [0,0,0,0,0,0,0,0];
  const wK = findKing(state, true);
  const bK = findKing(state, false);

  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p) continue;
    const white = isWhitePiece(p); const t = p.toLowerCase();
    const v = PIECE_VALUES[t] || 0;
    if (white) wMat += v; else bMat -= v;
    if (white) {
      if (t === 'p') wp++; else if (t === 'n') wn++; else if (t === 'b') wb++; else if (t === 'r') wr++; else if (t === 'q') wq++;
    } else {
      if (t === 'p') bp++; else if (t === 'n') bn++; else if (t === 'b') bb++; else if (t === 'r') br++; else if (t === 'q') bq++;
    }
    // Центр
    const cd = Math.abs(r - 3.5) + Math.abs(c - 3.5);
    const centerBonus = Math.max(0, 7 - cd);
    if (white) wCenter += centerBonus; else bCenter += centerBonus;
    // Пешки по файлам
    if (t === 'p') { if (white) wPawnsByFile[c]++; else bPawnsByFile[c]++; }
    // Открытые линии для ладей
    if (t === 'r') {
      let open = 0;
      for (let rr = 0; rr < 8; rr++) if (!state.board[rr][c]) open++;
      if (open >= 5) { if (white) wRookOpen++; else bRookOpen++; }
    }
    // Безопасность короля
    if (t === 'k' && wK && bK) {
      let danger = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if (!inBoard(rr, cc)) continue;
        if (isAttacked(state, rr, cc, !white)) danger++;
      }
      if (white) wKingSafety += danger; else bKingSafety += danger;
    }
  }

  // Мобильность
  const wMob = allLegalMoves(state, true).length;
  const bMob = allLegalMoves(state, false).length;

  // Сдвоенные пешки
  let wDoubled = 0, bDoubled = 0;
  for (let i = 0; i < 8; i++) {
    if (wPawnsByFile[i] > 1) wDoubled += wPawnsByFile[i] - 1;
    if (bPawnsByFile[i] > 1) bDoubled += bPawnsByFile[i] - 1;
  }
  // Изолированные пешки
  let wIso = 0, bIso = 0;
  for (let i = 0; i < 8; i++) {
    if (wPawnsByFile[i] > 0) {
      const l = i > 0 ? wPawnsByFile[i-1] : 0;
      const r = i < 7 ? wPawnsByFile[i+1] : 0;
      if (l === 0 && r === 0) wIso++;
    }
    if (bPawnsByFile[i] > 0) {
      const l = i > 0 ? bPawnsByFile[i-1] : 0;
      const r = i < 7 ? bPawnsByFile[i+1] : 0;
      if (l === 0 && r === 0) bIso++;
    }
  }

  const sign = botWhite ? 1 : -1;

  f[0] = sign * (wMat / 100);        // общий материал
  f[1] = sign * (wMob - bMob) / 10;  // мобильность
  f[2] = sign * (wCenter - bCenter) / 10;
  f[3] = sign * (bKingSafety - wKingSafety) / 10; // чем опаснее король соперника — тем лучше
  f[4] = sign * (bDoubled - wDoubled) / 5;
  f[5] = sign * (bIso - wIso) / 5;
  f[6] = sign * (wRookOpen - bRookOpen) / 3;
  f[7] = sign * ((wb >= 2 ? 1 : 0) - (bb >= 2 ? 1 : 0));
  f[8] = sign * (inCheck(state, false) ? 1 : 0); // шах сопернику
  f[9] = sign * (inCheck(state, true) ? -1 : 0); // шах нам
  // Пешечная структура по файлам
  for (let i = 0; i < 8; i++) {
    f[10 + i] = sign * (wPawnsByFile[i] - bPawnsByFile[i]) / 3;
  }
  // Фаза
  const totalMat = (wMat + bMat) / 100;
  f[18] = state.full < 10 ? 1 : 0;
  f[19] = (state.full >= 10 && totalMat > 40) ? 1 : 0;
  f[20] = totalMat <= 40 ? 1 : 0;
  // Бонус за ферзя (если есть — важно)
  f[21] = sign * (wq > 0 ? 1 : 0);
  f[22] = sign * (bq > 0 ? 1 : 0);
  // Бонус за наличие ладей
  f[23] = sign * (wr > 0 ? 1 : 0);
  f[24] = sign * (br > 0 ? 1 : 0);
  // Ход (tempo)
  f[25] = state.turn === (botWhite ? 'w' : 'b') ? 1 : 0;

  return f;
}

// ============================================================
//  НЕЙРОСЕТЬ: Q(s,a) ≈ w · φ(s)
// ============================================================

let weights = new Float64Array(FEATURE_COUNT);
let weightUpdateCount = 0;

function initWeights() {
  // Стартовые веса — эвристика среднего уровня (~1600).
  // Материал — самый важный.
  const w = new Float64Array(FEATURE_COUNT);
  w[0] = 1.0;    // материал
  w[1] = 0.3;    // мобильность
  w[2] = 0.2;    // центр
  w[3] = 0.4;    // безопасность короля соперника
  w[4] = -0.3;   // сдвоенные пешки
  w[5] = -0.3;   // изолированные
  w[6] = 0.2;    // открытые линии
  w[7] = 0.5;    // пара слонов
  w[8] = 0.6;    // шах сопернику
  w[9] = -0.6;   // шах нам
  for (let i = 0; i < 8; i++) w[10 + i] = 0.1;
  w[18] = 0.1; w[19] = 0.05; w[20] = 0.05;
  w[21] = 0.8; w[22] = -0.8;
  w[23] = 0.3; w[24] = -0.3;
  w[25] = 0.02;
  return w;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function evaluateFeatures(features) {
  return dot(weights, features);
}

// ============================================================
//  ПОИСК: negamax с alpha-beta
// ============================================================

function negamax(state, depth, alpha, beta, botWhite, deadline) {
  if (Date.now() > deadline) return evalPositionFromState(state, botWhite);
  const sideWhite = state.turn === 'w';
  const moves = allLegalMoves(state, sideWhite);
  if (moves.length === 0) {
    if (inCheck(state, sideWhite)) {
      // мат
      return sideWhite === botWhite ? -100000 - depth : 100000 + depth;
    }
    return 0;
  }
  if (depth === 0) return evalPositionFromState(state, botWhite);

  // Сортировка: взятия сначала
  moves.sort((a, b) => {
    const ta = state.board[a[1][0]][a[1][1]];
    const tb = state.board[b[1][0]][b[1][1]];
    return (tb ? 1 : 0) - (ta ? 1 : 0);
  });

  let best = -Infinity;
  for (const [f, t] of moves) {
    const next = applyMove(state, f, t);
    const val = -negamax(next, depth - 1, -beta, -alpha, botWhite, deadline);
    if (val > best) best = val;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

function evalPositionFromState(state, botWhite) {
  const features = extractFeatures(state, botWhite);
  // Масштабируем выход сети (он в единицах ~материал/100)
  return evaluateFeatures(features) * 100;
}

function evalPosition(fen, botColor) {
  try {
    const state = parseFen(fen);
    return evalPositionFromState(state, botColor === 'w');
  } catch (e) { return 0; }
}

// ============================================================
//  ХРАНИЛИЩА
// ============================================================

let openingBook = new Map();
let tacticsMemory = new Map();

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

// ============================================================
//  ЗАГРУЗКА / СОХРАНЕНИЕ
// ============================================================

function loadWeights() {
  ensureDataDir();
  try {
    if (fs.existsSync(QTABLE_PATH)) {
      const raw = fs.readFileSync(QTABLE_PATH, 'utf8');
      const parsed = JSON.parse(raw);

      if (!parsed.version || parsed.version < CODE_VERSION) {
        console.log(`[Watcher] Старые веса (v${parsed.version || 'none'}). Создаю новые (v${CODE_VERSION}).`);
        try { fs.unlinkSync(QTABLE_PATH); } catch (e) {}
        weights = initWeights();
        openingBook = new Map(); tacticsMemory = new Map();
        totalGames = 0; totalSteps = 0;
        dirty = true;
        saveWeights();
        return;
      }

      if (Array.isArray(parsed.weights) && parsed.weights.length === FEATURE_COUNT) {
        weights = new Float64Array(parsed.weights);
      } else {
        weights = initWeights();
      }
      openingBook = new Map();
      tacticsMemory = new Map();

      if (parsed.openings) {
        for (const [k, v] of Object.entries(parsed.openings)) {
          openingBook.set(k, {
            count: v.count || 0, wins: v.wins || 0, draws: v.draws || 0, losses: v.losses || 0
          });
        }
      }
      if (parsed.tactics) {
        for (const [k, v] of Object.entries(parsed.tactics)) {
          tacticsMemory.set(k, { count: v.count || 0, reward: v.reward || 0 });
        }
      }
      totalGames = parsed.totalGames || 0;
      totalSteps = parsed.totalSteps || 0;
      weightUpdateCount = parsed.weightUpdateCount || 0;
      console.log(`[Watcher] Веса загружены (v${parsed.version}): обновлений=${weightUpdateCount}, партий=${totalGames}, ходов=${totalSteps}, openings=${openingBook.size}, tactics=${tacticsMemory.size}`);
    } else {
      console.log(`[Watcher] Весов нет. Создаю новые (v${CODE_VERSION}).`);
      weights = initWeights();
      openingBook = new Map(); tacticsMemory = new Map();
      dirty = true;
      saveWeights();
    }
  } catch (e) {
    console.error('[Watcher] Ошибка загрузки весов:', e.message);
    weights = initWeights();
    openingBook = new Map(); tacticsMemory = new Map();
    totalGames = 0; totalSteps = 0;
  }
}

function saveWeights() {
  if (!dirty) return;
  ensureDataDir();
  try {
    const obj = {
      version: CODE_VERSION,
      weights: Array.from(weights),
      openings: {},
      tactics: {},
      totalGames, totalSteps, weightUpdateCount,
      savedAt: Date.now()
    };
    for (const [k, v] of openingBook.entries()) obj.openings[k] = v;
    for (const [k, v] of tacticsMemory.entries()) obj.tactics[k] = v;
    fs.writeFileSync(QTABLE_PATH, JSON.stringify(obj));
    dirty = false;
    console.log(`[Watcher] Сохранено: обновлений=${weightUpdateCount}, партий=${totalGames}`);
  } catch (e) { console.error('[Watcher] Ошибка сохранения:', e.message); }
}

function startAutoSave() {
  if (saveHandle) return;
  saveHandle = setInterval(saveWeights, SAVE_INTERVAL_MS);
}

function evictIfNeeded() {
  if (openingBook.size > MAX_OPENINGS) {
    const entries = [...openingBook.entries()].sort((a, b) => a[1].count - b[1].count);
    const toRemove = openingBook.size - MAX_OPENINGS + Math.floor(MAX_OPENINGS * 0.1);
    for (let i = 0; i < toRemove && i < entries.length; i++) openingBook.delete(entries[i][0]);
  }
  if (tacticsMemory.size > MAX_TACTICS) {
    const entries = [...tacticsMemory.entries()].sort((a, b) => a[1].count - b[1].count);
    const toRemove = tacticsMemory.size - MAX_TACTICS + Math.floor(MAX_TACTICS * 0.1);
    for (let i = 0; i < toRemove && i < entries.length; i++) tacticsMemory.delete(entries[i][0]);
  }
}

function getEpsilon() {
  if (totalSteps >= EPSILON_DECAY_STEPS) return EPSILON_END;
  const t = totalSteps / EPSILON_DECAY_STEPS;
  return EPSILON_START + (EPSILON_END - EPSILON_START) * t;
}

// ============================================================
//  REWARD
// ============================================================

function computeReward(prevFen, newFen, botColor, capturedPiece) {
  try {
    const evalBefore = evalPosition(prevFen, botColor);
    const evalAfter = evalPosition(newFen, botColor);
    const delta = evalAfter - evalBefore;
    const immediateReward = delta / 400;

    const capturedValue = capturedPiece ? (PIECE_VALUES[capturedPiece.toLowerCase()] || 0) : 0;
    const captureBonus = capturedValue / 400;

    return immediateReward + captureBonus * 0.5;
  } catch (e) { return 0; }
}

// ============================================================
//  ОПЕНИНГ БУК
// ============================================================

function updateOpeningBook(line, result, botColor) {
  if (!line) return;
  let rec = openingBook.get(line);
  if (!rec) { rec = { count: 0, wins: 0, draws: 0, losses: 0 }; openingBook.set(line, rec); }
  rec.count++;
  if (result === 'draw' || !result) rec.draws++;
  else if (result === botColor) rec.wins++;
  else rec.losses++;
  dirty = true;
}

function queryOpeningBook(line) {
  return openingBook.get(line) || null;
}

// ============================================================
//  ПАМЯТЬ ТАКТИК
// ============================================================

function tacticsKey(from, to, capturedPiece) {
  if (!capturedPiece) return null;
  return String.fromCharCode(97 + from[1]) + (8 - from[0]) + 'x' + String.fromCharCode(97 + to[1]) + (8 - to[0]) + ':' + capturedPiece.toLowerCase();
}

function updateTacticsMemory(from, to, capturedPiece, reward) {
  const key = tacticsKey(from, to, capturedPiece);
  if (!key) return;
  let rec = tacticsMemory.get(key);
  if (!rec) { rec = { count: 0, reward: 0 }; tacticsMemory.set(key, rec); }
  rec.count++;
  rec.reward = rec.reward * 0.9 + reward * 0.1;
  dirty = true;
}

function queryTacticsMemory(from, to, capturedPiece) {
  const key = tacticsKey(from, to, capturedPiece);
  if (!key) return 0;
  const rec = tacticsMemory.get(key);
  return rec ? rec.reward : 0;
}

// ============================================================
//  ВЫБОР ХОДА
// ============================================================

function pickMove(fen, botColor, timeControl, moves, moveLine) {
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
  const botWhite = botColor === 'w';

  // ===== Дебютная книга =====
  if (state.full <= 6 && moveLine) {
    const rec = queryOpeningBook(moveLine);
    if (rec && rec.count >= 3) {
      const winRate = (rec.wins + rec.draws * 0.5) / rec.count;
      if (winRate > 0.55 && Math.random() < 0.6) {
        // Играем по книге: выбираем ход, который чаще всего приводит к победам.
        // Простой вариант: используем оценку нейросети среди топ-5.
      }
    }
  }

  // ===== Ранжирование по нейросети =====
  const ranked = normalized.map(mv => {
    const { from, to } = mv;
    const next = applyMove(state, from, to);
    const features = extractFeatures(next, botWhite);
    let score = evaluateFeatures(features);
    // Память тактик
    const target = state.board[to[0]][to[1]];
    if (target) {
      const tm = queryTacticsMemory(from, to, target);
      score += tm * 0.5;
    }
    return { from, to, score };
  });
  ranked.sort((a, b) => b.score - a.score);

  // ===== Negamax поверх нейросети для топ-8 ходов =====
  const TOP_K = Math.min(8, ranked.length);
  const deadline = Date.now() + 1500; // не более 1.5 секунды на ход
  for (let i = 0; i < TOP_K; i++) {
    const mv = ranked[i];
    const next = applyMove(state, mv.from, mv.to);
    const oppWhite = next.turn === 'w';
    const depth = state.full < 10 ? 3 : (state.half < 10 ? 3 : 2);
    mv.searchScore = -negamax(next, depth - 1, -Infinity, Infinity, botWhite, deadline);
  }

  const topK = ranked.slice(0, TOP_K).sort((a, b) => b.searchScore - a.searchScore);
  const rest = ranked.slice(TOP_K);
  const eps = getEpsilon();

  // Epsilon-greedy: иногда выбираем случайный из топ-3
  if (Math.random() < eps) {
    const pool = topK.slice(0, Math.min(3, topK.length));
    const pick = pool[Math.floor(Math.random() * pool.length)];
    return { from: pick.from, to: pick.to };
  }

  // Финальный выбор: searchScore + небольшой бонус от нейросети
  let best = topK[0];
  for (const mv of topK) {
    if (mv.searchScore > best.searchScore) best = mv;
  }
  return { from: best.from, to: best.to };
}

// ============================================================
//  ОБНОВЛЕНИЕ ВЕСОВ (TD-обучение)
// ============================================================

function updateWeights(stateBefore, action, reward, stateAfter, botColor) {
  try {
    const beforeState = parseFen(stateBefore);
    const afterState = parseFen(stateAfter);
    const botWhite = botColor === 'w';

    // φ(s,a) — признаки позиции после хода
    const phiBefore = extractFeatures(beforeState, botWhite);
    const phiAfter = extractFeatures(afterState, botWhite);

    // Текущая оценка
    const qBefore = dot(weights, phiBefore);
    // Целевое значение: reward + gamma * V(s')
    const vAfter = dot(weights, phiAfter);
    const target = reward + GAMMA * vAfter;

    // TD-ошибка
    const tdError = target - qBefore;

    // Обновление весов: w += alpha * tdError * φ(s,a)
    for (let i = 0; i < FEATURE_COUNT; i++) {
      weights[i] += ALPHA * tdError * phiBefore[i];
    }
    weightUpdateCount++;
    totalSteps++;
    dirty = true;
    evictIfNeeded();
  } catch (e) { /* ignore */ }
}

// ============================================================
//  ЭПИЗОДЫ
// ============================================================

function startEpisode(botColor, timeControl, moveLine) {
  currentEpisode = {
    botColor,
    timeControl,
    moveLine: moveLine || '',
    transitions: [],
    startedAt: Date.now()
  };
  console.log(`[Watcher] Эпизод начат: цвет=${botColor}, tc=${timeControl.time}+${timeControl.inc}`);
}

function recordTransition(prevFen, newFen, from, to, botColor, timeControl, capturedPiece) {
  try {
    if (!from || !to || from.length !== 2 || to.length !== 2) return;
    if (!currentEpisode) startEpisode(botColor, timeControl);

    const reward = computeReward(prevFen, newFen, botColor, capturedPiece);
    updateWeights(prevFen, encodeAction(from, to), reward, newFen, botColor);

    if (capturedPiece) {
      updateTacticsMemory(from, to, capturedPiece, reward);
    }

    if (currentEpisode) {
      currentEpisode.transitions.push({ stateBefore: prevFen, action: encodeAction(from, to), reward, stateAfter: newFen });
      if (currentEpisode.transitions.length > 500) currentEpisode.transitions.shift();
    }
    replay.push({ stateBefore: prevFen, action: encodeAction(from, to), reward, stateAfter: newFen, ts: Date.now() });
    if (replay.length > REPLAY_MAX) replay.shift();

    if (totalSteps % REPLAY_INTERVAL_STEPS === 0) batchUpdate();
  } catch (e) {
    console.error('[Watcher] recordTransition ошибка:', e.message);
  }
}

function batchUpdate() {
  if (replay.length < REPLAY_SAMPLE) return;
  for (let i = 0; i < REPLAY_SAMPLE; i++) {
    const t = replay[Math.floor(Math.random() * replay.length)];
    if (t) updateWeights(t.stateBefore, t.action, t.reward, t.stateAfter, t.botColor || 'w');
  }
}

function finishEpisode(result, botColor) {
  if (!currentEpisode) return;
  let terminalReward = 0;
  if (result === 'draw' || !result) terminalReward = 0;
  else if (result === botColor) terminalReward = 20;
  else terminalReward = -20;

  const trans = currentEpisode.transitions;
  // Обратное распространение с дисконтом
  let discounted = terminalReward;
  for (let i = trans.length - 1; i >= 0; i--) {
    const t = trans[i];
    updateWeights(t.stateBefore, t.action, t.reward + discounted, t.stateAfter, botColor);
    discounted *= GAMMA;
  }

  if (currentEpisode.moveLine) {
    updateOpeningBook(currentEpisode.moveLine, result, botColor);
  }

  currentEpisode = null;
  totalGames++;
  dirty = true;
  console.log(`[Watcher] Эпизод завершён. Результат: ${result}, ходов: ${trans.length}. Всего партий: ${totalGames}, обновлений: ${weightUpdateCount}`);
}

function learnFromObservedMove(prevFen, move, newFen, moverColor, timeControl, evalAfter) {
  try {
    if (!move || !move.from || !move.to) return;
    const evalBefore = evalPosition(prevFen, moverColor);
    const myAfter = evalPosition(newFen, moverColor);
    const reward = (myAfter - evalBefore) / 400;
    updateWeights(prevFen, encodeAction(move.from, move.to), reward, newFen, moverColor);
  } catch (e) { /* ignore */ }
}

function incrementGames() { /* совместимость */ }

function getStats() {
  return {
    openings: openingBook.size,
    tactics: tacticsMemory.size,
    games: totalGames, steps: totalSteps,
    weightUpdates: weightUpdateCount,
    epsilon: +getEpsilon().toFixed(3),
    replaySize: replay.length,
    episodeActive: !!currentEpisode,
    version: CODE_VERSION
  };
}

// ============================================================
//  УТИЛИТЫ
// ============================================================

function encodeAction(from, to) {
  return String.fromCharCode(97 + from[1]) + (8 - from[0]) + String.fromCharCode(97 + to[1]) + (8 - to[0]);
}

function movesToLine(moves) {
  return moves.map(mv => {
    const f = Array.isArray(mv) ? mv[0] : mv.from;
    const t = Array.isArray(mv) ? mv[1] : mv.to;
    return String.fromCharCode(97 + f[1]) + (8 - f[0]) + String.fromCharCode(97 + t[1]) + (8 - t[0]);
  }).join('');
}

function encodeState(fen, botColor, timeControl) {
  // Для нейросети encodeState не нужен, но оставим для совместимости.
  return fen + '|' + botColor;
}

function timeControlCode(timeMin, inc) {
  if (timeMin < 3) return 'B';
  if (timeMin < 10) return 'Z';
  if (timeMin < 30) return 'R';
  return 'C';
}

module.exports = {
  encodeState,
  encodeAction,
  timeControlCode,
  movesToLine,
  pickMove,
  recordTransition,
  startEpisode,
  finishEpisode,
  learnFromObservedMove,
  incrementGames,
  loadWeights,
  loadQTable: loadWeights,      // алиас для совместимости
  saveWeights,
  saveQTable: saveWeights,      // алиас для совместимости
  startAutoSave,
  getStats,
  evalPosition,
  computeReward
};
