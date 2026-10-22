'use strict';

// ============================================================
// DATA / PERSISTENCE
// ============================================================
let DATA = {
  version: 5,
  weights: {},          // PST-веса (только чтение; не обучаем)
  params: {             // обучаемые скалярные параметры
    doubledPawn: 10,
    isolatedPawn: 15,
    passedPawnBase: 20,
    bishopPair: 30,
    kingShield: 10,
    openFileRook: 25,
    mobility: 2,
    tempo: 10,
  },
  games: 0,
  wins: 0,
  losses: 0,
  draws: 0,
  lastUpdate: 0,
};

const PST_START = {
  P: [0,0,0,0,0,0,0,0, 50,50,50,50,50,50,50,50, 10,10,20,30,30,20,10,10, 5,5,10,25,25,10,5,5, 0,0,0,20,20,0,0,0, 5,-5,-10,0,0,-10,-5,5, 5,10,10,-20,-20,10,10,5, 0,0,0,0,0,0,0,0],
  N: [-50,-40,-30,-30,-30,-30,-40,-50, -40,-20,0,0,0,0,-20,-40, -30,0,10,15,15,10,0,-30, -30,5,15,20,20,15,5,-30, -30,0,15,20,20,15,0,-30, -30,5,10,15,15,10,5,-30, -40,-20,0,5,5,0,-20,-40, -50,-40,-30,-30,-30,-30,-40,-50],
  B: [-20,-10,-10,-10,-10,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,10,10,5,0,-10, -10,5,5,10,10,5,5,-10, -10,0,10,10,10,10,0,-10, -10,10,10,10,10,10,10,-10, -10,5,0,0,0,0,5,-10, -20,-10,-10,-10,-10,-10,-10,-20],
  R: [0,0,0,0,0,0,0,0, 5,10,10,10,10,10,10,5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, 0,0,0,5,5,0,0,0],
  Q: [-20,-10,-10,-5,-5,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,5,5,5,0,-10, -5,0,5,5,5,5,0,-5, 0,0,5,5,5,5,0,-5, -10,5,5,5,5,5,0,-10, -10,0,5,0,0,0,0,-10, -20,-10,-10,-5,-5,-10,-10,-20],
  K: [-30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -20,-30,-30,-40,-40,-30,-30,-20, -10,-20,-20,-20,-20,-20,-20,-10, 20,20,0,0,0,0,20,20, 20,30,10,0,0,10,30,20],
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

// ============================================================
// POSTGRES
// ============================================================
let _pool = null;
const mistakeMemory = new Map();
const MAX_MISTAKES = 6000;

function setPool(pool) { _pool = pool; }
function positionKey(fen) { return String(fen || '').split(' ').slice(0, 4).join(' '); }
function mistakeKey(pos, from, to) { return `${pos}|${from}|${to}`; }
function squareFromRC(sq) { return sqName(sq[0], sq[1]); }

function recordMistake(pos, from, to, penalty) {
  if (!pos || !from || !to || !(penalty > 0)) return;
  const key = mistakeKey(pos, from, to);
  const old = mistakeMemory.get(key) || { penalty: 0, seen: 0, updated: 0 };
  old.penalty = Math.min(1800, Math.max(old.penalty, penalty));
  old.seen += 1; old.updated = Date.now();
  mistakeMemory.set(key, old);
  if (mistakeMemory.size > MAX_MISTAKES) {
    const oldest = [...mistakeMemory.entries()]
      .sort((a, b) => a[1].updated - b[1].updated)
      .slice(0, mistakeMemory.size - MAX_MISTAKES);
    for (const [k] of oldest) mistakeMemory.delete(k);
  }
  if (_pool) {
    _pool.query(`INSERT INTO watcher_tactical_mistakes (position_key, from_sq, to_sq, penalty, seen, updated_at)
      VALUES ($1,$2,$3,$4,1,$5)
      ON CONFLICT (position_key, from_sq, to_sq) DO UPDATE SET
      penalty = GREATEST(watcher_tactical_mistakes.penalty, EXCLUDED.penalty),
      seen = watcher_tactical_mistakes.seen + 1, updated_at = EXCLUDED.updated_at`,
      [pos, from, to, old.penalty, old.updated])
      .catch(e => console.error('[Watcher] Ошибка сохранения тактической ошибки:', e.message));
  }
}

async function ensureTables() {
  if (!_pool) return;
  await _pool.query(`CREATE TABLE IF NOT EXISTS watcher_weights (key TEXT PRIMARY KEY, value REAL NOT NULL DEFAULT 0);`);
  await _pool.query(`CREATE TABLE IF NOT EXISTS watcher_stats (id INTEGER PRIMARY KEY DEFAULT 1, games INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, draws INTEGER NOT NULL DEFAULT 0, last_update BIGINT NOT NULL DEFAULT 0);`);
  await _pool.query(`CREATE TABLE IF NOT EXISTS watcher_tactical_mistakes (position_key TEXT NOT NULL, from_sq TEXT NOT NULL, to_sq TEXT NOT NULL, penalty REAL NOT NULL DEFAULT 0, seen INTEGER NOT NULL DEFAULT 1, updated_at BIGINT NOT NULL DEFAULT 0, PRIMARY KEY(position_key, from_sq, to_sq));`);
  await _pool.query(`CREATE TABLE IF NOT EXISTS watcher_params (key TEXT PRIMARY KEY, value REAL NOT NULL DEFAULT 0);`);
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
    const pRes = await _pool.query('SELECT key, value FROM watcher_params');
    for (const row of pRes.rows) {
      if (typeof DATA.params[row.key] === 'number') DATA.params[row.key] = Number(row.value);
    }
    const mRes = await _pool.query('SELECT position_key, from_sq, to_sq, penalty, seen, updated_at FROM watcher_tactical_mistakes ORDER BY updated_at DESC LIMIT $1', [MAX_MISTAKES]);
    mistakeMemory.clear();
    for (const row of mRes.rows) {
      mistakeMemory.set(mistakeKey(row.position_key, row.from_sq, row.to_sq), {
        penalty: Number(row.penalty) || 0,
        seen: Number(row.seen) || 1,
        updated: Number(row.updated_at) || 0
      });
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
    const pEntries = Object.entries(DATA.params);
    if (pEntries.length) {
      const params = [];
      const values = [];
      pEntries.forEach(([k, v], idx) => {
        params.push(`($${idx * 2 + 1}, $${idx * 2 + 2})`);
        values.push(k, Number(v));
      });
      await _pool.query(`INSERT INTO watcher_params (key, value) VALUES ${params.join(',')} ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, values);
    }
    await _pool.query(`UPDATE watcher_stats SET games = $1, wins = $2, losses = $3, draws = $4, last_update = $5 WHERE id = 1`,
      [DATA.games, DATA.wins, DATA.losses, DATA.draws, Date.now()]);
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

// ============================================================
// CHESS PRIMITIVES
// ============================================================
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

function sqName(r, c) { return String.fromCharCode(97 + c) + (8 - r); }

// ============================================================
// FAST isAttacked (no pseudoMoves)
// ============================================================
function isAttacked(state, r, c, byWhite) {
  const b = state.board;
  // Pawns
  const pdir = byWhite ? 1 : -1; // от атакующего к цели
  const pr = r + pdir;
  if (inBoard(pr, c - 1)) {
    const p = b[pr][c - 1];
    if (p && isWhite(p) === byWhite && p.toLowerCase() === 'p') return true;
  }
  if (inBoard(pr, c + 1)) {
    const p = b[pr][c + 1];
    if (p && isWhite(p) === byWhite && p.toLowerCase() === 'p') return true;
  }
  // Knights
  const knightDirs = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
  for (const [dr, dc] of knightDirs) {
    const rr = r + dr, cc = c + dc;
    if (!inBoard(rr, cc)) continue;
    const p = b[rr][cc];
    if (p && isWhite(p) === byWhite && p.toLowerCase() === 'n') return true;
  }
  // King
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    const rr = r + dr, cc = c + dc;
    if (!inBoard(rr, cc)) continue;
    const p = b[rr][cc];
    if (p && isWhite(p) === byWhite && p.toLowerCase() === 'k') return true;
  }
  // Sliding: rook/queen
  const rookDirs = [[-1,0],[1,0],[0,-1],[0,1]];
  for (const [dr, dc] of rookDirs) {
    let rr = r + dr, cc = c + dc;
    while (inBoard(rr, cc)) {
      const p = b[rr][cc];
      if (p) {
        if (isWhite(p) === byWhite && (p.toLowerCase() === 'r' || p.toLowerCase() === 'q')) return true;
        break;
      }
      rr += dr; cc += dc;
    }
  }
  // Sliding: bishop/queen
  const bishopDirs = [[-1,-1],[-1,1],[1,-1],[1,1]];
  for (const [dr, dc] of bishopDirs) {
    let rr = r + dr, cc = c + dc;
    while (inBoard(rr, cc)) {
      const p = b[rr][cc];
      if (p) {
        if (isWhite(p) === byWhite && (p.toLowerCase() === 'b' || p.toLowerCase() === 'q')) return true;
        break;
      }
      rr += dr; cc += dc;
    }
  }
  return false;
}

function findKing(state, white) {
  const k = white ? 'K' : 'k';
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (state.board[r][c] === k) return [r, c];
  return null;
}

function inCheck(state, white) {
  const k = findKing(state, white);
  if (!k) return false;
  return isAttacked(state, k[0], k[1], !white);
}

// ============================================================
// MOVE GENERATION
// ============================================================
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

function hasAnyLegalMove(state, white) {
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c];
    if (!p || isWhite(p) !== white) continue;
    for (const [rr, cc] of pseudoMoves(state, r, c)) {
      if (!inCheck(applyMove(state, [r, c], [rr, cc]), white)) return true;
    }
  }
  return false;
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
  if (!cast || cast === '') cast = '-';
  let ep = '-';
  if (type === 'p' && Math.abs(tr - fr) === 2) ep = String.fromCharCode(97 + fc) + (8 - (fr + (tr - fr) / 2));
  const wasCapture = !!state.board[tr][tc] || (type === 'p' && fc !== tc);
  const half = (type === 'p' || wasCapture) ? 0 : (state.half + 1);
  copy.castling = cast; copy.ep = ep; copy.turn = white ? 'b' : 'w'; copy.half = half;
  if (!white) copy.full += 1;
  return copy;
}

// ============================================================
// EVALUATION (fast: no isAttacked in hot path)
// ============================================================
const KING_ENDGAME_PST = [
  [-50,-40,-30,-20,-20,-30,-40,-50],
  [-30,-20,-10,  0,  0,-10,-20,-30],
  [-30,-10, 20, 30, 30, 20,-10,-30],
  [-30,-10, 30, 40, 40, 30,-10,-30],
  [-30,-10, 30, 40, 40, 30,-10,-30],
  [-30,-10, 20, 30, 30, 20,-10,-30],
  [-30,-30,  0,  0,  0,  0,-30,-30],
  [-50,-30,-30,-30,-30,-30,-30,-50]
];

function evaluate(state, forWhite) {
  let score = 0;
  let whitePieces = 0, blackPieces = 0;
  let whiteKing = null, blackKing = null;
  let wB = 0, bB = 0;
  const wpFile = [0,0,0,0,0,0,0,0];
  const bpFile = [0,0,0,0,0,0,0,0];
  const wPawns = [], bPawns = [];
  let totalMat = 0;

  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p) continue;
    const isW = isWhite(p);
    const t = p.toLowerCase();
    const mat = PIECE_VALUES[t] || 0;
    if (t !== 'k') totalMat += mat;
    score += isW ? mat : -mat;

    const w = DATA.weights[`${p}_${sqName(r, c)}`] || 0;
    score += isW ? w * 100 : -w * 100;

    if (p === 'K') whiteKing = [r, c];
    if (p === 'k') blackKing = [r, c];
    if (t !== 'k') { if (isW) whitePieces++; else blackPieces++; }
    if (t === 'p') {
      if (isW) { wpFile[c]++; wPawns.push([r, c]); }
      else    { bpFile[c]++; bPawns.push([r, c]); }
    }
    if (t === 'b') { if (isW) wB++; else bB++; }
  }

  const endgame = totalMat <= 2400;

  // Bishop pair
  if (wB >= 2) score += DATA.params.bishopPair;
  if (bB >= 2) score -= DATA.params.bishopPair;

  // Doubled / isolated
  for (let f = 0; f < 8; f++) {
    if (wpFile[f] > 1) score -= DATA.params.doubledPawn * (wpFile[f] - 1);
    if (bpFile[f] > 1) score += DATA.params.doubledPawn * (bpFile[f] - 1);
  }
  for (let f = 0; f < 8; f++) {
    if (wpFile[f] > 0) {
      const left = f > 0 ? wpFile[f-1] : 0;
      const right = f < 7 ? wpFile[f+1] : 0;
      if (left === 0 && right === 0) score -= DATA.params.isolatedPawn;
    }
    if (bpFile[f] > 0) {
      const left = f > 0 ? bpFile[f-1] : 0;
      const right = f < 7 ? bpFile[f+1] : 0;
      if (left === 0 && right === 0) score += DATA.params.isolatedPawn;
    }
  }

  // Passed pawns
  for (const [r, c] of wPawns) {
    let passed = true;
    for (const [br, bc] of bPawns) {
      if ((bc === c || bc === c - 1 || bc === c + 1) && br < r) { passed = false; break; }
    }
    if (passed) {
      const rank = 7 - r;
      const bonus = DATA.params.passedPawnBase + [0, 10, 20, 35, 60, 100, 160, 0][rank];
      score += bonus;
    }
  }
  for (const [r, c] of bPawns) {
    let passed = true;
    for (const [wr, wc] of wPawns) {
      if ((wc === c || wc === c - 1 || wc === c + 1) && wr > r) { passed = false; break; }
    }
    if (passed) {
      const rank = r;
      const bonus = DATA.params.passedPawnBase + [0, 10, 20, 35, 60, 100, 160, 0][rank];
      score -= bonus;
    }
  }

  // Rooks on open/semi-open files
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p) continue;
    if (p.toLowerCase() !== 'r') continue;
    const isW = isWhite(p);
    const own = isW ? wpFile : bpFile;
    const opp = isW ? bpFile : wpFile;
    if (own[c] === 0 && opp[c] === 0) score += isW ? DATA.params.openFileRook : -DATA.params.openFileRook;
    else if (own[c] === 0) score += isW ? DATA.params.openFileRook * 0.5 : -DATA.params.openFileRook * 0.5;
  }

  // King safety (middlegame)
  if (!endgame) {
    if (whiteKing) {
      const [kr, kc] = whiteKing;
      let shield = 0;
      for (const dc of [-1, 0, 1]) {
        const rr = kr - 1, cc = kc + dc;
        if (inBoard(rr, cc) && state.board[rr][cc] === 'P') shield++;
      }
      score += shield * DATA.params.kingShield;
      // Penalty for central king in middlegame
      if (kc === 4 && kr >= 6) score -= 40;
      if (kr < 6) score -= 30;
    }
    if (blackKing) {
      const [kr, kc] = blackKing;
      let shield = 0;
      for (const dc of [-1, 0, 1]) {
        const rr = kr + 1, cc = kc + dc;
        if (inBoard(rr, cc) && state.board[rr][cc] === 'p') shield++;
      }
      score -= shield * DATA.params.kingShield;
      if (kc === 4 && kr <= 1) score += 40;
      if (kr > 1) score += 30;
    }
  } else {
    // Endgame: king centralization
    if (whiteKing) {
      const [kr, kc] = whiteKing;
      score += KING_ENDGAME_PST[kr][kc];
    }
    if (blackKing) {
      const [kr, kc] = blackKing;
      score -= KING_ENDGAME_PST[7 - kr][kc];
    }
    // Mate drive: push opponent king to edge
    if (whiteKing && blackKing && totalMat <= 1500) {
      const wc = whiteKing, bc = blackKing;
      const dist = Math.abs(wc[0] - bc[0]) + Math.abs(wc[1] - bc[1]);
      score += (14 - dist) * 15;
      const edgeB = Math.min(bc[0], 7 - bc[0], bc[1], 7 - bc[1]);
      score -= edgeB * 30;
    }
  }

  // Mobility (cheap: count pseudo moves)
  let wm = 0, bm = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p) continue;
    const n = pseudoMoves(state, r, c).length;
    if (isWhite(p)) wm += n; else bm += n;
  }
  score += (wm - bm) * DATA.params.mobility;

  // Tempo
  score += state.turn === 'w' ? DATA.params.tempo : -DATA.params.tempo;

  // 50-move rule
  if (state.half >= 100) score = 0;

  return forWhite ? score : -score;
}

// ============================================================
// LEARNING: mistake memory only
// ============================================================
function tacticalSafetyPenalty(state, from, to, moverWhite) {
  const piece = state.board[from[0]][from[1]];
  if (!piece) return 0;
  const next = applyMove(state, from, to);
  const moved = next.board[to[0]][to[1]];
  if (!moved) return 0;
  const value = PIECE_VALUES[moved.toLowerCase()] || 0;
  if (value < 300) return 0;
  const attacked = isAttacked(next, to[0], to[1], !moverWhite);
  if (!attacked) return 0;
  const defended = isAttacked(next, to[0], to[1], moverWhite);
  let cheapestAttacker = Infinity;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = next.board[r][c];
    if (!p || isWhite(p) !== !moverWhite) continue;
    if (pseudoMoves(next, r, c).some(([rr, cc]) => rr === to[0] && cc === to[1])) {
      cheapestAttacker = Math.min(cheapestAttacker, PIECE_VALUES[p.toLowerCase()] || 0);
    }
  }
  if (!defended) return Math.round(value * 0.88);
  if (Number.isFinite(cheapestAttacker) && cheapestAttacker < value) {
    return Math.round((value - cheapestAttacker) * 0.45);
  }
  return 0;
}

function learnedMistakePenalty(state, from, to) {
  const key = mistakeKey(positionKey(toFen(state)), sqName(from[0], from[1]), sqName(to[0], to[1]));
  const item = mistakeMemory.get(key);
  if (!item) return 0;
  const ageMs = Date.now() - (item.updated || 0);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const decay = Math.exp(-ageDays / 30);
  const seenBoost = Math.min(1.5, 1 + Math.log2(Math.max(1, item.seen)) * 0.08);
  return Math.min(1800, item.penalty * seenBoost * decay);
}

// ============================================================
// TRANSPOSITION TABLE
// ============================================================
const TT = new Map();
const TT_MAX = 500000;

function ttKeyOf(state) {
  // Компактный ключ: доска + turn + castling + ep
  let s = '';
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      s += state.board[r][c] || '.';
    }
  }
  return s + '|' + state.turn + '|' + state.castling + '|' + state.ep;
}

function ttGet(k) { return TT.get(k); }
function ttSet(k, depth, score, flag, move) {
  if (TT.size > TT_MAX) {
    let i = 0;
    for (const key of TT.keys()) { TT.delete(key); if (++i > TT_MAX / 2) break; }
  }
  TT.set(k, { depth, score, flag, move });
}

// ============================================================
// SEARCH: quiescence + negamax
// ============================================================
function quiescence(state, alpha, beta, color, qdepth) {
  if (qdepth > 6) return evaluate(state, color === 1);
  const standPat = evaluate(state, color === 1);
  if (standPat >= beta) return beta;
  if (standPat + 200 < alpha) return alpha; // delta pruning
  if (alpha < standPat) alpha = standPat;

  const isW = color === 1;
  const legal = allLegalMoves(state, isW);
  if (legal.length === 0) {
    if (inCheck(state, isW)) return -MATE_SCORE + qdepth;
    return 0;
  }

  const captures = [];
  for (const [from, to] of legal) {
    const target = state.board[to[0]][to[1]];
    const piece = state.board[from[0]][from[1]];
    if (target) captures.push([from, to]);
    else if (piece && piece.toLowerCase() === 'p' && from[1] !== to[1]) captures.push([from, to]);
  }
  captures.sort((a, b) => {
    const aP = state.board[a[0][0]][a[0][1]].toLowerCase();
    const aV = state.board[a[1][0]][a[1][1]].toLowerCase();
    const bP = state.board[b[0][0]][b[0][1]].toLowerCase();
    const bV = state.board[b[1][0]][b[1][1]].toLowerCase();
    return ((PIECE_VALUES[bV] || 0) * 10 - (PIECE_VALUES[bP] || 0)) -
           ((PIECE_VALUES[aV] || 0) * 10 - (PIECE_VALUES[aP] || 0));
  });

  for (const [from, to] of captures) {
    const next = applyMove(state, from, to);
    const score = -quiescence(next, -beta, -alpha, -color, qdepth + 1);
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

const killerMoves = [];
const historyHeuristic = new Map();

function historyKeyOf(from, to) { return from[0] + '' + from[1] + to[0] + '' + to[1]; }

function orderMoves(state, moves, ply, ttMove) {
  const scored = moves.map(([from, to]) => {
    let s = 0;
    if (ttMove && ttMove[0][0] === from[0] && ttMove[0][1] === from[1] &&
        ttMove[1][0] === to[0] && ttMove[1][1] === to[1]) s += 100000;
    const cap = state.board[to[0]][to[1]];
    const piece = state.board[from[0]][from[1]];
    if (cap) {
      s += 10000 + (PIECE_VALUES[cap.toLowerCase()] || 0) * 10 -
           (PIECE_VALUES[piece.toLowerCase()] || 0);
    }
    if (piece && piece.toLowerCase() === 'p' && (to[0] === 0 || to[0] === 7)) s += 9000;
    const hk = ply + '|' + historyKeyOf(from, to);
    s += historyHeuristic.get(hk) || 0;
    const killers = killerMoves[ply] || [];
    for (const [kf, kt] of killers) {
      if (kf[0] === from[0] && kf[1] === from[1] && kt[0] === to[0] && kt[1] === to[1]) s += 500;
    }
    return { from, to, s };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored.map(x => [x.from, x.to]);
}

let SEARCH_DEADLINE = 0;
let SEARCH_ABORTED = false;

function negamax(state, depth, alpha, beta, color, ply) {
  if (Date.now() >= SEARCH_DEADLINE) { SEARCH_ABORTED = true; return evaluate(state, color === 1); }

  const key = ttKeyOf(state);
  const cached = ttGet(key);
  const alphaOrig = alpha, betaOrig = beta;
  let ttMove = null;
  if (cached) {
    if (cached.depth >= depth) {
      if (cached.flag === 'EXACT') return cached.score;
      if (cached.flag === 'LOWER' && cached.score > alpha) alpha = cached.score;
      if (cached.flag === 'UPPER' && cached.score < beta) beta = cached.score;
      if (alpha >= beta) return cached.score;
    }
    ttMove = cached.move || null;
  }

  if (depth <= 0) return quiescence(state, alpha, beta, color, 0);

  const legal = allLegalMoves(state, color === 1);
  if (legal.length === 0) {
    if (inCheck(state, color === 1)) return -MATE_SCORE + ply;
    return 0;
  }

  const ordered = orderMoves(state, legal, ply, ttMove);

  let best = -Infinity;
  let bestMove = null;
  for (let i = 0; i < ordered.length; i++) {
    if (Date.now() >= SEARCH_DEADLINE) { SEARCH_ABORTED = true; break; }
    const [from, to] = ordered[i];
    const next = applyMove(state, from, to);
    const isCapture = !!state.board[to[0]][to[1]];
    const isQuiet = !isCapture;
    const givesCheck = inCheck(next, color !== 1);
    const isPromo = state.board[from[0]][from[1]] &&
                    state.board[from[0]][from[1]].toLowerCase() === 'p' &&
                    (to[0] === 0 || to[0] === 7);

    // Extensions
    let extension = 0;
    if (givesCheck && depth >= 3) extension = 1;
    else if (isPromo) extension = 1;

    // LMR
    let reduction = 0;
    if (isQuiet && !givesCheck && !isPromo && i >= 4 && depth >= 3) reduction = 1;

    let score;
    if (i === 0) {
      score = -negamax(next, depth - 1 + extension, -beta, -alpha, -color, ply + 1);
    } else {
      score = -negamax(next, depth - 1 + extension - reduction, -alpha - 1, -alpha, -color, ply + 1);
      if (score > alpha && score < beta) {
        // re-search with full window
        score = -negamax(next, depth - 1 + extension, -beta, -alpha, -color, ply + 1);
      }
    }

    if (SEARCH_ABORTED) break;

    if (score > best) { best = score; bestMove = [from, to]; }
    if (score > alpha) alpha = score;
    if (alpha >= beta) {
      if (isQuiet) {
        const k = killerMoves[ply] || [];
        k.unshift([from, to]);
        if (k.length > 2) k.pop();
        killerMoves[ply] = k;
        const hk = ply + '|' + historyKeyOf(from, to);
        historyHeuristic.set(hk, (historyHeuristic.get(hk) || 0) + depth * depth);
      }
      break;
    }
  }

  let flag = 'EXACT';
  if (best <= alphaOrig) flag = 'UPPER';
  else if (best >= betaOrig) flag = 'LOWER';
  ttSet(key, depth, best, flag, bestMove);

  return best;
}

// ============================================================
// OPENING BOOK (compact)
// ============================================================
const OPENING_BOOK = [
  { line: 'e2e4', weight: 40 },
  { line: 'e2e4 e7e5 g1f3', weight: 30 },
  { line: 'e2e4 e7e5 g1f3 b8c6 f1b5', weight: 20 },
  { line: 'e2e4 e7e5 g1f3 b8c6 f1c4', weight: 15 },
  { line: 'e2e4 e7e5 g1f3 b8c6 d2d4', weight: 10 },
  { line: 'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6', weight: 10 },
  { line: 'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5', weight: 10 },
  { line: 'e2e4 e7e5 g1f3 b8c6 d2d4 e5d4 f3d4', weight: 8 },
  { line: 'e2e4 e7e5 g1f3 g8f6', weight: 8 },
  { line: 'e2e4 e7e5 g1f3 d7d6', weight: 6 },
  { line: 'e2e4 c7c5', weight: 25 },
  { line: 'e2e4 c7c5 g1f3 d7d6', weight: 15 },
  { line: 'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4', weight: 12 },
  { line: 'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6', weight: 10 },
  { line: 'e2e4 c7c5 g1f3 b8c6', weight: 10 },
  { line: 'e2e4 c7c5 g1f3 b8c6 d2d4 c5d4 f3d4', weight: 8 },
  { line: 'e2e4 c7c5 g1f3 b8c6 f1b5', weight: 6 },
  { line: 'e2e4 c7c5 c2c3', weight: 5 },
  { line: 'e2e4 c7c5 b1c3', weight: 4 },
  { line: 'e2e4 e7e6', weight: 12 },
  { line: 'e2e4 e7e6 d2d4 d7d5', weight: 10 },
  { line: 'e2e4 e7e6 d2d4 d7d5 b1c3', weight: 6 },
  { line: 'e2e4 e7e6 d2d4 d7d5 b1d2', weight: 4 },
  { line: 'e2e4 c7c6', weight: 12 },
  { line: 'e2e4 c7c6 d2d4 d7d5', weight: 10 },
  { line: 'e2e4 c7c6 d2d4 d7d5 b1c3', weight: 5 },
  { line: 'e2e4 c7c6 d2d4 d7d5 e4e5', weight: 4 },
  { line: 'e2e4 d7d6', weight: 5 },
  { line: 'e2e4 g8f6', weight: 4 },
  { line: 'e2e4 d7d5', weight: 4 },
  { line: 'd2d4', weight: 30 },
  { line: 'd2d4 d7d5', weight: 20 },
  { line: 'd2d4 d7d5 c2c4', weight: 18 },
  { line: 'd2d4 d7d5 c2c4 e7e6', weight: 12 },
  { line: 'd2d4 d7d5 c2c4 e7e6 b1c3', weight: 8 },
  { line: 'd2d4 d7d5 c2c4 c7c6', weight: 8 },
  { line: 'd2d4 d7d5 c2c4 d5c4', weight: 6 },
  { line: 'd2d4 d7d5 g1f3', weight: 6 },
  { line: 'd2d4 g8f6', weight: 15 },
  { line: 'd2d4 g8f6 c2c4', weight: 12 },
  { line: 'd2d4 g8f6 c2c4 g7g6', weight: 8 },
  { line: 'd2d4 g8f6 c2c4 e7e6', weight: 10 },
  { line: 'd2d4 f7f5', weight: 4 },
  { line: 'c2c4', weight: 12 },
  { line: 'c2c4 e7e5', weight: 6 },
  { line: 'c2c4 g8f6', weight: 6 },
  { line: 'g1f3', weight: 8 },
  { line: 'g1f3 d7d5', weight: 5 },
  { line: 'g1f3 g8f6', weight: 4 },
  { line: 'g2g3', weight: 3 },
];

const OPENING_INDEX = new Map();
(function buildOpeningIndex() {
  for (const entry of OPENING_BOOK) {
    const moves = entry.line.split(' ').filter(Boolean);
    for (let i = 1; i <= moves.length; i++) {
      const prefix = moves.slice(0, i).join(' ');
      if (!OPENING_INDEX.has(prefix)) OPENING_INDEX.set(prefix, []);
      OPENING_INDEX.get(prefix).push({ move: moves[i - 1], weight: entry.weight });
    }
  }
})();

function uciFromTo(from, to) {
  return String.fromCharCode(97 + from[1]) + (8 - from[0]) +
         String.fromCharCode(97 + to[1]) + (8 - to[0]);
}

function uciToMove(uci) {
  if (!uci || uci.length < 4) return null;
  const fc = uci.charCodeAt(0) - 97;
  const fr = 8 - parseInt(uci[1], 10);
  const tc = uci.charCodeAt(2) - 97;
  const tr = 8 - parseInt(uci[3], 10);
  if (!inBoard(fr, fc) || !inBoard(tr, tc)) return null;
  return [[fr, fc], [tr, tc]];
}

function bookMove(fen, historyLine, legalSet) {
  if (!historyLine) return null;
  const parts = historyLine.trim().split(/\s+/).filter(Boolean);
  for (let len = parts.length; len >= 1; len--) {
    const prefix = parts.slice(0, len).join(' ');
    const candidates = OPENING_INDEX.get(prefix);
    if (!candidates || !candidates.length) continue;
    const filtered = candidates.filter(c => legalSet.has(c.move));
    if (!filtered.length) continue;
    const total = filtered.reduce((s, c) => s + c.weight, 0);
    let r = Math.random() * total;
    for (const c of filtered) { r -= c.weight; if (r <= 0) return uciToMove(c.move); }
    return uciToMove(filtered[0].move);
  }
  return null;
}

// ============================================================
// MAIN SEARCH DRIVER
// ============================================================
function pickMoveSearch(state, isWhiteTurn, timeMs, historyLine, positionCounts) {
  const legal = allLegalMoves(state, isWhiteTurn);
  if (legal.length === 0) return null;
  if (legal.length === 1) return legal[0];

  const legalSet = new Set(legal.map(([f, t]) => uciFromTo(f, t)));
  const color = isWhiteTurn ? 1 : -1;
  const myTime = Math.max(0.5, timeMs / 1000);

  // Opening book
  if (historyLine && state.full <= 15) {
    const bm = bookMove(toFen(state), historyLine, legalSet);
    if (bm) return bm;
  }

  // Adaptive depth from time
  let maxDepth = 6;
  if (myTime < 3) maxDepth = 3;
  else if (myTime < 8) maxDepth = 4;
  else if (myTime < 20) maxDepth = 5;

  SEARCH_ABORTED = false;
  SEARCH_DEADLINE = Date.now() + Math.max(40, timeMs);

  let bestMove = legal[0];
  let ordered = orderMoves(state, legal, 0, null);
  let prevPv = null;

  for (let depth = 1; depth <= maxDepth; depth++) {
    if (Date.now() >= SEARCH_DEADLINE) break;
    let alpha = -Infinity, beta = Infinity;
    let localBest = null, localBestScore = -Infinity;

    // Move PV first
    if (prevPv) {
      const idx = ordered.findIndex(([f, t]) =>
        f[0] === prevPv[0][0] && f[1] === prevPv[0][1] &&
        t[0] === prevPv[1][0] && t[1] === prevPv[1][1]);
      if (idx > 0) {
        const [pv] = ordered.splice(idx, 1);
        ordered.unshift(pv);
      }
    }

    for (const [from, to] of ordered) {
      if (Date.now() >= SEARCH_DEADLINE) { SEARCH_ABORTED = true; break; }
      const next = applyMove(state, from, to);
      let score = -negamax(next, depth - 1, -beta, -alpha, -color, 1);
      if (SEARCH_ABORTED) break;

      // Safety + memory penalty (only at root, only for own moves)
      const safetyPenalty = tacticalSafetyPenalty(state, from, to, isWhiteTurn);
      const memoryPenalty = learnedMistakePenalty(state, from, to);
      const immediateGain = evaluate(next, isWhiteTurn) - evaluate(state, isWhiteTurn);
      if (safetyPenalty > 0 && immediateGain < safetyPenalty * 0.8) score -= safetyPenalty;
      score -= memoryPenalty;

      // Repetition penalty
      if (positionCounts) {
        const nextKey = positionKey(toFen(next));
        const c = positionCounts.get(nextKey) || 0;
        if (c >= 1) score -= 30;
        if (c >= 2) score -= 120;
      }

      if (score > localBestScore) { localBestScore = score; localBest = [from, to]; }
      if (score > alpha) alpha = score;
    }

    if (localBest && !SEARCH_ABORTED) {
      bestMove = localBest;
      prevPv = localBest;
    }
    if (Date.now() >= SEARCH_DEADLINE) break;
  }

  return bestMove;
}

// ============================================================
// SELF-PLAY (fixed depth, quality over speed)
// ============================================================
function playSelfPlayGame() {
  let state = parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  const history = [];
  const moveLog = [];
  const positionCounts = new Map();
  let result = 0;
  let finalEval = 0;
  const maxMoves = 200;

  for (let move = 0; move < maxMoves; move++) {
    const legal = allLegalMoves(state, state.turn === 'w');
    if (legal.length === 0) {
      if (inCheck(state, state.turn === 'w')) result = state.turn === 'w' ? -1 : 1;
      else result = 0;
      break;
    }
    if (state.half >= 100) { result = 0; break; }

    const key = positionKey(toFen(state));
    const count = (positionCounts.get(key) || 0) + 1;
    positionCounts.set(key, count);

    if (count >= 3) {
      const evalNow = evaluate(state, state.turn === 'w');
      if (Math.abs(evalNow) > 150) {
        const nonRepeating = legal.filter(([from, to]) => {
          const next = applyMove(state, from, to);
          const nextKey = positionKey(toFen(next));
          return !positionCounts.has(nextKey) || positionCounts.get(nextKey) < 2;
        });
        if (nonRepeating.length > 0) {
          const isW = state.turn === 'w';
          let bestMv = nonRepeating[0], bestScore = -Infinity;
          for (const [from, to] of nonRepeating) {
            const next = applyMove(state, from, to);
            const score = evaluate(next, !isW);
            if (score > bestScore) { bestScore = score; bestMv = [from, to]; }
          }
          const pieceMoved = state.board[bestMv[0][0]][bestMv[0][1]];
          const nextState = applyMove(state, bestMv[0], bestMv[1]);
          const causedCheck = inCheck(nextState, !isW);
          const isMate = causedCheck && allLegalMoves(nextState, !isW).length === 0;
          history.push({
            white: isW, pieceMoved,
            sqFrom: sqName(bestMv[0][0], bestMv[0][1]),
            sqTo: sqName(bestMv[1][0], bestMv[1][1]),
            causedCheck, isMate
          });
          state = nextState;
          moveLog.push({ from: bestMv[0], to: bestMv[1], byColor: isW ? 'w' : 'b', fenAfter: toFen(state) });
          continue;
        }
      }
      result = 0;
      break;
    }

    const isW = state.turn === 'w';
    // fixed depth 4 with wide window (more quality, slower)
    const mv = pickMoveSearch(state, isW, 2000, null, positionCounts);
    if (!mv || mv.length !== 2) break;

    const pieceMoved = state.board[mv[0][0]][mv[0][1]];
    const nextState = applyMove(state, mv[0], mv[1]);
    const causedCheck = inCheck(nextState, !isW);
    const isMate = causedCheck && allLegalMoves(nextState, !isW).length === 0;

    history.push({
      white: isW, pieceMoved,
      sqFrom: sqName(mv[0][0], mv[0][1]),
      sqTo: sqName(mv[1][0], mv[1][1]),
      causedCheck, isMate
    });
    state = nextState;
    finalEval = evaluate(state, state.turn === 'w');
    moveLog.push({ from: mv[0], to: mv[1], byColor: isW ? 'w' : 'b', fenAfter: toFen(state) });
  }

  let adjustedResult = result;
  if (result === 0 && Math.abs(finalEval) > 300) {
    adjustedResult = finalEval > 0 ? 1 : -1;
  }

  // No PST training — only stats
  DATA.games++;
  if (adjustedResult === 1) DATA.wins++;
  else if (adjustedResult === -1) DATA.losses++;
  else DATA.draws++;

  return { result: adjustedResult, moveLog };
}

// ============================================================
// API
// ============================================================
function getStats() {
  return {
    games: DATA.games,
    wins: DATA.wins,
    losses: DATA.losses,
    draws: DATA.draws,
    episodeActive: false,
    tacticalMistakes: mistakeMemory.size,
  };
}

function pickMoveForServer(fen, color, timeInfo, availableMoves, line) {
  if (!fen || typeof fen !== 'string') return null;

  try {
    const state = parseFen(fen);
    const myTime = timeInfo && typeof timeInfo.timeLeft === 'number' ? timeInfo.timeLeft : 5;
    const inc = timeInfo && typeof timeInfo.inc === 'number' ? timeInfo.inc : 0;

    let thinkMs;
    if (myTime < 2) thinkMs = 30;
    else if (myTime < 5) thinkMs = 60;
    else if (myTime < 10) thinkMs = 120;
    else if (myTime < 30) thinkMs = 300;
    else if (myTime < 60) thinkMs = 600;
    else if (myTime < 180) thinkMs = 1200;
    else thinkMs = 2000;

    const allowedByClock = (myTime + inc) * 0.08 * 1000;
    thinkMs = Math.min(thinkMs, allowedByClock);
    thinkMs = Math.max(30, thinkMs);

    const historyLine = line || null;
    const move = pickMoveSearch(state, color === 'w', thinkMs, historyLine, null);

    if (!move || !Array.isArray(move) || move.length !== 2) return null;
    if (!Array.isArray(move[0]) || !Array.isArray(move[1])) return null;
    if (move[0].length !== 2 || move[1].length !== 2) return null;

    // Validate against availableMoves if provided
    if (Array.isArray(availableMoves) && availableMoves.length > 0) {
      const uci = uciFromTo(move[0], move[1]);
      const ok = availableMoves.some(m => {
        if (typeof m === 'string') return m === uci;
        if (m && typeof m === 'object') {
          const from = m.from || m.fromSq;
          const to = m.to || m.toSq;
          if (typeof from === 'string' && typeof to === 'string') {
            return from + to === uci;
          }
          if (Array.isArray(from) && Array.isArray(to)) {
            return from[0] === move[0][0] && from[1] === move[0][1] &&
                   to[0] === move[1][0] && to[1] === move[1][1];
          }
        }
        return false;
      });
      if (!ok) {
        // fallback: play first available
        const first = availableMoves[0];
        if (typeof first === 'string' && first.length >= 4) {
          const fallback = uciToMove(first);
          if (fallback) return { from: fallback[0], to: fallback[1] };
        }
      }
    }

    return { from: move[0], to: move[1] };
  } catch (e) {
    console.error('[Watcher] pickMoveForServer error:', e.message);
    return null;
  }
}

function startEpisode() {}
function recordTransition() {}
function finishEpisode() {}

function learnFromObservedMove(prevFen, move, newFen, moverColor, timeControl, evalAfter) {
  try {
    if (!prevFen || !newFen || !move || !move.from || !move.to) return;
    const before = parseFen(prevFen), after = parseFen(newFen);
    const moverWhite = moverColor === 'w';

    function parseSq(v) {
      if (Array.isArray(v) && v.length === 2 && Number.isFinite(v[0]) && Number.isFinite(v[1])) {
        return [v[0], v[1]];
      }
      if (typeof v === 'string' && /^[a-h][1-8]$/.test(v)) {
        return [8 - Number(v[1]), v.charCodeAt(0) - 97];
      }
      return null;
    }
    const from = parseSq(move.from);
    const to = parseSq(move.to);
    if (!from || !to) return;
    if (!before.board[from[0]] || !before.board[from[0]][from[1]]) return;

    const beforeEval = evaluate(before, moverWhite);
    const afterEval = evaluate(after, moverWhite);
    const drop = beforeEval - afterEval;
    let hanging = 0;
    const p = after.board[to[0]] && after.board[to[0]][to[1]];
    if (p && isWhite(p) === moverWhite && (PIECE_VALUES[p.toLowerCase()] || 0) >= 300 &&
        isAttacked(after, to[0], to[1], !moverWhite)) {
      const defended = isAttacked(after, to[0], to[1], moverWhite);
      if (!defended) hanging = Math.round((PIECE_VALUES[p.toLowerCase()] || 0) * 0.8);
    }
    const penalty = Math.max(drop > 220 ? drop : 0, hanging);
    if (penalty >= 250) {
      recordMistake(positionKey(prevFen), sqName(from[0], from[1]), sqName(to[0], to[1]), penalty);
    }
  } catch (e) {
    console.error('[Watcher] Ошибка анализа обучающего хода:', e.message);
  }
}

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
