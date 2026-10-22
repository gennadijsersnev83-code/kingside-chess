// bot-worker.js
const { parentPort } = require('worker_threads');

// ============================================================
// PIECE VALUES & PIECE-SQUARE TABLES
// ============================================================
const PIECE_VALUES = { 'p': 100, 'n': 320, 'b': 330, 'r': 500, 'q': 900, 'k': 20000 };

const PST = {
  p: [[0,0,0,0,0,0,0,0],[50,50,50,50,50,50,50,50],[10,10,20,30,30,20,10,10],[5,5,10,25,25,10,5,5],[0,0,0,20,20,0,0,0],[5,-5,-10,0,0,-10,-5,5],[5,10,10,-20,-20,10,10,5],[0,0,0,0,0,0,0,0]],
  n: [[-50,-40,-30,-30,-30,-30,-40,-50],[-40,-20,0,0,0,0,-20,-40],[-30,0,10,15,15,10,0,-30],[-30,5,15,20,20,15,5,-30],[-30,0,15,20,20,15,0,-30],[-30,5,10,15,15,10,5,-30],[-40,-20,0,5,5,0,-20,-40],[-50,-40,-30,-30,-30,-30,-40,-50]],
  b: [[-20,-10,-10,-10,-10,-10,-10,-20],[-10,0,0,0,0,0,0,-10],[-10,0,5,10,10,5,0,-10],[-10,5,5,10,10,5,5,-10],[-10,0,10,10,10,10,0,-10],[-10,10,10,10,10,10,10,-10],[-10,5,0,0,0,0,5,-10],[-20,-10,-10,-10,-10,-10,-10,-20]],
  r: [[0,0,0,0,0,0,0,0],[5,10,10,10,10,10,10,5],[-5,0,0,0,0,0,0,-5],[-5,0,0,0,0,0,0,-5],[-5,0,0,0,0,0,0,-5],[-5,0,0,0,0,0,0,-5],[-5,0,0,0,0,0,0,-5],[0,0,0,5,5,0,0,0]],
  q: [[-20,-10,-10,-5,-5,-10,-10,-20],[-10,0,0,0,0,0,0,-10],[-10,0,5,5,5,5,0,-10],[-5,0,5,5,5,5,0,-5],[0,0,5,5,5,5,0,-5],[-10,5,5,5,5,5,0,-10],[-10,0,5,0,0,0,0,-10],[-20,-10,-10,-5,-5,-10,-10,-20]],
  k: [[-30,-40,-40,-50,-50,-40,-40,-30],[-30,-40,-40,-50,-50,-40,-40,-30],[-30,-40,-40,-50,-50,-40,-40,-30],[-30,-40,-40,-50,-50,-40,-40,-30],[-20,-30,-30,-40,-40,-30,-30,-20],[-10,-20,-20,-20,-20,-20,-20,-10],[20,20,0,0,0,0,20,20],[20,30,10,0,0,10,30,20]]
};

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

// ============================================================
// TRANSPOSITION TABLE
// ============================================================
const TT_CACHE = new Map();
const TT_MAX = 800000;
function ttKey(state) {
  const boardStr = state.board.map(row => row.map(c => c || '.').join('')).join('/');
  return boardStr + '|' + state.turn + '|' + state.castling + '|' + state.ep;
}
function ttGet(k) { return TT_CACHE.get(k); }
function ttSet(k, d, s, flag) {
  if (TT_CACHE.size > TT_MAX) {
    let i = 0;
    for (const key of TT_CACHE.keys()) {
      TT_CACHE.delete(key);
      if (++i > TT_MAX / 2) break;
    }
  }
  TT_CACHE.set(k, { depth: d, score: s, flag });
}

// ============================================================
// FEN / BOARD UTILITIES
// ============================================================
function botParseFen(fen) {
  const parts = fen.split(' ');
  const board = Array.from({length:8}, () => Array(8).fill(null));
  parts[0].split('/').forEach((row, r) => { let f = 0; for (const ch of row) { if (/\d/.test(ch)) f += +ch; else board[r][f++] = ch; } });
  return { board, turn: parts[1], castling: parts[2], ep: parts[3], half: +parts[4] || 0, full: +parts[5] || 1 };
}
function botToFen(state) {
  const rows = state.board.map(r => { let s = '', e = 0; for (const c of r) { if (c) { if (e) { s += e; e = 0; } s += c; } else e++; } if (e) s += e; return s; }).join('/');
  return [rows, state.turn, state.castling, state.ep, state.half, state.full].join(' ');
}
const botIsWhite = p => !!p && p === p.toUpperCase();
const botInBoard = (r,c) => r >= 0 && r < 8 && c >= 0 && c < 8;

// ============================================================
// MOVE GENERATION
// ============================================================
function botPseudoMoves(state, r, c) {
  const p = state.board[r][c]; if (!p) return [];
  const moves = []; const white = botIsWhite(p); const type = p.toLowerCase();
  const dir = white ? -1 : 1;
  const add = (rr, cc) => { if (!botInBoard(rr, cc)) return false; const t = state.board[rr][cc]; if (t && botIsWhite(t) === white) return false; moves.push([rr, cc]); return !t; };
  if (type === 'p') {
    const startRow = white ? 6 : 1, oneR = r + dir;
    if (botInBoard(oneR, c) && !state.board[oneR][c]) {
      moves.push([oneR, c]);
      const twoR = r + 2 * dir;
      if (r === startRow && botInBoard(twoR, c) && !state.board[twoR][c]) moves.push([twoR, c]);
    }
    for (const dc of [-1, 1]) {
      const rr = r + dir, cc = c + dc;
      if (!botInBoard(rr, cc)) continue;
      const t = state.board[rr][cc];
      if (t && botIsWhite(t) !== white) moves.push([rr, cc]);
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

function botFindKing(state, white) {
  const k = white ? 'K' : 'k';
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (state.board[r][c] === k) return [r, c];
  return null;
}

function botIsAttacked(state, r, c, byWhite) {
  for (let rr = 0; rr < 8; rr++) for (let cc = 0; cc < 8; cc++) {
    const p = state.board[rr][cc]; if (!p || botIsWhite(p) !== byWhite) continue;
    const t = p.toLowerCase();
    if (t === 'p') { const dir = byWhite ? -1 : 1; if (rr + dir === r && (cc - 1 === c || cc + 1 === c)) return true; continue; }
    if (t === 'k') { if (Math.abs(rr - r) <= 1 && Math.abs(cc - c) <= 1 && (rr !== r || cc !== c)) return true; continue; }
    if (t === 'n') { const dr = Math.abs(rr - r), dc = Math.abs(cc - c); if ((dr === 2 && dc === 1) || (dr === 1 && dc === 2)) return true; continue; }
    if (t === 'r' || t === 'q') {
      if (rr === r) { let ok = true; for (let x = Math.min(cc, c) + 1; x < Math.max(cc, c); x++) if (state.board[rr][x]) { ok = false; break; } if (ok) return true; }
      if (cc === c) { let ok = true; for (let y = Math.min(rr, r) + 1; y < Math.max(rr, r); y++) if (state.board[y][cc]) { ok = false; break; } if (ok) return true; }
    }
    if (t === 'b' || t === 'q') {
      if (Math.abs(rr - r) === Math.abs(cc - c)) {
        const dr = rr < r ? 1 : -1, dc = cc < c ? 1 : -1;
        let y = rr + dr, x = cc + dc, ok = true;
        while (y !== r && x !== c) { if (state.board[y][x]) { ok = false; break; } y += dr; x += dc; }
        if (ok) return true;
      }
    }
  }
  return false;
}

function botInCheck(state, white) { const k = botFindKing(state, white); if (!k) return false; return botIsAttacked(state, k[0], k[1], !white); }

// ============================================================
// MOVE APPLICATION
// ============================================================
function botApplyMove(state, from, to) {
  const copy = { board: state.board.map(row => row.slice()), turn: state.turn, castling: state.castling, ep: state.ep, half: state.half, full: state.full };
  const [fr, fc] = from, [tr, tc] = to;
  const p = copy.board[fr][fc]; const white = botIsWhite(p); const type = p.toLowerCase();
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
  if (!cast || cast === '') cast = '-';
  let ep = '-';
  if (type === 'p' && Math.abs(tr - fr) === 2) ep = String.fromCharCode(97 + fc) + (8 - (fr + (tr - fr) / 2));
  const wasCapture = !!state.board[tr][tc] || (type === 'p' && fc !== tc);
  const half = (type === 'p' || wasCapture) ? 0 : (state.half + 1);
  copy.castling = cast; copy.ep = ep; copy.turn = white ? 'b' : 'w'; copy.half = half;
  if (!white) copy.full += 1;
  return copy;
}

function botLegalMovesFor(state, r, c) {
  const p = state.board[r][c]; if (!p) return [];
  const white = botIsWhite(p);
  return botPseudoMoves(state, r, c).filter(([rr, cc]) => !botInCheck(botApplyMove(state, [r, c], [rr, cc]), white));
}

function botAllLegalMoves(state, white) {
  const res = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p || botIsWhite(p) !== white) continue;
    for (const [rr, cc] of botLegalMovesFor(state, r, c)) res.push([[r,c],[rr,cc]]);
  }
  return res;
}

// ============================================================
// EVALUATION
// ============================================================
function materialOf(state) {
  let w = 0, b = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p) continue;
    const t = p.toLowerCase();
    if (t === 'k') continue;
    const v = PIECE_VALUES[t] || 0;
    if (botIsWhite(p)) w += v; else b += v;
  }
  return { w, b };
}

function botEval(state) {
  let score = 0;
  let whiteBishops = 0, blackBishops = 0;
  const whitePawnsByFile = [0,0,0,0,0,0,0,0];
  const blackPawnsByFile = [0,0,0,0,0,0,0,0];
  const whitePawnRanks = [];
  const blackPawnRanks = [];
  const wK = botFindKing(state, true);
  const bK = botFindKing(state, false);
  const totalMat = materialOf(state);
  const endgame = (totalMat.w + totalMat.b) <= 2400;

  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p) continue;
    const white = botIsWhite(p); const t = p.toLowerCase();
    let v = PIECE_VALUES[t] || 0;
    if (t === 'k') {
      const table = endgame ? KING_ENDGAME_PST : PST.k;
      const rr = white ? r : 7 - r;
      v += table[rr][c];
    } else {
      const table = PST[t];
      if (table) { const rr = white ? r : 7 - r; v += table[rr][c]; }
      if (t === 'p') {
        const rank = white ? (7 - r) : r;
        if (rank >= 4) v += (rank - 3) * 15;
        if (white) { whitePawnsByFile[c]++; whitePawnRanks.push([r, c]); }
        else { blackPawnsByFile[c]++; blackPawnRanks.push([r, c]); }
      }
    }
    if (t === 'b') { if (white) whiteBishops++; else blackBishops++; }
    score += white ? v : -v;
  }

  if (whiteBishops >= 2) score += 30;
  if (blackBishops >= 2) score -= 30;

  for (let f = 0; f < 8; f++) {
    if (whitePawnsByFile[f] > 1) score -= 15 * (whitePawnsByFile[f] - 1);
    if (blackPawnsByFile[f] > 1) score += 15 * (blackPawnsByFile[f] - 1);
  }

  for (let f = 0; f < 8; f++) {
    if (whitePawnsByFile[f] > 0) {
      const left = f > 0 ? whitePawnsByFile[f-1] : 0;
      const right = f < 7 ? whitePawnsByFile[f+1] : 0;
      if (left === 0 && right === 0) score -= 20;
    }
    if (blackPawnsByFile[f] > 0) {
      const left = f > 0 ? blackPawnsByFile[f-1] : 0;
      const right = f < 7 ? blackPawnsByFile[f+1] : 0;
      if (left === 0 && right === 0) score += 20;
    }
  }

  for (const [r, c] of whitePawnRanks) {
    let passed = true;
    for (const [br, bc] of blackPawnRanks) {
      if ((bc === c || bc === c - 1 || bc === c + 1) && br < r) { passed = false; break; }
    }
    if (passed) {
      const rank = 7 - r;
      const bonus = [0, 10, 20, 35, 60, 100, 160, 0][rank];
      score += bonus;
    }
  }
  for (const [r, c] of blackPawnRanks) {
    let passed = true;
    for (const [wr, wc] of whitePawnRanks) {
      if ((wc === c || wc === c - 1 || wc === c + 1) && wr > r) { passed = false; break; }
    }
    if (passed) {
      const rank = r;
      const bonus = [0, 10, 20, 35, 60, 100, 160, 0][rank];
      score -= bonus;
    }
  }

  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p) continue;
    if (p.toLowerCase() !== 'r') continue;
    const white = botIsWhite(p);
    const ownPawns = white ? whitePawnsByFile : blackPawnsByFile;
    const oppPawns = white ? blackPawnsByFile : whitePawnsByFile;
    if (ownPawns[c] === 0 && oppPawns[c] === 0) score += white ? 25 : -25;
    else if (ownPawns[c] === 0) score += white ? 12 : -12;
  }

  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p) continue;
    if (p.toLowerCase() !== 'b') continue;
    const white = botIsWhite(p);
    let blocked = 0;
    const dirs = [[-1,-1],[-1,1],[1,-1],[1,1]];
    for (const [dr, dc] of dirs) {
      let rr = r + dr, cc = c + dc;
      while (botInBoard(rr, cc)) {
        const q = state.board[rr][cc];
        if (q) { if (q.toLowerCase() === 'p' && botIsWhite(q) === white) blocked++; break; }
        rr += dr; cc += dc;
      }
    }
    if (blocked >= 2) score += white ? -10 : 10;
  }

  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p) continue;
    if (p.toLowerCase() === 'q') {
      const centerBonus = (3.5 - Math.abs(r - 3.5)) + (3.5 - Math.abs(c - 3.5));
      score += botIsWhite(p) ? centerBonus * 2 : -centerBonus * 2;
    }
  }

  if (!endgame) {
    if (wK) {
      const shieldW = [[wK[0]-1, wK[1]-1],[wK[0]-1, wK[1]],[wK[0]-1, wK[1]+1]]
        .reduce((acc, [rr, cc]) => acc + ((botInBoard(rr, cc) && state.board[rr][cc] === 'P') ? 1 : 0), 0);
      score += shieldW * 10;
    }
    if (bK) {
      const shieldB = [[bK[0]+1, bK[1]-1],[bK[0]+1, bK[1]],[bK[0]+1, bK[1]+1]]
        .reduce((acc, [rr, cc]) => acc + ((botInBoard(rr, cc) && state.board[rr][cc] === 'p') ? 1 : 0), 0);
      score -= shieldB * 10;
    }
  }

  let wm = 0, bm = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p) continue;
    const n = botPseudoMoves(state, r, c).length;
    if (botIsWhite(p)) wm += n; else bm += n;
  }
  score += (wm - bm) * 2;

  if (botInCheck(state, true)) score -= 200;
  if (botInCheck(state, false)) score += 200;

  if (state.half >= 100) score = 0;

  return score;
}

// ============================================================
// OPENING BOOK
// ============================================================
const OPENING_BOOK = [
  { line: 'e2e4', weight: 40 },
  { line: 'e2e4 e7e5 g1f3', weight: 30 },
  { line: 'e2e4 e7e5 g1f3 b8c6 f1b5', weight: 20 },
  { line: 'e2e4 e7e5 g1f3 b8c6 f1c4', weight: 15 },
  { line: 'e2e4 e7e5 g1f3 b8c6 d2d4', weight: 10 },
  { line: 'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6', weight: 10 },
  { line: 'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4', weight: 6 },
  { line: 'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5c6', weight: 4 },
  { line: 'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5', weight: 10 },
  { line: 'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3', weight: 6 },
  { line: 'e2e4 e7e5 g1f3 b8c6 d2d4 e5d4 f3d4', weight: 8 },
  { line: 'e2e4 e7e5 g1f3 b8c6 d2d4 e5d4 f3d4 g8f6', weight: 5 },
  { line: 'e2e4 e7e5 g1f3 b8c6 d2d4 e5d4 f3d4 f8c5', weight: 4 },
  { line: 'e2e4 e7e5 g1f3 g8f6', weight: 8 },
  { line: 'e2e4 e7e5 g1f3 g8f6 f3e5 d7d6', weight: 5 },
  { line: 'e2e4 e7e5 g1f3 d7d6', weight: 6 },
  { line: 'e2e4 e7e5 g1f3 d7d6 d2d4', weight: 4 },
  { line: 'e2e4 e7e5 f1c4', weight: 5 },
  { line: 'e2e4 e7e5 b1c3', weight: 4 },
  { line: 'e2e4 c7c5', weight: 25 },
  { line: 'e2e4 c7c5 g1f3 d7d6', weight: 15 },
  { line: 'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4', weight: 12 },
  { line: 'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6', weight: 10 },
  { line: 'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3', weight: 8 },
  { line: 'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6', weight: 6 },
  { line: 'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 g7g6', weight: 5 },
  { line: 'e2e4 c7c5 g1f3 b8c6', weight: 10 },
  { line: 'e2e4 c7c5 g1f3 b8c6 d2d4 c5d4 f3d4', weight: 8 },
  { line: 'e2e4 c7c5 g1f3 b8c6 d2d4 c5d4 f3d4 g7g6', weight: 4 },
  { line: 'e2e4 c7c5 g1f3 b8c6 f1b5', weight: 6 },
  { line: 'e2e4 c7c5 g1f3 e7e6', weight: 6 },
  { line: 'e2e4 c7c5 g1f3 e7e6 d2d4 c5d4 f3d4', weight: 4 },
  { line: 'e2e4 c7c5 c2c3', weight: 5 },
  { line: 'e2e4 c7c5 c2c3 d7d5', weight: 4 },
  { line: 'e2e4 c7c5 b1c3', weight: 4 },
  { line: 'e2e4 e7e6', weight: 12 },
  { line: 'e2e4 e7e6 d2d4 d7d5', weight: 10 },
  { line: 'e2e4 e7e6 d2d4 d7d5 b1c3', weight: 6 },
  { line: 'e2e4 e7e6 d2d4 d7d5 b1d2', weight: 4 },
  { line: 'e2e4 e7e6 d2d4 d7d5 e4e5', weight: 3 },
  { line: 'e2e4 c7c6', weight: 12 },
  { line: 'e2e4 c7c6 d2d4 d7d5', weight: 10 },
  { line: 'e2e4 c7c6 d2d4 d7d5 b1c3', weight: 5 },
  { line: 'e2e4 c7c6 d2d4 d7d5 e4e5', weight: 4 },
  { line: 'e2e4 c7c6 d2d4 d7d5 b1d2', weight: 4 },
  { line: 'e2e4 d7d6', weight: 5 },
  { line: 'e2e4 d7d6 d2d4 g8f6', weight: 3 },
  { line: 'e2e4 g7g6', weight: 5 },
  { line: 'e2e4 g8f6', weight: 4 },
  { line: 'e2e4 g8f6 e4e5 f6d5 d2d4', weight: 3 },
  { line: 'e2e4 d7d5', weight: 4 },
  { line: 'e2e4 d7d5 e4d5 d8d5 b1c3', weight: 3 },
  { line: 'd2d4', weight: 30 },
  { line: 'd2d4 d7d5', weight: 20 },
  { line: 'd2d4 d7d5 c2c4', weight: 18 },
  { line: 'd2d4 d7d5 c2c4 e7e6', weight: 12 },
  { line: 'd2d4 d7d5 c2c4 e7e6 b1c3', weight: 8 },
  { line: 'd2d4 d7d5 c2c4 e7e6 b1c3 g8f6', weight: 6 },
  { line: 'd2d4 d7d5 c2c4 e7e6 b1c3 g8f6 c1g5', weight: 4 },
  { line: 'd2d4 d7d5 c2c4 d5c4', weight: 6 },
  { line: 'd2d4 d7d5 c2c4 c7c6', weight: 8 },
  { line: 'd2d4 d7d5 c2c4 c7c6 g1f3', weight: 5 },
  { line: 'd2d4 d7d5 c2c4 c7c6 b1c3', weight: 4 },
  { line: 'd2d4 d7d5 g1f3', weight: 6 },
  { line: 'd2d4 d7d5 g1f3 g8f6', weight: 4 },
  { line: 'd2d4 d7d5 c1f4', weight: 3 },
  { line: 'd2d4 g8f6', weight: 15 },
  { line: 'd2d4 g8f6 c2c4', weight: 12 },
  { line: 'd2d4 g8f6 c2c4 g7g6', weight: 8 },
  { line: 'd2d4 g8f6 c2c4 g7g6 b1c3', weight: 6 },
  { line: 'd2d4 g8f6 c2c4 g7g6 b1c3 d7d5', weight: 4 },
  { line: 'd2d4 g8f6 c2c4 g7g6 b1c3 f8g7', weight: 4 },
  { line: 'd2d4 g8f6 c2c4 e7e6', weight: 10 },
  { line: 'd2d4 g8f6 c2c4 e7e6 b1c3', weight: 8 },
  { line: 'd2d4 g8f6 c2c4 e7e6 b1c3 f8b4', weight: 5 },
  { line: 'd2d4 g8f6 c2c4 e7e6 g1f3', weight: 5 },
  { line: 'd2d4 g8f6 c2c4 e7e6 g1f3 b7b6', weight: 3 },
  { line: 'd2d4 g8f6 c2c4 c7c5', weight: 4 },
  { line: 'd2d4 g8f6 c2c4 d7d5', weight: 4 },
  { line: 'd2d4 f7f5', weight: 4 },
  { line: 'd2d4 f7f5 c2c4', weight: 3 },
  { line: 'd2d4 e7e6', weight: 4 },
  { line: 'd2d4 e7e6 c2c4', weight: 3 },
  { line: 'd2d4 c7c5', weight: 4 },
  { line: 'd2d4 c7c5 d4d5', weight: 3 },
  { line: 'c2c4', weight: 12 },
  { line: 'c2c4 e7e5', weight: 6 },
  { line: 'c2c4 e7e5 b1c3', weight: 4 },
  { line: 'c2c4 g8f6', weight: 6 },
  { line: 'c2c4 g8f6 b1c3', weight: 5 },
  { line: 'c2c4 g8f6 b1c3 g7g6', weight: 3 },
  { line: 'c2c4 c7c5', weight: 5 },
  { line: 'c2c4 e7e6', weight: 4 },
  { line: 'c2c4 e7e6 b1c3', weight: 3 },
  { line: 'c2c4 g7g6', weight: 3 },
  { line: 'g1f3', weight: 8 },
  { line: 'g1f3 d7d5', weight: 5 },
  { line: 'g1f3 d7d5 g2g3', weight: 3 },
  { line: 'g1f3 g8f6', weight: 4 },
  { line: 'g1f3 g8f6 c2c4', weight: 3 },
  { line: 'g1f3 c7c5', weight: 4 },
  { line: 'g1f3 c7c5 c2c4', weight: 3 },
  { line: 'g2g3', weight: 3 },
  { line: 'g2g3 d7d5', weight: 2 },
  { line: 'b2b3', weight: 2 },
  { line: 'b2b3 e7e5', weight: 2 }
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
  const f = String.fromCharCode(97 + from[1]) + (8 - from[0]);
  const t = String.fromCharCode(97 + to[1]) + (8 - to[0]);
  return f + t;
}

function uciToMove(uci) {
  if (!uci || uci.length < 4) return null;
  const fc = uci.charCodeAt(0) - 97;
  const fr = 8 - parseInt(uci[1], 10);
  const tc = uci.charCodeAt(2) - 97;
  const tr = 8 - parseInt(uci[3], 10);
  if (!botInBoard(fr, fc) || !botInBoard(tr, tc)) return null;
  return [[fr, fc], [tr, tc]];
}

function bookMove(fen, historyLine) {
  if (!historyLine) return null;
  const trimmed = historyLine.trim();
  const parts = trimmed ? trimmed.split(' ') : [];
  for (let len = parts.length; len >= 1; len--) {
    const prefix = parts.slice(0, len).join(' ');
    const candidates = OPENING_INDEX.get(prefix);
    if (!candidates || !candidates.length) continue;
    const state = botParseFen(fen);
    const legal = botAllLegalMoves(state, state.turn === 'w');
    const legalSet = new Set(legal.map(([f, t]) => uciFromTo(f, t)));
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
// OPENING HEURISTIC (fallback)
// ============================================================
function openingHeuristic(state, from, to, moveCount) {
  if (moveCount > 12) return 0;
  const piece = state.board[from[0]][from[1]];
  if (!piece) return 0;
  const white = botIsWhite(piece);
  const type = piece.toLowerCase();
  let bonus = 0;
  const target = state.board[to[0]][to[1]];
  if (target) return 0;

  if (type === 'n' || type === 'b') {
    const homeRow = white ? 7 : 0;
    if (from[0] === homeRow) bonus += 18;
    else bonus -= 6;
    if (type === 'n' && ((to[0] === 3 || to[0] === 4) && (to[1] === 2 || to[1] === 5))) bonus += 8;
  }
  if (type === 'q') {
    const homeRow = white ? 7 : 0;
    if (from[0] === homeRow) bonus -= 40;
    const developedKnights = (() => {
      let n = 0;
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        const p = state.board[r][c]; if (!p) continue;
        if (p.toLowerCase() !== 'n') continue;
        if (botIsWhite(p) !== white) continue;
        const hr = white ? 7 : 0;
        if (r !== hr) n++;
      }
      return n;
    })();
    if (developedKnights < 2) bonus -= 25;
    if (moveCount <= 4) bonus -= 30;
    if ((to[0] === 3 || to[0] === 4) && (to[1] === 3 || to[1] === 4) && moveCount <= 8) bonus -= 40;
  }
  if (type === 'r' && moveCount <= 8) {
    const castlingDone = white ? !state.castling.includes('K') && !state.castling.includes('Q') : !state.castling.includes('k') && !state.castling.includes('q');
    if (!castlingDone) bonus -= 15;
  }
  if (type === 'k' && Math.abs(to[1] - from[1]) === 2) bonus += 50;
  if (type === 'k' && Math.abs(to[1] - from[1]) !== 2 && moveCount <= 10) bonus -= 30;
  if (type === 'p') {
    if ((to[1] === 3 || to[1] === 4) && (to[0] === 3 || to[0] === 4)) bonus += 12;
    const homeRow = white ? 6 : 1;
    const twoStep = Math.abs(to[0] - from[0]) === 2;
    if (from[0] === homeRow && !twoStep) bonus -= 4;
  }
  return bonus;
}

// ============================================================
// SEARCH
// ============================================================
function moveScore(state, from, to) {
  const target = state.board[to[0]][to[1]];
  const piece = state.board[from[0]][from[1]];
  if (!target) return 0;
  const victimVal = PIECE_VALUES[target.toLowerCase()] || 0;
  const attackerVal = PIECE_VALUES[piece.toLowerCase()] || 0;
  return victimVal * 10 - attackerVal;
}

const KILLER = new Map();
const HISTORY = new Map();

function historyKey(from, to) { return from[0] + '' + from[1] + to[0] + '' + to[1]; }

function orderMoves(state, moves, depth, ply, ttMove) {
  const scored = moves.map(([from, to]) => {
    let s = 0;
    if (ttMove && ttMove[0][0] === from[0] && ttMove[0][1] === from[1] && ttMove[1][0] === to[0] && ttMove[1][1] === to[1]) s += 100000;
    const cap = state.board[to[0]][to[1]];
    if (cap) s += 10000 + (PIECE_VALUES[cap.toLowerCase()] || 0) * 10 - (PIECE_VALUES[state.board[from[0]][from[1]].toLowerCase()] || 0);
    const hk = depth + '|' + historyKey(from, to);
    s += (HISTORY.get(hk) || 0);
    const killers = KILLER.get(depth) || [];
    for (const [kf, kt] of killers) {
      if (kf[0] === from[0] && kf[1] === from[1] && kt[0] === to[0] && kt[1] === to[1]) s += 500;
    }
    return { from, to, s };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored.map(x => [x.from, x.to]);
}

function botQuiescence(state, alpha, beta, depthLeft, qdepth) {
  const stand = botEval(state);
  if (depthLeft <= 0 || qdepth >= 4) return stand;
  const white = state.turn === 'w';
  if (white) {
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
  } else {
    if (stand <= alpha) return alpha;
    if (stand < beta) beta = stand;
  }

  const moves = botAllLegalMoves(state, white);
  const captures = moves.filter(([f, t]) => {
    const target = state.board[t[0]][t[1]];
    const piece = state.board[f[0]][f[1]];
    if (target) return true;
    if (piece && piece.toLowerCase() === 'p' && f[1] !== t[1]) return true;
    return false;
  });
  captures.sort((a, b) => moveScore(state, b[0], b[1]) - moveScore(state, a[0], a[1]));

  if (white) {
    for (const [from, to] of captures) {
      const next = botApplyMove(state, from, to);
      const score = botQuiescence(next, alpha, beta, depthLeft - 1, qdepth + 1);
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  } else {
    for (const [from, to] of captures) {
      const next = botApplyMove(state, from, to);
      const score = botQuiescence(next, alpha, beta, depthLeft - 1, qdepth + 1);
      if (score <= alpha) return alpha;
      if (score < beta) beta = score;
    }
    return beta;
  }
}

let SEARCH_DEADLINE = 0;
let SEARCH_ABORTED = false;

function botMinimax(state, depth, alpha, beta, ply, ttMove, moveCount) {
  if (Date.now() > SEARCH_DEADLINE) { SEARCH_ABORTED = true; return botEval(state); }

  const key = ttKey(state);
  const cached = ttGet(key);
  const alphaOrig = alpha, betaOrig = beta;
  if (cached && cached.depth >= depth) {
    if (cached.flag === 'EXACT') return cached.score;
    if (cached.flag === 'LOWER' && cached.score > alpha) alpha = cached.score;
    if (cached.flag === 'UPPER' && cached.score < beta) beta = cached.score;
    if (alpha >= beta) return cached.score;
  }

  if (depth <= 0) return botQuiescence(state, alpha, beta, 3, 0);

  const white = state.turn === 'w';
  let moves = botAllLegalMoves(state, white);
  if (!moves.length) {
    if (botInCheck(state, white)) return white ? -100000 + ply : 100000 - ply;
    return 0;
  }
  moves = orderMoves(state, moves, depth, ply, ttMove);

  let best;
  if (white) {
    best = -Infinity;
    for (let i = 0; i < moves.length; i++) {
      const [from, to] = moves[i];
      const next = botApplyMove(state, from, to);
      const isCapture = !!state.board[to[0]][to[1]];
      const givesCheck = botInCheck(next, false);
      const isPromo = state.board[from[0]][from[1]] && state.board[from[0]][from[1]].toLowerCase() === 'p' && (to[0] === 0 || to[0] === 7);

      let extension = 0;
      if (givesCheck && depth >= 3) extension = 1;
      else if (isPromo) extension = 1;

      let reduction = 0;
      if (!isCapture && !givesCheck && i >= 6 && depth >= 3) reduction = 1;

      const score = botMinimax(next, depth - 1 + extension - reduction, alpha, beta, ply + 1, null, moveCount + 1);
      if (SEARCH_ABORTED) return best;
      if (score > best) best = score;
      if (best > alpha) alpha = best;
      if (beta <= alpha) {
        if (!isCapture) {
          const k = KILLER.get(depth) || [];
          k.unshift([from, to]); if (k.length > 2) k.pop();
          KILLER.set(depth, k);
          const hk = depth + '|' + historyKey(from, to);
          HISTORY.set(hk, (HISTORY.get(hk) || 0) + depth * depth);
        }
        break;
      }
    }
  } else {
    best = Infinity;
    for (let i = 0; i < moves.length; i++) {
      const [from, to] = moves[i];
      const next = botApplyMove(state, from, to);
      const isCapture = !!state.board[to[0]][to[1]];
      const givesCheck = botInCheck(next, true);
      const isPromo = state.board[from[0]][from[1]] && state.board[from[0]][from[1]].toLowerCase() === 'p' && (to[0] === 0 || to[0] === 7);

      let extension = 0;
      if (givesCheck && depth >= 3) extension = 1;
      else if (isPromo) extension = 1;

      let reduction = 0;
      if (!isCapture && !givesCheck && i >= 6 && depth >= 3) reduction = 1;

      const score = botMinimax(next, depth - 1 + extension - reduction, alpha, beta, ply + 1, null, moveCount + 1);
      if (SEARCH_ABORTED) return best;
      if (score < best) best = score;
      if (best < beta) beta = best;
      if (beta <= alpha) {
        if (!isCapture) {
          const k = KILLER.get(depth) || [];
          k.unshift([from, to]); if (k.length > 2) k.pop();
          KILLER.set(depth, k);
          const hk = depth + '|' + historyKey(from, to);
          HISTORY.set(hk, (HISTORY.get(hk) || 0) + depth * depth);
        }
        break;
      }
    }
  }

  let flag = 'EXACT';
  if (best <= alphaOrig) flag = 'UPPER';
  else if (best >= betaOrig) flag = 'LOWER';
  ttSet(key, depth, best, flag);
  return best;
}

function findMateInOne(state, white) {
  const moves = botAllLegalMoves(state, white);
  for (const [from, to] of moves) {
    const next = botApplyMove(state, from, to);
    const oppWhite = next.turn === 'w';
    const oppMoves = botAllLegalMoves(next, oppWhite);
    if (oppMoves.length === 0 && botInCheck(next, oppWhite)) return [from, to];
  }
  return null;
}

function findMateInTwo(state, white) {
  const moves = botAllLegalMoves(state, white);
  for (const [from, to] of moves) {
    const next = botApplyMove(state, from, to);
    const oppWhite = next.turn === 'w';
    if (botInCheck(next, oppWhite) && botAllLegalMoves(next, oppWhite).length === 0) continue;
    const oppMoves = botAllLegalMoves(next, oppWhite);
    if (oppMoves.length === 0) continue;
    let allLeadToMate = true;
    for (const [of, ot] of oppMoves) {
      const after = botApplyMove(next, of, ot);
      const myMoves = botAllLegalMoves(after, white);
      let foundMate = false;
      for (const [mf, mt] of myMoves) {
        const mateState = botApplyMove(after, mf, mt);
        const opp2 = mateState.turn === 'w';
        if (botInCheck(mateState, opp2) && botAllLegalMoves(mateState, opp2).length === 0) { foundMate = true; break; }
      }
      if (!foundMate) { allLeadToMate = false; break; }
    }
    if (allLeadToMate) return [from, to];
  }
  return null;
}

// ============================================================
// BOT PARAMS (RATING-BASED)
// ============================================================
function getBotParams(rating, baseTimeMin, timeLeftSec = baseTimeMin * 60, incrementSec = 0) {
  let depth, noise;
  if (rating < 1100)      { depth = 1; noise = 80; }
  else if (rating < 1250) { depth = 2; noise = 35; }
  else if (rating < 1400) { depth = 2; noise = 18; }
  else if (rating < 1550) { depth = 3; noise = 8; }
  else if (rating < 1750) { depth = 3; noise = 2; }
  else if (rating < 1900) { depth = 4; noise = 0; }
  else if (rating < 2100) { depth = 5; noise = 0; }
  else if (rating < 2300) { depth = 6; noise = 0; }
  else                    { depth = 7; noise = 0; }

  if (baseTimeMin <= 1) depth = Math.min(depth, 2);
  else if (baseTimeMin <= 2) depth = Math.min(depth, 3);
  else if (baseTimeMin <= 3) depth = Math.min(depth, 4);
  else if (baseTimeMin <= 5) depth = Math.min(depth, 4);
  else if (baseTimeMin <= 10) depth = Math.min(depth, 5);
  else if (baseTimeMin <= 15) depth = Math.min(depth, 6);

  const left = Math.max(0, Number(timeLeftSec) || 0);
  const inc = Math.max(0, Number(incrementSec) || 0);

  let timeBudgetMs;
  if (left <= 2) timeBudgetMs = Math.max(20, left * 1000 * 0.08);
  else if (left <= 5) timeBudgetMs = Math.max(50, left * 1000 * 0.10);
  else if (left <= 15) timeBudgetMs = Math.max(100, left * 1000 * 0.12);
  else if (left <= 60) timeBudgetMs = Math.max(150, left * 1000 * 0.14);
  else if (left <= 180) timeBudgetMs = Math.max(250, left * 1000 * 0.15);
  else timeBudgetMs = Math.max(300, Math.min(3500, left * 1000 * 0.10 + inc * 800));
  if (inc > 0) timeBudgetMs += Math.min(inc * 1000 * 0.5, 800);
  timeBudgetMs = Math.min(timeBudgetMs, 4000);

  if (left <= 3) depth = Math.min(depth, 2);
  else if (left <= 8) depth = Math.min(depth, 3);
  else if (left <= 18) depth = Math.min(depth, 4);
  else if (left <= 35 && inc < 2) depth = Math.min(depth, 5);
  else if (left <= 60 && inc === 0) depth = Math.min(depth, 5);

  // Мастер всегда получает больше времени, чтобы не тупить
  if (rating >= 1900) timeBudgetMs = Math.max(timeBudgetMs, 800);

  if (left <= 8 && rating >= 1400) noise = Math.max(noise, 3);
  return { depth, noise, timeBudgetMs };
}

// ============================================================
// MAIN MOVE PICKER
// ============================================================
function pickBotMoveByRating(fen, rating, baseTimeMin, timeLeftSec, incrementSec, historyLine) {
  const state = botParseFen(fen);
  const white = state.turn === 'w';
  const moves = botAllLegalMoves(state, white);
  if (!moves.length) return null;
  if (moves.length === 1) return moves[0];

  const moveCount = state.full;

  if (moveCount <= 15 && historyLine) {
    const bm = bookMove(fen, historyLine);
    if (bm) {
      const legalSet = new Set(moves.map(([f, t]) => uciFromTo(f, t)));
      if (legalSet.has(uciFromTo(bm[0], bm[1]))) return bm;
    }
  }

  const params = getBotParams(rating, baseTimeMin, timeLeftSec, incrementSec);

  if (rating >= 1800) {
    const mate = findMateInOne(state, white);
    if (mate) return mate;
  }
  if (rating >= 1900) {
    const mate2 = findMateInTwo(state, white);
    if (mate2) return mate2;
  }

  const openingPhase = moveCount <= 12;
  const openingBonus = openingPhase
    ? new Map(moves.map(([from, to]) => [uciFromTo(from, to), openingHeuristic(state, from, to, moveCount)]))
    : null;

  SEARCH_ABORTED = false;
  SEARCH_DEADLINE = Date.now() + Math.max(40, params.timeBudgetMs);

  let bestMove = moves[0];
  let ordered = orderMoves(state, moves, params.depth, 0, null);

  for (let d = 1; d <= params.depth; d++) {
    let curBest = null;
    let curScore = white ? -Infinity : Infinity;
    const scored = [];
    for (let i = 0; i < ordered.length; i++) {
      const [from, to] = ordered[i];
      const next = botApplyMove(state, from, to);
      let score = botMinimax(next, d - 1, -Infinity, Infinity, 1, null, moveCount + 1);
      if (SEARCH_ABORTED) break;
      if (params.noise > 0) score += (Math.random() * 2 - 1) * params.noise;
      if (openingBonus) {
        const b = openingBonus.get(uciFromTo(from, to)) || 0;
        score += white ? b : -b;
      }
      scored.push({ from, to, score });
      if (white ? score > curScore : score < curScore) {
        curScore = score;
        curBest = [from, to];
      }
    }
    if (SEARCH_ABORTED) break;
    if (curBest) {
      bestMove = curBest;
      scored.sort((a, b) => white ? b.score - a.score : a.score - b.score);
      ordered = scored.map(x => [x.from, x.to]);
    }
    if (Date.now() > SEARCH_DEADLINE) break;
  }

  if (rating < 1100 && Math.random() < 0.45) {
    const all = orderMoves(state, moves, 1, 0, null);
    return all[Math.floor(Math.random() * Math.min(4, all.length))];
  }
  if (rating < 1250 && Math.random() < 0.30) {
    const all = orderMoves(state, moves, 1, 0, null);
    return all[Math.floor(Math.random() * Math.min(3, all.length))];
  }
  if (rating < 1400 && Math.random() < 0.15) {
    const all = orderMoves(state, moves, 1, 0, null);
    return all[Math.floor(Math.random() * Math.min(2, all.length))];
  }
  if (rating < 1550 && Math.random() < 0.07) {
    const all = orderMoves(state, moves, 1, 0, null);
    return all[Math.floor(Math.random() * Math.min(2, all.length))];
  }

  return bestMove;
}

// ============================================================
// WORKER MESSAGE HANDLER
// ============================================================
parentPort.on('message', (msg) => {
  const { id, fen, rating, timeMin, timeLeftSec, incrementSec, historyLine } = msg;
  try {
    const safeRating = Math.max(400, Math.min(2800, Number(rating) || 1000));
    const safeTimeMin = Math.max(0, Number(timeMin) || 5);
    const safeLeft = Math.max(0, Number(timeLeftSec) || safeTimeMin * 60);
    const safeInc = Math.max(0, Number(incrementSec) || 0);

    const move = pickBotMoveByRating(fen, safeRating, safeTimeMin, safeLeft, safeInc, historyLine);
    parentPort.postMessage({ id, ok: true, move });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err.message || String(err) });
  }
});
