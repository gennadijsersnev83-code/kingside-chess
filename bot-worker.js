// bot-worker.js
const { parentPort } = require('worker_threads');

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

const TT_CACHE = new Map();
const TT_MAX = 400000;
function ttKey(state) { return state.board.map(row => row.map(c => c || '.').join('')).join('/') + state.turn + state.castling + state.ep; }
function ttGet(k) { return TT_CACHE.get(k); }
function ttSet(k, d, s, flag) { if (TT_CACHE.size > TT_MAX) TT_CACHE.clear(); TT_CACHE.set(k, { depth: d, score: s, flag }); }

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

function botPseudoMoves(state, r, c) {
  const p = state.board[r][c]; if (!p) return [];
  const moves = []; const white = botIsWhite(p); const type = p.toLowerCase();
  const dir = white ? -1 : 1;
  const add = (rr, cc) => { if (!botInBoard(rr, cc)) return false; const t = state.board[rr][cc]; if (t && botIsWhite(t) === white) return false; moves.push([rr, cc]); return !t; };
  if (type === 'p') {
    const startRow = white ? 6 : 1, oneR = r + dir;
    if (botInBoard(oneR, c) && !state.board[oneR][c]) { moves.push([oneR, c]); const twoR = r + 2 * dir; if (r === startRow && botInBoard(twoR, c) && !state.board[twoR][c]) moves.push([twoR, c]); }
    for (const dc of [-1, 1]) { const rr = r + dir, cc = c + dc; if (!botInBoard(rr, cc)) continue; const t = state.board[rr][cc]; if (t && botIsWhite(t) !== white) moves.push([rr, cc]); const epTarget = String.fromCharCode(97 + cc) + (8 - rr); if (state.ep && state.ep === epTarget && !t) moves.push([rr, cc]); }
  } else if (type === 'n') { [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]].forEach(([dr,dc]) => add(r+dr, c+dc)); }
  else if (type === 'k') {
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
function botFindKing(state, white) { const k = white ? 'K' : 'k'; for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (state.board[r][c] === k) return [r, c]; return null; }
function botIsAttacked(state, r, c, byWhite) {
  for (let rr = 0; rr < 8; rr++) for (let cc = 0; cc < 8; cc++) {
    const p = state.board[rr][cc]; if (!p || botIsWhite(p) !== byWhite) continue;
    const t = p.toLowerCase();
    if (t === 'p') { const dir = byWhite ? -1 : 1; if (rr + dir === r && (cc - 1 === c || cc + 1 === c)) return true; continue; }
    if (t === 'k') { if (Math.abs(rr - r) <= 1 && Math.abs(cc - c) <= 1 && (rr !== r || cc !== c)) return true; continue; }
    if (t === 'n') {
      const dr = Math.abs(rr - r), dc = Math.abs(cc - c);
      if ((dr === 2 && dc === 1) || (dr === 1 && dc === 2)) return true;
      continue;
    }
    if (t === 'r' || t === 'q') {
      if (rr === r) {
        let ok = true;
        for (let x = Math.min(cc, c) + 1; x < Math.max(cc, c); x++) if (state.board[rr][x]) { ok = false; break; }
        if (ok) return true;
      }
      if (cc === c) {
        let ok = true;
        for (let y = Math.min(rr, r) + 1; y < Math.max(rr, r); y++) if (state.board[y][cc]) { ok = false; break; }
        if (ok) return true;
      }
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

function botApplyMove(state, from, to) {
  const copy = { board: state.board.map(row => row.slice()), turn: state.turn, castling: state.castling, ep: state.ep, half: state.half, full: state.full };
  const [fr, fc] = from, [tr, tc] = to;
  const p = copy.board[fr][fc]; const white = botIsWhite(p); const type = p.toLowerCase();
  if (type === 'p' && copy.ep) { const target = String.fromCharCode(97 + tc) + (8 - tr); if (copy.ep === target && !copy.board[tr][tc]) copy.board[fr][tc] = null; }
  copy.board[tr][tc] = p; copy.board[fr][fc] = null;
  if (type === 'p' && (tr === 0 || tr === 7)) copy.board[tr][tc] = white ? 'Q' : 'q';
  if (type === 'k' && Math.abs(tc - fc) === 2) { const row = fr; if (tc > fc) { copy.board[row][5] = copy.board[row][7]; copy.board[row][7] = null; } else { copy.board[row][3] = copy.board[row][0]; copy.board[row][0] = null; } }
  let cast = copy.castling;
  if (type === 'k') cast = cast.replace(white ? /[KQ]/g : /[kq]/g, '');
  if (type === 'r') { if (fr === 7 && fc === 0) cast = cast.replace('Q', ''); if (fr === 7 && fc === 7) cast = cast.replace('K', ''); if (fr === 0 && fc === 0) cast = cast.replace('q', ''); if (fr === 0 && fc === 7) cast = cast.replace('k', ''); }
  if (!cast) cast = '-';
  let ep = '-'; if (type === 'p' && Math.abs(tr - fr) === 2) ep = String.fromCharCode(97 + fc) + (8 - (fr + (tr - fr) / 2));
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
  let whiteMaterial = 0, blackMaterial = 0;
  const whitePawnsByFile = [0,0,0,0,0,0,0,0];
  const blackPawnsByFile = [0,0,0,0,0,0,0,0];
  const whitePawnRanks = [];
  const blackPawnRanks = [];
  const wK = botFindKing(state, true);
  const bK = botFindKing(state, false);
  const totalMat = materialOf(state);
  const endgame = (totalMat.w + totalMat.b) <= 2200;

  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p) continue;
    const white = botIsWhite(p); const t = p.toLowerCase();
    let v = PIECE_VALUES[t] || 0;
    if (t === 'k') {
      const table = endgame ? KING_ENDGAME_PST : PST.k;
      const rr = white ? r : 7 - r;
      v += table[rr][c];
    } else {
      const table = PST[t]; if (table) { const rr = white ? r : 7 - r; v += table[rr][c]; }
      if (t === 'p') {
        const rank = white ? (7 - r) : r;
        if (rank >= 4) v += (rank - 3) * 12;
        if (white) { whitePawnsByFile[c]++; whitePawnRanks.push([r, c]); }
        else { blackPawnsByFile[c]++; blackPawnRanks.push([r, c]); }
      }
    }
    if (t === 'b') { if (white) whiteBishops++; else blackBishops++; }
    if (white) whiteMaterial += v; else blackMaterial += v;
    score += white ? v : -v;
  }
  if (whiteBishops >= 2) score += 35;
  if (blackBishops >= 2) score -= 35;

  for (let f = 0; f < 8; f++) {
    if (whitePawnsByFile[f] > 1) score -= 12 * (whitePawnsByFile[f] - 1);
    if (blackPawnsByFile[f] > 1) score += 12 * (blackPawnsByFile[f] - 1);
  }
  for (let f = 0; f < 8; f++) {
    if (whitePawnsByFile[f] > 0) {
      const left = f > 0 ? whitePawnsByFile[f-1] : 0;
      const right = f < 7 ? whitePawnsByFile[f+1] : 0;
      if (left === 0 && right === 0) score -= 18;
    }
    if (blackPawnsByFile[f] > 0) {
      const left = f > 0 ? blackPawnsByFile[f-1] : 0;
      const right = f < 7 ? blackPawnsByFile[f+1] : 0;
      if (left === 0 && right === 0) score += 18;
    }
  }

  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p) continue;
    const t = p.toLowerCase();
    if (t === 'b') {
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
      if (blocked >= 2) score += white ? -8 : 8;
    }
  }

  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p) continue;
    if (p.toLowerCase() !== 'r') continue;
    const white = botIsWhite(p);
    const ownPawns = white ? whitePawnsByFile : blackPawnsByFile;
    const oppPawns = white ? blackPawnsByFile : whitePawnsByFile;
    if (ownPawns[c] === 0 && oppPawns[c] === 0) score += white ? 22 : -22;
    else if (ownPawns[c] === 0) score += white ? 11 : -11;
  }

  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p) continue;
    if (p.toLowerCase() === 'q') {
      const centerBonus = (3.5 - Math.abs(r - 3.5)) + (3.5 - Math.abs(c - 3.5));
      score += botIsWhite(p) ? centerBonus * 3 : -centerBonus * 3;
    }
  }

  if (!endgame && wK) {
    const shieldW = [[wK[0]-1, wK[1]-1],[wK[0]-1, wK[1]],[wK[0]-1, wK[1]+1]].reduce((acc, [rr, cc]) => acc + ((botInBoard(rr, cc) && state.board[rr][cc] === 'P') ? 1 : 0), 0);
    const shieldB = bK ? [[bK[0]+1, bK[1]-1],[bK[0]+1, bK[1]],[bK[0]+1, bK[1]+1]].reduce((acc, [rr, cc]) => acc + ((botInBoard(rr, cc) && state.board[rr][cc] === 'p') ? 1 : 0), 0) : 0;
    score += shieldW * 8 - shieldB * 8;
    const wc = wK[1];
    const inCenterFile = wc >= 3 && wc <= 4;
    score += inCenterFile && wK[0] >= 6 ? 6 : 0;
  }

  const whiteMoves = botAllLegalMoves(state, true).length;
  const blackMoves = botAllLegalMoves(state, false).length;
  score += (whiteMoves - blackMoves) * 2;

  if (wK) {
    const attackers = botAllLegalMoves(state, false).filter(([f, t]) => state.board[t[0]][t[1]] === 'K');
    if (attackers.length > 0) score -= 600;
    if (botInCheck(state, true)) score -= 250;
  }
  if (bK) {
    const attackers = botAllLegalMoves(state, true).filter(([f, t]) => state.board[t[0]][t[1]] === 'k');
    if (attackers.length > 0) score += 600;
    if (botInCheck(state, false)) score += 250;
  }

  for (const [r, c] of whitePawnRanks) {
    let passed = true;
    for (const [br, bc] of blackPawnRanks) {
      if ((bc === c || bc === c - 1 || bc === c + 1) && br < r) { passed = false; break; }
    }
    if (passed) score += 20 + (6 - r) * 8;
  }
  for (const [r, c] of blackPawnRanks) {
    let passed = true;
    for (const [wr, wc] of whitePawnRanks) {
      if ((wc === c || wc === c - 1 || wc === c + 1) && wr > r) { passed = false; break; }
    }
    if (passed) score -= 20 + r * 8;
  }

  if (state.half >= 100) score = 0;
  return score;
}

// ============================================================
// OPENING BOOK
// ============================================================
// UCI строки, начинающиеся с позиции. Ключ — префикс ходов (space-separated UCI).
// Вес — вероятность выбора (мастер чаще берёт main line).
const OPENING_BOOK = [
  // 1.e4
  { line: 'e2e4', weight: 40 },
  { line: 'e2e4 e7e5 g1f3', weight: 30 },
  { line: 'e2e4 e7e5 g1f3 b8c6 f1b5', weight: 20 }, // Ruy Lopez
  { line: 'e2e4 e7e5 g1f3 b8c6 f1c4', weight: 15 }, // Italian
  { line: 'e2e4 e7e5 g1f3 b8c6 d2d4', weight: 10 }, // Scotch
  { line: 'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6', weight: 10 },
  { line: 'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4', weight: 6 },
  { line: 'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5c6', weight: 4 },
  { line: 'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5', weight: 10 }, // Giuoco
  { line: 'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3', weight: 6 },
  { line: 'e2e4 e7e5 g1f3 b8c6 d2d4 e5d4 f3d4', weight: 8 }, // Scotch
  { line: 'e2e4 e7e5 g1f3 b8c6 d2d4 e5d4 f3d4 g8f6', weight: 5 },
  { line: 'e2e4 e7e5 g1f3 b8c6 d2d4 e5d4 f3d4 f8c5', weight: 4 },
  { line: 'e2e4 e7e5 g1f3 g8f6', weight: 8 }, // Petroff
  { line: 'e2e4 e7e5 g1f3 g8f6 f3e5 d7d6', weight: 5 },
  { line: 'e2e4 e7e5 g1f3 d7d6', weight: 6 }, // Philidor
  { line: 'e2e4 e7e5 g1f3 d7d6 d2d4', weight: 4 },
  { line: 'e2e4 e7e5 f1c4', weight: 5 }, // Bishop's opening
  { line: 'e2e4 e7e5 b1c3', weight: 4 }, // Vienna
  { line: 'e2e4 e7e5 d2d4', weight: 3 },
  // Sicilian
  { line: 'e2e4 c7c5', weight: 25 },
  { line: 'e2e4 c7c5 g1f3 d7d6', weight: 15 },
  { line: 'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4', weight: 12 }, // Open Sicilian
  { line: 'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6', weight: 10 },
  { line: 'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3', weight: 8 }, // Najdorf-ish
  { line: 'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6', weight: 6 }, // Najdorf
  { line: 'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 g7g6', weight: 5 }, // Dragon
  { line: 'e2e4 c7c5 g1f3 b8c6', weight: 10 },
  { line: 'e2e4 c7c5 g1f3 b8c6 d2d4 c5d4 f3d4', weight: 8 },
  { line: 'e2e4 c7c5 g1f3 b8c6 d2d4 c5d4 f3d4 g7g6', weight: 4 }, // Accelerated Dragon
  { line: 'e2e4 c7c5 g1f3 b8c6 f1b5', weight: 6 }, // Rossolimo
  { line: 'e2e4 c7c5 g1f3 e7e6', weight: 6 }, // French-Sicilian
  { line: 'e2e4 c7c5 g1f3 e7e6 d2d4 c5d4 f3d4', weight: 4 },
  { line: 'e2e4 c7c5 c2c3', weight: 5 }, // Alapin
  { line: 'e2e4 c7c5 c2c3 d7d5', weight: 4 },
  { line: 'e2e4 c7c5 b1c3', weight: 4 }, // Closed Sicilian
  // French
  { line: 'e2e4 e7e6', weight: 12 },
  { line: 'e2e4 e7e6 d2d4 d7d5', weight: 10 },
  { line: 'e2e4 e7e6 d2d4 d7d5 b1c3', weight: 6 }, // Winawer
  { line: 'e2e4 e7e6 d2d4 d7d5 b1d2', weight: 4 }, // Tarrasch
  { line: 'e2e4 e7e6 d2d4 d7d5 e4e5', weight: 3 }, // Advance
  // Caro-Kann
  { line: 'e2e4 c7c6', weight: 12 },
  { line: 'e2e4 c7c6 d2d4 d7d5', weight: 10 },
  { line: 'e2e4 c7c6 d2d4 d7d5 b1c3', weight: 5 }, // Classical
  { line: 'e2e4 c7c6 d2d4 d7d5 e4e5', weight: 4 }, // Advance
  { line: 'e2e4 c7c6 d2d4 d7d5 b1d2', weight: 4 },
  // Pirc / Modern / Alekhine / Scandinavian
  { line: 'e2e4 d7d6', weight: 5 },
  { line: 'e2e4 d7d6 d2d4 g8f6', weight: 3 },
  { line: 'e2e4 g7g6', weight: 5 },
  { line: 'e2e4 g8f6', weight: 4 }, // Alekhine
  { line: 'e2e4 g8f6 e4e5 f6d5 d2d4', weight: 3 },
  { line: 'e2e4 d7d5', weight: 4 }, // Scandinavian
  { line: 'e2e4 d7d5 e4d5 d8d5 b1c3', weight: 3 },
  // 1.d4
  { line: 'd2d4', weight: 30 },
  { line: 'd2d4 d7d5', weight: 20 },
  { line: 'd2d4 d7d5 c2c4', weight: 18 }, // QGD/QGA
  { line: 'd2d4 d7d5 c2c4 e7e6', weight: 12 }, // QGD
  { line: 'd2d4 d7d5 c2c4 e7e6 b1c3', weight: 8 },
  { line: 'd2d4 d7d5 c2c4 e7e6 b1c3 g8f6', weight: 6 },
  { line: 'd2d4 d7d5 c2c4 e7e6 b1c3 g8f6 c1g5', weight: 4 },
  { line: 'd2d4 d7d5 c2c4 d5c4', weight: 6 }, // QGA
  { line: 'd2d4 d7d5 c2c4 c7c6', weight: 8 }, // Slav
  { line: 'd2d4 d7d5 c2c4 c7c6 g1f3', weight: 5 },
  { line: 'd2d4 d7d5 c2c4 c7c6 b1c3', weight: 4 },
  { line: 'd2d4 d7d5 g1f3', weight: 6 },
  { line: 'd2d4 d7d5 g1f3 g8f6', weight: 4 },
  { line: 'd2d4 d7d5 c1f4', weight: 3 }, // London
  { line: 'd2d4 g8f6', weight: 15 },
  { line: 'd2d4 g8f6 c2c4', weight: 12 },
  { line: 'd2d4 g8f6 c2c4 g7g6', weight: 8 }, // KID/Gruenfeld
  { line: 'd2d4 g8f6 c2c4 g7g6 b1c3', weight: 6 },
  { line: 'd2d4 g8f6 c2c4 g7g6 b1c3 d7d5', weight: 4 }, // Grunfeld
  { line: 'd2d4 g8f6 c2c4 g7g6 b1c3 f8g7', weight: 4 }, // KID
  { line: 'd2d4 g8f6 c2c4 e7e6', weight: 10 }, // Nimzo/QID
  { line: 'd2d4 g8f6 c2c4 e7e6 b1c3', weight: 8 },
  { line: 'd2d4 g8f6 c2c4 e7e6 b1c3 f8b4', weight: 5 }, // Nimzo
  { line: 'd2d4 g8f6 c2c4 e7e6 g1f3', weight: 5 },
  { line: 'd2d4 g8f6 c2c4 e7e6 g1f3 b7b6', weight: 3 }, // QID
  { line: 'd2d4 g8f6 c2c4 c7c5', weight: 4 }, // Benoni
  { line: 'd2d4 g8f6 c2c4 d7d5', weight: 4 },
  { line: 'd2d4 f7f5', weight: 4 }, // Dutch
  { line: 'd2d4 f7f5 c2c4', weight: 3 },
  { line: 'd2d4 e7e6', weight: 4 },
  { line: 'd2d4 e7e6 c2c4', weight: 3 },
  { line: 'd2d4 c7c5', weight: 4 }, // Benoni
  { line: 'd2d4 c7c5 d4d5', weight: 3 },
  // 1.c4
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
  // 1.Nf3 / 1.g3 / 1.b3
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

// Индекс книги по префиксу UCI ходов
const OPENING_INDEX = new Map();
(function buildOpeningIndex() {
  for (const entry of OPENING_BOOK) {
    const moves = entry.line.split(' ').filter(Boolean);
    // добавляем все префиксы, чтобы книга срабатывала на ранних ходах
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

// Определяем ходы, которые уже сделаны в партии, по FEN — нельзя восстановить точно,
// поэтому книга вызывается только когда есть historyLine (строка UCI через пробел).
function bookMove(fen, historyLine) {
  if (!historyLine) return null;
  const trimmed = historyLine.trim();
  // ищем самый длинный префикс в книге
  const parts = trimmed ? trimmed.split(' ') : [];
  for (let len = parts.length; len >= 1; len--) {
    const prefix = parts.slice(0, len).join(' ');
    const candidates = OPENING_INDEX.get(prefix);
    if (!candidates || !candidates.length) continue;

    // среди кандидатов — только легальные из текущей позиции
    const state = botParseFen(fen);
    const legal = botAllLegalMoves(state, state.turn === 'w');
    const legalSet = new Set(legal.map(([f, t]) => uciFromTo(f, t)));
    const filtered = candidates.filter(c => legalSet.has(c.move));
    if (!filtered.length) continue;

    // взвешенный выбор
    const total = filtered.reduce((s, c) => s + c.weight, 0);
    let r = Math.random() * total;
    for (const c of filtered) { r -= c.weight; if (r <= 0) return uciToMove(c.move); }
    return uciToMove(filtered[0].move);
  }
  return null;
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

// ============================================================
// OPENING HEURISTICS (fallback если книги нет)
// ============================================================
function openingHeuristic(state, from, to, moveCount) {
  if (moveCount > 12) return 0;
  const piece = state.board[from[0]][from[1]];
  if (!piece) return 0;
  const white = botIsWhite(piece);
  const type = piece.toLowerCase();
  let bonus = 0;

  const target = state.board[to[0]][to[1]];
  if (target) bonus += 0; // взятия не трогаем — тактика решает

  // Развитие лёгких фигур
  if (type === 'n' || type === 'b') {
    const homeRow = white ? 7 : 0;
    if (from[0] === homeRow) bonus += 18;
    else bonus -= 6; // повторные ходы фигурой в дебюте
    // центральные поля для коня
    if (type === 'n' && ((to[0] === 3 || to[0] === 4) && (to[1] === 2 || to[1] === 5))) bonus += 8;
  }

  // Ранний ферзь — сильный штраф
  if (type === 'q') {
    const homeRow = white ? 7 : 0;
    if (from[0] === homeRow) bonus -= 40; // выход ферзём с начальной позиции
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
    if (moveCount <= 4) bonus -= 30; // особенно на 2-4 ходу
    if ((to[0] === 3 || to[0] === 4) && (to[1] === 3 || to[1] === 4) && moveCount <= 8) bonus -= 40; // ферзь в центр
  }

  // Ранняя ладья по открытой линии — не всегда плохо, но до рокировки рано
  if (type === 'r' && moveCount <= 8) {
    const castlingDone = white ? !state.castling.includes('K') && !state.castling.includes('Q') : !state.castling.includes('k') && !state.castling.includes('q');
    if (!castlingDone) bonus -= 15;
  }

  // Рокировка — большой плюс
  if (type === 'k' && Math.abs(to[1] - from[1]) === 2) bonus += 50;
  // Уход королём без рокировки — минус
  if (type === 'k' && Math.abs(to[1] - from[1]) !== 2 && moveCount <= 10) bonus -= 30;

  // Пешки в центр
  if (type === 'p') {
    if ((to[1] === 3 || to[1] === 4) && (to[0] === 3 || to[0] === 4)) bonus += 12;
    const homeRow = white ? 6 : 1;
    const twoStep = Math.abs(to[0] - from[0]) === 2;
    if (from[0] === homeRow && !twoStep) bonus -= 4; // одношаговые пешки в начале — ок, но не топ
  }

  // Не двигаем одну и ту же фигуру многократно в дебюте
  // (упрощённо: если фигура уже покидала homeRow, повторный ход штрафуется выше)

  // Штраф за вылет ферзём далеко без развития
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
    if (cap) {
      s += 10000 + (PIECE_VALUES[cap.toLowerCase()] || 0) * 10 - (PIECE_VALUES[state.board[from[0]][from[1]].toLowerCase()] || 0);
    }
    const hk = depth + '|' + historyKey(from, to);
    const hist = HISTORY.get(hk) || 0;
    s += hist;
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
  const maximizing = white;
  if (maximizing) { if (stand >= beta) return beta; if (stand > alpha) alpha = stand; }
  else { if (stand <= alpha) return alpha; if (stand < beta) beta = stand; }

  const moves = botAllLegalMoves(state, white);
  const captures = moves.filter(([f, t]) => !!state.board[t[0]][t[1]] || (state.board[f[0]][f[1]] && state.board[f[0]][f[1]].toLowerCase() === 'p' && f[1] !== t[1]));
  captures.sort((a, b) => moveScore(state, b[0], b[1]) - moveScore(state, a[0], a[1]));

  if (maximizing) {
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

let SEARCH_START = 0;
let SEARCH_DEADLINE = 0;
let SEARCH_ABORTED = false;

function botMinimax(state, depth, alpha, beta, ply, ttMove, moveCount) {
  if (Date.now() > SEARCH_DEADLINE) { SEARCH_ABORTED = true; return botEval(state); }
  const key = ttKey(state);
  const cached = ttGet(key);
  let alphaOrig = alpha, betaOrig = beta;
  if (cached && cached.depth >= depth) {
    if (cached.flag === 'EXACT') return cached.score;
    if (cached.flag === 'LOWER' && cached.score > alpha) alpha = cached.score;
    if (cached.flag === 'UPPER' && cached.score < beta) beta = cached.score;
    if (alpha >= beta) return cached.score;
  }
  if (depth === 0) return botQuiescence(state, alpha, beta, 3, 0);

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
      const isPromo = (state.board[from[0]][from[1]] && state.board[from[0]][from[1]].toLowerCase() === 'p' && (to[0] === 0 || to[0] === 7));

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
          k.unshift([from, to]);
          if (k.length > 2) k.pop();
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
      const isPromo = (state.board[from[0]][from[1]] && state.board[from[0]][from[1]].toLowerCase() === 'p' && (to[0] === 0 || to[0] === 7));

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
          k.unshift([from, to]);
          if (k.length > 2) k.pop();
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

function getBotParams(rating, baseTimeMin, timeLeftSec = baseTimeMin * 60, incrementSec = 0) {
  let depth, noise, timeMultiplier;
    
  if (rating < 1000) {  // Easy level
    depth = 2;
    noise = 50;
    timeMultiplier = 0.05;
  } else if (rating < 1300) {  // Medium level
    depth = 3;
    noise = 25;
    timeMultiplier = 0.07;
  } else if (rating < 1600) {  // Hard level
      depth = 4;
      noise = 10;
    timeMultiplier = 0.10;
  } else if (rating < 1800) {  // Very Hard level
    depth = 5;
    noise = 5;
    timeMultiplier = 0.14;
  } else {  // Master level
    depth = 8;  // Увеличенная глубина поиска
    noise = 0;
    timeMultiplier = 0.20;
  }

  // Адаптивная регулировка глубины
  const material = materialOf(state);
  const materialDiff = Math.abs(material.w - material.b);
  if (materialDiff > 2000) {
    depth += 1;  // Увеличиваем глубину при материальном преимуществе
  }

  // Ограничения по времени
  if (baseTimeMin <= 1) depth = Math.min(depth, 2);
  else if (baseTimeMin <= 2) depth = Math.min(depth, 3);
  else if (baseTimeMin <= 3) depth = Math.min(depth, 4);
  else if (baseTimeMin <= 5) depth = Math.min(depth, 5);
  else if (baseTimeMin <= 10) depth = Math.min(depth, 6);
  else if (baseTimeMin <= 15) depth = Math.min(depth, 7);
  else if (baseTimeMin > 15) depth = Math.min(depth, 9);  // Увеличение максимальной глубины
  else if (baseTimeMin > 60) depth = Math.min(depth, 10);

  const left = Math.max(0, Number(timeLeftSec) || 0);
  const inc = Math.max(0, Number(incrementSec) || 0);

  let timeBudgetMs;
  if (left <= 2) timeBudgetMs = Math.max(20, left * 1000 * timeMultiplier);
  else if (left <= 5) timeBudgetMs = Math.max(40, left * 1000 * timeMultiplier);
  else if (left <= 15) timeBudgetMs = Math.max(80, left * 1000 * timeMultiplier);
  else if (left <= 60) timeBudgetMs = Math.max(120, left * 1000 * timeMultiplier);
  else if (left <= 180) timeBudgetMs = Math.max(200, left * 1000 * timeMultiplier);
  else timeBudgetMs = Math.max(250, Math.min(2500, left * 1000 * timeMultiplier + inc * 800));
    
  if (inc > 0) timeBudgetMs += Math.min(inc * 1000 * 0.5, 800);
    timeBudgetMs = Math.min(timeBudgetMs, 3000);

  return { depth, noise, timeBudgetMs };
}

function pickBotMoveByRating(fen, rating, baseTimeMin, timeLeftSec, incrementSec, historyLine) {
  const state = botParseFen(fen);
  const white = state.turn === 'w';
  const moves = botAllLegalMoves(state, white);
  if (!moves.length) return null;
  if (moves.length === 1) return moves[0];

  const moveCount = state.full;

  // 1) Дебютная книга
  if (moveCount <= 15 && historyLine) {
    const bm = bookMove(fen, historyLine);
    if (bm) {
      const legalSet = new Set(moves.map(([f, t]) => uciFromTo(f, t)));
      if (legalSet.has(uciFromTo(bm[0], bm[1]))) return bm;
    }
  }

  const params = getBotParams(rating, baseTimeMin, timeLeftSec, incrementSec);

  // 2) Быстрый мат в 1 для мастеров
  if (rating >= 1850) {
    const mate = findMateInOne(state, white);
    if (mate) return mate;
  }

  // 3) Дебютные эвристики — сдвигаем оценку ходов
  const openingPhase = moveCount <= 12;
  const openingBonus = openingPhase
    ? new Map(moves.map(([from, to]) => [uciFromTo(from, to), openingHeuristic(state, from, to, moveCount)]))
    : null;

  SEARCH_ABORTED = false;
  SEARCH_START = Date.now();
  SEARCH_DEADLINE = SEARCH_START + Math.max(40, params.timeBudgetMs);

  let bestMove = moves[0];
  let bestScore = white ? -Infinity : Infinity;
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
        // бонус меньше веса тактики, чтобы не перебивать мат/взятия
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
      bestScore = curScore;
      scored.sort((a, b) => white ? b.score - a.score : a.score - b.score);
      ordered = scored.map(x => [x.from, x.to]);
    }
    if (Date.now() > SEARCH_DEADLINE) break;
  }

  if (rating < 1100 && Math.random() < 0.4) {
    const all = orderMoves(state, moves, 1, 0, null);
    return all[Math.floor(Math.random() * Math.min(3, all.length))];
  }
  if (rating < 1350 && Math.random() < 0.25) {
    const all = orderMoves(state, moves, 1, 0, null);
    return all[Math.floor(Math.random() * Math.min(2, all.length))];
  }
  if (rating < 1500 && Math.random() < 0.1) {
    const all = orderMoves(state, moves, 1, 0, null);
    return all[Math.floor(Math.random() * Math.min(2, all.length))];
  }
  return bestMove;
}

parentPort.on('message', (msg) => {
  const { id, fen, rating, timeMin, timeLeftSec, incrementSec, historyLine } = msg;
  try {
    const move = pickBotMoveByRating(fen, rating, timeMin, timeLeftSec, incrementSec, historyLine);
    parentPort.postMessage({ id, ok: true, move });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err.message });
  }
});
