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
const TT_CACHE = new Map();
const TT_MAX = 200000;
function ttKey(state) { return state.board.map(row => row.map(c => c || '.').join('')).join('/') + state.turn + state.castling + state.ep; }
function ttGet(k) { return TT_CACHE.get(k); }
function ttSet(k, d, s) { if (TT_CACHE.size > TT_MAX) TT_CACHE.clear(); TT_CACHE.set(k, { depth: d, score: s }); }

function botParseFen(fen) {
  const parts = fen.split(' ');
  const board = Array.from({length:8}, () => Array(8).fill(null));
  parts[0].split('/').forEach((row, r) => { let f = 0; for (const ch of row) { if (/\d/.test(ch)) f += +ch; else board[r][f++] = ch; } });
  return { board, turn: parts[1], castling: parts[2], ep: parts[3], half: +parts[4] || 0, full: +parts[5] || 1 };
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
    if (botPseudoMoves(state, rr, cc).some(([mr, mc]) => mr === r && mc === c)) return true;
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
  copy.castling = cast; copy.ep = ep; copy.turn = white ? 'b' : 'w'; copy.full += 1;
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
function botEval(state) {
  let score = 0;
  let whiteBishops = 0, blackBishops = 0;
  let whiteMaterial = 0, blackMaterial = 0;
  const whitePawnsByFile = [0,0,0,0,0,0,0,0];
  const blackPawnsByFile = [0,0,0,0,0,0,0,0];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p) continue;
    const white = botIsWhite(p); const t = p.toLowerCase();
    let v = PIECE_VALUES[t] || 0;
    if (t !== 'k') { const table = PST[t]; if (table) { const rr = white ? r : 7 - r; v += table[rr][c]; } }
    if (t === 'b') { if (white) whiteBishops++; else blackBishops++; }
    if (t === 'p') { if (white) whitePawnsByFile[c]++; else blackPawnsByFile[c]++; }
    if (white) whiteMaterial += v; else blackMaterial += v;
    score += white ? v : -v;
  }
  if (whiteBishops >= 2) score += 30;
  if (blackBishops >= 2) score -= 30;
  for (let f = 0; f < 8; f++) {
    if (whitePawnsByFile[f] > 1) score -= 10 * (whitePawnsByFile[f] - 1);
    if (blackPawnsByFile[f] > 1) score += 10 * (blackPawnsByFile[f] - 1);
  }
  for (let f = 0; f < 8; f++) {
    if (whitePawnsByFile[f] > 0) {
      const left = f > 0 ? whitePawnsByFile[f-1] : 0;
      const right = f < 7 ? whitePawnsByFile[f+1] : 0;
      if (left === 0 && right === 0) score -= 15;
    }
    if (blackPawnsByFile[f] > 0) {
      const left = f > 0 ? blackPawnsByFile[f-1] : 0;
      const right = f < 7 ? blackPawnsByFile[f+1] : 0;
      if (left === 0 && right === 0) score += 15;
    }
  }
  const whiteMoves = botAllLegalMoves(state, true).length;
  const blackMoves = botAllLegalMoves(state, false).length;
  score += (whiteMoves - blackMoves) * 2;
  const wK = botFindKing(state, true);
  const bK = botFindKing(state, false);
  if (wK) {
    const attackers = botAllLegalMoves(state, false).filter(([f, t]) => state.board[t[0]][t[1]] === 'K');
    if (attackers.length > 0) score -= 500;
  }
  if (bK) {
    const attackers = botAllLegalMoves(state, true).filter(([f, t]) => state.board[t[0]][t[1]] === 'k');
    if (attackers.length > 0) score += 500;
  }
  const totalMaterial = whiteMaterial + blackMaterial;
  if (totalMaterial < 2000) {
    if (wK) score += (7 - Math.abs(wK[0] - 3.5) - Math.abs(wK[1] - 3.5)) * 5;
    if (bK) score -= (7 - Math.abs(bK[0] - 3.5) - Math.abs(bK[1] - 3.5)) * 5;
  }
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c]; if (!p) continue;
    if (p.toLowerCase() === 'q') {
      const centerBonus = (3.5 - Math.abs(r - 3.5)) + (3.5 - Math.abs(c - 3.5));
      score += botIsWhite(p) ? centerBonus * 3 : -centerBonus * 3;
    }
  }
  return score;
}
function moveScore(state, from, to) {
  const target = state.board[to[0]][to[1]];
  const piece = state.board[from[0]][from[1]];
  if (!target) return 0;
  const victimVal = PIECE_VALUES[target.toLowerCase()] || 0;
  const attackerVal = PIECE_VALUES[piece.toLowerCase()] || 0;
  return victimVal * 10 - attackerVal;
}
function botQuiescence(state, alpha, beta, maximizing, depthLeft) {
  if (depthLeft <= 0) return botEval(state);
  const stand = botEval(state);
  if (maximizing) { if (stand >= beta) return beta; if (stand > alpha) alpha = stand; }
  else { if (stand <= alpha) return alpha; if (stand < beta) beta = stand; }
  const white = state.turn === 'w';
  const captures = botAllLegalMoves(state, white).filter(([f, t]) => state.board[t[0]][t[1]]);
  captures.sort((a, b) => moveScore(state, b[0], b[1]) - moveScore(state, a[0], a[1]));
  if (maximizing) {
    for (const [from, to] of captures) {
      const next = botApplyMove(state, from, to);
      const score = botQuiescence(next, alpha, beta, false, depthLeft - 1);
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  } else {
    for (const [from, to] of captures) {
      const next = botApplyMove(state, from, to);
      const score = botQuiescence(next, alpha, beta, true, depthLeft - 1);
      if (score <= alpha) return alpha;
      if (score < beta) beta = score;
    }
    return beta;
  }
}
function botMinimax(state, depth, alpha, beta, maximizing) {
  const key = ttKey(state);
  const cached = ttGet(key);
  if (cached && cached.depth >= depth) return cached.score;
  if (depth === 0) return botQuiescence(state, alpha, beta, maximizing, 2);
  const white = state.turn === 'w';
  const moves = botAllLegalMoves(state, white);
  if (!moves.length) {
    if (botInCheck(state, white)) return white ? -99999 + (10 - depth) : 99999 - (10 - depth);
    return 0;
  }
  moves.sort((a, b) => moveScore(state, b[0], b[1]) - moveScore(state, a[0], a[1]));
  let best;
  if (maximizing) {
    best = -Infinity;
    for (let i = 0; i < moves.length; i++) {
      const [from, to] = moves[i];
      const next = botApplyMove(state, from, to);
      const isCapture = !!state.board[to[0]][to[1]];
      let reduction = 0;
      if (!isCapture && i >= 4 && depth >= 3) reduction = 1;
      const score = botMinimax(next, depth - 1 - reduction, alpha, beta, false);
      if (score > best) best = score;
      if (best > alpha) alpha = best;
      if (beta <= alpha) break;
    }
  } else {
    best = Infinity;
    for (let i = 0; i < moves.length; i++) {
      const [from, to] = moves[i];
      const next = botApplyMove(state, from, to);
      const isCapture = !!state.board[to[0]][to[1]];
      let reduction = 0;
      if (!isCapture && i >= 4 && depth >= 3) reduction = 1;
      const score = botMinimax(next, depth - 1 - reduction, alpha, beta, true);
      if (score < best) best = score;
      if (best < beta) beta = best;
      if (beta <= alpha) break;
    }
  }
  ttSet(key, depth, best);
  return best;
}
function getBotParams(rating, baseTimeMin) {
  let depth, noise;
  if (rating < 1100)      { depth = 1; noise = 60; }
  else if (rating < 1350) { depth = 2; noise = 25; }
  else if (rating < 1500) { depth = 2; noise = 12; }
  else if (rating < 1700) { depth = 3; noise = 5; }
  else if (rating < 1850) { depth = 3; noise = 2; }
  else if (rating < 2000) { depth = 4; noise = 0; }
  else if (rating < 2200) { depth = 5; noise = 0; }
  else                    { depth = 6; noise = 0; }
  if (baseTimeMin <= 1) depth = Math.min(depth, 1);
  else if (baseTimeMin <= 2) depth = Math.min(depth, 2);
  else if (baseTimeMin <= 3) depth = Math.min(depth, 3);
  else if (baseTimeMin <= 5) depth = Math.min(depth, 3);
  else if (baseTimeMin <= 10) depth = Math.min(depth, 4);
  else if (baseTimeMin <= 15) depth = Math.min(depth, 5);
  return { depth, noise };
}
function pickBotMoveByRating(fen, rating, baseTimeMin) {
  const state = botParseFen(fen);
  const white = state.turn === 'w';
  const moves = botAllLegalMoves(state, white);
  if (!moves.length) return null;
  const { depth, noise } = getBotParams(rating, baseTimeMin);
  if (moves.length === 1) return moves[0];
  moves.sort((a, b) => moveScore(state, b[0], b[1]) - moveScore(state, a[0], a[1]));
  const scored = moves.map(([from, to]) => {
    const next = botApplyMove(state, from, to);
    let score = botMinimax(next, depth - 1, -Infinity, Infinity, !white);
    if (noise > 0) score += (Math.random() * 2 - 1) * noise;
    return { from, to, score };
  });
  scored.sort((a, b) => white ? b.score - a.score : a.score - b.score);
  if (rating < 1100 && scored.length > 2 && Math.random() < 0.4) return scored[1 + Math.floor(Math.random() * 2)];
  if (rating < 1350 && scored.length > 1 && Math.random() < 0.25) return scored[1];
  if (rating < 1500 && scored.length > 1 && Math.random() < 0.1) return scored[1];
  return scored[0];
}

parentPort.on('message', (msg) => {
  const { id, fen, rating, timeMin } = msg;
  try {
    const move = pickBotMoveByRating(fen, rating, timeMin);
    parentPort.postMessage({ id, ok: true, move });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err.message });
  }
});
