'use strict';

let DATA = {
  version: 6,
  weights: {},
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

// ==================== POSTGRES ====================
let _pool = null;
const mistakeMemory = new Map();
const MAX_MISTAKES = 12000;
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
    const oldest = [...mistakeMemory.entries()].sort((a,b) => a[1].updated - b[1].updated).slice(0, mistakeMemory.size - MAX_MISTAKES);
    for (const [k] of oldest) mistakeMemory.delete(k);
  }
  if (_pool) {
    _pool.query(`INSERT INTO watcher_tactical_mistakes (position_key, from_sq, to_sq, penalty, seen, updated_at)
      VALUES ($1,$2,$3,$4,1,$5)
      ON CONFLICT (position_key, from_sq, to_sq) DO UPDATE SET
      penalty = GREATEST(watcher_tactical_mistakes.penalty, EXCLUDED.penalty),
      seen = watcher_tactical_mistakes.seen + 1, updated_at = EXCLUDED.updated_at`,
      [pos, from, to, old.penalty, old.updated]).catch(e => console.error('[Watcher] Ошибка сохранения тактической ошибки:', e.message));
  }
}

async function ensureTables() {
  if (!_pool) return;
  await _pool.query(`CREATE TABLE IF NOT EXISTS watcher_weights (key TEXT PRIMARY KEY, value REAL NOT NULL DEFAULT 0);`);
  await _pool.query(`CREATE TABLE IF NOT EXISTS watcher_stats (id INTEGER PRIMARY KEY DEFAULT 1, games INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, draws INTEGER NOT NULL DEFAULT 0, last_update BIGINT NOT NULL DEFAULT 0);`);
  await _pool.query(`CREATE TABLE IF NOT EXISTS watcher_tactical_mistakes (position_key TEXT NOT NULL, from_sq TEXT NOT NULL, to_sq TEXT NOT NULL, penalty REAL NOT NULL DEFAULT 0, seen INTEGER NOT NULL DEFAULT 1, updated_at BIGINT NOT NULL DEFAULT 0, PRIMARY KEY(position_key, from_sq, to_sq));`);
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
    const mRes = await _pool.query('SELECT position_key, from_sq, to_sq, penalty, seen, updated_at FROM watcher_tactical_mistakes ORDER BY updated_at DESC LIMIT $1', [MAX_MISTAKES]);
    mistakeMemory.clear();
    for (const row of mRes.rows) mistakeMemory.set(mistakeKey(row.position_key, row.from_sq, row.to_sq), { penalty: Number(row.penalty) || 0, seen: Number(row.seen) || 1, updated: Number(row.updated_at) || 0 });
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

function isPinned(state, r, c, white) {
  const k = findKing(state, white);
  if (!k) return false;
  if (r === k[0] && c === k[1]) return false;
  const p = state.board[r][c];
  if (!p || isWhite(p) !== white) return false;
  const copy = { board: state.board.map(row => row.slice()), turn: state.turn, castling: state.castling, ep: state.ep, half: state.half, full: state.full };
  copy.board[r][c] = null;
  return !isAttacked(state, k[0], k[1], !white) && isAttacked(copy, k[0], k[1], !white);
}

function isDefended(state, r, c, white) {
  for (let rr = 0; rr < 8; rr++) for (let cc = 0; cc < 8; cc++) {
    if (rr === r && cc === c) continue;
    const q = state.board[rr][cc]; if (!q || isWhite(q) !== white) continue;
    if (isPinned(state, rr, cc, white)) continue;
    if (pseudoMoves(state, rr, cc).some(([mr, mc]) => mr === r && mc === c)) return true;
  }
  return false;
}

function developmentScore(state, white) {
  let dev = 0;
  const startN = white ? [[7,1],[7,6]] : [[0,1],[0,6]];
  for (const [r, c] of startN) {
    if (state.board[r][c] !== (white ? 'N' : 'n')) dev += 1;
  }
  const startB = white ? [[7,2],[7,5]] : [[0,2],[0,5]];
  for (const [r, c] of startB) {
    if (state.board[r][c] !== (white ? 'B' : 'b')) dev += 1;
  }
  if (white) {
    if (state.board[4][3] === 'P') dev += 1;
    if (state.board[4][4] === 'P') dev += 1;
  } else {
    if (state.board[3][3] === 'p') dev += 1;
    if (state.board[3][4] === 'p') dev += 1;
  }
  return dev;
}

// ============================================================
// 🔥 TRANSPOSITION TABLE
// ============================================================
const TT_SIZE = 1 << 20;
const TT = {
  keys: new Int32Array(TT_SIZE),
  depths: new Int8Array(TT_SIZE),
  scores: new Int32Array(TT_SIZE),
  flags: new Int8Array(TT_SIZE),
  moves: new Int32Array(TT_SIZE),
  age: new Int32Array(TT_SIZE),
};
let ttAge = 0;

function hashState(state) {
  let h = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c];
    if (!p) continue;
    const idx = 'PNBRQKpnbrqk'.indexOf(p);
    h ^= (idx + 1) * (r * 8 + c + 1) * 0x9E3779B1;
  }
  h ^= state.turn === 'w' ? 0xABCD : 0x1234;
  h ^= (state.castling.length << 16);
  h ^= state.ep === '-' ? 0 : (state.ep.charCodeAt(0) << 20);
  return h >>> 0;
}

function ttStore(key, depth, score, flag, move, age) {
  const idx = key & (TT_SIZE - 1);
  if (TT.depths[idx] > depth && TT.age[idx] === age) return;
  TT.keys[idx] = key;
  TT.depths[idx] = depth;
  TT.scores[idx] = score;
  TT.flags[idx] = flag;
  TT.moves[idx] = move;
  TT.age[idx] = age;
}

function ttProbe(key, depth, alpha, beta, age) {
  const idx = key & (TT_SIZE - 1);
  if (TT.keys[idx] !== key || TT.age[idx] !== age) return null;
  if (TT.depths[idx] < depth) return null;
  const score = TT.scores[idx];
  const flag = TT.flags[idx];
  if (flag === 0) return score;
  if (flag === 1 && score >= beta) return beta;
  if (flag === 2 && score <= alpha) return alpha;
  return null;
}

function encodeMove(from, to) { return (from[0] << 12) | (from[1] << 8) | (to[0] << 4) | to[1]; }
function decodeMove(m) { return [[ (m >> 12) & 15, (m >> 8) & 15 ], [ (m >> 4) & 15, m & 15 ]]; }

// ============================================================
// 🔥 ОЦЕНКА
// ============================================================
function evaluate(state, forWhite) {
  let score = 0;
  let whitePieces = 0, blackPieces = 0;
  let whiteKing = null, blackKing = null;
  let totalPieces = 0;
  let whiteQueens = 0, blackQueens = 0;
  const wPawns = [0,0,0,0,0,0,0,0];
  const bPawns = [0,0,0,0,0,0,0,0];

  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p) continue;
    totalPieces++;
    const isW = isWhite(p);
    const material = PIECE_VALUES[p.toLowerCase()] || 0;
    const w = DATA.weights[`${p}_${sqName(r, c)}`] || 0;
    score += isW ? (material + w * 100) : -(material + w * 100);

    if (p === 'K') whiteKing = [r, c];
    if (p === 'k') blackKing = [r, c];
    if (p === 'Q') whiteQueens++;
    if (p === 'q') blackQueens++;
    if (p !== 'K' && p !== 'k') { if (isW) whitePieces++; else blackPieces++; }
    if (p === 'P') wPawns[c]++;
    if (p === 'p') bPawns[c]++;
  }

  // Потеря ферзя
  if (whiteQueens === 0 && blackQueens > 0) score -= 900;
  if (blackQueens === 0 && whiteQueens > 0) score += 900;

  // Пешечная структура
  for (let f = 0; f < 8; f++) {
    if (wPawns[f] > 1) score -= 15 * (wPawns[f] - 1);
    if (bPawns[f] > 1) score += 15 * (bPawns[f] - 1);
    if (wPawns[f] > 0 && (f === 0 || wPawns[f-1] === 0) && (f === 7 || wPawns[f+1] === 0)) score -= 20;
    if (bPawns[f] > 0 && (f === 0 || bPawns[f-1] === 0) && (f === 7 || bPawns[f+1] === 0)) score += 20;
  }

  // Бонус за развитие
  if (totalPieces > 20) {
    score += developmentScore(state, true) * 30;
    score -= developmentScore(state, false) * 30;
  }

  // Безопасность короля
  if (whitePieces + blackPieces > 8) {
    if (whiteKing) {
      const isCastled = whiteKing[0] === 7 && (whiteKing[1] === 6 || whiteKing[1] === 2);
      if (isCastled) score += 250;
      else if (whiteKing[0] < 7) score -= 150;
    }
    if (blackKing) {
      const isCastled = blackKing[0] === 0 && (blackKing[1] === 6 || blackKing[1] === 2);
      if (isCastled) score -= 250;
      else if (blackKing[0] > 0) score += 150;
    }
  }

  // Мобильность (миттельшпиль)
  if (whitePieces + blackPieces > 10 && whitePieces + blackPieces < 25) {
    let wMob = 0, bMob = 0;
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const p = state.board[r][c]; if (!p) continue;
      if (p.toLowerCase() === 'k' || p.toLowerCase() === 'p') continue;
      const mob = pseudoMoves(state, r, c).length;
      if (isWhite(p)) wMob += mob; else bMob += mob;
    }
    score += (wMob - bMob) * 3;
  }

  // Висяки
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p) continue;
    const isW = isWhite(p);
    const val = PIECE_VALUES[p.toLowerCase()] || 0;
    if (val < 300) continue;
    if (isAttacked(state, r, c, !isW)) {
      const defended = isDefended(state, r, c, isW);
      if (!defended) score += isW ? -val * 1.2 : val * 1.2;
      else score += isW ? -val * 0.1 : val * 0.1;
    }
  }

  return forWhite ? score : -score;
}

// ============================================================
// 🔥 QUIESCENCE
// ============================================================
function quiescence(state, alpha, beta, color, qdepth) {
  const standPat = evaluate(state, color === 1);
  if (standPat >= beta) return beta;
  if (alpha < standPat) alpha = standPat;
  if (qdepth <= 0) return alpha;

  const legal = allLegalMoves(state, color === 1);
  if (legal.length === 0) {
    if (inCheck(state, color === 1)) return -MATE_SCORE;
    return 0;
  }

  const capturesAndChecks = legal.filter(([from, to]) => {
    if (state.board[to[0]][to[1]]) return true;
    try {
      const next = applyMove(state, from, to);
      return inCheck(next, color !== 1);
    } catch(e) { return false; }
  });

  capturesAndChecks.sort((a, b) => {
    const attackerA = state.board[a[0][0]][a[0][1]].toLowerCase();
    const victimA = state.board[a[1][0]][a[1][1]];
    const scoreA = victimA ? (PIECE_VALUES[victimA.toLowerCase()] || 0) * 10 - (PIECE_VALUES[attackerA] || 0) : 0;
    const attackerB = state.board[b[0][0]][b[0][1]].toLowerCase();
    const victimB = state.board[b[1][0]][b[1][1]];
    const scoreB = victimB ? (PIECE_VALUES[victimB.toLowerCase()] || 0) * 10 - (PIECE_VALUES[attackerB] || 0) : 0;
    return scoreB - scoreA;
  });

  for (const [from, to] of capturesAndChecks) {
    try {
      const next = applyMove(state, from, to);
      const score = -quiescence(next, -beta, -alpha, -color, qdepth - 1);
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    } catch(e) {}
  }
  return alpha;
}

// ============================================================
// 🔥 NEGAMAX с ТТ и Check Extension
// ============================================================
function negamax(state, depth, alpha, beta, color, deadline, ply = 0) {
  if (Date.now() >= deadline) return evaluate(state, color === 1);

  const key = hashState(state);
  const probe = ttProbe(key, depth, alpha, beta, ttAge);
  if (probe !== null) return probe;

  const legal = allLegalMoves(state, color === 1);
  if (legal.length === 0) {
    if (inCheck(state, color === 1)) return -MATE_SCORE + ply;
    return 0;
  }

  const inChk = inCheck(state, color === 1);
  if (inChk && depth < 8) depth += 1;

  if (depth <= 0) return quiescence(state, alpha, beta, color, 4);

  const ttMove = TT.moves[key & (TT_SIZE - 1)];
  const ordered = legal.slice().sort((a, b) => {
    const aEnc = encodeMove(a[0], a[1]);
    const bEnc = encodeMove(b[0], b[1]);
    if (ttMove && aEnc === ttMove) return -1;
    if (ttMove && bEnc === ttMove) return 1;
    const aCap = state.board[a[1][0]][a[1][1]];
    const bCap = state.board[b[1][0]][b[1][1]];
    if (aCap && !bCap) return -1;
    if (!aCap && bCap) return 1;
    return 0;
  });

  let best = -Infinity;
  let bestMove = null;
  let flag = 2;

  for (const [from, to] of ordered) {
    try {
      const next = applyMove(state, from, to);
      let score = -negamax(next, depth - 1, -beta, -alpha, -color, deadline, ply + 1);
      
      const piece = state.board[from[0]][from[1]];
      if (piece && piece.toLowerCase() === 'q') {
        const attacked = isAttacked(next, to[0], to[1], color !== 1);
        const defended = isDefended(next, to[0], to[1], color === 1);
        if (attacked && !defended) score -= 5000;
      }
      
      if (score > best) { best = score; bestMove = [from, to]; }
      if (score > alpha) { alpha = score; flag = 0; }
      if (alpha >= beta) { flag = 1; break; }
    } catch(e) {}
    if (Date.now() >= deadline) break;
  }

  if (bestMove) {
    ttStore(key, depth, best, flag, encodeMove(bestMove[0], bestMove[1]), ttAge);
  }
  return best;
}

// ============================================================
// 🔥 MOVE SCORE
// ============================================================
function moveScore(state, from, to) {
  try {
    const attacker = state.board[from[0]][from[1]];
    if (!attacker) return 0;
    const victim = state.board[to[0]][to[1]];
    const isW = isWhite(attacker);
    let score = 0;

    if (victim) {
      const attackerVal = PIECE_VALUES[attacker.toLowerCase()] || 0;
      const victimVal = PIECE_VALUES[victim.toLowerCase()] || 0;
      score += 10000 + victimVal * 10 - attackerVal;
      
      if (attacker.toLowerCase() === 'q') {
        const next = applyMove(state, from, to);
        const defended = isDefended(next, to[0], to[1], isW);
        const attacked = isAttacked(next, to[0], to[1], !isW);
        if (attacked && !defended) score -= 5000;
      }
    }

    if (attacker.toLowerCase() === 'p' && (to[0] === 0 || to[0] === 7)) score += 9000;
    if (attacker.toLowerCase() === 'k' && Math.abs(to[1] - from[1]) === 2) return 50000;

    let totalPieces = 0;
    for (let r=0; r<8; r++) for (let c=0; c<8; c++) if (state.board[r][c]) totalPieces++;
    
    if (attacker.toLowerCase() === 'k' && totalPieces > 20 && !inCheck(state, isW)) score -= 200;
    if ((attacker === 'Q' || attacker === 'q') && totalPieces > 20) score -= 50;
    if (totalPieces > 20 && (attacker === 'N' || attacker === 'n' || attacker === 'B' || attacker === 'b')) score += 80;

    return score;
  } catch(e) { return 0; }
}

function tacticalSafetyPenalty(state, from, to, moverWhite) {
  try {
    const piece = state.board[from[0]][from[1]];
    if (!piece) return 0;
    const next = applyMove(state, from, to);
    const moved = next.board[to[0]][to[1]];
    if (!moved) return 0;
    const value = PIECE_VALUES[moved.toLowerCase()] || 0;
    if (value < 300) return 0;

    const oppLegal = allLegalMoves(next, !moverWhite);
    if (oppLegal.length === 0) return 0;

    let canBeCaptured = false;
    let cheapestAttacker = Infinity;
    for (const [[fr, fc], [tr, tc]] of oppLegal) {
      if (tr === to[0] && tc === to[1]) {
        canBeCaptured = true;
        cheapestAttacker = Math.min(cheapestAttacker, PIECE_VALUES[next.board[fr][fc].toLowerCase()] || 0);
      }
    }
    if (!canBeCaptured) return 0;

    const defended = isDefended(next, to[0], to[1], moverWhite);
    if (!defended) return Math.round(value * 1.5);
    if (Number.isFinite(cheapestAttacker) && cheapestAttacker < value) return Math.round((value - cheapestAttacker) * 0.8);
    return 0;
  } catch(e) { return 0; }
}

function learnedMistakePenalty(state, from, to) {
  try {
    const key = mistakeKey(positionKey(toFen(state)), sqName(from[0], from[1]), sqName(to[0], to[1]));
    const item = mistakeMemory.get(key);
    return item ? Math.min(1800, item.penalty * Math.min(1.5, 1 + Math.log2(Math.max(1, item.seen)) * 0.08)) : 0;
  } catch(e) { return 0; }
}

// ============================================================
// 🔥 PICK MOVE (Iterative Deepening)
// ============================================================
function pickMoveSearch(state, isWhiteTurn, timeMs) {
  const legal = allLegalMoves(state, isWhiteTurn);
  if (legal.length === 0) return null;
  if (legal.length === 1) return legal[0];

  const color = isWhiteTurn ? 1 : -1;
  const deadline = Date.now() + Math.max(100, timeMs);
  ttAge++;
  if (ttAge > 255) ttAge = 0;

  let bestMove = legal[0];
  let prevBest = null;

  for (let depth = 1; depth <= 8; depth++) {
    let alpha = -Infinity, beta = Infinity;
    let localBest = null, localBestScore = -Infinity;

    const ordered = legal.slice().sort((a, b) => {
      if (prevBest && a[0][0] === prevBest[0][0] && a[0][1] === prevBest[0][1] && a[1][0] === prevBest[1][0] && a[1][1] === prevBest[1][1]) return -1;
      if (prevBest && b[0][0] === prevBest[0][0] && b[0][1] === prevBest[0][1] && b[1][0] === prevBest[1][0] && b[1][1] === prevBest[1][1]) return 1;
      const sa = moveScore(state, a[0], a[1]);
      const sb = moveScore(state, b[0], b[1]);
      return sb - sa;
    });

    for (const [from, to] of ordered) {
      if (Date.now() >= deadline) break;
      try {
        const next = applyMove(state, from, to);
        let score = -negamax(next, depth - 1, -beta, -alpha, -color, deadline, 1);
        
        const safetyPenalty = tacticalSafetyPenalty(state, from, to, isWhiteTurn);
        if (safetyPenalty > 0) score -= safetyPenalty;
        const memoryPenalty = learnedMistakePenalty(state, from, to);
        if (memoryPenalty > 0) score -= memoryPenalty;
        
        if (score > localBestScore) { localBestScore = score; localBest = [from, to]; }
        if (score > alpha) alpha = score;
      } catch (e) {}
    }

    if (localBest) { bestMove = localBest; prevBest = localBest; }
    if (Date.now() >= deadline) break;
  }

  return bestMove;
}

// ============================================================
// SELF-PLAY (для обучения весов)
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

    const key = toFen(state).split(' ').slice(0, 4).join(' ');
    const count = (positionCounts.get(key) || 0) + 1;
    positionCounts.set(key, count);

    if (count >= 3) {
      const evalNow = evaluate(state, state.turn === 'w');
      if (Math.abs(evalNow) > 150) {
        const nonRepeating = legal.filter(([from, to]) => {
          const next = applyMove(state, from, to);
          const nextKey = toFen(next).split(' ').slice(0, 4).join(' ');
          return !positionCounts.has(nextKey) || positionCounts.get(nextKey) < 2;
        });
        if (nonRepeating.length > 0) {
          let bestMv = nonRepeating[0];
          let bestScore = -Infinity;
          const isW = state.turn === 'w';
          for (const [from, to] of nonRepeating) {
            const next = applyMove(state, from, to);
            const score = evaluate(next, !isW);
            if (score > bestScore) { bestScore = score; bestMv = [from, to]; }
          }
          const pieceMoved = state.board[bestMv[0][0]][bestMv[0][1]];
          const captured = state.board[bestMv[1][0]][bestMv[1][1]];
          const nextState = applyMove(state, bestMv[0], bestMv[1]);
          const causedCheck = inCheck(nextState, !isW);
          const isMate = causedCheck && allLegalMoves(nextState, !isW).length === 0;
          history.push({ white: isW, pieceMoved, captured, sqFrom: sqName(bestMv[0][0], bestMv[0][1]), sqTo: sqName(bestMv[1][0], bestMv[1][1]), causedCheck, isMate });
          state = nextState;
          moveLog.push({ from: bestMv[0], to: bestMv[1], byColor: isW ? 'w' : 'b', fenAfter: toFen(state) });
          continue;
        }
      }
      result = 0;
      break;
    }

    const isW = state.turn === 'w';
    const mv = pickMoveSearch(state, isW, 400);

    if (!mv || !Array.isArray(mv) || mv.length !== 2) break;
    if (!Array.isArray(mv[0]) || !Array.isArray(mv[1])) break;
    if (mv[0].length !== 2 || mv[1].length !== 2) break;

    const pieceMoved = state.board[mv[0][0]][mv[0][1]];
    const captured = state.board[mv[1][0]][mv[1][1]];
    const nextState = applyMove(state, mv[0], mv[1]);
    const causedCheck = inCheck(nextState, !isW);
    const isMate = causedCheck && allLegalMoves(nextState, !isW).length === 0;

    history.push({ white: isW, pieceMoved, captured, sqFrom: sqName(mv[0][0], mv[0][1]), sqTo: sqName(mv[1][0], mv[1][1]), causedCheck, isMate });
    state = nextState;
    finalEval = evaluate(state, state.turn === 'w');

    moveLog.push({ from: mv[0], to: mv[1], byColor: isW ? 'w' : 'b', fenAfter: toFen(state) });
  }

  let adjustedResult = result;
  if (result === 0 && Math.abs(finalEval) > 300) adjustedResult = finalEval > 0 ? 1 : -1;

  trainOnHistory(history, adjustedResult);

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
  const lr = 0.01;

  let whiteReward, blackReward;
  if (result === 1) { whiteReward = 1; blackReward = -1; }
  else if (result === -1) { whiteReward = -1; blackReward = 1; }
  else { whiteReward = 0; blackReward = 0; }

  for (const move of history) {
    const reward = move.white ? whiteReward : blackReward;
    const side = move.white ? 1 : -1;

    const checkBonus = move.causedCheck ? 0.1 : 0;
    const mateBonus = move.isMate ? 1.0 : 0;
    const total = reward + checkBonus + mateBonus;

    const keyFrom = `${move.pieceMoved}_${move.sqFrom}`;
    const keyTo = `${move.pieceMoved}_${move.sqTo}`;
    if (typeof DATA.weights[keyTo] !== 'number') DATA.weights[keyTo] = 0;
    if (typeof DATA.weights[keyFrom] !== 'number') DATA.weights[keyFrom] = 0;

    DATA.weights[keyTo] = Math.max(-3, Math.min(3, DATA.weights[keyTo] + lr * side * total));
    DATA.weights[keyFrom] = Math.max(-3, Math.min(3, DATA.weights[keyFrom] - lr * side * total * 0.5));
  }
}

// ============================================================
// API
// ============================================================
function getStats() {
  return {
    games: DATA.games, wins: DATA.wins, losses: DATA.losses, draws: DATA.draws,
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
    if (myTime < 2) thinkMs = 100;
    else if (myTime < 5) thinkMs = 200;
    else if (myTime < 10) thinkMs = 300;
    else if (myTime < 30) thinkMs = 500;
    else if (myTime < 60) thinkMs = 700;
    else thinkMs = 1000;

    const allowedByClock = (myTime + inc) * 0.1 * 1000;
    thinkMs = Math.min(thinkMs, allowedByClock);
    thinkMs = Math.max(100, thinkMs);

    const move = pickMoveSearch(state, color === 'w', thinkMs);
    
    if (!move || !Array.isArray(move) || move.length !== 2) {
      const fallbackMoves = allLegalMoves(state, color === 'w');
      if (fallbackMoves.length > 0) return { from: fallbackMoves[0][0], to: fallbackMoves[0][1] };
      return null;
    }
    
    if (!Array.isArray(move[0]) || !Array.isArray(move[1])) return null;
    if (move[0].length !== 2 || move[1].length !== 2) return null;
    return { from: move[0], to: move[1] };
  } catch (e) {
    console.error('[Watcher] pickMoveForServer error:', e.message);
    try {
      const state = parseFen(fen);
      const fallbackMoves = allLegalMoves(state, color === 'w');
      if (fallbackMoves.length > 0) return { from: fallbackMoves[0][0], to: fallbackMoves[0][1] };
    } catch (e2) {}
    return null;
  }
}

function startEpisode() {}
function recordTransition() {}
function learnFromObservedMove(prevFen, move, newFen, moverColor, timeControl, evalAfter) {
  try {
    if (!prevFen || !newFen || !move || !move.from || !move.to) return;
    const before = parseFen(prevFen), after = parseFen(newFen);
    const moverWhite = moverColor === 'w';
    const from = Array.isArray(move.from) ? move.from : [8 - Number(String(move.from).slice(1)), String(move.from).charCodeAt(0) - 97];
    const to = Array.isArray(move.to) ? move.to : [8 - Number(String(move.to).slice(1)), String(move.to).charCodeAt(0) - 97];
    if (!before.board[from[0]] || !after.board[to[0]]) return;
    const beforeEval = evaluate(before, moverWhite);
    const afterEval = evaluate(after, moverWhite);
    const drop = beforeEval - afterEval;
    let hanging = 0;
    const p = after.board[to[0]][to[1]];
    if (p && isWhite(p) === moverWhite && (PIECE_VALUES[p.toLowerCase()] || 0) >= 300 && isAttacked(after, to[0], to[1], !moverWhite)) {
      const defended = isDefended(after, to[0], to[1], moverWhite);
      if (!defended) hanging = Math.round((PIECE_VALUES[p.toLowerCase()] || 0) * 1.5);
    }
    const penalty = Math.max(drop > 220 ? drop : 0, hanging);
    if (penalty >= 250) recordMistake(positionKey(prevFen), sqName(from[0], from[1]), sqName(to[0], to[1]), penalty);
  } catch (e) {}
}
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
