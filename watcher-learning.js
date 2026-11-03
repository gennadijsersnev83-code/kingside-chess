'use strict';

// ============================================================
// DATA / PERSISTENCE
// ============================================================
let DATA = {
  version: 7,
  weights: {},
  params: {
    doubledPawn: 10,
    isolatedPawn: 15,
    passedPawnBase: 20,
    bishopPair: 30,
    kingShield: 10,
    openFileRook: 40,
    mobility: 4,
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
      const idx = isWhitePiece ? r * 8 + c : (7 - r) * 8 + (7 - c);
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
      .catch(e => console.error('[Watcher] Ошибка сохранения ошибки:', e.message));
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
    console.log(`[Watcher] Загружено: ${DATA.games} партий, W/L/D = ${DATA.wins}/${DATA.losses}/${DATA.draws}`);
  } catch (e) {
    console.error('[Watcher] Ошибка загрузки:', e.message);
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
    await _pool.query(`UPDATE watcher_stats SET games=$1, wins=$2, losses=$3, draws=$4, last_update=$5 WHERE id=1`,
      [DATA.games, DATA.wins, DATA.losses, DATA.draws, Date.now()]);
    DATA.lastUpdate = Date.now();
  } catch (e) {
    console.error('[Watcher] Ошибка сохранения:', e.message);
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
    const sRes = await _pool.query('SELECT games, wins, losses, draws FROM watcher_stats WHERE id=1');
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
const MATE_SCORE = 1000000;
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
// ATTACK DETECTION
// ============================================================
function isAttacked(state, r, c, byWhite) {
  const b = state.board;
  const pdir = byWhite ? 1 : -1;
  const pr = r + pdir;
  if (inBoard(pr, c - 1)) {
    const p = b[pr][c - 1];
    if (p && isWhite(p) === byWhite && p.toLowerCase() === 'p') return true;
  }
  if (inBoard(pr, c + 1)) {
    const p = b[pr][c + 1];
    if (p && isWhite(p) === byWhite && p.toLowerCase() === 'p') return true;
  }
  const knightDirs = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
  for (const [dr, dc] of knightDirs) {
    const rr = r + dr, cc = c + dc;
    if (!inBoard(rr, cc)) continue;
    const p = b[rr][cc];
    if (p && isWhite(p) === byWhite && p.toLowerCase() === 'n') return true;
  }
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    const rr = r + dr, cc = c + dc;
    if (!inBoard(rr, cc)) continue;
    const p = b[rr][cc];
    if (p && isWhite(p) === byWhite && p.toLowerCase() === 'k') return true;
  }
  for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
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
  for (const [dr, dc] of [[-1,-1],[-1,1],[1,-1],[1,1]]) {
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

function applyMove(state, from, to) {
  const copy = {
    board: state.board.map(row => row.slice()),
    turn: state.turn, castling: state.castling, ep: state.ep,
    half: state.half, full: state.full
  };
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
// SEE (упрощённая)
// ============================================================
function see(state, from, to, depth) {
  depth = depth || 0;
  if (depth > 4) return 0;
  const target = state.board[to[0]][to[1]];
  const piece = state.board[from[0]][from[1]];
  if (!piece) return 0;
  const gain = target ? (PIECE_VALUES[target.toLowerCase()] || 0) : 0;
  const next = applyMove(state, from, to);
  if (!findKing(next, true) || !findKing(next, false)) return gain;
  const oppWhite = !isWhite(piece);
  let bestAttacker = null, bestVal = Infinity;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = next.board[r][c];
    if (!p || isWhite(p) !== oppWhite) continue;
    if (!canAttack(next, r, c, to[0], to[1])) continue;
    const v = PIECE_VALUES[p.toLowerCase()] || 0;
    if (v < bestVal) { bestVal = v; bestAttacker = [r, c]; }
  }
  if (!bestAttacker) return gain;
  return Math.max(0, gain - see(next, bestAttacker, to, depth + 1));
}

function canAttack(state, r, c, tr, tc) {
  const p = state.board[r][c]; if (!p) return false;
  const t = p.toLowerCase();
  const dr = tr - r, dc = tc - c;
  const adr = Math.abs(dr), adc = Math.abs(dc);
  if (t === 'p') { const d = isWhite(p) ? -1 : 1; return dr === d && adc === 1; }
  if (t === 'n') return (adr === 2 && adc === 1) || (adr === 1 && adc === 2);
  if (t === 'k') return Math.max(adr, adc) === 1;
  if (t === 'r' || t === 'q') {
    if (r === tr) { for (let x = Math.min(c, tc) + 1; x < Math.max(c, tc); x++) if (state.board[r][x]) return false; return true; }
    if (c === tc) { for (let y = Math.min(r, tr) + 1; y < Math.max(r, tr); y++) if (state.board[y][c]) return false; return true; }
  }
  if (t === 'b' || t === 'q') {
    if (adr === adc) {
      const sr = dr > 0 ? 1 : -1, sc = dc > 0 ? 1 : -1;
      let y = r + sr, x = c + sc;
      while (y !== tr && x !== tc) { if (state.board[y][x]) return false; y += sr; x += sc; }
      return true;
    }
  }
  return false;
}

// ============================================================
// EVALUATION (УЛУЧШЕННЫЙ ЭНДШПИЛЬ)
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

function hangingMaterial(state, white) {
  let lost = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c];
    if (!p || isWhite(p) !== white) continue;
    const v = PIECE_VALUES[p.toLowerCase()] || 0;
    if (v < 300) continue;
    if (!isAttacked(state, r, c, !white)) continue;
    if (!isAttacked(state, r, c, white)) lost += v;
  }
  return lost;
}

function debutScore(state) {
  let s = 0;
  if (state.full > 15) return 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p) continue;
    const white = isWhite(p);
    const t = p.toLowerCase();
    const homeRow = white ? 7 : 0;
    const sign = white ? 1 : -1;
    if (t === 'p') {
      if (c === 3 || c === 4) {
        if (r === 3 || r === 4) s += 35 * sign;
        else s += 15 * sign;
      }
      if (c === 0 || c === 7) s -= 8 * sign;
    }
    if (t === 'n') {
      if (r !== homeRow) {
        if (c === 2 || c === 5) s -= 3 * sign;
        else s -= 18 * sign;
      }
      if (c === 0 || c === 7) s -= 25 * sign;
    }
    if (t === 'q' && r !== homeRow && state.full <= 8) s -= 30 * sign;
    if (t === 'r' && r !== homeRow) s -= 15 * sign;
  }
  if (state.full > 5) {
    const whiteCastled = !state.castling.includes('K') && !state.castling.includes('Q');
    const blackCastled = !state.castling.includes('k') && !state.castling.includes('q');
    if (whiteCastled) {
      const k = findKing(state, true);
      if (k) s += k[1] > 3 ? 30 : -20;
    }
    if (blackCastled) {
      const k = findKing(state, false);
      if (k) s -= k[1] > 3 ? 30 : -20;
    }
  }
  return s;
}

function evaluate(state, forWhite) {
  let score = 0;
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
    if (t === 'p') {
      if (isW) { wpFile[c]++; wPawns.push([r, c]); }
      else    { bpFile[c]++; bPawns.push([r, c]); }
    }
    if (t === 'b') { if (isW) wB++; else bB++; }
  }

  const endgame = totalMat <= 2400;

  if (wB >= 2) score += DATA.params.bishopPair;
  if (bB >= 2) score -= DATA.params.bishopPair;

  for (let f = 0; f < 8; f++) {
    if (wpFile[f] > 1) score -= DATA.params.doubledPawn * (wpFile[f] - 1);
    if (bpFile[f] > 1) score += DATA.params.doubledPawn * (bpFile[f] - 1);
    if (wpFile[f] > 0) {
      const left = f > 0 ? wpFile[f-1] : 0, right = f < 7 ? wpFile[f+1] : 0;
      if (left === 0 && right === 0) score -= DATA.params.isolatedPawn;
    }
    if (bpFile[f] > 0) {
      const left = f > 0 ? bpFile[f-1] : 0, right = f < 7 ? bpFile[f+1] : 0;
      if (left === 0 && right === 0) score += DATA.params.isolatedPawn;
    }
  }

  for (const [r, c] of wPawns) {
    let passed = true;
    for (const [br, bc] of bPawns) {
      if ((bc === c || bc === c-1 || bc === c+1) && br < r) { passed = false; break; }
    }
    if (passed) {
      const rank = 7 - r;
      score += DATA.params.passedPawnBase + [0,10,20,35,60,100,160,0][rank];
    }
  }
  for (const [r, c] of bPawns) {
    let passed = true;
    for (const [wr, wc] of wPawns) {
      if ((wc === c || wc === c-1 || wc === c+1) && wr > r) { passed = false; break; }
    }
    if (passed) {
      score -= DATA.params.passedPawnBase + [0,10,20,35,60,100,160,0][r];
    }
  }

  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p || p.toLowerCase() !== 'r') continue;
    const isW = isWhite(p);
    const own = isW ? wpFile : bpFile, opp = isW ? bpFile : wpFile;
    if (own[c] === 0 && opp[c] === 0) score += isW ? DATA.params.openFileRook : -DATA.params.openFileRook;
    else if (own[c] === 0) score += isW ? DATA.params.openFileRook * 0.5 : -DATA.params.openFileRook * 0.5;
  }

  if (!endgame) {
    if (whiteKing) {
      const [kr, kc] = whiteKing;
      let shield = 0;
      for (const dc of [-1, 0, 1]) if (inBoard(kr-1, kc+dc) && state.board[kr-1][kc+dc] === 'P') shield++;
      score += shield * DATA.params.kingShield;
      if (kc === 4 && kr >= 6) score -= 40;
      if (kr < 6) score -= 30;
    }
    if (blackKing) {
      const [kr, kc] = blackKing;
      let shield = 0;
      for (const dc of [-1, 0, 1]) if (inBoard(kr+1, kc+dc) && state.board[kr+1][kc+dc] === 'p') shield++;
      score -= shield * DATA.params.kingShield;
      if (kc === 4 && kr <= 1) score += 40;
      if (kr > 1) score += 30;
    }
  } else {
    if (whiteKing) score += KING_ENDGAME_PST[whiteKing[0]][whiteKing[1]];
    if (blackKing) score -= KING_ENDGAME_PST[7 - blackKing[0]][blackKing[1]];
    if (whiteKing && blackKing && totalMat <= 1500) {
      const dist = Math.abs(whiteKing[0]-blackKing[0]) + Math.abs(whiteKing[1]-blackKing[1]);
      score += (14 - dist) * 15;
      const edgeB = Math.min(blackKing[0], 7-blackKing[0], blackKing[1], 7-blackKing[1]);
      score -= edgeB * 30;
    }
    // --- УЛУЧШЕНИЕ ЭНДШПИЛЯ: ладья на 7-й линии ---
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const p = state.board[r][c]; if (!p || p.toLowerCase() !== 'r') continue;
      const isW = isWhite(p);
      if (isW && r === 1) score += 50; // белая ладья на 7-й горизонтали
      if (!isW && r === 6) score -= 50; // чёрная ладья на 2-й горизонтали
    }
  }

  let wm = 0, bm = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p) continue;
    const t = p.toLowerCase();
    if (t === 'p' || t === 'k') continue;
    const n = pseudoMoves(state, r, c).length;
    if (isWhite(p)) wm += n; else bm += n;
  }
  score += (wm - bm) * DATA.params.mobility;

  score += state.turn === 'w' ? DATA.params.tempo : -DATA.params.tempo;

  const hangW = hangingMaterial(state, true);
  const hangB = hangingMaterial(state, false);
  score -= hangW * 0.5;
  score += hangB * 0.5;

  score += debutScore(state);

  if (state.half >= 100) score = 0;

  return forWhite ? score : -score;
}

// ============================================================
// TACTICAL SAFETY
// ============================================================
function isHangingAfterMove(state, from, to, moverWhite) {
  const next = applyMove(state, from, to);
  let hang = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = next.board[r][c];
    if (!p || isWhite(p) !== moverWhite) continue;
    const v = PIECE_VALUES[p.toLowerCase()] || 0;
    if (v < 300) continue;
    if (isAttacked(next, r, c, !moverWhite) && !isAttacked(next, r, c, moverWhite)) {
      hang += v;
    }
  }
  return hang;
}

function learnedMistakePenalty(state, from, to) {
  const key = mistakeKey(positionKey(toFen(state)), sqName(from[0], from[1]), sqName(to[0], to[1]));
  const item = mistakeMemory.get(key);
  if (!item) return 0;
  const ageDays = (Date.now() - (item.updated || 0)) / (1000 * 60 * 60 * 24);
  const decay = Math.exp(-ageDays / 14);
  const seenBoost = Math.min(1.2, 1 + Math.log2(Math.max(1, item.seen)) * 0.05);
  return Math.min(120, item.penalty * seenBoost * decay * 0.15);
}

// ============================================================
// TRANSPOSITION TABLE
// ============================================================
const TT = new Map();
const TT_MAX = 500000;
function ttKeyOf(state) {
  let s = '';
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) s += state.board[r][c] || '.';
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
// SEARCH DEADLINE / ABORT
// ============================================================
let SEARCH_DEADLINE = 0;
let SEARCH_ABORTED = false;

// ============================================================
// QUIESCENCE
// ============================================================
function quiescence(state, alpha, beta, color, qdepth) {
  if (Date.now() >= SEARCH_DEADLINE) { SEARCH_ABORTED = true; return evaluate(state, color === 1); }
  const isW = color === 1;
  const checked = inCheck(state, isW);
  if (qdepth >= 8) return evaluate(state, isW);

  let standPat = -Infinity;
  if (!checked) {
    standPat = evaluate(state, isW);
    if (standPat >= beta) return beta;
    if (standPat > alpha) alpha = standPat;
  }

  const legal = allLegalMoves(state, isW);
  if (legal.length === 0) {
    if (checked) return -MATE_SCORE + qdepth;
    return 0;
  }

  let candidates;
  if (checked) {
    candidates = legal;
  } else {
    candidates = [];
    for (const [from, to] of legal) {
      const target = state.board[to[0]][to[1]];
      const piece = state.board[from[0]][from[1]];
      if (target || (piece && piece.toLowerCase() === 'p' &&
          from[1] !== to[1] && state.ep !== '-')) {
        candidates.push([from, to]);
      }
    }
    candidates = candidates.filter(([f, t]) => see(state, f, t) >= 0);
  }

  candidates.sort((a, b) => {
    const scoreMove = ([from, to]) => {
      const attacker = state.board[from[0]][from[1]];
      let victim = state.board[to[0]][to[1]];
      if (!victim && attacker && attacker.toLowerCase() === 'p' && from[1] !== to[1]) victim = isW ? 'p' : 'P';
      const victimValue = victim ? (PIECE_VALUES[victim.toLowerCase()] || 0) : 0;
      const attackerValue = attacker ? (PIECE_VALUES[attacker.toLowerCase()] || 0) : 0;
      const promotion = attacker && attacker.toLowerCase() === 'p' && (to[0] === 0 || to[0] === 7) ? 800 : 0;
      return victimValue * 10 - attackerValue + promotion;
    };
    return scoreMove(b) - scoreMove(a);
  });

  for (const [from, to] of candidates) {
    if (SEARCH_ABORTED) return alpha;
    const next = applyMove(state, from, to);
    const score = -quiescence(next, -beta, -alpha, -color, qdepth + 1);
    if (SEARCH_ABORTED) return alpha;
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

// ============================================================
// MOVE ORDERING
// ============================================================
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
      let se = 0;
      try { se = see(state, from, to); } catch (_) { se = 0; }
      if (se >= 0) s += 10000 + (PIECE_VALUES[cap.toLowerCase()] || 0) * 10 - (PIECE_VALUES[piece.toLowerCase()] || 0);
      else s += 2000 + (PIECE_VALUES[cap.toLowerCase()] || 0);
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

// ============================================================
// NEGAMAX
// ============================================================
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

    let extension = 0;
    if (givesCheck && depth >= 2) extension = 1;
    else if (isPromo) extension = 1;

    let reduction = 0;
    if (isQuiet && !givesCheck && !isPromo && i >= 4 && depth >= 3) reduction = 1;
    if (reduction && depth >= 5 && i >= 8) reduction = 2;

    let score;
    if (i === 0) {
      score = -negamax(next, depth - 1 + extension, -beta, -alpha, -color, ply + 1);
    } else {
      score = -negamax(next, depth - 1 + extension - reduction, -alpha - 1, -alpha, -color, ply + 1);
      if (score > alpha && score < beta) {
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

  if (best !== Infinity && best !== -Infinity) {
    let flag = 'EXACT';
    if (best <= alphaOrig) flag = 'UPPER';
    else if (best >= betaOrig) flag = 'LOWER';
    ttSet(key, depth, best, flag, bestMove);
  }
  return best;
}

// ============================================================
// MATE SEARCH (быстрая проверка мата в 1-2 хода)
// ============================================================
function isMateAfterMove(state, from, to, moverWhite) {
  const next = applyMove(state, from, to);
  return inCheck(next, !moverWhite) && allLegalMoves(next, !moverWhite).length === 0;
}

function findMateInOne(state, white) {
  for (const [from, to] of allLegalMoves(state, white)) {
    if (isMateAfterMove(state, from, to, white)) return [from, to];
  }
  return null;
}

// ============================================================
// OPENING BOOK
// ============================================================
const OPENING_BOOK = [
  { line: 'e2e4', weight: 40 },
  { line: 'e2e4 e7e5 g1f3', weight: 30 },
  { line: 'e2e4 e7e5 g1f3 b8c6 f1b5', weight: 20 },
  { line: 'e2e4 e7e5 g1f3 b8c6 f1c4', weight: 15 },
  { line: 'e2e4 c7c5', weight: 25 },
  { line: 'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4', weight: 12 },
  { line: 'e2e4 e7e6 d2d4 d7d5', weight: 10 },
  { line: 'e2e4 c7c6 d2d4 d7d5', weight: 10 },
  { line: 'd2d4', weight: 30 },
  { line: 'd2d4 d7d5 c2c4', weight: 18 },
  { line: 'd2d4 g8f6 c2c4', weight: 12 },
  { line: 'd2d4 g8f6 c2c4 g7g6', weight: 8 },
  { line: 'c2c4', weight: 12 },
  { line: 'g1f3', weight: 8 },
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
function bookMove(historyLine, legalSet) {
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
  const myTime = Math.max(0.05, timeMs / 1000);
  const moveCount = state.full;

  if (historyLine && moveCount <= 15) {
    const bm = bookMove(historyLine, legalSet);
    if (bm) return bm;
  }

  const mateIn1 = findMateInOne(state, isWhiteTurn);
  if (mateIn1) return mateIn1;

  let maxDepth = 12;
  if (myTime < 0.25) maxDepth = 3;
  else if (myTime < 0.6) maxDepth = 4;
  else if (myTime < 1.2) maxDepth = 5;
  else if (myTime < 3) maxDepth = 6;
  else if (myTime < 6) maxDepth = 8;
  else if (myTime < 10) maxDepth = 10;

  SEARCH_ABORTED = false;
  SEARCH_DEADLINE = Date.now() + Math.max(1000, timeMs);

  let bestMove = legal[0];
  let ordered = orderMoves(state, legal, 0, null);
  let prevPv = null;
  let deepestReached = 0;

  for (let depth = 1; depth <= maxDepth; depth++) {
    if (Date.now() >= SEARCH_DEADLINE) break;
    let alpha = -Infinity, beta = Infinity;
    let localBest = null, localBestScore = -Infinity;

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
      
      const nextIsMate = inCheck(next, !isWhiteTurn) && allLegalMoves(next, !isWhiteTurn).length === 0;
      const hangAfter = isHangingAfterMove(state, from, to, isWhiteTurn);
      
      let hangPenalty = 0;
      if (!nextIsMate && hangAfter > 0) {
        hangPenalty = hangAfter * 10; 
      }
      
      const score = -negamax(next, depth - 1, -beta, -alpha, -color, 1);
      if (SEARCH_ABORTED) break;

      let adjusted = score;
      if (!nextIsMate) {
        adjusted -= hangPenalty;
        
        const mem = learnedMistakePenalty(state, from, to);
        if (mem > 0) adjusted -= mem;

        if (positionCounts && moveCount > 10) {
          const nextKey = positionKey(toFen(next));
          const c = positionCounts.get(nextKey) || 0;
          if (c >= 2) adjusted -= 50;
        }
      }

      if (adjusted > localBestScore) { localBestScore = adjusted; localBest = [from, to]; }
      if (score > alpha) alpha = score;
    }

    if (localBest && !SEARCH_ABORTED) {
      bestMove = localBest;
      prevPv = localBest;
      deepestReached = depth;
    }
    if (Date.now() >= SEARCH_DEADLINE) break;
  }

  if (myTime >= 2) {
    console.log(`[Watcher] think=${Math.round(timeMs)}ms, depth=${deepestReached}, move=${uciFromTo(bestMove[0], bestMove[1])}`);
  }

  return bestMove;
}

// ============================================================
// SELF-PLAY
// ============================================================
function playSelfPlayGame() {
  let state = parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  const moveLog = [];
  const positionCounts = new Map();
  let result = 0;
  let finalEval = 0;
  const maxMoves = 200;

  for (let move = 0; move < maxMoves; move++) {
    const legal = allLegalMoves(state, state.turn === 'w');
    if (legal.length === 0) {
      if (inCheck(state, state.turn === 'w')) result = state.turn === 'w' ? -1 : 1;
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
          const nk = positionKey(toFen(next));
          return !positionCounts.has(nk) || positionCounts.get(nk) < 2;
        });
        if (nonRepeating.length > 0) {
          const isW = state.turn === 'w';
          let bestMv = nonRepeating[0], bestScore = -Infinity;
          for (const [from, to] of nonRepeating) {
            const next = applyMove(state, from, to);
            const score = evaluate(next, !isW);
            if (score > bestScore) { bestScore = score; bestMv = [from, to]; }
          }
          state = applyMove(state, bestMv[0], bestMv[1]);
          moveLog.push({ from: bestMv[0], to: bestMv[1], byColor: isW ? 'w' : 'b', fenAfter: toFen(state) });
          continue;
        }
      }
      result = 0; break;
    }

    const isW = state.turn === 'w';
    const mv = pickMoveSearch(state, isW, 2000, null, positionCounts);
    if (!mv) break;

    state = applyMove(state, mv[0], mv[1]);
    finalEval = evaluate(state, state.turn === 'w');
    moveLog.push({ from: mv[0], to: mv[1], byColor: isW ? 'w' : 'b', fenAfter: toFen(state) });
  }

  let adjustedResult = result;
  if (result === 0 && Math.abs(finalEval) > 300) adjustedResult = finalEval > 0 ? 1 : -1;

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

function pickMoveForServer(fen, color, timeInfo, availableMoves, line, positionCounts) {
  if (!fen || typeof fen !== 'string') return null;
  try {
    const state = parseFen(fen);
    const myTime = Number(timeInfo && timeInfo.timeLeft);
    const inc = Number(timeInfo && timeInfo.inc);
    const total = Number(timeInfo && timeInfo.total);

    const safeMyTime = Number.isFinite(myTime) && myTime > 0 ? myTime : 10;
    const safeInc = Number.isFinite(inc) && inc > 0 ? inc : 0;
    const safeTotal = Number.isFinite(total) && total > 0 ? total : 600; 

    // --- ДИНАМИЧЕСКОЕ РАСПРЕДЕЛЕНИЕ ВРЕМЕНИ ---
    let thinkMs;
    if (safeTotal <= 1) thinkMs = 500;           // Пуля 1+0
    else if (safeTotal <= 3) thinkMs = 1200;     // Блиц 3+0
    else if (safeTotal <= 5) thinkMs = 2500;     // Блиц 5+0
    else if (safeTotal <= 10) thinkMs = 5000;    // Рапид 10+0
    else if (safeTotal <= 30) thinkMs = 7000;    // Рапид 30+0
    else thinkMs = 8000;                          // Классика 60+ минут

    // --- ЗАЩИТА ОТ ЦЕЙТНОТА ---
    if (safeMyTime <= 5) thinkMs = Math.min(thinkMs, 400);
    else if (safeMyTime <= 15) thinkMs = Math.min(thinkMs, 1000);
    else if (safeMyTime <= 30) thinkMs = Math.min(thinkMs, 2000);
    else if (safeMyTime <= 60) thinkMs = Math.min(thinkMs, 3000);
    else if (safeMyTime <= 120) thinkMs = Math.min(thinkMs, 4000);

    // --- ОГРАНИЧЕНИЕ ПО ПРОЦЕНТУ ВРЕМЕНИ ---
    const allowedByClock = (safeMyTime + safeInc) * 0.08 * 1000;
    if (allowedByClock > 0) {
      thinkMs = Math.min(thinkMs, allowedByClock);
    }

    thinkMs = Math.max(200, thinkMs);

    const historyLine = line || null;
    const posCounts = positionCounts instanceof Map ? positionCounts : null;
    const move = pickMoveSearch(state, color === 'w', thinkMs, historyLine, posCounts);

    if (!move || !Array.isArray(move) || move.length !== 2 ||
        !Array.isArray(move[0]) || !Array.isArray(move[1])) {
      const legal = allLegalMoves(state, color === 'w');
      if (legal.length > 0) return { from: legal[0][0], to: legal[0][1] };
      return null;
    }

    if (Array.isArray(availableMoves) && availableMoves.length > 0) {
      const uci = uciFromTo(move[0], move[1]);
      const ok = availableMoves.some(m => {
        if (typeof m === 'string') return m === uci;
        if (m && typeof m === 'object' && !Array.isArray(m)) {
          const from = m.from || m.fromSq;
          const to = m.to || m.toSq;
          if (typeof from === 'string' && typeof to === 'string') return from + to === uci;
        }
        return false;
      });
      if (!ok) {
        for (const m of availableMoves) {
          if (typeof m === 'string' && m.length >= 4) {
            const fb = uciToMove(m);
            if (fb) return { from: fb[0], to: fb[1] };
          }
        }
      }
    }

    return { from: move[0], to: move[1] };
  } catch (e) {
    console.error('[Watcher] pickMoveForServer error:', e.message);
    try {
      const state = parseFen(fen);
      const legal = allLegalMoves(state, color === 'w');
      if (legal.length > 0) return { from: legal[0][0], to: legal[0][1] };
    } catch (_) {}
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
      if (Array.isArray(v) && v.length === 2 && Number.isFinite(v[0]) && Number.isFinite(v[1])) return [v[0], v[1]];
      if (typeof v === 'string' && /^[a-h][1-8]$/.test(v)) return [8 - Number(v[1]), v.charCodeAt(0) - 97];
      return null;
    }
    const from = parseSq(move.from), to = parseSq(move.to);
    if (!from || !to) return;
    if (!before.board[from[0]] || !before.board[from[0]][from[1]]) return;

    const afterIsMate = inCheck(after, !moverWhite) && allLegalMoves(after, !moverWhite).length === 0;
    if (afterIsMate) return;

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
    console.error('[Watcher] Ошибка анализа хода:', e.message);
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
