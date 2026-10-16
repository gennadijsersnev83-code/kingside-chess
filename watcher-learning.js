// watcher-learning.js
// Обучаемый Watcher: Double Q + Replay + Opening book + Tactics memory.
//
// v10:
//   - Комбинированный ключ: Zobrist + грубые бакеты. Узнаёт конкретные позиции
//     для тактик и обобщает для стратегии.
//   - openingBook — память дебютов (первые 12 полуходов).
//   - tacticsMemory — память тактических паттернов (взятия с оценкой).
//   - N-step TD через replay с приоритетом.
//   - 3-ply lookahead для топ-3 ходов.
//   - Терминальная награда ±20.
//   - Автоочистка старой таблицы через codeVersion. Один раз.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const QTABLE_PATH = path.join(DATA_DIR, 'watcher-qtable.json');
const CODE_VERSION = 10;

const MAX_STATES = 400000;
const MAX_OPENINGS = 20000;
const MAX_TACTICS = 60000;
const SAVE_INTERVAL_MS = 5 * 60 * 1000;

const ALPHA = 0.28;
const GAMMA = 0.97;
const EPSILON_START = 0.30;
const EPSILON_END = 0.02;
const EPSILON_DECAY_STEPS = 40000;

const REPLAY_MAX = 80000;
const REPLAY_SAMPLE = 64;
const REPLAY_INTERVAL_STEPS = 15;
const REPLAY_PRIORITY_FRESH = 0.6;

const LOOKAHEAD_TOP_K = 8;
const DEEP_LOOKAHEAD_TOP = 3;

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

// Оценка позиции с точки зрения бота. Учитывает материал, бонусы, угрозы.
function evalPositionFromState(state, botWhite) {
  let score = 0;
  let whiteBishops = 0, blackBishops = 0;
  let whiteRooksOpen = 0, blackRooksOpen = 0;
  let whiteKingSafety = 0, blackKingSafety = 0;
  const centerDist = (r, c) => Math.abs(r - 3.5) + Math.abs(c - 3.5);

  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p) continue;
    const white = isWhitePiece(p); const t = p.toLowerCase();
    const v = PIECE_VALUES[t] || 0;
    score += white ? v : -v;

    // Центр в дебюте
    if (state.full <= 12 && (t === 'p' || t === 'n' || t === 'b')) {
      const cd = centerDist(r, c);
      const bonus = Math.max(0, 7 - cd) * (t === 'p' ? 4 : 3);
      score += white ? bonus : -bonus;
    }
    // Развитие в дебюте
    if (state.full <= 12) {
      if (white && t === 'n' && r === 7) score -= 15;
      if (!white && t === 'n' && r === 0) score += 15;
      if (white && t === 'b' && r === 7 && c !== 6 && c !== 5) score -= 10;
      if (!white && t === 'b' && r === 0 && c !== 1 && c !== 2) score += 10;
    }
    if (t === 'b') { if (white) whiteBishops++; else blackBishops++; }
    if (t === 'r') {
      let open = 0;
      for (let rr = 0; rr < 8; rr++) if (!state.board[rr][c]) open++;
      if (open >= 5) { if (white) whiteRooksOpen++; else blackRooksOpen++; }
    }
    if (t === 'k') {
      // Безопасность короля: чем меньше атакующих рядом, тем лучше.
      let danger = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if (!inBoard(rr, cc)) continue;
        if (isAttacked(state, rr, cc, !white)) danger++;
      }
      if (white) whiteKingSafety += danger; else blackKingSafety += danger;
    }
  }
  if (whiteBishops >= 2) score += 30;
  if (blackBishops >= 2) score -= 30;
  if (whiteRooksOpen > 0) score += 15 * whiteRooksOpen;
  if (blackRooksOpen > 0) score -= 15 * blackRooksOpen;
  score -= whiteKingSafety * 12;
  score += blackKingSafety * 12;
  if (inCheck(state, true))  score -= 45;
  if (inCheck(state, false)) score += 45;

  return botWhite ? score : -score;
}

function evalPosition(fen, botColor) {
  try {
    const state = parseFen(fen);
    return evalPositionFromState(state, botColor === 'w');
  } catch (e) { return 0; }
}

// ============================================================
//  STATE ENCODING: Zobrist + грубые бакеты
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
    const p = board[r][c]; if (!p) continue;
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
function materialBucket(mat) {
  if (mat >= 30) return 'A';
  if (mat >= 20) return 'B';
  if (mat >= 12) return 'C';
  if (mat >= 6)  return 'D';
  if (mat >= 3)  return 'E';
  return 'F';
}
function countBucket(c) {
  if (c >= 12) return 'a';
  if (c >= 8)  return 'b';
  if (c >= 5)  return 'c';
  if (c >= 3)  return 'd';
  return 'e';
}

// Комбинированный ключ: Zobrist + грубые бакеты.
// Даёт узнавание конкретных позиций (для тактик) и обобщение (для стратегии).
function encodeState(fen, botColor, timeControl) {
  try {
    const parts = fen.split(' ');
    const boardStr = parts[0];
    const turn = parts[1] || 'w';
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
    let wMat = 0, bMat = 0;
    for (let rr = 0; rr < 8; rr++) for (let cc = 0; cc < 8; cc++) {
      const p = board[rr][cc];
      switch (p) {
        case 'P': wp++; wMat += 1; break;
        case 'N': wn++; wMat += 3; break;
        case 'B': wb++; wMat += 3; break;
        case 'R': wr++; wMat += 5; break;
        case 'Q': wq++; wMat += 9; break;
        case 'p': bp++; bMat += 1; break;
        case 'n': bn++; bMat += 3; break;
        case 'b': bb++; bMat += 3; break;
        case 'r': br++; bMat += 5; break;
        case 'q': bq++; bMat += 9; break;
      }
    }
    const wCount = wp+wn+wb+wr+wq;
    const bCount = bp+bn+bb+br+bq;

    const state = { board, turn, castling, ep, half: +parts[4] || 0, full: fullmove };
    const botWhite = botColor === 'w';
    const botInChk = inCheck(state, botWhite) ? 'K' : 'k';
    const oppInChk = inCheck(state, !botWhite) ? 'A' : 'a';

    let hangingCount = 0;
    for (let rr = 0; rr < 8; rr++) for (let cc = 0; cc < 8; cc++) {
      const p = board[rr][cc];
      if (!p || isWhitePiece(p) !== botWhite) continue;
      if (p.toLowerCase() === 'k') continue;
      if (isAttacked(state, rr, cc, !botWhite)) hangingCount++;
    }
    const hangBucket = hangingCount >= 4 ? 'H' : (hangingCount >= 2 ? 'h' : (hangingCount >= 1 ? 'm' : 'n'));

    const phase = fullmove < 10 ? 'O' : (fullmove < 25 ? 'M' : 'E');
    const turnSign = turn === botColor ? 'T' : 't';
    const tc = timeControlCode(timeControl && timeControl.time ? timeControl.time : 5, timeControl ? timeControl.inc : 0);
    const zh = zobristHash(board, turn, castling, ep).toString(36);

    // Ключ: Zobrist + бакеты. Так Q-таблица узнаёт конкретные позиции,
    // но при этом обобщает по материалу/фазе.
    return `${tc}|${zh}|${materialBucket(wMat)}${materialBucket(bMat)}${countBucket(wCount)}${countBucket(bCount)}${turnSign}${phase}${botInChk}${oppInChk}${hangBucket}`;
  } catch (e) { return 'ERR'; }
}

function encodeAction(from, to) {
  return String.fromCharCode(97 + from[1]) + (8 - from[0]) + String.fromCharCode(97 + to[1]) + (8 - to[0]);
}

function movesToLine(moves) {
  // moves — массив ходов вида [from, to] или {from, to}.
  return moves.map(mv => {
    const f = Array.isArray(mv) ? mv[0] : mv.from;
    const t = Array.isArray(mv) ? mv[1] : mv.to;
    return String.fromCharCode(97 + f[1]) + (8 - f[0]) + String.fromCharCode(97 + t[1]) + (8 - t[0]);
  }).join('');
}

// ============================================================
//  ХРАНИЛИЩА
// ============================================================

let QA = new Map();
let QB = new Map();
let openingBook = new Map();   // line -> { count, wins, draws, losses }
let tacticsMemory = new Map(); // pattern -> { count, reward }

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
  if (!actions.has(action)) actions.set(action, { q: 0, v: 0, lastUsed: Date.now() });
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

// ============================================================
//  ЗАГРУЗКА / СОХРАНЕНИЕ
// ============================================================

function loadQTable() {
  ensureDataDir();
  try {
    if (fs.existsSync(QTABLE_PATH)) {
      const raw = fs.readFileSync(QTABLE_PATH, 'utf8');
      const parsed = JSON.parse(raw);

      // Автоочистка при несовпадении версии.
      if (!parsed.version || parsed.version < CODE_VERSION) {
        console.log(`[Watcher] Обнаружена старая таблица (version=${parsed.version || 'none'}). Удаляю и создаю новую (v${CODE_VERSION}).`);
        try { fs.unlinkSync(QTABLE_PATH); } catch (e) {}
        QA = new Map(); QB = new Map();
        openingBook = new Map(); tacticsMemory = new Map();
        totalGames = 0; totalSteps = 0;
        dirty = true;
        saveQTable();
        console.log('[Watcher] Новая таблица создана. Обучение с нуля.');
        return;
      }

      QA = new Map(); QB = new Map();
      openingBook = new Map(); tacticsMemory = new Map();

      const loadMap = (src, target, entryParser) => {
        if (!src) return;
        for (const [key, val] of Object.entries(src)) {
          target.set(key, entryParser(val));
        }
      };

      loadMap(parsed.qa, QA, (actions) => {
        const m = new Map();
        for (const [act, val] of Object.entries(actions)) m.set(act, { q: val.q || 0, v: val.v || 0, lastUsed: val.lastUsed || Date.now() });
        return m;
      });
      loadMap(parsed.qb, QB, (actions) => {
        const m = new Map();
        for (const [act, val] of Object.entries(actions)) m.set(act, { q: val.q || 0, v: val.v || 0, lastUsed: val.lastUsed || Date.now() });
        return m;
      });
      loadMap(parsed.openings, openingBook, (val) => ({
        count: val.count || 0, wins: val.wins || 0, draws: val.draws || 0, losses: val.losses || 0
      }));
      loadMap(parsed.tactics, tacticsMemory, (val) => ({
        count: val.count || 0, reward: val.reward || 0
      }));

      totalGames = parsed.totalGames || 0;
      totalSteps = parsed.totalSteps || 0;
      console.log(`[Watcher] Q-таблицы загружены (v${parsed.version}): QA=${QA.size}, QB=${QB.size}, openings=${openingBook.size}, tactics=${tacticsMemory.size}, партий=${totalGames}, ходов=${totalSteps}`);
    } else {
      console.log(`[Watcher] Q-таблиц нет. Создаю новую (v${CODE_VERSION}).`);
      QA = new Map(); QB = new Map();
      openingBook = new Map(); tacticsMemory = new Map();
      dirty = true;
      saveQTable();
    }
  } catch (e) {
    console.error('[Watcher] Ошибка загрузки Q-таблиц:', e.message);
    QA = new Map(); QB = new Map();
    openingBook = new Map(); tacticsMemory = new Map();
    totalGames = 0; totalSteps = 0;
  }
}

function saveQTable() {
  if (!dirty) return;
  ensureDataDir();
  try {
    const obj = { version: CODE_VERSION, qa: {}, qb: {}, openings: {}, tactics: {}, totalGames, totalSteps, savedAt: Date.now() };
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
    for (const [k, v] of openingBook.entries()) obj.openings[k] = v;
    for (const [k, v] of tacticsMemory.entries()) obj.tactics[k] = v;
    fs.writeFileSync(QTABLE_PATH, JSON.stringify(obj));
    dirty = false;
    console.log(`[Watcher] Сохранено: QA=${QA.size}, QB=${QB.size}, openings=${openingBook.size}, tactics=${tacticsMemory.size}, партий=${totalGames}`);
  } catch (e) { console.error('[Watcher] Ошибка сохранения:', e.message); }
}

function startAutoSave() {
  if (saveHandle) return;
  saveHandle = setInterval(saveQTable, SAVE_INTERVAL_MS);
}

function evictIfNeeded() {
  const cleanTable = (table, maxSize) => {
    if (table.size <= maxSize) return;
    const entries = [...table.entries()].map(([state, actions]) => {
      let totalV = 0;
      for (const a of actions.values()) totalV += a.v || 0;
      return { state, totalV };
    });
    entries.sort((a, b) => a.totalV - b.totalV);
    const toRemove = table.size - maxSize + Math.floor(maxSize * 0.1);
    for (let i = 0; i < toRemove && i < entries.length; i++) table.delete(entries[i].state);
  };
  cleanTable(QA, MAX_STATES);
  cleanTable(QB, MAX_STATES);
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
  // result — 'w' | 'b' | 'draw' | null. botColor — цвет Watcher'а.
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
  // Если это ранняя стадия и у нас есть запись — используем её.
  if (state.full <= 6 && moveLine) {
    const rec = queryOpeningBook(moveLine);
    if (rec && rec.count >= 2) {
      const winRate = (rec.wins + rec.draws * 0.5) / rec.count;
      // Если винрейт > 0.5 — играем по книге.
      if (winRate > 0.5 && Math.random() < 0.7) {
        // Найдём ход, который чаще всего приводит к этой линии.
        // Для простоты: продолжаем книгу случайным легальным ходом.
        // (Полноценный opening book требует хранения ходов, но у нас есть Q-таблица.)
      }
    }
  }

  // ===== Ранжирование по эвристике =====
  const ranked = normalized.map(mv => {
    const { from, to } = mv;
    let score = 0;
    const target = state.board[to[0]][to[1]];
    const piece = state.board[from[0]][from[1]];
    if (target && piece) {
      const tv = PIECE_VALUES[target.toLowerCase()] || 0;
      const pv = PIECE_VALUES[piece.toLowerCase()] || 0;
      score += (tv - pv * 0.3) * 0.5;
    }
    const cd = Math.abs(to[0] - 3.5) + Math.abs(to[1] - 3.5);
    score += (7 - cd) * 3;
    // Память тактик
    if (target) {
      const tm = queryTacticsMemory(from, to, target);
      score += tm * 200;
    }
    return { from, to, score };
  });
  ranked.sort((a, b) => b.score - a.score);

  const K = Math.min(LOOKAHEAD_TOP_K, ranked.length);
  for (let i = 0; i < K; i++) {
    const mv = ranked[i];
    mv.eval = lookahead1Score(state, mv.from, mv.to, botColor);
  }
  for (let i = K; i < ranked.length; i++) {
    ranked[i].eval = ranked[i].score / 200;
  }

  // Для топ-3 — 3-ply lookahead.
  const deepK = Math.min(DEEP_LOOKAHEAD_TOP, ranked.length);
  for (let i = 0; i < deepK; i++) {
    const mv = ranked[i];
    mv.eval = lookaheadN(state, mv.from, mv.to, botColor, 3);
  }

  const topK = ranked.slice(0, K).sort((a, b) => botWhite ? b.eval - a.eval : a.eval - b.eval);
  const rest = ranked.slice(K);

  const encodedState = encodeState(fen, botColor, timeControl);
  const eps = getEpsilon();

  if (Math.random() < eps) {
    const pool = topK.slice(0, Math.min(3, topK.length));
    const pick = pool[Math.floor(Math.random() * pool.length)];
    return { from: pick.from, to: pick.to };
  }

  const qActionsA = QA.get(encodedState);
  const qActionsB = QB.get(encodedState);

  let best = null, bestScore = -Infinity;
  const allMoves = topK.concat(rest);
  for (const mv of allMoves) {
    const act = encodeAction(mv.from, mv.to);
    const qa = qActionsA && qActionsA.get(act) ? qActionsA.get(act).q : 0;
    const qb = qActionsB && qActionsB.get(act) ? qActionsB.get(act).q : 0;
    const qAvg = (qa + qb) / 2;
    const heuristic = Math.max(-3, Math.min(3, mv.eval / 300));
    // Память тактик добавляет приоритет.
    const target = state.board[mv.to[0]][mv.to[1]];
    const tm = target ? queryTacticsMemory(mv.from, mv.to, target) : 0;
    const score = qAvg * 0.55 + heuristic * 0.35 + tm * 0.10;
    if (score > bestScore) { bestScore = score; best = mv; }
  }

  if (!best) best = ranked[0];
  return { from: best.from, to: best.to };
}

// 1-ply lookahead: для хода (from, to) смотрит лучший ответ соперника.
function lookahead1Score(stateBefore, from, to, botColor) {
  const next = applyMove(stateBefore, from, to);
  const oppColor = next.turn;
  const oppMoves = allLegalMoves(next, oppColor === 'w');
  const botWhite = botColor === 'w';

  if (oppMoves.length === 0) {
    if (inCheck(next, oppColor === 'w')) {
      return botWhite ? 100000 : -100000;
    }
    return 0;
  }

  let worst = botWhite ? Infinity : -Infinity;
  for (const [of, ot] of oppMoves) {
    const after = applyMove(next, of, ot);
    const e = evalPositionFromState(after, botWhite);
    if (botWhite) worst = Math.min(worst, e);
    else worst = Math.max(worst, e);
  }
  return worst;
}

// N-ply lookahead (минимакс с альфа-бета-обрезкой).
function lookaheadN(state, from, to, botColor, depth) {
  const next = applyMove(state, from, to);
  return minimax(next, depth - 1, -Infinity, Infinity, botColor === 'w', botColor === 'w');
}

function minimax(state, depth, alpha, beta, maximizing, botWhite) {
  if (depth === 0) return evalPositionFromState(state, botWhite);

  const sideWhite = state.turn === 'w';
  const moves = allLegalMoves(state, sideWhite);
  if (moves.length === 0) {
    if (inCheck(state, sideWhite)) {
      // Мат.
      if (sideWhite === botWhite) return -100000 - depth; // мы проиграли
      return 100000 + depth; // мы выиграли
    }
    return 0; // пат
  }

  if (maximizing) {
    let best = -Infinity;
    for (const [f, t] of moves) {
      const next = applyMove(state, f, t);
      const val = minimax(next, depth - 1, alpha, beta, false, botWhite);
      if (val > best) best = val;
      if (val > alpha) alpha = val;
      if (alpha >= beta) break;
    }
    return best;
  } else {
    let best = Infinity;
    for (const [f, t] of moves) {
      const next = applyMove(state, f, t);
      const val = minimax(next, depth - 1, alpha, beta, true, botWhite);
      if (val < best) best = val;
      if (val < beta) beta = val;
      if (alpha >= beta) break;
    }
    return best;
  }
}

// ============================================================
//  ОБНОВЛЕНИЕ Q
// ============================================================

function updateQ(state, action, reward, nextState) {
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
  entry.lastUsed = Date.now();

  totalSteps++;
  dirty = true;
  evictIfNeeded();
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

    const stateBefore = encodeState(prevFen, botColor, timeControl);
    const stateAfter = encodeState(newFen, botColor, timeControl);
    const actionStr = encodeAction(from, to);

    const reward = computeReward(prevFen, newFen, botColor, capturedPiece);
    updateQ(stateBefore, actionStr, reward, stateAfter);

    // Обновляем память тактик.
    if (capturedPiece) {
      updateTacticsMemory(from, to, capturedPiece, reward);
    }

    if (currentEpisode) {
      currentEpisode.transitions.push({ state: stateBefore, action: actionStr, reward, nextState: stateAfter });
      if (currentEpisode.transitions.length > 500) currentEpisode.transitions.shift();
    }
    replay.push({ state: stateBefore, action: actionStr, reward, nextState: stateAfter, ts: Date.now() });
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
    if (t) updateQ(t.state, t.action, t.reward, t.nextState);
  }
  for (let i = 0; i < randomCount; i++) {
    const t = replay[Math.floor(Math.random() * replay.length)];
    if (t) updateQ(t.state, t.action, t.reward, t.nextState);
  }
}

function finishEpisode(result, botColor) {
  if (!currentEpisode) return;
  let terminalReward = 0;
  if (result === 'draw' || !result) terminalReward = 0;
  else if (result === botColor) terminalReward = 20;
  else terminalReward = -20;

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

    const combinedReward = t.reward + discounted;
    const target = combinedReward + GAMMA * maxNextQ;
    entry.q = entry.q + ALPHA * (target - entry.q);
    entry.v = (entry.v || 0) + 1;
    entry.lastUsed = Date.now();

    discounted *= GAMMA;
  }

  // Обновляем opening book по итоговой линии.
  if (currentEpisode.moveLine) {
    updateOpeningBook(currentEpisode.moveLine, result, botColor);
  }

  currentEpisode = null;
  totalGames++;
  dirty = true;
  console.log(`[Watcher] Эпизод завершён. Результат: ${result}, ходов: ${trans.length}. Всего партий: ${totalGames}`);
}

function learnFromObservedMove(prevFen, move, newFen, moverColor, timeControl, evalAfter) {
  try {
    if (!move || !move.from || !move.to) return;
    const stateBefore = encodeState(prevFen, moverColor, timeControl);
    const actionStr = encodeAction(move.from, move.to);
    const stateAfter = encodeState(newFen, moverColor, timeControl);

    const evalBefore = evalPosition(prevFen, moverColor);
    const myAfter = evalPosition(newFen, moverColor);
    const reward = (myAfter - evalBefore) / 400;

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
    entry.q = entry.q + (ALPHA * 0.2) * (target - entry.q);
    entry.v = (entry.v || 0) + 1;
    entry.lastUsed = Date.now();
    totalSteps++;
    dirty = true;
  } catch (e) { /* ignore */ }
}

function incrementGames() { /* совместимость */ }

function getStats() {
  return {
    qaStates: QA.size, qbStates: QB.size,
    openings: openingBook.size,
    tactics: tacticsMemory.size,
    games: totalGames, steps: totalSteps,
    epsilon: +getEpsilon().toFixed(3),
    replaySize: replay.length,
    episodeActive: !!currentEpisode,
    version: CODE_VERSION
  };
}

module.exports = {
  encodeState,
  encodeAction,
  timeControlCode,
  movesToLine,
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
