'use strict';

let DATA = {
  version: 4,
  weights: {},
  games: 0,
  wins: 0,
  losses: 0,
  draws: 0,
  lastUpdate: 0,
};

const PST_START = {
  P: [
     0,  0,  0,  0,  0,  0,  0,  0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
     5,  5, 10, 25, 25, 10,  5,  5,
     0,  0,  0, 20, 20,  0,  0,  0,
     5, -5,-10,  0,  0,-10, -5,  5,
     5, 10, 10,-20,-20, 10, 10,  5,
     0,  0,  0,  0,  0,  0,  0,  0,
  ],
  N: [
    -50,-40,-30,-30,-30,-30,-40,-50,
    -40,-20,  0,  0,  0,  0,-20,-40,
    -30,  0, 10, 15, 15, 10,  0,-30,
    -30,  5, 15, 20, 20, 15,  5,-30,
    -30,  0, 15, 20, 20, 15,  0,-30,
    -30,  5, 10, 15, 15, 10,  5,-30,
    -40,-20,  0,  5,  5,  0,-20,-40,
    -50,-40,-30,-30,-30,-30,-40,-50,
  ],
  B: [
    -20,-10,-10,-10,-10,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5, 10, 10,  5,  0,-10,
    -10,  5,  5, 10, 10,  5,  5,-10,
    -10,  0, 10, 10, 10, 10,  0,-10,
    -10, 10, 10, 10, 10, 10, 10,-10,
    -10,  5,  0,  0,  0,  0,  5,-10,
    -20,-10,-10,-10,-10,-10,-10,-20,
  ],
  R: [
     0,  0,  0,  0,  0,  0,  0,  0,
     5, 10, 10, 10, 10, 10, 10,  5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
     0,  0,  0,  5,  5,  0,  0,  0,
  ],
  Q: [
    -20,-10,-10, -5, -5,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5,  5,  5,  5,  0,-10,
     -5,  0,  5,  5,  5,  5,  0, -5,
      0,  0,  5,  5,  5,  5,  0, -5,
    -10,  5,  5,  5,  5,  5,  0,-10,
    -10,  0,  5,  0,  0,  0,  0,-10,
    -20,-10,-10, -5, -5,-10,-10,-20,
  ],
  K: [
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

function initWeights() {
  const files = 'abcdefgh';
  const pieces = ['P','N','B','R','Q','K','p','n','b','r','q','k'];
  DATA.weights = {};
  for (const p of pieces) {
    const upper = p.toUpperCase();
    const table = PST_START[upper];
    const isWhitePiece = p === upper;
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const sq = `${files[c]}${8 - r}`;
      const idx = isWhitePiece ? r * 8 + c : (7 - r) * 8 + c;
      DATA.weights[`${p}_${sq}`] = (table[idx] || 0) / 100;
    }
  }
}

// ==================== POSTGRES ====================
let _pool = null;
function setPool(pool) { _pool = pool; }

async function ensureTables() {
  if (!_pool) return;
  await _pool.query(`CREATE TABLE IF NOT EXISTS watcher_weights (key TEXT PRIMARY KEY, value REAL NOT NULL DEFAULT 0);`);
  await _pool.query(`CREATE TABLE IF NOT EXISTS watcher_stats (id INTEGER PRIMARY KEY DEFAULT 1, games INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, draws INTEGER NOT NULL DEFAULT 0, last_update BIGINT NOT NULL DEFAULT 0);`);
  await _pool.query(`INSERT INTO watcher_stats (id, games, wins, losses, draws, last_update) VALUES (1, 0, 0, 0, 0, 0) ON CONFLICT (id) DO NOTHING;`);
}

async function loadFromDB() {
  if (!_pool) { initWeights(); return; }
  try {
    await ensureTables();
    const wRes = await _pool.query('SELECT key, value FROM watcher_weights');
    if (wRes.rows.length === 0) {
      initWeights();
      await saveToDB();
      console.log('[Watcher] Создал PST-веса в БД');
    } else {
      DATA.weights = {};
      for (const row of wRes.rows) DATA.weights[row.key] = Number(row.value);
      let restored = 0;
      for (const p of ['P','N','B','R','Q','K','p','n','b','r','q','k']) {
        for (const f of 'abcdefgh') for (let n = 1; n <= 8; n++) {
          const key = `${p}_${f}${n}`;
          if (typeof DATA.weights[key] !== 'number') { DATA.weights[key] = 0; restored++; }
        }
      }
      if (restored) await saveToDB();
    }
    const sRes = await _pool.query('SELECT games, wins, losses, draws FROM watcher_stats WHERE id = 1');
    if (sRes.rows.length) {
      const r = sRes.rows[0];
      DATA.games = r.games; DATA.wins = r.wins; DATA.losses = r.losses; DATA.draws = r.draws;
    }
    console.log(`[Watcher] Загружено из БД: ${DATA.games} партий, W/L/D = ${DATA.wins}/${DATA.losses}/${DATA.draws}`);
  } catch (e) {
    console.error('[Watcher] Ошибка загрузки из БД:', e.message);
    initWeights();
  }
}

async function saveToDB() {
  if (!_pool) return;
  try {
    const entries = Object.entries(DATA.weights);
    if (entries.length) {
      const BATCH = 100;
      for (let i = 0; i < entries.length; i += BATCH) {
        const chunk = entries.slice(i, i + BATCH);
        const values = [];
        const params = [];
        chunk.forEach(([k, v], idx) => {
          params.push(`($${idx * 2 + 1}, $${idx * 2 + 2})`);
          values.push(k, Number(v));
        });
        await _pool.query(`INSERT INTO watcher_weights (key, value) VALUES ${params.join(',')} ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, values);
      }
    }
    await _pool.query(`UPDATE watcher_stats SET games = $1, wins = $2, losses = $3, draws = $4, last_update = $5 WHERE id = 1`, [DATA.games, DATA.wins, DATA.losses, DATA.draws, Date.now()]);
    DATA.lastUpdate = Date.now();
  } catch (e) {
    console.error('[Watcher] Ошибка сохранения в БД:', e.message);
  }
}

async function reloadFromDB() {
  if (!_pool) return;
  try {
    const wRes = await _pool.query('SELECT key, value FROM watcher_weights');
    if (wRes.rows.length) {
      DATA.weights = {};
      for (const row of wRes.rows) DATA.weights[row.key] = Number(row.value);
    }
    const sRes = await _pool.query('SELECT games, wins, losses, draws FROM watcher_stats WHERE id = 1');
    if (sRes.rows.length) {
      const r = sRes.rows[0];
      DATA.games = r.games; DATA.wins = r.wins; DATA.losses = r.losses; DATA.draws = r.draws;
    }
  } catch (e) {}
}

let autoSaveTimer = null;
function startAutoSave() {
  if (autoSaveTimer) return;
  autoSaveTimer = setInterval(() => { saveToDB().catch(() => {}); }, 2 * 60 * 1000);
}

// ==================== ШАХМАТЫ ====================
const PIECE_VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };
const MATE_SCORE = 100000;
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

function sqName(r, c) { return String.fromCharCode(97 + c) + (8 - r); }

// ============================================================
// 🔥 ОЦЕНКА (с эндшпилем, БЕЗ спорного бонуса за шах)
// ============================================================
function evaluate(state, forWhite) {
  let score = 0;
  let whitePieces = 0, blackPieces = 0;
  let whiteKing = null, blackKing = null;
  
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p) continue;
    const isW = isWhite(p);
    const material = PIECE_VALUES[p.toLowerCase()] || 0;
    const w = DATA.weights[`${p}_${sqName(r, c)}`] || 0;
    score += isW ? (material + w * 100) : -(material + w * 100);
    
    if (p === 'K') whiteKing = [r, c];
    if (p === 'k') blackKing = [r, c];
    if (p !== 'K' && p !== 'k') { if (isW) whitePieces++; else blackPieces++; }
  }
  
  // 🔥 В эндшпиле (мало фигур, кроме королей)
  if (whitePieces + blackPieces <= 5) {
    if (whiteKing && blackKing) {
      const dist = Math.abs(whiteKing[0] - blackKing[0]) + Math.abs(whiteKing[1] - blackKing[1]);
      score += (14 - dist) * 15; // Ближе к врагу = лучше
      
      // Оттесняем короля врага к краю
      const edgeDistB = Math.min(blackKing[0], 7 - blackKing[0], blackKing[1], 7 - blackKing[1]);
      score -= edgeDistB * 30;
      
      const edgeDistW = Math.min(whiteKing[0], 7 - whiteKing[0], whiteKing[1], 7 - whiteKing[1]);
      score += edgeDistW * 10;
    }
  }
  
  // ❌ УБРАН бонус +50 за шах. Он заставлял бота жертвовать фигуры ради пустого шаха.
  // Алгоритм поиска сам найдёт мат или вилку.
  
  return forWhite ? score : -score;
}

// ============================================================
// 🔥 QUIESCENCE (поиск взятий, с защитой от мата)
// ============================================================
function quiescence(state, alpha, beta, color) {
  const standPat = evaluate(state, color === 1);
  if (standPat >= beta) return beta;
  if (alpha < standPat) alpha = standPat;

  const legal = allLegalMoves(state, color === 1);
  
  // 🔥 Если ходов нет (мат или пат) — возвращаем соответствующую оценку
  if (legal.length === 0) {
    if (inCheck(state, color === 1)) return -MATE_SCORE;
    return 0;
  }

  const captures = legal.filter(([from, to]) => state.board[to[0]][to[1]]);
  
  // 🔥 MVV-LVA сортировка для quiescence (пешка бьёт ферзя важнее, чем ферзь бьёт пешку)
  captures.sort((a, b) => {
    const attackerA = state.board[a[0][0]][a[0][1]].toLowerCase();
    const victimA = state.board[a[1][0]][a[1][1]].toLowerCase();
    const scoreA = (PIECE_VALUES[victimA] || 0) * 10 - (PIECE_VALUES[attackerA] || 0);
    
    const attackerB = state.board[b[0][0]][b[0][1]].toLowerCase();
    const victimB = state.board[b[1][0]][b[1][1]].toLowerCase();
    const scoreB = (PIECE_VALUES[victimB] || 0) * 10 - (PIECE_VALUES[attackerB] || 0);
    return scoreB - scoreA;
  });

  for (const [from, to] of captures) {
    const next = applyMove(state, from, to);
    const score = -quiescence(next, -beta, -alpha, -color);
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

function negamax(state, depth, alpha, beta, color, deadline) {
  if (Date.now() >= deadline) return evaluate(state, color === 1);

  const legal = allLegalMoves(state, color === 1);
  if (legal.length === 0) {
    if (inCheck(state, color === 1)) return -MATE_SCORE + (10 - depth);
    return 0;
  }

  if (depth === 0) return quiescence(state, alpha, beta, color);

  let best = -Infinity;
  for (const [from, to] of legal) {
    const next = applyMove(state, from, to);
    const score = -negamax(next, depth - 1, -beta, -alpha, -color, deadline);
    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
    if (Date.now() >= deadline) break;
  }
  return best;
}

// ============================================================
// 🔥 MOVE ORDERING (MVV-LVA) — главное улучшение!
// ============================================================
function moveScore(state, from, to) {
  const attacker = state.board[from[0]][from[1]];
  const victim = state.board[to[0]][to[1]];
  let score = 0;

  // 1. Взятия — самое главное
  if (victim) {
    const attackerVal = PIECE_VALUES[attacker.toLowerCase()] || 0;
    const victimVal = PIECE_VALUES[victim.toLowerCase()] || 0;
    // MVV-LVA: чем ценнее жертва и чем дешевле наш нападающий — тем выше приоритет
    score += 10000 + victimVal * 10 - attackerVal;
  }

  // 2. Превращение пешки в ферзя
  if (attacker.toLowerCase() === 'p' && (to[0] === 0 || to[0] === 7)) {
    score += 9000;
  }

  // 3. Ходы, которые дают шах (проверяем, но это дорого — поэтому только базово)
  // Вместо полной проверки, просто отдаем приоритет ходам на поле вражеского короля
  const oppKingChar = attacker === attacker.toUpperCase() ? 'k' : 'K';
  let oppKingPos = null;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    if (state.board[r][c] === oppKingChar) { oppKingPos = [r, c]; break; }
  }
  if (oppKingPos) {
    const dist = Math.abs(to[0] - oppKingPos[0]) + Math.abs(to[1] - oppKingPos[1]);
    if (dist <= 2) score += 100; // Близость к вражескому королю
  }

  return score;
}

function pickMoveSearch(state, isWhiteTurn, timeMs) {
  const legal = allLegalMoves(state, isWhiteTurn);
  if (legal.length === 0) return null;
  if (legal.length === 1) return legal[0];

  // 🔥 Небольшая случайность в начале, чтобы не было детерминизма
  for (let i = legal.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [legal[i], legal[j]] = [legal[j], legal[i]];
  }

  const color = isWhiteTurn ? 1 : -1;
  const deadline = Date.now() + Math.max(50, timeMs);

  let bestMove = legal[0];
  let maxDepth = 6;

  for (let depth = 1; depth <= maxDepth; depth++) {
    let alpha = -Infinity, beta = Infinity;
    let localBest = null, localBestScore = -Infinity;

    // 🔥 НОВАЯ СОРТИРОВКА: MVV-LVA + превращение + близость к королю
    // Стабильная сортировка (сортирует только на текущей итерации)
    const ordered = legal.slice().sort((a, b) => {
      return moveScore(state, b[0], b[1]) - moveScore(state, a[0], a[1]);
    });

    for (const [from, to] of ordered) {
      if (Date.now() >= deadline) break;
      const next = applyMove(state, from, to);
      const score = -negamax(next, depth - 1, -beta, -alpha, -color, deadline);
      if (score > localBestScore) { localBestScore = score; localBest = [from, to]; }
      if (score > alpha) alpha = score;
    }

    if (localBest && Date.now() < deadline) bestMove = localBest;
    if (Date.now() >= deadline) break;
  }

  return bestMove;
}

// ============================================================
// 🔥 SELF-PLAY С АНТИПОВТОРЕНИЕМ
// ============================================================
function playSelfPlayGame() {
  let state = parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  const history = [];
  const moveLog = [];
  const positionCounts = new Map();
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
    
    // 🔥 Троекратное повторение = ничья
    const key = toFen(state).split(' ').slice(0, 4).join(' ');
    const count = (positionCounts.get(key) || 0) + 1;
    positionCounts.set(key, count);
    if (count >= 3) { result = 0; break; }

    const isW = state.turn === 'w';
    const mv = pickMoveSearch(state, isW, 80);
    if (!mv) break;

    const pieceMoved = state.board[mv[0][0]][mv[0][1]];
    const captured = state.board[mv[1][0]][mv[1][1]];
    const nextState = applyMove(state, mv[0], mv[1]);
    const causedCheck = inCheck(nextState, !isW);
    const isMate = causedCheck && allLegalMoves(nextState, !isW).length === 0;

    history.push({ white: isW, pieceMoved, captured, sqFrom: sqName(mv[0][0], mv[0][1]), sqTo: sqName(mv[1][0], mv[1][1]), causedCheck, isMate });
    state = nextState;

    moveLog.push({
      from: mv[0],
      to: mv[1],
      byColor: isW ? 'w' : 'b',
      fenAfter: toFen(state)
    });
  }

  trainOnHistory(history, result);

  DATA.games++;
  if (result === 1) DATA.wins++;
  else if (result === -1) DATA.losses++;
  else DATA.draws++;

  return { result, moveLog };
}

// ============================================================
// ОБУЧЕНИЕ
// ============================================================
function trainOnHistory(history, result) {
  if (history.length === 0) return;
  const lr = 0.005;

  let whiteReward, blackReward;
  if (result === 1) { whiteReward = 1; blackReward = -1; }
  else if (result === -1) { whiteReward = -1; blackReward = 1; }
  else { whiteReward = 0.1; blackReward = 0.1; }

  for (const move of history) {
    const reward = move.white ? whiteReward : blackReward;
    const side = move.white ? 1 : -1;

    const checkBonus = move.causedCheck ? 0.05 : 0;
    const mateBonus = move.isMate ? 0.5 : 0;
    const total = reward + checkBonus + mateBonus;

    const keyFrom = `${move.pieceMoved}_${move.sqFrom}`;
    const keyTo = `${move.pieceMoved}_${move.sqTo}`;
    if (typeof DATA.weights[keyTo] !== 'number') DATA.weights[keyTo] = 0;
    if (typeof DATA.weights[keyFrom] !== 'number') DATA.weights[keyFrom] = 0;

    DATA.weights[keyTo] = Math.max(-2, Math.min(2, DATA.weights[keyTo] + lr * side * total));
    DATA.weights[keyFrom] = Math.max(-2, Math.min(2, DATA.weights[keyFrom] - lr * side * total * 0.3));
  }
}

// ============================================================
// API
// ============================================================
function getStats() {
  return {
    games: DATA.games, wins: DATA.wins, losses: DATA.losses, draws: DATA.draws,
    episodeActive: false,
  };
}

function pickMoveForServer(fen, color, timeInfo, availableMoves, line) {
  const state = parseFen(fen);
  const myTime = timeInfo.time || 5;

  let thinkMs;
  if (myTime < 2) thinkMs = 50;
  else if (myTime < 5) thinkMs = 150;
  else if (myTime < 10) thinkMs = 300;
  else if (myTime < 30) thinkMs = 800;
  else thinkMs = 1500;
  thinkMs = Math.min(thinkMs, myTime * 1000 * 0.1);

  const move = pickMoveSearch(state, color === 'w', thinkMs);
  if (!move) return null;
  return { from: move[0], to: move[1] };
}

function startEpisode() {}
function recordTransition() {}
function learnFromObservedMove() {}
function finishEpisode() {}
function loadWeights() { return loadFromDB(); }
function saveWeights() { return saveToDB(); }
function reloadWeights() { return reloadFromDB(); }

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
  playSelfPlayGame,
  saveData: saveToDB,
  reloadWeights,
  setPool,
};
