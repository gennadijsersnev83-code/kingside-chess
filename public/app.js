/* app.js — вся клиентская логика Kingside */

'use strict';

// ============================================================
// UTILS
// ============================================================
const Utils = {
  MSK_TZ: 'Europe/Moscow',
  fmtMskHM(ts) {
    return new Intl.DateTimeFormat('ru-RU', { timeZone: this.MSK_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts));
  },
  fmtTimeHM(ts) {
    const d = new Date(ts);
    return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
  },
  fmtDate(ts) {
    const d = new Date(ts);
    const today = new Date(); const yest = new Date(); yest.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Сегодня';
    if (d.toDateString() === yest.toDateString()) return 'Вчера';
    return d.toLocaleDateString('ru-RU');
  },
  escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  },
  nickHtml(username, isAdminFlag, isModFlag, isBotFlag) {
    if (!username) return '';
    const admin = (typeof isAdminFlag === 'boolean') ? isAdminFlag : (username === 'PeshkaSasha' || username === 'admin');
    const mod = (typeof isModFlag === 'boolean') ? isModFlag : (username === 'PeshkaSasha' || username === 'Debian');
    const bot = !!isBotFlag;
    const crown = admin ? '<span class="crown">👑</span>' : '';
    const mark = (!admin && mod) ? '<span class="modMark" title="Модератор">!</span>' : '';
    const botTag = bot ? '<span class="botBadge" style="margin-right:4px">🤖 BOT</span>' : '';
    return `<span class="playerNick" data-player="${this.escapeHtml(username)}">${botTag}${crown}${mark}${this.escapeHtml(username)}</span>`;
  },
  onlineDotHtml(online) {
    return online ? '<span class="onlineDot" title="В сети"></span>' : '<span class="offlineDot" title="Не в сети"></span>';
  },
  watchersHtml(n) {
    if (!n || n <= 0) return '';
    return `<span class="watchersBadge" title="Зрителей">👁 <b>${n}</b></span>`;
  },
  formatTime(s) {
    s = Math.max(0, Math.floor(s));
    return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
  },
  formatMMSS(ms) {
    const t = Math.max(0, Math.floor(ms/1000));
    return String(Math.floor(t/60)).padStart(2,'0') + ':' + String(t%60).padStart(2,'0');
  },
  genId() { return Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6); }
};

// ============================================================
// SOUNDS
// ============================================================
const Sounds = (function() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  let ctx = null;
  function ensure() { if (!ctx) ctx = new AudioCtx(); if (ctx.state === 'suspended') ctx.resume(); return ctx; }
  function playTone(freq, dur, type, vol, delay) {
    try {
      const c = ensure();
      const t0 = c.currentTime + (delay || 0);
      const osc = c.createOscillator(); const gain = c.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(vol || 0.15, t0 + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain); gain.connect(c.destination);
      osc.start(t0); osc.stop(t0 + dur + 0.02);
    } catch (e) {}
  }
  const last = { move:0, capture:0, check:0, mate:0, draw:0, win:0, lose:0, start:0, msg:0 };
  const COOLDOWN = 180;
  function can(key) { const now = performance.now(); if (now - last[key] < COOLDOWN) return false; last[key] = now; return true; }
  let lastSan = '', lastSanTime = 0;
  return {
    move()    { if (can('move'))    playTone(360, 0.045, 'sine', 0.075); },
    capture() { if (can('capture')) playTone(245, 0.065, 'triangle', 0.095); },
    check()   { if (can('check'))   playTone(740, 0.085, 'sine', 0.10); },
    mate()    { if (can('mate'))    { playTone(520, 0.12, 'sine', 0.10); playTone(390, 0.16, 'sine', 0.085, 0.12); } },
    draw()    { if (can('draw'))    playTone(460, 0.11, 'sine', 0.075); },
    win()     { if (can('win'))     { playTone(660, 0.09, 'sine', 0.09); playTone(880, 0.13, 'sine', 0.085, 0.10); } },
    lose()    { if (can('lose'))    playTone(290, 0.15, 'triangle', 0.08); },
    start()   { if (can('start'))   playTone(580, 0.10, 'sine', 0.075); },
    msg()     { if (can('msg'))     playTone(880, 0.06, 'sine', 0.07); },
    moveBySan(san) {
      if (!san) return;
      const now = performance.now();
      if (san === lastSan && now - lastSanTime < 300) return;
      lastSan = san; lastSanTime = now;
      if (san.includes('#'))      this.mate();
      else if (san.includes('+')) this.check();
      else if (san.includes('x')) this.capture();
      else                        this.move();
    },
    initOnFirstClick() { window.addEventListener('pointerdown', () => ensure(), { once: true }); }
  };
})();

// ============================================================
// CHESS
// ============================================================
const Chess = {
  // Классические фигуры в стиле Cburnett/Lichess. Все фигуры — SVG, без эмодзи и шрифтов.
  pieceSvg(piece) {
    if (!piece) return '';
    const white = piece === piece.toUpperCase();
    const kind = piece.toLowerCase();
    const fill = white ? '#fff' : '#000';
    const stroke = '#000';
    const inner = white ? '#000' : '#fff';
    const common = `fill="${fill}" stroke="${stroke}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"`;
    const paths = {
      p: `<path ${common} d="M22.5 9c-2.21 0-4 1.79-4 4 0 .89.29 1.71.78 2.38C17.33 16.5 16 18.59 16 21c0 2.03.94 3.84 2.41 5.03-3 1.06-7.41 5.55-7.41 13.47h23c0-7.92-4.41-12.41-7.41-13.47 1.47-1.19 2.41-3 2.41-5.03 0-2.41-1.33-4.5-3.28-5.62.49-.67.78-1.49.78-2.38 0-2.21-1.79-4-4-4z"/>`,
      n: `<g ${common}><path d="M22 10c10.5 1 16.5 8 16 29H15c0-9 10-6.5 8-21"/><path d="M24 18c.38 2.91-5.55 7.37-8 9-3 2-2.82 4.34-5 4-1.04-.94 1.41-3.04 0-3-1 0 .19 1.23-1 2-1 0-4 1-4-4 0-2 6-12 6-12s1.89-1.9 2-3.5c-.73-.99-.5-2-.5-3 1-1 3 2.5 3 2.5h2s.78-1.99 2.5-3c1 0 1 3 1 3"/><circle cx="8.5" cy="25.5" r="0.85" fill="${inner}" stroke="${inner}" stroke-width="0.7"/></g>`,
      b: `<g ${common}><path d="M9 36c3.39-.97 10.11.43 13.5-2 3.39 2.43 10.11 1.03 13.5 2 0 0 1.65.54 3 2-.68.97-1.65.99-3 .5-3.39-.97-10.11.46-13.5-1-3.39 1.46-10.11.03-13.5 1-1.35.49-2.32.47-3-.5 1.35-1.94 3-2 3-2z"/><path d="M15 32c2.5 2.5 12.5 2.5 15 0 .5-1.5 0-2 0-2 0-2.5-2.5-4-2.5-4 5.5-1.5 6-11.5-5-15.5-11 4-10.5 14-5 15.5 0 0-2.5 1.5-2.5 4 0 0-.5.5 0 2z"/><circle cx="22.5" cy="8" r="2.5"/><path d="M17.5 26h10M15 30h15m-7.5-14.5v5M20 18h5" fill="none" stroke="${inner}"/></g>`,
      r: `<g ${common}><path d="M9 39h27v-3H9zM12 36v-4h21v4zM11 14V9h4v2h5V9h5v2h5V9h4v5"/><path d="M34 14l-3 3H14l-3-3M31 17v12.5H14V17M31 29.5l1.5 2.5h-20l1.5-2.5"/><path d="M11 14h23" fill="none" stroke="${inner}"/></g>`,
      q: `<g ${common}><path d="M8 12a2 2 0 1 1-4 0 2 2 0 1 1 4 0zM24.5 7.5a2 2 0 1 1-4 0 2 2 0 1 1 4 0zM41 12a2 2 0 1 1-4 0 2 2 0 1 1 4 0zM16 8.5a2 2 0 1 1-4 0 2 2 0 1 1 4 0zM33 9a2 2 0 1 1-4 0 2 2 0 1 1 4 0z"/><path d="M9 26c8.5-1.5 21-1.5 27 0l2-12-7 11V11l-5.5 13.5-3-15-3 15-5.5-14V25L7 14z"/><path d="M9 26c0 2 1.5 2 2.5 4 1 1.5 1 1 .5 3.5-1.5 1-1.5 2.5-1.5 2.5-1.5 1.5.5 2.5.5 2.5 6.5 1 16.5 1 23 0 0 0 1.5-1 0-2.5 0 0 .5-1.5-1-2.5-.5-2.5-.5-2 .5-3.5 1-2 2.5-2 2.5-4-8.5-1.5-18.5-1.5-27 0z"/><path d="M11.5 30c3.5-1 18.5-1 22 0M12 33.5c6-1 15-1 21 0" fill="none" stroke="${inner}"/></g>`,
      k: `<g ${common}><path d="M22.5 11.63V6M20 8h5" fill="none" stroke="#000" stroke-width="1.7"/><path d="M22.5 25s4.5-7.5 3-10.5c0 0-1-2.5-3-2.5s-3 2.5-3 2.5c-1.5 3 3 10.5 3 10.5z"/><path d="M11.5 37c5.5 3.5 15.5 3.5 21 0v-7s9-4.5 6-10.5c-4-6.5-13.5-3.5-16 4V27v-3.5c-3.5-7.5-13-10.5-16-4-3 6 5 10 5 10V37z"/><path d="M11.5 30c5.5-3 15.5-3 21 0m-21 3.5c5.5-3 15.5-3 21 0m-21 3.5c5.5-3 15.5-3 21 0" fill="none" stroke="${inner}" stroke-width="1.2"/><path d="M17.5 29.5h10" fill="none" stroke="${inner}" stroke-width="1.2"/></g>`
    };
    const label = ({k:'король',q:'ферзь',r:'ладья',b:'слон',n:'конь',p:'пешка'})[kind] || 'шахматная фигура';
    return `<svg class="pieceSvg ${white ? 'pieceWhite' : 'pieceBlack'}" viewBox="0 0 45 45" role="img" aria-label="${label}" focusable="false">${paths[kind] || ''}</svg>`;
  },
  parseFen(fen) {
    const parts = fen.split(' ');
    const board = Array.from({length:8}, () => Array(8).fill(null));
    parts[0].split('/').forEach((row, r) => { let f = 0; for (const ch of row) { if (/\d/.test(ch)) f += +ch; else board[r][f++] = ch; } });
    return { board, turn: parts[1], castling: parts[2], ep: parts[3], half: +parts[4] || 0, full: +parts[5] || 1 };
  },
  toFen(state) {
    const rows = state.board.map(r => { let s = '', e = 0; for (const c of r) { if (c) { if (e) { s += e; e = 0; } s += c; } else e++; } if (e) s += e; return s; }).join('/');
    return [rows, state.turn, state.castling, state.ep, state.half, state.full].join(' ');
  },
  isWhite(p) { return !!p && p === p.toUpperCase(); },
  inBoard(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; },
  pseudoMoves(state, r, c) {
    const p = state.board[r][c]; if (!p) return [];
    const moves = []; const white = this.isWhite(p); const type = p.toLowerCase();
    const dir = white ? -1 : 1;
    const add = (rr, cc) => { if (!this.inBoard(rr, cc)) return false; const t = state.board[rr][cc]; if (t && this.isWhite(t) === white) return false; moves.push([rr, cc]); return !t; };
    if (type === 'p') {
      const startRow = white ? 6 : 1, oneR = r + dir;
      if (this.inBoard(oneR, c) && !state.board[oneR][c]) { moves.push([oneR, c]); const twoR = r + 2 * dir; if (r === startRow && this.inBoard(twoR, c) && !state.board[twoR][c]) moves.push([twoR, c]); }
      for (const dc of [-1, 1]) { const rr = r + dir, cc = c + dc; if (!this.inBoard(rr, cc)) continue; const t = state.board[rr][cc]; if (t && this.isWhite(t) !== white) moves.push([rr, cc]); const epTarget = String.fromCharCode(97 + cc) + (8 - rr); if (state.ep && state.ep === epTarget && !t) moves.push([rr, cc]); }
    } else if (type === 'n') { [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]].forEach(([dr,dc]) => add(r+dr, c+dc)); }
    else if (type === 'k') {
      [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]].forEach(([dr,dc]) => add(r+dr, c+dc));
      if (white && r === 7 && c === 4 && !this.isAttacked(state, 7, 4, false)) {
        if (state.castling.includes('K') && !state.board[7][5] && !state.board[7][6] && state.board[7][7] === 'R' && !this.isAttacked(state, 7, 5, false) && !this.isAttacked(state, 7, 6, false)) moves.push([7, 6]);
        if (state.castling.includes('Q') && !state.board[7][3] && !state.board[7][2] && !state.board[7][1] && state.board[7][0] === 'R' && !this.isAttacked(state, 7, 3, false) && !this.isAttacked(state, 7, 2, false)) moves.push([7, 2]);
      }
      if (!white && r === 0 && c === 4 && !this.isAttacked(state, 0, 4, true)) {
        if (state.castling.includes('k') && !state.board[0][5] && !state.board[0][6] && state.board[0][7] === 'r' && !this.isAttacked(state, 0, 5, true) && !this.isAttacked(state, 0, 6, true)) moves.push([0, 6]);
        if (state.castling.includes('q') && !state.board[0][3] && !state.board[0][2] && !state.board[0][1] && state.board[0][0] === 'r' && !this.isAttacked(state, 0, 3, true) && !this.isAttacked(state, 0, 2, true)) moves.push([0, 2]);
      }
    } else {
      const dirs = [];
      if (type === 'r' || type === 'q') dirs.push([-1,0],[1,0],[0,-1],[0,1]);
      if (type === 'b' || type === 'q') dirs.push([-1,-1],[-1,1],[1,-1],[1,1]);
      for (const [dr, dc] of dirs) { let rr = r + dr, cc = c + dc; while (add(rr, cc)) { rr += dr; cc += dc; } }
    }
    return moves;
  },
  findKing(state, white) { const k = white ? 'K' : 'k'; for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (state.board[r][c] === k) return [r, c]; return null; },
  isAttacked(state, r, c, byWhite) {
    for (let rr = 0; rr < 8; rr++) for (let cc = 0; cc < 8; cc++) {
      const p = state.board[rr][cc]; if (!p || this.isWhite(p) !== byWhite) continue;
      const t = p.toLowerCase();
      if (t === 'p') { const dir = byWhite ? -1 : 1; if (rr + dir === r && (cc - 1 === c || cc + 1 === c)) return true; continue; }
      if (t === 'k') { if (Math.abs(rr - r) <= 1 && Math.abs(cc - c) <= 1 && (rr !== r || cc !== c)) return true; continue; }
      if (this.pseudoMoves(state, rr, cc).some(([mr, mc]) => mr === r && mc === c)) return true;
    }
    return false;
  },
  inCheck(state, white) { const k = this.findKing(state, white); if (!k) return false; return this.isAttacked(state, k[0], k[1], !white); },
  applyMove(state, from, to) {
    const copy = { board: state.board.map(row => row.slice()), turn: state.turn, castling: state.castling, ep: state.ep, half: state.half, full: state.full };
    const [fr, fc] = from, [tr, tc] = to;
    const p = copy.board[fr][fc]; const white = this.isWhite(p); const type = p.toLowerCase();
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
  },
  legalMovesFor(state, r, c) {
    const p = state.board[r][c]; if (!p) return [];
    const white = this.isWhite(p);
    return this.pseudoMoves(state, r, c).filter(([rr, cc]) => !this.inCheck(this.applyMove(state, [r, c], [rr, cc]), white));
  },
  hasAnyLegalMove(state, white) {
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const p = state.board[r][c];
      if (p && this.isWhite(p) === white && this.legalMovesFor(state, r, c).length) return true;
    }
    return false;
  },
  pieceSAN(p) { const t = p.toLowerCase(); if (t === 'n') return 'N'; if (t === 'b') return 'B'; if (t === 'r') return 'R'; if (t === 'q') return 'Q'; if (t === 'k') return 'K'; return ''; },
  toSAN(state, from, to) {
    const [fr, fc] = from, [tr, tc] = to;
    const p = state.board[fr][fc]; if (!p) return '';
    const t = p.toLowerCase();
    const isCapture = !!state.board[tr][tc] || (t === 'p' && fc !== tc);
    const dest = String.fromCharCode(97 + tc) + (8 - tr);
    if (t === 'k' && Math.abs(tc - fc) === 2) return (tc > fc) ? 'O-O' : 'O-O-O';
    let san = '';
    if (t === 'p') { if (isCapture) san += String.fromCharCode(97 + fc) + 'x'; san += dest; }
    else {
      san += this.pieceSAN(p);
      let ambiguous = false, sameFile = false, sameRank = false;
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        if (r === fr && c === fc) continue;
        const q = state.board[r][c]; if (!q || q !== p) continue;
        if (this.legalMovesFor(state, r, c).some(([mr,mc]) => mr === tr && mc === tc)) {
          ambiguous = true;
          if (c === fc) sameFile = true;
          if (r === fr) sameRank = true;
        }
      }
      if (ambiguous) {
        if (!sameFile) san += String.fromCharCode(97 + fc);
        else if (!sameRank) san += (8 - fr);
        else san += String.fromCharCode(97 + fc) + (8 - fr);
      }
      if (isCapture) san += 'x';
      san += dest;
    }
    const next = this.applyMove(state, from, to);
    const nextWhite = next.turn === 'w';
    const isCheck = this.inCheck(next, nextWhite);
    const hasMoves = this.hasAnyLegalMove(next, nextWhite);
    if (isCheck && !hasMoves) san += '#'; else if (isCheck) san += '+';
    return san;
  }
};

// ============================================================
// AUTH
// ============================================================
const Auth = {
  mode: 'login',

  switchTab(mode) {
    this.mode = mode;
    const tabLogin = document.getElementById('tabLoginBtn');
    const tabReg = document.getElementById('tabRegisterBtn');
    const emailField = document.getElementById('emailField');
    const btnText = document.getElementById('btnText');

    if (mode === 'login') {
      tabLogin.classList.add('active');
      tabReg.classList.remove('active');
      emailField.style.display = 'none';
      btnText.textContent = 'Войти';
    } else {
      tabReg.classList.add('active');
      tabLogin.classList.remove('active');
      emailField.style.display = 'block';
      btnText.textContent = 'Зарегистрироваться';
    }
    document.getElementById('loginMsg').textContent = '';
    const usernameStatus = document.getElementById('usernameStatus');
    if (usernameStatus && mode === 'login') { usernameStatus.textContent = ''; usernameStatus.className = ''; }
  },

  togglePassword() {
    const pw = document.getElementById('password');
    const icon = document.getElementById('eyeIcon');
    if (pw.type === 'password') {
      pw.type = 'text';
      icon.textContent = '🙈';
    } else {
      pw.type = 'password';
      icon.textContent = '👁';
    }
  },

  openResetModal() {
    const modal = document.getElementById('resetRequestModal');
    if (modal) modal.classList.add('show');
    const input = document.getElementById('resetEmailInput');
    if (input) input.value = '';
  },

  closeResetModal() {
    const modal = document.getElementById('resetRequestModal');
    if (modal) modal.classList.remove('show');
  },

  submitResetRequest() {
    const email = document.getElementById('resetEmailInput').value.trim();
    if (!email) { alert('Пожалуйста, введите email'); return; }
    
    this.closeResetModal();
    
    App.socket.emit('requestPasswordReset', { email }, (res) => {
      alert(res?.msg || 'Если email зарегистрирован, письмо отправлено');
    });
  },

  doResetPassword() {
    const hashPart = location.hash.split('?')[1];
    const token = hashPart ? new URLSearchParams(hashPart).get('token') : null;
    const newPassword = document.getElementById('newPassword').value;
    const confirmPassword = document.getElementById('confirmPassword').value;
    const msgEl = document.getElementById('resetMsg');

    if (!token) { msgEl.textContent = 'Неверная ссылка для сброса'; msgEl.style.color = '#ff6b6b'; return; }
    if (!newPassword || newPassword.length < 3) { msgEl.textContent = 'Пароль минимум 3 символа'; msgEl.style.color = '#ff6b6b'; return; }
    if (newPassword !== confirmPassword) { msgEl.textContent = 'Пароли не совпадают'; msgEl.style.color = '#ff6b6b'; return; }

    msgEl.textContent = 'Загрузка...';
    msgEl.style.color = 'var(--text)';

    App.socket.emit('resetPassword', { token, newPassword }, (res) => {
      if (!res || !res.ok) {
        msgEl.style.color = '#ff6b6b';
        msgEl.textContent = res?.msg || 'Ошибка';
        return;
      }
      msgEl.style.color = '#629924';
      msgEl.textContent = 'Пароль успешно изменен!';
      setTimeout(() => Router.go('autorize'), 2000);
    });
  },

  init() {
    const usernameInput = document.getElementById('username');
    const emailInput = document.getElementById('email');
    const usernameStatus = document.getElementById('usernameStatus');
    const emailStatus = document.getElementById('emailStatus');
    let usernameTimeout = null;
    let emailTimeout = null;

    if (usernameInput && usernameStatus) {
      usernameInput.addEventListener('input', () => {
        clearTimeout(usernameTimeout);
        const val = usernameInput.value.trim();
        usernameStatus.textContent = '';
        usernameStatus.className = '';
        if (Auth.mode !== 'register' || val.length < 2) return;
        usernameTimeout = setTimeout(() => {
          if (Auth.mode !== 'register') return;
          App.socket.emit('checkUsername', { username: val }, (res) => {
            if (!res || Auth.mode !== 'register') return;
            usernameStatus.textContent = res.msg || '';
            usernameStatus.className = res.available ? 'available' : 'taken';
          });
        }, 500);
      });
    }

    if (emailInput && emailStatus) {
      emailInput.addEventListener('input', () => {
        clearTimeout(emailTimeout);
        const val = emailInput.value.trim();
        emailStatus.textContent = '';
        emailStatus.className = '';
        if (!/^[^@]+@[^@]+\.[^@]+$/.test(val)) return;
        emailTimeout = setTimeout(() => {
          App.socket.emit('checkEmail', { email: val }, (res) => {
            if (!res) return;
            emailStatus.textContent = res.msg || '';
            emailStatus.className = res.available ? 'available' : 'taken';
          });
        }, 500);
      });
    }
  }
};

// ============================================================
// APP
// ============================================================
const App = {
  socket: null, me: null, lobbyId: null, myColor: 'w',
  myTime: 0, oppTime: 0, inc: 0,
  gameActive: false, gameEnded: false,
  opponentName: '—', opponentRating: null, opponentIsAdmin: false,
  opponentOnline: true, opponentIsBot: false, isBotGame: false,
  currentFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  currentGameIsArena: false, currentArenaId: null, currentArenaName: null,
  profileViewing: null, botLevels: [],
  botDialogState: { level: 2, time: 5, inc: 0 },
  botTimes: [
    { t: 1,  i: 0,  label: '1+0' },
    { t: 3,  i: 0,  label: '3+0' },
    { t: 5,  i: 0,  label: '5+0' },
    { t: 10, i: 0,  label: '10+0' },
    { t: 15, i: 10, label: '15+10' },
    { t: 30, i: 0,  label: '30+0' }
  ],

  init() {
    this.socket = io({ transports: ['websocket', 'polling'], upgrade: true, reconnection: true, reconnectionAttempts: 10, reconnectionDelay: 1000 });
    Sounds.initOnFirstClick();
    this.bindSocket();
    Router.init();
    TopArenas.init(); Stats.init(); Lobby.init(); Bot.init();
    Watch.init(); Arena.init(); Profile.init(); Community.init();
    Game.init(); Banners.init(); UserMenu.init(); Inbox.init(); Ping.init(); Auth.init();
    this.tryAutoLogin();
    this.scheduleArenaClock();
  },

  showAuthenticatedUI() {
    document.body.classList.remove('login-active');
    const header = document.getElementById('mainHeader');
    const main = document.getElementById('mainContent');
    if (header) header.style.display = '';
    if (main) main.style.display = '';
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  },

  updateTopbarUser() {
    if (!this.me) return;
    document.getElementById('userBtn').style.display = 'flex';
    document.getElementById('logoutBtn').style.display = 'none';
    document.getElementById('msgBellBtn').style.display = 'flex';
    document.getElementById('userName').innerHTML = Utils.nickHtml(this.me.username, this.me.isAdmin, this.me.isMod, this.me.isBot) + ' (' + this.me.rating + ')';
    document.getElementById('userAvatar').textContent = this.me.username.charAt(0).toUpperCase();
    document.getElementById('umAvatar').textContent = this.me.username.charAt(0).toUpperCase();
    document.getElementById('umName').textContent = this.me.username;
    if (this.socket) this.socket.emit('msgGetUnread', (r) => { if (r) Inbox.setUnread(r.count); });
  },

  doLogin() {
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const email = document.getElementById('email').value.trim();
    const msgEl = document.getElementById('loginMsg');

    if (!username || !password) { msgEl.textContent = 'Введите логин и пароль'; return; }
    if (Auth.mode === 'register' && !email) { msgEl.textContent = 'Введите email'; return; }
    if (Auth.mode === 'register') {
      const honor = document.getElementById('honorCheckbox');
      if (honor && !honor.checked) { msgEl.textContent = 'Подтвердите, что будете играть честно'; return; }
    }

    msgEl.textContent = 'Загрузка...';
    msgEl.style.color = 'var(--text)';

    App.socket.emit('register', { username, password, email: Auth.mode === 'register' ? email : undefined }, (res) => {
      if (!res || !res.ok) {
        msgEl.style.color = '#ff6b6b';
        msgEl.textContent = (res && res.msg) || 'Ошибка';
        if (res && res.pending) {
          msgEl.style.color = '#7dbe30';
          msgEl.innerHTML = `Мы отправили письмо с подтверждением на почту: <b>${email}</b>.<br>Если письмо не приходит, проверьте папку «Спам».`;
        }
        return;
      }
      this.me = res.user;
      try { localStorage.setItem('kingside_login', JSON.stringify({ username, password })); } catch (e) {}
      this.showAuthenticatedUI();
      this.updateTopbarUser();
      Router.go('lobby');
      this.tryResumeGame();
    });
  },

  logout() {
    try { localStorage.removeItem('kingside_login'); localStorage.removeItem('kingside_active_lobby'); } catch (e) {}
    location.reload();
  },

  tryAutoLogin() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('kingside_login') || 'null'); } catch (e) {}
    if (!saved || !saved.username || !saved.password) return;
    try { document.getElementById('username').value = saved.username; } catch (e) {}
    this.socket.emit('register', { username: saved.username, password: saved.password }, (res) => {
      if (!res || !res.ok) { try { localStorage.removeItem('kingside_login'); } catch (e) {} return; }
      this.me = res.user;
      this.showAuthenticatedUI();
      this.updateTopbarUser();
      Router.go('lobby');
      this.tryResumeGame();
    });
  },

  tryResumeGame() {
    let saved = null;
    try { saved = localStorage.getItem('kingside_active_lobby'); } catch (e) {}
    if (!saved) return;

    if (saved.startsWith('sp_')) {
      try { localStorage.removeItem('kingside_active_lobby'); } catch (e) {}
      Game.updateBackToGameBtn();
      return;
    }

    this.socket.emit('getGameState', { lobbyId: saved }, (res) => {
      if (!res || !res.ok) {
        try { localStorage.removeItem('kingside_active_lobby'); } catch (e) {}
        Game.updateBackToGameBtn();
        return;
      }
      if (res.state && res.state.isSelfPlay) {
        try { localStorage.removeItem('kingside_active_lobby'); } catch (e) {}
        Game.updateBackToGameBtn();
        return;
      }
      this.lobbyId = saved;
      Game.applyGameStateFromServer(res.state, saved);
    });
  },

  returnToGame() {
    if (!this.lobbyId) return;
    if (this.gameActive && !this.gameEnded) { Router.go('game'); Game.renderBoard(); Game.renderMoves(); return; }
    this.socket.emit('getGameState', { lobbyId: this.lobbyId }, (res) => {
      if (!res || !res.ok) { alert((res && res.msg) || 'Не удалось вернуться к партии'); return; }
      if (res.state && res.state.isSelfPlay) { alert('Это self-play партия'); return; }
      Game.applyGameStateFromServer(res.state, this.lobbyId);
    });
  },

  scheduleArenaClock() {
    setInterval(() => {
      const localNow = Date.now();
      const nowClock = document.getElementById('arenasNowClock');
      if (nowClock) nowClock.textContent = Utils.fmtMskHM(localNow);
      if (!document.getElementById('arenasScreen').classList.contains('active')) return;
      const scroller = document.querySelector('#arenasGridWrap .arenasScroller');
      if (!scroller) return;
      const nowLine = scroller.querySelector('.nowLine'); if (!nowLine) return;
      const timeRow = scroller.querySelector('.timeRow'); if (!timeRow) return;
      const firstCell = timeRow.querySelector('.timeCell'); if (!firstCell) return;
      const SLOT_PX = (typeof window.__arenaSlotPx === 'number' && window.__arenaSlotPx > 0) ? window.__arenaSlotPx : (firstCell.getBoundingClientRect().width || 90);
      const SLOT_MS = 10 * 60 * 1000;
      const startMs = (typeof window.__arenaStartMs === 'number') ? window.__arenaStartMs : Math.floor(localNow / SLOT_MS) * SLOT_MS;
      const nowLeft = ((localNow - startMs) / SLOT_MS) * SLOT_PX;
      nowLine.style.left = nowLeft.toFixed(2) + 'px';
      const cells = timeRow.querySelectorAll('.timeCell');
      const idx = Math.floor((localNow - startMs) / SLOT_MS);
      cells.forEach((c, i) => c.classList.toggle('now', i === idx && idx >= 0 && idx < cells.length));
    }, 1000);
  },

  bindSocket() {
    const s = this.socket;
    s.on('connect', () => { s.emit('stats', () => {}); Ping.onReconnect(); });
    s.on('stats', (st) => Stats.onStats(st));
    s.on('communityOnline', (players) => Community.render(players));
    s.on('lobbiesUpdate', () => Lobby.refreshIfActive());
    s.on('connect_error', () => console.warn('Не удалось подключиться'));
    s.on('gameStart', (payload) => Game.onGameStart(payload));
    s.on('boardUpdate', (payload) => { Game.onBoardUpdate(payload); Watch.onBoardUpdate(payload); });
    s.on('timeUpdate', (payload) => { Game.onTimeUpdate(payload); Watch.onTimeUpdate(payload); });
    s.on('gameEnded', (payload) => { Game.onGameEnded(payload); Watch.onGameEnded(payload); });
    s.on('chatMessage', (msg) => { Game.onChatMessage(msg); Watch.onChatMessage(msg); });
    s.on('chatMessageDeleted', ({ msgId }) => Game.onChatDeleted(msgId));
    s.on('chatError', ({ msg }) => alert(msg));
    s.on('drawOffered', ({ from }) => Banners.showDrawOffer(from));
    s.on('drawDeclined', () => Game.onDrawDeclined());
    s.on('rematchOffered', ({ from }) => { Banners.rematchFrom = from; Banners.showRematch(from); Game.refreshResultBar(); });
    s.on('rematchDeclined', () => Game.onRematchDeclined());
    s.on('opponentOnline', ({ username }) => Game.onOpponentOnline(username));
    s.on('opponentOffline', ({ username }) => Game.onOpponentOffline(username));
    s.on('opponentLeft', () => Game.onOpponentLeft());
    s.on('modAction', (info) => App.onModAction(info));
    s.on('watchersUpdate', ({ lobbyId, count }) => Watch.onWatchersUpdate(lobbyId, count));
    s.on('arenaChatMessage', (msg) => Arena.onChatMessage(msg));
    s.on('arenaUpdate', ({ arenaId }) => Arena.onUpdate(arenaId));
    s.on('arenaStarted', ({ arenaId }) => Arena.onUpdate(arenaId));
    s.on('arenaFinished', ({ arenaId, top3 }) => Arena.onFinished(arenaId, top3));
    s.on('liveGamesUpdate', (list) => { if (document.getElementById('watchScreen').classList.contains('active')) Watch.refreshFromList(list); });
    s.on('msgNew', (msg) => Inbox.onNew(msg));
    s.on('msgUnread', ({ count }) => Inbox.setUnread(count));
    s.on('msgDialogDeleted', ({ with: other }) => Inbox.onDialogDeleted(other));
  },

  onModAction(info) {
    if (!info || !this.me) return;
    if (info.action === 'mute' && info.target === this.me.username) alert(`Вы заглушены на ${info.minutes} мин. модератором ${info.by}.`);
    if (info.action === 'unmute' && info.target === this.me.username) alert('С вас снят мут.');
  }
};

// ============================================================
// USER MENU
// ============================================================
const UserMenu = {
  isOpen: false,
  init() {
    document.addEventListener('click', (e) => {
      const m = document.getElementById('userMenu');
      const btn = document.getElementById('userBtn');
      if (!m || m.style.display === 'none') return;
      if (m.contains(e.target) || (btn && btn.contains(e.target))) return;
      this.close();
    });
  },
  toggle(e) { if (e) e.stopPropagation(); this.isOpen ? this.close() : this.open(); },
  open() {
    const m = document.getElementById('userMenu'); if (!m) return;
    m.style.display = 'block'; this.isOpen = true;
    Ping.refresh();
    if (App.socket) App.socket.emit('msgGetUnread', (r) => { if (r) Inbox.setUnread(r.count); });
  },
  close() { const m = document.getElementById('userMenu'); if (!m) return; m.style.display = 'none'; this.isOpen = false; },
  goProfile() { this.close(); Router.go('profile'); },
  goInbox() { this.close(); Router.go('inbox'); },
  togglePing() { Ping.refresh(); }
};

// ============================================================
// PING
// ============================================================
const Ping = {
  timer: null, lastPingMs: null,
  init() { this.timer = setInterval(() => { const m = document.getElementById('userMenu'); if (m && m.style.display !== 'none') this.refresh(); }, 3000); },
  onReconnect() { this.refresh(); },
  refresh() {
    if (!App.socket) return;
    const t0 = performance.now();
    App.socket.emit('getStats', () => { const ms = Math.round(performance.now() - t0); this.setPing(ms); });
  },
  setPing(ms) {
    this.lastPingMs = ms;
    const el = document.getElementById('umPingValue');
    const bars = document.getElementById('umPingBars');
    const dot = document.getElementById('umServerDot');
    const srv = document.getElementById('umServerValue');
    if (el) el.textContent = ms + ' ms';
    if (srv) srv.textContent = '—';
    if (bars) { bars.classList.remove('good', 'mid', 'bad'); if (ms < 80) bars.classList.add('good'); else if (ms < 250) bars.classList.add('mid'); else bars.classList.add('bad'); }
    if (dot) { dot.classList.remove('ok', 'bad'); if (App.socket && App.socket.connected) dot.classList.add('ok'); else dot.classList.add('bad'); }
    const umPing = document.getElementById('umPing'); if (umPing) umPing.textContent = ms + ' ms';
  }
};

// ============================================================
// ROUTER
// ============================================================
const Router = {
  current: { name: 'lobby', param: null },
  init() { window.addEventListener('hashchange', () => this.handle()); this.handle(); },
  go(name, param) {
    const path = param ? `#/${name}/${encodeURIComponent(param)}` : `#/${name}`;
    if (location.hash === path) this.handle(); else location.hash = path;
  },
  handle() {
    const hash = location.hash.replace(/^#\/?/, '');
    const parts = hash.split('/').filter(Boolean);
    const name = parts[0] || (App.me ? 'lobby' : 'login');
    const param = parts[1] ? decodeURIComponent(parts[1]) : null;
    this.current = { name, param }; this.apply();
  },
  apply() {
    const { name, param } = this.current;

    if (App.me && App.gameActive && !App.gameEnded && (name === 'arenas' || name === 'arenaPage')) {
      Router.go('lobby');
      return;
    }

    if (name === 'reset') {
      document.body.classList.add('login-active');
      Router.show('resetScreen');
      return;
    }

    if (name === 'verify') {
      Router.go('autorize');
      return;
    }

    if (name === 'login' || name === 'autorize' || !App.me) {
      document.body.classList.add('login-active');
      Router.show('autorizeScreen');

      if (name === 'autorize' && param && param.includes('verified=1')) {
        const urlParams = new URLSearchParams(location.hash.split('?')[1]);
        const un = urlParams.get('username');

        if (un && App.socket) {
          App.socket.emit('register', { username: un, password: '' }, (res) => {
            const loginMsg = document.getElementById('loginMsg');
            loginMsg.textContent = 'Email подтвержден! Теперь войдите.';
            loginMsg.style.color = '#629924';
            const usernameInput = document.getElementById('username');
            if (usernameInput) usernameInput.value = un;
          });
        } else {
          const loginMsg = document.getElementById('loginMsg');
          loginMsg.textContent = 'Email подтвержден! Теперь войдите.';
          loginMsg.style.color = '#629924';
        }
      }
      return;
    }

    if (App.me && name !== 'reset' && name !== 'verify' && name !== 'login' && name !== 'autorize') {
      document.body.classList.remove('login-active');
      const header = document.getElementById('mainHeader');
      const main = document.getElementById('mainContent');
      if (header) header.style.display = '';
      if (main) main.style.display = '';
    }

    if (App.me && App.gameActive && !App.gameEnded && App.lobbyId && name === 'lobby') {
      const opponent = document.getElementById('activeGameOpponent');
      if (opponent) opponent.textContent = App.opponentName || 'соперником';
      this.show('lobbyScreen');
      document.querySelectorAll('#mainNav a').forEach(a => a.classList.toggle('active', a.dataset.nav === 'lobby'));
      Lobby.render();
      return;
    }
    const activeNotice = document.getElementById('activeGameNoticeScreen');
    if (activeNotice) activeNotice.classList.remove('active');
    if (name !== 'watch' && Watch.autoRefreshHandle) { clearInterval(Watch.autoRefreshHandle); Watch.autoRefreshHandle = null; }
    if (name !== 'arenaPage' && Arena.currentArenaId) Arena.leaveRoom();
    const map = { login: 'autorizeScreen', lobby: 'lobbyScreen', watch: 'watchScreen', arenas: 'arenasScreen', arenaPage: 'arenaPageScreen', profile: 'profileScreen', community: 'communityScreen', game: 'gameScreen', inbox: 'inboxScreen' };
    const screenId = map[name];
    if (!screenId) { this.show('lobbyScreen'); return; }
    this.show(screenId);
    document.querySelectorAll('#mainNav a').forEach(a => {
      const nav = a.dataset.nav;
      a.classList.toggle('active', nav === name || (name === 'arenaPage' && nav === 'arenas'));
    });
    switch (name) {
      case 'lobby': Lobby.enter(); break;
      case 'watch': Watch.enter(param); break;
      case 'arenas': Arena.enterList(); break;
      case 'arenaPage': Arena.enterPage(param); break;
      case 'profile': Profile.enter(param); break;
      case 'community': Community.enter(); break;
      case 'game': Game.enter(param); break;
      case 'inbox': Inbox.enter(param); break;
    }
  },
  show(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const el = document.getElementById(screenId); if (el) el.classList.add('active');
  }
};

// ============================================================
// TOP ARENAS
// ============================================================
const TopArenas = {
  lastHash: '', timer: null,
  init() { this.timer = setInterval(() => { if (document.hidden) return; if (!document.getElementById('lobbyScreen').classList.contains('active')) return; this.refresh(); }, 5000); },
  refresh() {
    App.socket.emit('getTopArenas', (list) => {
      const box = document.getElementById('topArenasBox'); if (!box) return;
      const hash = JSON.stringify(list); if (hash === this.lastHash) return; this.lastHash = hash;
      if (!list || !list.length) { box.innerHTML = '<div class="arenaEmpty" style="padding:20px 0">Сейчас активных арен нет</div>'; return; }
      box.innerHTML = list.map(a => {
        const cls = 'topArenaCard' + (a.phase === 'live' ? ' live' : '');
        const phaseText = a.phase === 'live' ? 'идёт сейчас' : 'ждёт старта';
        const botTag = a.botFriendly ? ' 🤖' : '';
        return `<div class="${cls}" onclick="Router.go('arenaPage', '${Utils.escapeHtml(a.id)}')"><div class="taName">${Utils.escapeHtml(a.name)}${botTag}</div><div class="taInfo"><span>${a.timeControl}+${a.increment}</span><span><b>${a.participantsCount}</b> 👥 · ${phaseText}</span></div></div>`;
      }).join('');
    });
  }
};

// ============================================================
// STATS
// ============================================================
const Stats = {
  init() {},
  refresh() { App.socket.emit('getStats', (s) => this.onStats(s)); },
  onStats(s) {
    if (!s) return;
    const e1 = document.getElementById('statOnline');
    const e2 = document.getElementById('statGames');
    const e3 = document.getElementById('statActive');
    if (e1) e1.textContent = s.online;
    if (e2) e2.textContent = s.games;
    if (e3) e3.textContent = s.activeGames || 0;
  }
};

// ============================================================
// LOBBY
// ============================================================
const Lobby = {
  currentTab: 'create', known: new Map(), disappeared: new Map(),
  init() { document.querySelectorAll('[data-tab]').forEach(b => { b.onclick = () => this.switchTab(b.dataset.tab); }); },
  enter() { TopArenas.refresh(); Stats.refresh(); this.render(); },
  switchTab(tab) { this.currentTab = tab; document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab)); this.render(); },
  refreshIfActive() { if (document.getElementById('lobbyScreen').classList.contains('active') && this.currentTab === 'waiting') this.render(); },
  render() {
    const el = document.getElementById('lobbyTabContent'); if (!el) return;
    if (App.me && App.gameActive && !App.gameEnded && App.lobbyId) {
      const oppName = App.opponentName || 'соперником';
      const opponent = document.getElementById('activeGameOpponent'); if (opponent) opponent.textContent = oppName;
      el.innerHTML = `<div class="activeGamePanel"><div class="activeGamePanelWatermark" aria-hidden="true">♞</div><div class="activeGamePanelInner"><div class="agpTitle">Подождите!</div><div class="agpSub">У вас идёт игра с <strong>${Utils.escapeHtml(oppName)}</strong>.</div><button class="agpReturnBtn" onclick="App.returnToGame()">▶ ПРИНЯТЬ ВЫЗОВ</button><div class="agpOr">или</div><button class="agpAbortBtn" onclick="Game.resign(); if (App.gameEnded) Router.go('lobby')">✖ СДАТЬСЯ</button><div class="agpFoot">Вы не можете начать новую партию, пока текущая не завершена.</div></div></div>`;
      return;
    }
    if (this.currentTab === 'create') {
      el.innerHTML = `<div class="quickGrid">${[
            {t:1,i:0,name:'Пуля'},{t:2,i:1,name:'Пуля'},
            {t:3,i:0,name:'Блиц'},{t:3,i:2,name:'Блиц'},{t:5,i:0,name:'Блиц'},{t:5,i:3,name:'Блиц'},
            {t:10,i:0,name:'Рапид'},{t:10,i:5,name:'Рапид'},{t:15,i:10,name:'Рапид'},
            {t:30,i:0,name:'Классика'},{t:30,i:20,name:'Классика'}
          ].map(({t,i,name}) => `<button class="quickBtn" onclick="Lobby.quickStart(${t},${i})"><div class="qb-time">${t}+${i}</div><div class="qb-name">${name}</div></button>`).join('')}<button class="quickBtn custom" onclick="Lobby.showCustom()"><div class="qb-time">Своя</div><div class="qb-name">игра</div></button></div>
        <div id="customGamePanel" style="display:none; margin:0 16px 16px; padding:14px; background:var(--panel-2); border-radius:6px;"><div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;"><label style="color:var(--muted);font-size:13px;">Минуты:</label><input id="customMin" type="number" value="5" min="1" max="60" style="width:70px;"><label style="color:var(--muted);font-size:13px;">Инкремент:</label><input id="customInc" type="number" value="0" min="0" max="60" style="width:70px;"><button class="primary" onclick="Lobby.createCustom()" style="padding:8px 18px;">Создать</button></div></div>`;
      return;
    }
    this.renderWaiting();
  },
  renderWaiting() {
    const el = document.getElementById('lobbyTabContent');
    App.socket.emit('getLobbies', (res) => {
      let list = Array.isArray(res) ? res : ((res && Array.isArray(res.list)) ? res.list : []);
      list = list.filter(l => !l.isSelfPlay);

      el.innerHTML = '';
      const current = new Map();
      if (list.length) for (const l of list) if (l.status === 'waiting') current.set(l.id, l);
      const now = Date.now();
      for (const [id, data] of this.known) if (!current.has(id)) this.disappeared.set(id, { data, removedAt: now + 5000 });
      this.known = current;
      for (const [id, info] of this.disappeared) if (Date.now() > info.removedAt) this.disappeared.delete(id);
      const allItems = [];
      for (const [id, l] of current) allItems.push({ kind: 'waiting', id, data: l });
      for (const [id, info] of this.disappeared) allItems.push({ kind: 'started', id, data: info.data });
      if (!allItems.length) { el.innerHTML = `<div class="lobbyHeader"><div></div><div class="hRating">Рейтинг</div><div class="hPlayer">Игрок</div><div class="hTime">Время</div><div class="hMode">Режим</div></div><div class="arenaEmpty" style="padding:30px 20px;">Нет активных вызовов. Нажми «Создать запрос на игру» справа.</div>`; return; }
      allItems.sort((a, b) => { if (a.kind !== b.kind) return a.kind === 'started' ? -1 : 1; return (b.data.time || 0) - (a.data.time || 0); });
      const header = document.createElement('div'); header.className = 'lobbyHeader';
      header.innerHTML = `<div></div><div class="hRating">Рейтинг</div><div class="hPlayer">Игрок</div><div class="hTime">Время</div><div class="hMode">Режим</div>`;
      el.appendChild(header);
      const wrap = document.createElement('div'); wrap.className = 'lobbyList';
      for (const item of allItems) {
        const l = item.data; const isMine = App.me && l.host === App.me.username; const isStarted = item.kind === 'started';
        const row = document.createElement('div');
        row.className = 'lobbyRow' + (isMine && !isStarted ? ' mine' : '') + (isStarted ? ' started' : '');
        const circleCls = isStarted ? 'white' : 'black';
        const rating = l.hostRating || '';
        row.innerHTML = `<div class="lColor ${circleCls}"></div><div class="lRating muted">${rating || '—'}</div><div class="lName">${Utils.nickHtml(l.host, l.hostIsAdmin, l.hostIsMod, l.isBot)}${isStarted ? '<span class="mineTag">(началась)</span>' : (isMine ? '<span class="mineTag">(ваш)</span>' : '')}</div><div class="lTime">${l.time}+${l.inc}</div><div class="lMode"><span class="modeIcon">⚔</span>Рейтинговая</div>`;
        if (!isStarted) { row.title = isMine ? 'Нажми, чтобы отменить свой вызов' : 'Нажми, чтобы начать партию'; row.onclick = () => this.onRowClick(l, isMine); }
        wrap.appendChild(row);
      }
      el.appendChild(wrap);
      if (this.disappeared.size) setTimeout(() => { if (this.currentTab === 'waiting') this.render(); }, 5200);
    });
  },
  onRowClick(l, isMine) {
    if (isMine) { App.socket.emit('cancelLobby', { id: l.id }, () => this.render()); return; }
    App.socket.emit('joinLobby', { id: l.id }, (r) => { if (!r || !r.ok) { alert((r && r.msg) || 'Ошибка'); return; } App.lobbyId = r.id || l.id; });
  },
  quickStart(time, inc) {
    App.socket.emit('createLobby', { time, inc }, (res) => {
      if (!res || !res.ok) { alert((res && res.msg) || 'Ошибка'); return; }
      if (res.matched) { App.lobbyId = res.id; return; }
      App.lobbyId = res.id; App.myColor = 'w';
      App.currentFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      App.gameActive = false; App.gameEnded = false;
      App.opponentName = '—'; App.opponentRating = null;
      App.opponentIsAdmin = false; App.opponentIsBot = false;
      App.isBotGame = false; App.currentGameIsArena = false; App.currentArenaName = null;
      Game.reset(); Game.resetUI(); Game.hideResultBar();
      Router.go('game'); Game.renderBoard(); Game.renderMoves();
      const bar = document.getElementById('statusBar');
      if (bar) { bar.className = 'statusGreen'; bar.textContent = 'Ожидание соперника...'; }
    });
  },
  showCustom() { const p = document.getElementById('customGamePanel'); if (p) p.style.display = p.style.display === 'none' ? 'block' : 'none'; },
  createCustom() {
    const m = +document.getElementById('customMin').value || 5;
    const i = +document.getElementById('customInc').value || 0;
    this.quickStart(m, i);
  }
};

// ============================================================
// BOT
// ============================================================
const Bot = {
  init() { const dlg = document.getElementById('botDialog'); if (dlg) dlg.addEventListener('click', (e) => { if (e.target === dlg) this.closeDialog(); }); },
  openDialog() {
    const dlg = document.getElementById('botDialog'); if (!dlg) return;
    App.socket.emit('getBots', (list) => {
      if (Array.isArray(list)) App.botLevels = list.map(b => ({ level: b.level, name: b.name, title: b.title, desc: b.desc || '', rating: b.rating, initialRating: b.initialRating, games: b.games || 0, isMaster: b.level === 4 }));
      this.render(); dlg.classList.add('show');
    });
  },
  closeDialog() { const dlg = document.getElementById('botDialog'); if (dlg) dlg.classList.remove('show'); },
  render() {
    const levelsEl = document.getElementById('botLevels'); const timesEl = document.getElementById('botTimes');
    if (!levelsEl || !timesEl) return;
    if (!App.botLevels.length) { App.socket.emit('getBots', (list) => { if (Array.isArray(list)) { App.botLevels = list.map(b => ({ level: b.level, name: b.name, title: b.title, desc: b.desc || '', rating: b.rating, initialRating: b.initialRating, games: b.games || 0, isMaster: b.level === 4 })); this.render(); } }); return; }
    const st = App.botDialogState;
    levelsEl.innerHTML = App.botLevels.map(l => { const active = st.level === l.level; const cls = active ? 'active' : ''; const extra = l.isMaster ? 'masterBtn' : ''; return `<button data-level="${l.level}" class="${cls} ${extra}"><div class="btitle">${l.title}</div><div class="brating">${l.rating}</div></button>`; }).join('');
    timesEl.innerHTML = App.botTimes.map(t => { const active = st.time === t.t && st.inc === t.i; return `<button data-t="${t.t}" data-i="${t.i}" class="${active ? 'active' : ''}">${t.label}</button>`; }).join('');
    levelsEl.querySelectorAll('button').forEach(b => b.onclick = () => { App.botDialogState.level = +b.dataset.level; this.render(); });
    timesEl.querySelectorAll('button').forEach(b => b.onclick = () => { App.botDialogState.time = +b.dataset.t; App.botDialogState.inc = +b.dataset.i; this.render(); });
  },
  startGame() {
    const bot = App.botLevels.find(b => b.level === App.botDialogState.level); if (!bot) return;
    App.socket.emit('playWithBot', { time: App.botDialogState.time, inc: App.botDialogState.inc, botName: bot.name }, (res) => {
      if (!res || !res.ok) { alert((res && res.msg) || 'Ошибка'); return; } this.closeDialog();
    });
  }
};

// ============================================================
// WATCH
// ============================================================
const Watch = {
  watchingGameId: null, watchingGame: null, lastHash: '', lastBoardHash: '',
  watchClockHandle: null, watchClockSyncedAt: 0, watchClockW: 0, watchClockB: 0, watchClockTurn: 'w',
  requestId: 0, autoRefreshHandle: null,
  init() {},
  enter(gameId) {
    if (gameId && gameId.startsWith('sp_')) { Router.go('watch'); return; }
    this.refresh(true);
    if (gameId) this.watch(gameId);
    if (this.autoRefreshHandle) clearInterval(this.autoRefreshHandle);
    this.autoRefreshHandle = setInterval(() => { if (document.getElementById('watchScreen').classList.contains('active')) this.refresh(false); }, 3000);
  },
  refresh(force) { App.socket.emit('getLiveGames', (list) => { this.refreshFromList(list); }); },
  refreshFromList(list) {
    const box = document.getElementById('watchListBody'); if (!box) return;

    list = (list || []).filter(g => !g.isSelfPlay && !(g.id && g.id.startsWith('sp_')));

    const hash = JSON.stringify(list); if (hash === this.lastHash) return; this.lastHash = hash;
    if (!list.length) { box.innerHTML = '<div class="arenasEmpty" style="padding:20px 10px;">Пока никто не играет</div>'; return; }
    box.innerHTML = list.map(g => {
      const cls = 'watchRow' + (g.isArena ? ' isArena' : '') + (g.isBotGame ? ' isBotGame' : '');
      const arenaTag = g.isArena ? ` · ${Utils.escapeHtml(g.arenaName || 'турнир')}` : '';
      const botTag = g.isBotGame ? ' 🤖' : '';
      const wBot = g.whiteIsBot ? '🤖' : ''; const bBot = g.blackIsBot ? '🤖' : '';
      return `<div class="${cls}" onclick="Watch.watch('${g.id}')">
        <div class="wrPlayers"><span><span class="liveDot"></span>⚪ ${wBot}${Utils.nickHtml(g.white, g.whiteIsAdmin, g.whiteIsMod, g.whiteIsBot)}${g.whiteRating ? ' <span class="prat">('+g.whiteRating+')</span>' : ''}</span><span>${Utils.formatTime(g.timeW)}</span></div>
        <div class="wrPlayers"><span>⚫ ${bBot}${Utils.nickHtml(g.black, g.blackIsAdmin, g.blackIsMod, g.blackIsBot)}${g.blackRating ? ' <span class="prat">('+g.blackRating+')</span>' : ''}</span><span>${Utils.formatTime(g.timeB)}</span></div>
        <div class="wrMeta"><span>${g.timeControl}+${g.increment}${arenaTag}${botTag}</span><span>ход: <b>${g.turn === 'w' ? 'белые' : 'чёрные'}</b> ${Utils.watchersHtml(g.watchersCount)}</span></div>
      </div>`;
    }).join('');
  },
  watch(id) {
    if (!id || id.startsWith('sp_')) { alert('Self-play партии недоступны для просмотра'); return; }
    if (this.watchingGameId === id) { if (Router.current.name !== 'watch') Router.go('watch', id); return; }
    if (this.watchingGameId) App.socket.emit('unwatchGame', { id: this.watchingGameId });
    this.watchingGameId = id; this.watchingGame = null; this.lastBoardHash = '';
    if (Router.current.name !== 'watch') { Router.go('watch', id); return; }
    const reqId = ++this.requestId;
    App.socket.emit('watchGame', { id }, (res) => {
      if (reqId !== this.requestId) return;
      if (!res || !res.ok) { alert((res && res.msg) || 'Не удалось начать просмотр'); this.watchingGameId = null; return; }
      if (res.game && res.game.isSelfPlay) { alert('Self-play партии недоступны'); this.watchingGameId = null; return; }
      this.watchingGame = res.game; this.lastBoardHash = ''; this.renderBoard();
    });
  },
  stop() {
    if (this.watchingGameId) App.socket.emit('unwatchGame', { id: this.watchingGameId });
    this.watchingGameId = null; this.watchingGame = null; this.lastBoardHash = '';
    if (this.watchClockHandle) { cancelAnimationFrame(this.watchClockHandle); this.watchClockHandle = null; }
    this.renderBoard();
    if (Router.current.name === 'watch') Router.go('watch');
  },
  renderBoard() {
    const box = document.getElementById('watchBoardBox'); if (!box) return;
    if (!this.watchingGame) { box.innerHTML = '<div class="wbEmpty">Выбери партию слева</div>'; return; }
    const g = this.watchingGame;
    const state = Chess.parseFen(g.fen);
    const flip = false;
    const lmHash = g.lastMove ? g.lastMove.from.join(',') + '>' + g.lastMove.to.join(',') : '';
    const hash = g.id + '|' + g.fen + '|' + g.turn + '|' + flip + '|' + (g.watchersCount || 0) + '|' + (g.finished ? 'F' : 'A') + '|' + lmHash;
    if (hash === this.lastBoardHash) return;
    this.lastBoardHash = hash;
    const whiteActive = g.turn === 'w', blackActive = g.turn === 'b';
    let squares = '';
    const lm = g.lastMove;
    for (let dr = 0; dr < 8; dr++) for (let dc = 0; dc < 8; dc++) {
      const r = flip ? 7 - dr : dr, c = flip ? 7 - dc : dc;
      let cls = 'sq ' + ((r + c) % 2 ? 'dark' : 'light');
      if (lm && ((lm.from[0] === r && lm.from[1] === c) || (lm.to[0] === r && lm.to[1] === c))) cls += ' lastmove';
      const p = state.board[r][c]; let inner = '';
      if (p) { const isW = p === p.toUpperCase(); inner = `<span class="piece ${isW?'w':'b'}">${Chess.pieceSvg(p)}</span>`; }
      let coords = '';
      if (dr === 7) coords += `<span class="coord-f">${String.fromCharCode(97 + c)}</span>`;
      if (dc === 0) coords += `<span class="coord-r">${8 - r}</span>`;
      squares += `<div class="${cls}">${inner}${coords}</div>`;
    }
    const finishedLine = g.finished ? `<div style="text-align:center; margin-top:10px; padding:8px 12px; background:rgba(98,153,36,.12); border-left:3px solid var(--green); border-radius:4px; color:var(--text-bright); font-size:13px;">✅ Партия завершена${g.reason ? ' · ' + Utils.escapeHtml(g.reason) : ''}</div>` : '';
    const wBot = g.whiteIsBot ? '🤖 ' : ''; const bBot = g.blackIsBot ? '🤖 ' : '';
    box.innerHTML = `<div class="wbHeader"><div style="min-width:0; flex:1"><div class="wbTitle">Партия ${g.isArena ? 'турнира' : ''}${g.whiteIsBot || g.blackIsBot ? ' (с ботом)' : ''}</div><div class="wbSub">${g.timeControl}+${g.increment}${g.arenaName ? ' · '+Utils.escapeHtml(g.arenaName) : ''}</div></div><button class="secondary" onclick="Watch.stop()" style="flex-shrink:0">✕ Выйти</button></div>
      <div class="wbPlayers"><div class="wbPlayer ${blackActive?'active':''}"><span style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"><span class="name">⚫ ${bBot}${Utils.nickHtml(g.black, g.blackIsAdmin, g.blackIsMod, g.blackIsBot)}</span>${g.blackRating ? `<span class="rating">(${g.blackRating})</span>` : ''}</span><span class="time" id="watchTimeB">${Utils.formatTime(g.timeB)}</span></div><div class="wbPlayer ${whiteActive?'active':''}"><span style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"><span class="name">⚪ ${wBot}${Utils.nickHtml(g.white, g.whiteIsAdmin, g.whiteIsMod, g.whiteIsBot)}</span>${g.whiteRating ? `<span class="rating">(${g.whiteRating})</span>` : ''}</span><span class="time" id="watchTimeW">${Utils.formatTime(g.timeW)}</span></div></div>
      <div class="wbBoardWrap"><div class="wbBoard">${squares}</div></div>${finishedLine}
      <div style="text-align:center; margin-top:8px; font-size:12px; color:var(--muted); ${g.watchersCount > 0 ? '' : 'display:none;'}">👁 Зрителей: <b style="color:var(--accent)">${g.watchersCount || 0}</b></div>`;
    this.startClock();
  },
  startClock() {
    if (this.watchClockHandle) cancelAnimationFrame(this.watchClockHandle);
    this.watchClockSyncedAt = performance.now();
    if (this.watchingGame) { this.watchClockW = this.watchingGame.timeW; this.watchClockB = this.watchingGame.timeB; this.watchClockTurn = this.watchingGame.turn; }
    const self = this;
    function tick() {
      if (!self.watchingGame) { self.watchClockHandle = null; return; }
      const elapsed = (performance.now() - self.watchClockSyncedAt) / 1000;
      let w = self.watchClockW, b = self.watchClockB;
      if (self.watchClockTurn === 'w') w = Math.max(0, w - elapsed); else b = Math.max(0, b - elapsed);
      const elW = document.getElementById('watchTimeW'); const elB = document.getElementById('watchTimeB');
      if (elW) elW.textContent = Utils.formatTime(w);
      if (elB) elB.textContent = Utils.formatTime(b);
      self.watchClockHandle = requestAnimationFrame(tick);
    }
    this.watchClockHandle = requestAnimationFrame(tick);
  },
  onWatchersUpdate(lobbyId, count) {
    if (this.watchingGame && this.watchingGame.id === lobbyId) { this.watchingGame.watchersCount = count; this.lastBoardHash = ''; this.renderBoard(); }
    if (document.getElementById('watchScreen').classList.contains('active')) this.refresh(false);
  },
  onBoardUpdate({ lobbyId, fen, turn, san, from, to }) {
    if (!this.watchingGame || this.watchingGame.id !== lobbyId) return;
    this.watchingGame.fen = fen; if (turn) this.watchingGame.turn = turn; if (from && to) this.watchingGame.lastMove = { from, to };
    this.lastBoardHash = ''; this.renderBoard();
  },
  onTimeUpdate({ lobbyId, timeW, timeB, serverNow }) {
    if (!this.watchingGame || this.watchingGame.id !== lobbyId) return;
    this.watchingGame.timeW = timeW; this.watchingGame.timeB = timeB;
    this.watchClockSyncedAt = performance.now(); this.watchClockW = timeW; this.watchClockB = timeB;
  },
  onGameEnded({ lobbyId, result, reason }) {
    if (!this.watchingGame || this.watchingGame.id !== lobbyId) return;
    this.watchingGame.finished = true; this.watchingGame.result = result; this.watchingGame.reason = reason;
    this.lastBoardHash = ''; this.renderBoard(); this.refresh(false);
  },
  onChatMessage(msg) { if (!this.watchingGame || this.watchingGame.id !== msg.lobbyId) return; }
};

// ============================================================
// ARENA
// ============================================================
const Arena = {
  cache: [], statesCache: {}, serverOffsetMs: 0, currentArenaId: null, currentArenaState: null,
  lastListHash: '', lastStateHash: '', lastGamesHash: '', loadBusy: false,
  pageRefreshHandle: null, statusTickHandle: null, gamesRefreshHandle: null, refreshHandle: null,
  init() {},
  enterList() { this.refresh(true); },
  enterPage(arenaId) {
    if (!arenaId) { Router.go('arenas'); return; }
    if (App.gameActive && !App.gameEnded) {
      Router.go('lobby');
      return;
    }
    if (Watch.watchingGameId) Watch.stop();
    if (this.currentArenaId && this.currentArenaId !== arenaId) App.socket.emit('leaveArenaRoom', { arenaId: this.currentArenaId });
    this.currentArenaId = arenaId;
    document.getElementById('arenaChatMessages').innerHTML = '';
    this.lastStateHash = ''; this.lastGamesHash = '';
    App.socket.emit('joinArenaRoom', { arenaId }, (res) => { if (res && res.ok && Array.isArray(res.chat)) { const box = document.getElementById('arenaChatMessages'); box.innerHTML = ''; res.chat.forEach(m => this.renderChatMsg(m)); } });
    this.loadPage();
    if (this.pageRefreshHandle) clearInterval(this.pageRefreshHandle);
    this.pageRefreshHandle = setInterval(() => { if (document.getElementById('arenaPageScreen').classList.contains('active')) this.loadPage(); }, 5000);
    if (this.statusTickHandle) clearInterval(this.statusTickHandle);
    this.statusTickHandle = setInterval(() => this.tickStatus(), 1000);
    if (this.gamesRefreshHandle) clearInterval(this.gamesRefreshHandle);
    this.gamesRefreshHandle = setInterval(() => { if (document.getElementById('arenaPageScreen').classList.contains('active')) this.renderGamesList(); }, 3000);
  },
  leaveRoom() {
    if (Watch.watchingGameId) Watch.stop();
    if (this.currentArenaId) { App.socket.emit('leaveArenaRoom', { arenaId: this.currentArenaId }); this.currentArenaId = null; }
    if (this.pageRefreshHandle) { clearInterval(this.pageRefreshHandle); this.pageRefreshHandle = null; }
    if (this.statusTickHandle) { clearInterval(this.statusTickHandle); this.statusTickHandle = null; }
    if (this.gamesRefreshHandle) { clearInterval(this.gamesRefreshHandle); this.gamesRefreshHandle = null; }
  },
  refresh(force) {
    if (!force && !document.getElementById('arenasScreen').classList.contains('active')) return;
    App.socket.emit('getArenas', (res) => {
      const list = (res && res.list) || []; const serverNow = (res && res.serverNow) || Date.now();
      this.serverOffsetMs = serverNow - Date.now(); this.cache = list;
      App.socket.emit('getMyArenaStates', (r2) => {
        this.statesCache = (r2 && r2.states) || {}; if (r2 && r2.serverNow) this.serverOffsetMs = r2.serverNow - Date.now();
        const hash = JSON.stringify(this.cache) + '|' + JSON.stringify(this.statesCache);
        if (hash === this.lastListHash && !force) return; this.lastListHash = hash; this.renderGrid();
      });
    });
    if (this.refreshHandle) clearInterval(this.refreshHandle);
    this.refreshHandle = setInterval(() => {
      if (!document.getElementById('arenasScreen').classList.contains('active')) return;
      App.socket.emit('getArenas', (res) => {
        const list = (res && res.list) || []; const serverNow = (res && res.serverNow) || Date.now();
        this.serverOffsetMs = serverNow - Date.now(); this.cache = list;
        App.socket.emit('getMyArenaStates', (r2) => {
          this.statesCache = (r2 && r2.states) || {};
          const hash = JSON.stringify(this.cache) + '|' + JSON.stringify(this.statesCache);
          if (hash === this.lastListHash) return; this.lastListHash = hash; this.renderGrid();
        });
      });
    }, 30000);
  },
  renderGrid() {
    const wrap = document.getElementById('arenasGridWrap'); if (!wrap) return;
    if (!this.cache || !this.cache.length) { wrap.innerHTML = '<div class="arenasEmpty">Нет доступных арен</div>'; return; }
    const localNow = Date.now();
    const toClient = (ts) => ts - this.serverOffsetMs;
    const isMobile = window.matchMedia('(max-width: 700px)').matches;
    const SLOT_PX = isMobile ? 60 : 90; const SLOT_MS = 10 * 60 * 1000; const COLS = isMobile ? 48 : 72;
    const startMs = Math.floor(localNow / SLOT_MS) * SLOT_MS; const endMs = startMs + COLS * SLOT_MS;
    window.__arenaStartMs = startMs; window.__arenaSlotPx = SLOT_PX;
    const toPx = (ts) => ((ts - startMs) / SLOT_MS) * SLOT_PX;
    const visible = this.cache.map(a => ({ ...a, clientStartsAt: toClient(a.startsAt), clientEndsAt: toClient(a.endsAt) })).filter(a => a.clientEndsAt > startMs && a.clientStartsAt < endMs).sort((a, b) => a.clientStartsAt - b.clientStartsAt);
    const rows = [];
    for (const arena of visible) {
      const lane = arena.lane || 0;
      if (!rows[lane]) rows[lane] = [];
      rows[lane].push(arena);
    }
    const finalRows = rows.filter(r => r && r.length);
    const rowWidth = COLS * SLOT_PX;
    let html = '<div class="arenasScroller"><div class="timeRow" style="width:' + rowWidth + 'px;">';
    for (let i = 0; i < COLS; i++) { const t = startMs + i * SLOT_MS; const isNow = t <= localNow && localNow < t + SLOT_MS; html += '<div class="timeCell' + (isNow ? ' now' : '') + '" style="width:' + SLOT_PX + 'px;min-width:' + SLOT_PX + 'px;">' + Utils.fmtMskHM(t) + '</div>'; }
    html += '</div>';
    for (const row of finalRows) {
      html += '<div class="arenaRowGrid" style="width:' + rowWidth + 'px;">';
      for (const arena of row) {
        const left = toPx(arena.clientStartsAt); const width = toPx(arena.clientEndsAt) - left;
        const isPast = arena.clientEndsAt < localNow; const isLive = arena.status === 'live';
        const colorClass = arena.color || 'blitz';
        const myState = this.statesCache[arena.id]; const joined = myState && myState.joined;
        const cls = 'arenaBlock ' + colorClass + (isPast && !isLive ? ' past' : '') + (isLive ? ' live' : '') + (joined ? ' joined' : '') + (arena.botFriendly ? ' botFriendly' : '');
        const tinfo = arena.timeControl + '+' + arena.increment;
        const participantsCount = (myState && myState.participantsCount) || 0;
        const showInfo = width >= 50; const dur = Math.round((arena.clientEndsAt - arena.clientStartsAt) / 60000);
        const botMark = arena.botFriendly ? '🤖 ' : '';
        const isDisabled = App.gameActive && !App.gameEnded;
        const clickHandler = isDisabled ? '' : `onclick="Router.go('arenaPage', '${Utils.escapeHtml(arena.id)}')"`;
        const disabledClass = isDisabled ? ' disabled' : '';
        html += '<div class="' + cls + disabledClass + '" style="left:' + left.toFixed(2) + 'px; width:' + width.toFixed(2) + 'px; cursor:' + (isDisabled?'not-allowed':'pointer') + '" ' + clickHandler + ' title="' + Utils.escapeHtml(botMark + arena.name) + ' · ' + tinfo + ' · ' + Utils.fmtMskHM(arena.clientStartsAt) + '–' + Utils.fmtMskHM(arena.clientEndsAt) + ' МСК (' + dur + ' мин)"><div class="tname">' + botMark + Utils.escapeHtml(arena.name) + '</div>' + (showInfo ? '<div class="tinfo"><span>' + tinfo + '</span><span>👥 ' + participantsCount + '</span></div>' : '') + '</div>';
      }
      html += '</div>';
    }
    const nowLeft = toPx(localNow);
    html += '<div class="nowLine" style="left:' + nowLeft.toFixed(2) + 'px;"></div></div>';
    wrap.innerHTML = html;
    const scroller = wrap.querySelector('.arenasScroller'); if (scroller) scroller.scrollLeft = Math.max(0, nowLeft - scroller.clientWidth / 4);
  },
  loadPage() {
    if (!this.currentArenaId || this.loadBusy) return; this.loadBusy = true;
    const arena = this.cache.find(a => a.id === this.currentArenaId);
    if (!arena) {
      App.socket.emit('getArenas', (res) => { this.cache = (res && res.list) || []; if (res && res.serverNow) this.serverOffsetMs = res.serverNow - Date.now(); this.loadBusy = false; if (this.cache.find(x => x.id === this.currentArenaId)) this.loadPage(); });
      return;
    }
    App.socket.emit('getArenaState', { arenaId: this.currentArenaId }, (state) => {
      this.loadBusy = false; this.currentArenaState = state;
      if (state.serverNow) this.serverOffsetMs = state.serverNow - Date.now();
      this.renderPage(arena, state); this.updateJoinButton(state); this.renderPairingBox(state);
      const stateHash = JSON.stringify(state.participants) + '|' + state.paused + '|' + state.phase;
      if (stateHash !== this.lastStateHash) { this.lastStateHash = stateHash; this.renderParticipants(arena, state); }
      this.tickStatus();
    });
  },
  tickStatus() {
    if (!this.currentArenaId) return;
    const row = document.getElementById('arenaStatusRow'); const lbl = document.getElementById('arenaStatusLabel'); const time = document.getElementById('arenaStatusTime');
    if (!row || !lbl || !time) return; const state = this.currentArenaState; if (!state) return;
    const serverNow = Date.now() + this.serverOffsetMs;
    row.classList.remove('live', 'finished');
    if (state.phase === 'finished') { row.classList.add('finished'); lbl.textContent = 'Завершена:'; time.textContent = '00:00'; return; }
    if (state.phase === 'waiting') { lbl.textContent = 'До начала:'; time.textContent = Utils.formatMMSS(Math.max(0, state.startsAt - serverNow)); return; }
    if (state.phase === 'live') { row.classList.add('live'); lbl.textContent = 'До конца:'; time.textContent = Utils.formatMMSS(Math.max(0, state.endsAt - serverNow)); return; }
  },
  renderPage(arena, state) {
    document.getElementById('arenaPageName').textContent = arena.name;
    const phaseText = { 'waiting':'Начало в '+Utils.fmtMskHM(arena.startsAt)+' МСК', 'live':'Идёт сейчас', 'finished':'Завершена' }[state.phase] || '';
    document.getElementById('arenaPageSub').textContent = `${arena.timeControl}+${arena.increment} · ${phaseText}`;
    document.getElementById('aInfoTitle').textContent = arena.name;
    document.getElementById('aInfoTime').textContent = Utils.fmtMskHM(arena.startsAt) + ' – ' + Utils.fmtMskHM(arena.endsAt) + ' МСК';
    document.getElementById('aInfoDesc').textContent = arena.description;
    if (state.top3 && state.top3.length) this.showWinnerBanner(state.top3); else document.getElementById('arenaWinnerBanner').style.display = 'none';
  },
  updateJoinButton(state) {
    const wrap = document.getElementById('arenaJoinBtnWrap');
    const isPlaying = App.gameActive && !App.gameEnded;
    if (isPlaying) {
      wrap.innerHTML = `<button class="secondary arenaJoinBtn" disabled style="width:180px; opacity:0.5; cursor:not-allowed;">ЗАНЯТЫ ИГРОЙ</button>`;
      return;
    }
    if (state.phase === 'finished') { wrap.innerHTML = `<button class="secondary" disabled style="width:180px;">ЗАВЕРШЕНА</button>`; return; }
    if (state.phase === 'waiting') { if (state.joined) wrap.innerHTML = `<button class="secondary arenaJoinBtn" onclick="Arena.leaveCurrent()">ОТМЕНИТЬ</button>`; else wrap.innerHTML = `<button class="primary arenaJoinBtn" onclick="Arena.joinCurrent()">УЧАСТВОВАТЬ</button>`; return; }
    if (state.joined) { if (state.paused) wrap.innerHTML = `<button class="primary arenaJoinBtn" onclick="Arena.pauseCurrent()">▶ ПРОДОЛЖИТЬ</button>`; else wrap.innerHTML = `<button class="secondary arenaJoinBtn" onclick="Arena.pauseCurrent()">⏸ ПАУЗА</button>`; }
    else { wrap.innerHTML = `<button class="primary arenaJoinBtn" onclick="Arena.joinCurrent()">УЧАСТВОВАТЬ</button>`; }
  },
  renderPairingBox(state) {
    const box = document.getElementById('arenaPairingBox'); if (!box) return;
    if (state.phase !== 'live') { box.style.display = 'none'; return; }
    if (!state.joined) { box.style.display = 'flex'; box.classList.remove('searching'); box.innerHTML = `<span>Нажмите «УЧАСТВОВАТЬ» для жеребьёвки.</span>`; return; }
    if (state.paused) { box.style.display = 'flex'; box.classList.remove('searching'); box.innerHTML = `<span>⏸ – Вы на паузе.</span>`; return; }
    if (state.pairingNow) { box.style.display = 'flex'; box.classList.add('searching'); box.innerHTML = `<div class="spinner"></div><span>Идёт жеребьёвка: <b>${Utils.escapeHtml(state.pairingNow)}</b></span>`; return; }
    box.style.display = 'flex'; box.classList.add('searching'); box.innerHTML = `<div class="spinner"></div><span>Ожидайте, идёт жеребьёвка…</span>`;
  },
  renderParticipants(arena, state) {
    const body = document.getElementById('arenaTableBody'); const list = state.participants || [];
    if (!list.length) { body.innerHTML = '<div class="arenasEmpty" style="padding:20px;">Пока никто не зарегистрировался</div>'; return; }
    const myName = App.me ? App.me.username : null;
    const search = (document.getElementById('arenaSearchInput').value || '').trim().toLowerCase();
    const filtered = search ? list.filter(p => p.username.toLowerCase().includes(search)) : list;
    body.innerHTML = filtered.map((p) => {
      const place = list.indexOf(p) + 1;
      const placeCls = place === 1 ? 'top1' : place === 2 ? 'top2' : place === 3 ? 'top3' : '';
      const isMe = myName && p.username === myName;
      const totalGames = (p.wins || 0) + (p.draws || 0) + (p.losses || 0);
      const greenDot = p.isBot ? '<span class="pgreen" style="color:#a56ce8">🤖</span>' : (p.online ? '<span class="pgreen">●</span>' : '');
      const pauseTag = p.paused ? '<span class="ppause">⏸</span>' : '';
      let streakTag = '';
      if (p.winStreak >= 3) streakTag = `<span class="streak">🔥${p.winStreak}</span>`;
      else if (p.drawStreak >= 2) streakTag = `<span class="streak">½${p.drawStreak}</span>`;
      const botCls = p.isBot ? 'botRow' : '';
      return `<div class="arenaTableRow ${isMe?'me':''} ${p.paused?'paused':''} ${botCls}"><span class="place ${placeCls}">${place}</span><span class="pname">${Utils.nickHtml(p.username, p.isAdmin, p.isMod, p.isBot)}${greenDot}${pauseTag}<span class="prat">(${p.rating})</span></span><span class="score">${p.score}${streakTag}</span><span class="wdl">${p.wins} / ${p.draws} / ${p.losses}</span><span class="games">${totalGames}</span></div>`;
    }).join('');
  },
  filterParticipants() { if (this.currentArenaState && this.currentArenaId) { const arena = this.cache.find(a => a.id === this.currentArenaId); if (arena) this.renderParticipants(arena, this.currentArenaState); } },
  renderGamesList() {
    const topEl = document.getElementById('arenaTopGame'); const listEl = document.getElementById('arenaGamesList');
    if (!topEl || !listEl) return;
    App.socket.emit('getArenaGames', { arenaId: this.currentArenaId }, (res) => {
      if (!res || typeof res !== 'object') return;
      const live = res.live || [], done = res.done || [];
      const pcEl = document.getElementById('arenaParticipantsCount'); const vcEl = document.getElementById('arenaViewersCount');
      if (pcEl) pcEl.textContent = res.participantsCount || 0; if (vcEl) vcEl.textContent = res.chatViewersCount || 0;
      const hash = JSON.stringify({ live: live.map(g => [g.lobbyId, g.fen, g.timeW, g.timeB]), done: done.slice(0, 30).map(g => [g.white, g.black, g.result, g.finishedAt]) });
      if (hash === this.lastGamesHash) return; this.lastGamesHash = hash;
      const myName = App.me ? App.me.username : null;
      const myLive = myName ? live.find(g => g.white === myName || g.black === myName) : null;
      const topGame = myLive || live[0] || null;
      if (topGame) { topEl.innerHTML = this.renderTopGame(topGame); const link = topEl.querySelector('.arenaTopGameLink'); if (link) link.onclick = () => Watch.watch(topGame.lobbyId); }
      else topEl.innerHTML = '<div class="arenaTopGameEmpty">Сейчас никто не играет</div>';
      if (!done.length) { listEl.innerHTML = '<div class="arenasEmpty" style="padding:20px 10px;">Пока нет партий</div>'; return; }
      listEl.innerHTML = done.slice(0, 50).map(g => {
        const resChar = g.result === 'w' ? '1-0' : (g.result === 'b' ? '0-1' : '½-½');
        const resCls = g.result === 'draw' ? 'd' : 'w';
        const dateStr = Utils.fmtMskHM(g.finishedAt);
        const wR = g.whiteRating ? `<span class="rating"> ${g.whiteRating}</span>` : ''; const bR = g.blackRating ? `<span class="rating"> ${g.blackRating}</span>` : '';
        return `<div class="arenaGameCard"><div class="row1"><span class="name">⚪ ${Utils.nickHtml(g.white, g.whiteIsAdmin, g.whiteIsMod)}${wR}</span><span class="res ${resCls}">${resChar}</span></div><div class="row1"><span class="name">⚫ ${Utils.nickHtml(g.black, g.blackIsAdmin, g.blackIsMod)}${bR}</span></div><div class="row2"><span>завершена</span><span>${dateStr}</span></div></div>`;
      }).join('');
    });
  },
  renderTopGame(g) {
    const state = Chess.parseFen(g.fen); let squares = '';
    for (let dr = 0; dr < 8; dr++) for (let dc = 0; dc < 8; dc++) { const cls = 'sq ' + ((dr + dc) % 2 ? 'dark' : 'light'); const p = state.board[dr][dc]; let inner = ''; if (p) { const isW = p === p.toUpperCase(); inner = `<span class="piece ${isW ? 'w' : 'b'}">${Chess.pieceSvg(p)}</span>`; } squares += `<div class="${cls}">${inner}</div>`; }
    const whiteActive = g.turn === 'w', blackActive = g.turn === 'b';
    const wR = g.whiteRating ? `<span class="prat">${g.whiteRating}</span>` : ''; const bR = g.blackRating ? `<span class="prat">${g.blackRating}</span>` : '';
    return `<div class="arenaTopGamePlayers"><span class="playerRow">⚫ <span class="name">${Utils.nickHtml(g.black, g.blackIsAdmin, g.blackIsMod)}</span>${bR}</span><span class="time" style="${blackActive ? 'color:var(--green-2);' : ''}">${Utils.formatTime(g.timeB)}</span></div><div class="arenaTopGameBoard">${squares}</div><div class="arenaTopGamePlayers"><span class="playerRow">⚪ <span class="name">${Utils.nickHtml(g.white, g.whiteIsAdmin, g.whiteIsMod)}</span>${wR}</span><span class="time" style="${whiteActive ? 'color:var(--green-2);' : ''}">${Utils.formatTime(g.timeW)}</span></div><div class="arenaTopGameLink">▶ – Смотреть партию</div>`;
  },
  showWinnerBanner(top3) {
    const banner = document.getElementById('arenaWinnerBanner'); const podium = document.getElementById('awbPodium');
    const medals = ['gold','silver','bronze'], places = ['🥇','🥈','🥉'];
    const order = top3.length >= 3 ? [1,0,2] : top3.map((_,i)=>i);
    podium.innerHTML = order.map(i => { const p = top3[i]; if (!p) return ''; return `<div class="awbItem ${medals[i]}"><div class="place">${places[i]}</div><div class="n">${Utils.nickHtml(p.username, p.username === 'PeshkaSasha')}</div><div class="s">${p.score}</div></div>`; }).join('');
    banner.style.display = 'block';
  },
  joinCurrent() { if (!this.currentArenaId) return; App.socket.emit('joinArena', { arenaId: this.currentArenaId }, (res) => { if (!res || !res.ok) { alert((res && res.msg) || 'Ошибка'); return; } this.lastStateHash = ''; this.lastGamesHash = ''; this.loadPage(); this.refresh(true); this.renderGamesList(); }); },
  pauseCurrent() { if (!this.currentArenaId) return; App.socket.emit('pauseArena', { arenaId: this.currentArenaId }, (res) => { if (!res || !res.ok) { alert((res && res.msg) || 'Ошибка'); return; } this.lastStateHash = ''; this.loadPage(); this.refresh(true); }); },
  leaveCurrent() { if (!this.currentArenaId) return; if (!confirm('Отменить участие?')) return; App.socket.emit('leaveArena', { arenaId: this.currentArenaId }, (res) => { if (!res || !res.ok) { alert((res && res.msg) || 'Ошибка'); return; } this.lastStateHash = ''; this.loadPage(); this.refresh(true); }); },
  sendChat(e) { e.preventDefault(); const input = document.getElementById('arenaChatInput'); const text = input.value.trim(); if (!text || !this.currentArenaId) return; App.socket.emit('arenaChat', { arenaId: this.currentArenaId, text }); input.value = ''; },
  onChatMessage(msg) { if (this.currentArenaId && msg.arenaId === this.currentArenaId) this.renderChatMsg(msg); },
  renderChatMsg(msg) {
    const box = document.getElementById('arenaChatMessages'); if (!box) return;
    const div = document.createElement('div');
    if (msg.system) { div.className = 'msg sys'; div.textContent = msg.text; }
    else {
      div.className = 'msg'; div.dataset.msgId = msg.id || '';
      const time = Utils.fmtMskHM(msg.ts);
      let modHtml = '';
      if (App.me && App.me.isMod) modHtml = `<span class="modBtn always" title="Модерация" style="cursor:pointer;color:var(--muted);margin-left:6px;">⚙</span>`;
      div.innerHTML = `<span class="u">${Utils.nickHtml(msg.user, msg.userIsAdmin, msg.userIsMod)}:</span> ${Utils.escapeHtml(msg.text)} <span class="t">${time}</span>${modHtml}`;
      if (App.me && App.me.isMod) { const btn = div.querySelector('.modBtn'); if (btn) btn.addEventListener('click', (ev) => { ev.stopPropagation(); Mod.openMenu(ev, msg.id, msg.user, 'arena', this.currentArenaId); }); }
    }
    box.appendChild(div);
    while (box.children.length > 200) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  },
  onUpdate(arenaId) {
    if (this.currentArenaId === arenaId) {
      this.lastStateHash = '';
      if (document.getElementById('arenaPageScreen').classList.contains('active')) this.loadPage();
    }
    if (document.getElementById('arenasScreen').classList.contains('active')) this.refresh();
    if (document.getElementById('lobbyScreen').classList.contains('active')) TopArenas.refresh();
  },
  onFinished(arenaId, top3) {
    if (this.currentArenaId === arenaId) {
      this.lastStateHash = ''; this.lastGamesHash = '';
      if (document.getElementById('arenaPageScreen').classList.contains('active')) { this.loadPage(); this.renderGamesList(); }
      if (top3 && top3.length) this.showWinnerBanner(top3);
    }
    if (document.getElementById('arenasScreen').classList.contains('active')) this.refresh();
    if (document.getElementById('lobbyScreen').classList.contains('active')) TopArenas.refresh();
  }
};

// ============================================================
// PROFILE (Lichess-стиль, график по всем контролям)
// ============================================================
const Profile = {
  gamesVisible: false,
  selectedCategory: 'all',
  chartRange: 'all',
  chartData: null,
  chartUserId: null,

  init() {},

  enter(username) {
    const target = username || (App.me && App.me.username); if (!target) return;
    App.profileViewing = target; this.gamesVisible = false; this.selectedCategory = 'all'; this.chartRange = 'all';
    const wrap = document.getElementById('profileGamesWrap'); const btn = document.getElementById('showGamesBtn');
    if (wrap) wrap.classList.add('profileGamesHidden'); if (btn) btn.textContent = '📜 Показать партии';
    App.socket.emit('getProfile', { username: target }, (res) => {
      if (!res || !res.ok) { alert((res && res.msg) || 'Ошибка'); return; }
      this.render(res.user, res.games, res.history, res.categoryHistory);
    });
  },

  writeMessage() {
    const target = App.profileViewing; if (!target) return;
    if (App.me && target === App.me.username) { alert('Это ваш профиль'); return; }
    Inbox.openWith(target);
  },

  toggleGames() {
    this.gamesVisible = !this.gamesVisible;
    const wrap = document.getElementById('profileGamesWrap'); const btn = document.getElementById('showGamesBtn');
    if (this.gamesVisible) { wrap.classList.remove('profileGamesHidden'); btn.textContent = '📜 Скрыть партии'; }
    else { wrap.classList.add('profileGamesHidden'); btn.textContent = '📜 Показать партии'; }
  },

  render(user, games, history, categoryHistory) {
    const avatarEl = document.getElementById('pAvatarBig');
    avatarEl.className = 'profileAvatar' + (user.isBot ? ' botAvatar' : '');
    avatarEl.innerHTML = (user.isAdmin ? '<span class="pCrown">👑</span>' : '') + (user.isBot ? '🤖' : user.username.charAt(0).toUpperCase());
    const onlinePrefix = Utils.onlineDotHtml(user.online);
    document.getElementById('pName').innerHTML = onlinePrefix + Utils.nickHtml(user.username, user.isAdmin, user.isMod, user.isBot);
    const badges = [];
    if (user.isBot) badges.push('<span class="botBadge">🤖 – Бот</span>');
    if (user.role === 'admin') badges.push('<span class="roleBadge admin">👑 – Админ</span>');
    if (user.role === 'moderator') badges.push('<span class="roleBadge mod">🛡 – Модератор</span>');
    if (user.isDev) badges.push('<span class="roleBadge dev">⚙ – Разраб</span>');
    if (user.mutedUntil && user.mutedUntil > Date.now()) { const mins = Math.ceil((user.mutedUntil - Date.now())/60000); badges.push(`<span class="muteBadge">🔇 – Мут ${mins} мин</span>`); }
    if (user.online) badges.push('<span class="roleBadge" style="color:var(--green-2)">● – В сети</span>');
    document.getElementById('pRoleBadges').innerHTML = badges.join(' ');
    const date = new Date(user.createdAt);
    document.getElementById('pSub').textContent = `На сайте с ${date.toLocaleDateString('ru-RU')} · ${user.games} партий`;
    document.getElementById('pRating').textContent = user.rating;
    document.getElementById('pGames').textContent = user.games;
    document.getElementById('pWins').textContent = user.wins;
    document.getElementById('pWinrate').textContent = (user.games ? Math.round((user.wins/user.games)*100) : 0) + '%';
    const catEl = document.getElementById('catRatingsGrid');
    if (user.categories) {
      const cats = [
        { key:'bullet', name:'Пуля', icon:'🔫', color:'#fb7185' },
        { key:'blitz', name:'Блиц', icon:'⚡', color:'#4ade80' },
        { key:'rapid', name:'Рапид', icon:'⏱', color:'#38bdf8' },
        { key:'classical', name:'Классика', icon:'🐢', color:'#a78bfa' }
      ];
      catEl.innerHTML = cats.map(c => {
        const r = user.categories[c.key] || { rating:user.rating, games:0 };
        return `<div class="catCard ${c.key}"><div class="catIcon">${c.icon}</div><div class="catName">${c.name}</div><div class="catRating">${r.rating}</div><div style="font-size:11px;color:var(--muted);margin-top:2px;">${r.games||0} партий</div></div>`;
      }).join('');
    } else catEl.innerHTML = '';
    const writeBtn = document.getElementById('pWriteBtn');
    if (writeBtn) { if (App.me && user.username !== App.me.username && !user.isBot) writeBtn.style.display = ''; else writeBtn.style.display = 'none'; }
    this.chartData = { games, history, user, categoryHistory };
    this.chartUserId = user.username;
    this.renderChartControls();
    this.renderChart();
    this.renderGamesList(games, user.username);
  },

  renderChartControls() {
    const wrap = document.getElementById('chartControls');
    if (!wrap) return;
    const ranges = [
      { key: '1m', label: '1М' },
      { key: '3m', label: '3М' },
      { key: '6m', label: '6М' },
      { key: '1y', label: '1Г' },
      { key: 'all', label: 'ALL' }
    ];
    wrap.innerHTML = ranges.map(r => `<button class="chartRangeBtn ${r.key === this.chartRange ? 'active' : ''}" onclick="Profile.setChartRange('${r.key}')">${r.label}</button>`).join('');
  },

  setChartRange(range) {
    this.chartRange = range;
    this.renderChartControls();
    this.renderChart();
  },

  renderChart() {
    const wrap = document.getElementById('ratingChartWrap');
    if (!wrap || !this.chartData) return;
    const { games, user, categoryHistory } = this.chartData;
    const categories = [
      { key:'bullet', label:'Пуля', color:'#fb7185' },
      { key:'blitz', label:'Блиц', color:'#4ade80' },
      { key:'rapid', label:'Рапид', color:'#38bdf8' },
      { key:'classical', label:'Классика', color:'#a78bfa' }
    ];
    const now = Date.now(), dayMs = 86400000;
    let startTs = Number(user.createdAt) || now;
    if (this.chartRange === '1m') startTs = Math.max(startTs, now - 30*dayMs);
    else if (this.chartRange === '3m') startTs = Math.max(startTs, now - 90*dayMs);
    else if (this.chartRange === '6m') startTs = Math.max(startTs, now - 180*dayMs);
    else if (this.chartRange === '1y') startTs = Math.max(startTs, now - 365*dayMs);
    const startDay = Math.floor(startTs / dayMs) * dayMs;
    const endDay = Math.floor(now / dayMs) * dayMs;
    const allGames = (Array.isArray(categoryHistory) ? categoryHistory : (games || []));
    const W=900, H=300, PL=58, PR=18, PT=18, PB=34, IW=W-PL-PR, IH=H-PT-PB;
    const xOf = day => PL + ((day-startDay)/(Math.max(dayMs,endDay-startDay))) * IW;
    const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

    // One shared timeline and one shared rating scale, with all time-control histories overlaid.
    const series = categories.map(cat => {
      const relevant = allGames.filter(g => g.category === cat.key)
        .sort((a,b) => Number(a.finishedAt)-Number(b.finishedAt));
      const byDay = new Map();
      for (const g of relevant) {
        const ts = Number(g.finishedAt);
        const rating = Number(g.white === this.chartUserId ? g.whiteAfter : g.blackAfter);
        if (Number.isFinite(ts) && Number.isFinite(rating)) byDay.set(Math.floor(ts/dayMs)*dayMs, rating);
      }
      if (!byDay.size) return { ...cat, points:[], latest:null, delta:null };
      let last = null;
      // Seed the range with the latest known rating before its start, if one exists.
      for (const [day, rating] of byDay) if (day < startDay) last = rating;
      const points=[];
      for(let d=startDay; d<=endDay; d+=dayMs) {
        if (byDay.has(d)) last=byDay.get(d);
        if (last !== null) points.push({day:d,rating:last});
      }
      // If a category has only a game after the current day boundary, keep its exact game day visible.
      for (const [day, rating] of byDay) {
        if (day >= startDay && day <= endDay && !points.some(p=>p.day===day)) points.push({day,rating});
      }
      points.sort((a,b)=>a.day-b.day);
      const inRange = [...byDay.entries()].filter(([day])=>day>=startDay && day<=endDay).map(([,rating])=>rating);
      const latest = points.length ? points[points.length-1].rating : null;
      const first = inRange.length ? inRange[0] : (points.length ? points[0].rating : null);
      return { ...cat, points, latest, delta: first===null || latest===null ? null : latest-first };
    });
    const visible = series.filter(s=>s.points.length);
    if (!visible.length) {
      wrap.innerHTML = '<div class="ratingChartEmpty">Пока нет истории рейтинга за выбранный период</div>';
      return;
    }
    const allValues = visible.flatMap(s=>s.points.map(p=>p.rating));
    const minV=Math.min(...allValues), maxV=Math.max(...allValues);
    const pad=Math.max(30,Math.ceil((maxV-minV)*.12));
    const yMin=Math.floor((minV-pad)/50)*50, yMax=Math.ceil((maxV+pad)/50)*50;
    const yOf = rating => PT+IH-((rating-yMin)/Math.max(1,yMax-yMin))*IH;
    const grid=[];
    for(let i=0;i<=5;i++) {
      const val=yMin+(yMax-yMin)*i/5, y=yOf(val);
      grid.push(`<line x1="${PL}" y1="${y}" x2="${W-PR}" y2="${y}" stroke="var(--border,#3a3833)" stroke-dasharray="3,4"/><text x="${PL-9}" y="${y+4}" fill="var(--muted,#7d7a72)" font-size="11" text-anchor="end">${Math.round(val)}</text>`);
    }
    const labels=[];
    for(let i=0;i<5;i++) {
      const day=startDay+(endDay-startDay)*i/4;
      labels.push(`<text x="${xOf(day)}" y="${H-8}" fill="var(--muted,#7d7a72)" font-size="11" text-anchor="middle">${new Date(day).toLocaleDateString('ru-RU',{day:'2-digit',month:'short'})}</text>`);
    }
    const paths=visible.map(s=>{
      const path=s.points.map((p,i)=>`${i?'L':'M'}${xOf(p.day).toFixed(1)},${yOf(p.rating).toFixed(1)}`).join(' ');
      return `<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>${s.points.length===1?`<circle cx="${xOf(s.points[0].day)}" cy="${yOf(s.points[0].rating)}" r="3.5" fill="${s.color}"/>`:''}`;
    }).join('');
    const legend=series.map(s=>{
      const value=s.latest===null?'—':s.latest;
      const delta=s.delta===null?'':` <em style="color:${s.delta>0?'#4ade80':s.delta<0?'#fb7185':'var(--muted)'}">${s.delta>0?'+':''}${s.delta}</em>`;
      return `<span class="ratingOverlayLegendItem"><i style="background:${s.color}"></i>${esc(s.label)} <b>${value}</b>${delta}</span>`;
    }).join('');
    wrap.innerHTML = `<div class="ratingOverlayLegend">${legend}</div><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="История рейтинга по всем режимам на одном графике" style="width:100%;height:auto;display:block">${grid.join('')}${paths}${labels.join('')}</svg>`;
  },

  renderGamesList(games, username) {
    const el = document.getElementById('gamesList');
    if (!games || !games.length) { el.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;padding:16px">Партий пока нет</div>'; return; }
    const filtered = this.selectedCategory === 'all' ? games : games.filter(g => g.category === this.selectedCategory);
    if (!filtered.length) { el.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;padding:16px">Нет партий в этой категории</div>'; return; }
    const frag = document.createDocumentFragment();
    filtered.forEach(g => {
      const iAmWhite = g.white === username;
      const myBefore = iAmWhite ? g.whiteBefore : g.blackBefore; const myAfter = iAmWhite ? g.whiteAfter : g.blackAfter;
      const delta = myAfter - myBefore; const opp = iAmWhite ? g.black : g.white;
      let resChar, resClass;
      if (g.result === 'draw') { resChar = 'Н'; resClass = 'd'; }
      else if ((g.result === 'w' && iAmWhite) || (g.result === 'b' && !iAmWhite)) { resChar = 'П'; resClass = 'w'; }
      else { resChar = 'Пр'; resClass = 'l'; }
      const date = new Date(g.finishedAt);
      const dateStr = date.toLocaleDateString('ru-RU') + ' ' + date.toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit' });
      const deltaStr = delta > 0 ? '+'+delta : (delta < 0 ? ''+delta : '0');
      const deltaClass = delta > 0 ? 'up' : (delta < 0 ? 'down' : '');
      const catBadge = g.category ? `<span style="color:var(--muted);font-size:11px;margin-left:4px;">[${g.category}]</span>` : '';
      const botBadge = g.isBot ? '<span style="color:#a56ce8;font-size:11px;margin-left:4px;">🤖</span>' : '';
      const row = document.createElement('div'); row.className = 'gameRow';
      row.innerHTML = `<span class="res ${resClass}">${resChar}</span><span class="opp">${iAmWhite?'⚪':'⚫'} против <b>${Utils.nickHtml(opp, opp==='PeshkaSasha')}</b>${catBadge}${botBadge}</span><span class="delta ${deltaClass}">${deltaStr} (${myAfter})</span><span class="date">${dateStr}</span>`;
      frag.appendChild(row);
    });
    el.innerHTML = ''; el.appendChild(frag);
  }
};

// ============================================================
// COMMUNITY
// ============================================================
const Community = {
  init() {},
  enter() { App.socket.emit('getCommunityOnline', (players) => this.render(players)); },
  render(players) {
    const list = document.getElementById('communityOnlineList'); const count = document.getElementById('communityOnlineCount');
    if (!list || !count) return;
    players = Array.isArray(players) ? players : [];
    count.textContent = `В сети: ${players.length}`;
    list.innerHTML = players.map(u => `<div class="communityPlayer" data-player="${Utils.escapeHtml(u.username)}" onclick="Router.go('profile', '${Utils.escapeHtml(u.username)}')"><div class="communityAvatar">${u.isBot ? '🤖' : Utils.escapeHtml(u.username.charAt(0).toUpperCase())}</div><div style="min-width:0"><div class="cpName">${Utils.onlineDotHtml(true)}${Utils.nickHtml(u.username,u.isAdmin,u.isMod,u.isBot)}</div><div class="cpSub">${u.isBot ? 'Бот' : 'Игрок'} · ${Number(u.rating)||1200} рейтинга</div></div></div>`).join('') || '<div style="color:var(--muted)">Сейчас никого нет в сети.</div>';
  }
};

// ============================================================
// INBOX
// ============================================================
const Inbox = {
  dialogs: [],
  activeWith: null,
  history: [],
  unread: 0,
  loaded: false,

  init() {},
  enter(param) {
    if (param) this.selectDialog(param, true);
    else if (!this.loaded) this.loadDialogs();
    else this.renderDialogs();
  },

  loadDialogs() {
    App.socket.emit('msgGetDialogs', (res) => {
      if (!res || !res.ok) return;
      this.dialogs = res.dialogs || [];
      this.loaded = true;
      this.renderDialogs();
    });
  },

  renderDialogs() {
    const box = document.getElementById('msgDialogs'); if (!box) return;
    if (!this.dialogs.length) { box.innerHTML = '<div class="msgEmpty">Диалогов пока нет</div>'; return; }
    const frag = document.createDocumentFragment();
    for (const d of this.dialogs) {
      const other = d.other;
      const lastText = (d.last_text || '').slice(0, 50);
      const unread = d.unread || 0;
      const row = document.createElement('div');
      row.className = 'msgDialogRow' + (this.activeWith === other ? ' active' : '') + (unread ? ' unread' : '');
      row.dataset.with = other;
      const online = App.onlinePlayers && App.onlinePlayers.has && App.onlinePlayers.has(other);
      row.innerHTML = `<div class="msgDialogAvatar">${Utils.escapeHtml(other.charAt(0).toUpperCase())}<span class="${online ? 'dotOnline' : 'dotOffline'}"></span></div><div class="msgDialogMeta"><div class="msgDialogName">${Utils.escapeHtml(other)}</div><div class="msgDialogPreview">${Utils.escapeHtml(lastText)}</div></div>${unread ? `<span class="msgDialogBadge">${unread}</span>` : ''}`;
      row.addEventListener('click', () => this.selectDialog(other));
      frag.appendChild(row);
    }
    box.innerHTML = '';
    box.appendChild(frag);
  },

  newDialog() {
    const row = document.getElementById('msgNewRow'); if (!row) return;
    row.style.display = row.style.display === 'none' ? 'flex' : 'none';
    const inp = document.getElementById('msgNewInput');
    if (inp && row.style.display !== 'none') { inp.value = ''; inp.focus(); }
  },

  startWithInput() {
    const inp = document.getElementById('msgNewInput'); if (!inp) return;
    const name = inp.value.trim(); if (!name) return;
    if (App.me && name === App.me.username) { alert('Нельзя написать самому себе'); return; }
    App.socket.emit('getPlayerCard', { username: name }, (res) => {
      if (!res || !res.ok) { alert('Игрок не найден'); return; }
      inp.value = '';
      document.getElementById('msgNewRow').style.display = 'none';
      this.selectDialog(name);
    });
  },

  selectDialog(other, open) {
    this.activeWith = other;
    const nameEl = document.getElementById('inboxChatName');
    const openBtn = document.getElementById('inboxOpenProfile');
    const delBtn = document.getElementById('inboxDelete');
    if (nameEl) nameEl.textContent = other;
    if (openBtn) openBtn.style.display = '';
    if (delBtn) delBtn.style.display = '';
    this.loadHistory(other);
    document.querySelectorAll('.msgDialogRow').forEach(r => r.classList.toggle('active', r.dataset.with === other));
    const wrap = document.querySelector('.inboxWrap'); if (wrap) wrap.classList.add('chatOpen');
  },

  openWith(username) {
    Router.go('inbox');
    setTimeout(() => this.selectDialog(username), 50);
  },

  loadHistory(other) {
    App.socket.emit('msgGetHistory', { with: other, markRead: true }, (res) => {
      if (!res || !res.ok) return;
      this.history = res.history || [];
      this.renderHistory();
    });
  },

  renderHistory() {
    const box = document.getElementById('inboxChatBody'); if (!box) return;
    if (!this.activeWith) { box.innerHTML = '<div class="msgEmpty">Выберите диалог</div>'; return; }
    if (!this.history.length) { box.innerHTML = '<div class="msgEmpty">Нет сообщений. Начните первым!</div>'; return; }
    const frag = document.createDocumentFragment();
    let lastDate = '';
    for (const m of this.history) {
      const ts = Number(m.created_at || m.createdAt || m.ts);
      const dateStr = Utils.fmtDate(ts);
      if (dateStr !== lastDate) {
        const div = document.createElement('div'); div.className = 'msgDateDivider'; div.textContent = dateStr;
        frag.appendChild(div); lastDate = dateStr;
      }
      const mine = (m.from_user === App.me.username);
      const div = document.createElement('div');
      div.className = 'msgBubble ' + (mine ? 'me' : 'them');
      div.textContent = m.text;
      const time = document.createElement('span'); time.className = 'msgTime'; time.textContent = Utils.fmtTimeHM(ts);
      div.appendChild(time);
      frag.appendChild(div);
    }
    box.innerHTML = '';
    box.appendChild(frag);
    box.scrollTop = box.scrollHeight;
  },

  send(e) {
    e.preventDefault();
    const inp = document.getElementById('inboxChatInput');
    if (!inp || !this.activeWith) return;
    const text = inp.value.trim(); if (!text) return;
    App.socket.emit('msgSend', { to: this.activeWith, text }, (res) => {
      if (!res || !res.ok) { alert((res && res.msg) || 'Ошибка'); return; }
      inp.value = '';
    });
  },

  onNew(msg) {
    const other = (msg.from === App.me.username) ? msg.to : msg.from;
    if (Router.current.name === 'inbox' && this.activeWith === other) {
      this.history.push({ id: msg.id, from_user: msg.from, to_user: msg.to, text: msg.text, created_at: msg.ts, read_at: msg.readAt });
      this.renderHistory();
      if (msg.from !== App.me.username) {
        App.socket.emit('msgGetHistory', { with: other, markRead: true }, (res) => {
          if (res && res.ok) { this.history = res.history; this.renderHistory(); }
        });
      }
    } else if (msg.from !== App.me.username) {
      Sounds.msg();
    }
    this.loadDialogs();
  },

  onDialogDeleted(other) {
    this.dialogs = this.dialogs.filter(d => d.other !== other);
    this.renderDialogs();
    if (this.activeWith === other) {
      this.activeWith = null; this.history = [];
      this.renderHistory();
      document.getElementById('inboxChatName').textContent = 'Выберите диалог';
      const wrap = document.querySelector('.inboxWrap'); if (wrap) wrap.classList.remove('chatOpen');
    }
  },

  deleteCurrent() {
    if (!this.activeWith) return;
    if (!confirm('Удалить чат с ' + this.activeWith + '?')) return;
    const other = this.activeWith;
    App.socket.emit('msgDeleteDialog', { with: other }, (res) => {
      if (!res || !res.ok) { alert((res && res.msg) || 'Ошибка'); return; }
      this.onDialogDeleted(other);
    });
  },

  openProfile() { if (!this.activeWith) return; const other = this.activeWith; Router.go('profile', other); },

  setUnread(count) {
    this.unread = count || 0;
    const badge = document.getElementById('msgBadge'); const um = document.getElementById('umInboxCount');
    if (badge) { badge.textContent = this.unread > 99 ? '99+' : this.unread; badge.style.display = this.unread > 0 ? 'flex' : 'none'; }
    if (um) um.textContent = this.unread > 0 ? this.unread : '';
  }
};

// ============================================================
// MOD MENU
// ============================================================
const Mod = {
  el: null,
  openMenu(ev, msgId, username, scope, scopeId) {
    this.close();
    if (!App.me || !App.me.isMod) return;
    const rect = ev.target.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'modMenu';
    menu.style.left = Math.min(window.innerWidth - 210, Math.max(8, rect.left - 60)) + 'px';
    menu.style.top = Math.min(window.innerHeight - 320, rect.bottom + 4) + 'px';
    menu.innerHTML = `<div class="lbl">Сообщение</div><button data-act="del">🗑 – Удалить сообщение</button><div class="sep"></div><div class="lbl">Игрок: ${Utils.escapeHtml(username)}</div>
      <button data-act="mute" data-min="5">🔇 – Мут 5 минут</button>
      <button data-act="mute" data-min="30">🔇 – Мут 30 минут</button>
      <button data-act="mute" data-min="60">🔇 – Мут 1 час</button>
      <button data-act="mute" data-min="1440">🔇 – Мут 1 сутки</button>
      <button data-act="unmute">🔊 – Снять мут</button>`;
    document.body.appendChild(menu); this.el = menu;
    menu.addEventListener('click', (e) => {
      const act = e.target.dataset.act;
      if (act === 'del') {
        const evName = scope === 'arena' ? 'modDeleteArenaMessage' : 'modDeleteMessage';
        const payload = scope === 'arena' ? { arenaId: scopeId, msgId } : { lobbyId: scopeId, msgId };
        App.socket.emit(evName, payload, (r) => { if (!r || !r.ok) alert((r && r.msg) || 'Ошибка'); this.close(); });
      } else if (act === 'mute') {
        App.socket.emit('modMuteUser', { username, minutes: +e.target.dataset.min }, (r) => { if (!r || !r.ok) alert((r && r.msg) || 'Ошибка'); this.close(); });
      } else if (act === 'unmute') {
        App.socket.emit('modUnmuteUser', { username }, (r) => { if (!r || !r.ok) alert((r && r.msg) || 'Ошибка'); this.close(); });
      }
    });
  },
  close() { if (this.el) { this.el.remove(); this.el = null; } }
};
document.addEventListener('click', (e) => { if (Mod.el && !Mod.el.contains(e.target)) Mod.close(); });

// ============================================================
// BANNERS
// ============================================================
const Banners = {
  rematchFrom: null, drawFrom: null,
  init() {
    const rAccept = document.getElementById('rematchBannerAccept');
    const rDecline = document.getElementById('rematchBannerDecline');
    const dAccept = document.getElementById('drawOfferBannerAccept');
    const dDecline = document.getElementById('drawOfferBannerDecline');
    if (rAccept) rAccept.onclick = () => { if (!App.lobbyId) return; App.socket.emit('rematchRequest', { lobbyId: App.lobbyId }, () => {}); this.hideRematch(); };
    if (rDecline) rDecline.onclick = () => { if (App.lobbyId) App.socket.emit('rematchDecline', { lobbyId: App.lobbyId }); this.hideRematch(); };
    if (dAccept) dAccept.onclick = () => { if (App.lobbyId) App.socket.emit('drawAccept', { lobbyId: App.lobbyId }); this.hideDraw(); };
    if (dDecline) dDecline.onclick = () => { if (App.lobbyId) App.socket.emit('drawDecline', { lobbyId: App.lobbyId }); this.hideDraw(); };
  },
  showRematch(from) {
    this.rematchFrom = from;
    const b = document.getElementById('rematchBanner'); const t = document.getElementById('rematchBannerText');
    if (!b || !t) return;
    t.textContent = `⚔ ${from} предлагает реванш`; b.style.display = 'flex';
    const btn = document.getElementById('grRematchBtn'); if (btn) { btn.classList.add('accept'); btn.textContent = 'ПРИНЯТЬ РЕВАНШ'; }
  },
  hideRematch() { this.rematchFrom = null; const b = document.getElementById('rematchBanner'); if (b) b.style.display = 'none'; },
  showDrawOffer(from) {
    this.drawFrom = from;
    const b = document.getElementById('drawOfferBanner'); const t = document.getElementById('drawOfferBannerText');
    if (!b || !t) return; t.textContent = `½ ${from} предлагает ничью`; b.style.display = 'flex';
  },
  hideDraw() { this.drawFrom = null; const b = document.getElementById('drawOfferBanner'); if (b) b.style.display = 'none'; }
};

// ============================================================
// GAME
// ============================================================
const Game = {
  selected: null, legalMoves: [], moveHistory: [], moveFens: [], viewIndex: -1,
  lastMove: null, boardFlipped: false, pendingDrawOffer: false, rematchRequested: false,
  lastBoardHash: '', dragging: null, dragStartPos: null, premove: null, ghostEl: null,
  clockLoopRunning: false, clockSyncedAt: 0, clockMyAtSync: 0, clockOppAtSync: 0, clockTurn: 'w',
  chatMsgIds: new Set(), rematchSpinnerTimer: null,

  init() {
    const board = document.getElementById('board'); if (!board) return;
    board.addEventListener('click', (ev) => {
      if (this.dragStartPos && (Math.abs(ev.clientX - this.dragStartPos.x) > 6 || Math.abs(ev.clientY - this.dragStartPos.y) > 6)) { this.dragStartPos = null; return; }
      this.dragStartPos = null;
      const sq = ev.target.closest('.sq'); if (!sq || sq.dataset.r == null) return;
      this.onSquareClick(+sq.dataset.r, +sq.dataset.c);
    });
    board.addEventListener('mousedown', (ev) => this.onMouseDown(ev));
    document.addEventListener('mousemove', (ev) => this.onMouseMove(ev));
    document.addEventListener('mouseup', (ev) => this.onMouseUp(ev));
    const pw = document.getElementById('password'); if (pw) pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') App.doLogin(); });
  },

  enter(lobbyId) {
    if (lobbyId && lobbyId.startsWith('sp_')) { Router.go('lobby'); return; }
    if (lobbyId && (!App.lobbyId || App.lobbyId !== lobbyId)) {
      App.lobbyId = lobbyId;
      App.socket.emit('getGameState', { lobbyId }, (res) => {
        if (!res || !res.ok) { alert((res && res.msg) || 'Партия не найдена'); Router.go('lobby'); return; }
        if (res.state && res.state.isSelfPlay) { Router.go('lobby'); return; }
        this.applyGameStateFromServer(res.state, lobbyId);
      });
      return;
    }
    this.renderBoard(); this.renderMoves(); this.updateTimers();
  },

  reset() {
    this.selected = null; this.legalMoves = []; this.moveHistory = []; this.moveFens = []; this.viewIndex = -1;
    this.lastMove = null; this.boardFlipped = false; this.premove = null; this.lastBoardHash = '';
    this.pendingDrawOffer = false; this.rematchRequested = false;
    this.chatMsgIds.clear(); this.stopRematchSpinner();
    const box = document.getElementById('chatMessages'); if (box) box.innerHTML = '';
  },
  resetUI() {
    document.getElementById('topName').textContent = '—'; document.getElementById('topRating').textContent = '';
    document.getElementById('topDot').className = 'dot'; document.getElementById('topTime').textContent = '--:--';
    document.getElementById('bottomName').innerHTML = App.me ? Utils.nickHtml(App.me.username, App.me.isAdmin, App.me.isMod, App.me.isBot) : '—';
    document.getElementById('bottomRating').textContent = App.me ? App.me.rating : '';
    document.getElementById('bottomDot').className = 'dot'; document.getElementById('bottomTime').textContent = '--:--';
  },
  hideResultBar() {
    document.getElementById('gameResultCompact').classList.remove('show');
    document.getElementById('bigActionsRow').style.display = '';
    document.getElementById('movesPanel').classList.remove('compact');
    const btn = document.getElementById('grRematchBtn');
    if (btn) { btn.classList.remove('accept'); btn.disabled = false; btn.textContent = 'РЕВАНШ'; }
    this.stopRematchSpinner();
  },
  showResultBar(winner, reason) {
    const bar = document.getElementById('gameResultCompact');
    const title = document.getElementById('grTitleCompact'); const sub = document.getElementById('grSubCompact');
    let text, cls;
    if (!winner) { text = '½ – Ничья'; cls = ''; }
    else if (winner === App.myColor) { text = (App.myColor === 'w' ? '1-0' : '0-1') + ' – Победа'; cls = 'win'; }
    else { text = (App.myColor === 'w' ? '0-1' : '1-0') + ' – Поражение'; cls = 'lose'; }
    title.textContent = text; title.className = 'grTitle ' + cls;
    sub.textContent = reason || '';
    const rematchBtn = document.getElementById('grRematchBtn'); const pauseBtn = document.getElementById('grPauseBtn'); const findBtn = document.getElementById('grFindBtn');
    if (App.currentGameIsArena) {
      rematchBtn.style.display = 'none'; pauseBtn.style.display = 'block';
      pauseBtn.textContent = (Arena.currentArenaState && Arena.currentArenaState.paused) ? '▶ ПРОДОЛЖИТЬ' : '⏸ ПАУЗА';
      findBtn.textContent = 'ПЕРЕЙТИ В ТУРНИР';
      findBtn.onclick = () => {
        const arenaId = App.currentArenaId;
        if (!arenaId) { this.hideResultBar(); Router.go('arenas'); return; }
        App.socket.emit('continueArenaPairing', { arenaId }, (res) => {
          if (!res || !res.ok) { alert((res && res.msg) || 'Не удалось вернуться в турнир'); return; }
          this.hideResultBar(); Router.go('arenaPage', arenaId);
        });
      };
    } else {
      rematchBtn.style.display = 'block'; pauseBtn.style.display = 'none'; rematchBtn.disabled = false;
      if (Banners.rematchFrom) { rematchBtn.classList.add('accept'); rematchBtn.textContent = 'ПРИНЯТЬ РЕВАНШ'; }
      else { rematchBtn.classList.remove('accept'); rematchBtn.textContent = 'РЕВАНШ'; }
      findBtn.textContent = 'НАЙТИ ДРУГОГО СОПЕРНИКА';
      findBtn.onclick = () => { this.hideResultBar(); this.cleanupAndLeave(); };
    }
    bar.classList.add('show');
    document.getElementById('movesPanel').classList.add('compact');
    document.getElementById('bigActionsRow').style.display = 'none';
  },
  refreshResultBar() {
    if (!App.gameEnded) return;
    const rematchBtn = document.getElementById('grRematchBtn'); if (!rematchBtn) return;
    if (Banners.rematchFrom) { rematchBtn.classList.add('accept'); rematchBtn.textContent = 'ПРИНЯТЬ РЕВАНШ'; }
    else { rematchBtn.classList.remove('accept'); rematchBtn.textContent = 'РЕВАНШ'; }
  },
  startRematchSpinner() {
    const btn = document.getElementById('grRematchBtn'); if (!btn) return;
    this.stopRematchSpinner();
    const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']; let i = 0;
    btn.disabled = true; btn.classList.remove('accept'); btn.textContent = frames[0] + ' ОЖИДАНИЕ';
    this.rematchSpinnerTimer = setInterval(() => { i = (i + 1) % frames.length; btn.textContent = frames[i] + ' ОЖИДАНИЕ'; }, 80);
  },
  stopRematchSpinner() { if (this.rematchSpinnerTimer) { clearInterval(this.rematchSpinnerTimer); this.rematchSpinnerTimer = null; } },
  cleanupAndLeave() {
    this.reset();
    App.lobbyId = null; App.gameActive = false; App.gameEnded = false;
    App.currentGameIsArena = false; App.currentArenaId = null; App.currentArenaName = null;
    try { localStorage.removeItem('kingside_active_lobby'); } catch (e) {}
    this.updateBackToGameBtn(); Router.go('lobby'); Lobby.switchTab('create');
  },
  updateBackToGameBtn() { const opponent = document.getElementById('activeGameOpponent'); if (opponent) opponent.textContent = App.opponentName || 'соперником'; },
  applyGameStateFromServer(s, lobbyId) {
    if (s && s.isSelfPlay) { console.warn('Попытка применить self-play state'); return; }
    App.lobbyId = lobbyId; App.myColor = s.myColor; App.opponentName = s.opponent;
    const activeGameOpponent = document.getElementById('activeGameOpponent'); if (activeGameOpponent) activeGameOpponent.textContent = s.opponent || 'соперником';
    App.opponentRating = s.opponentRating; App.opponentIsAdmin = s.opponentIsAdmin;
    App.opponentOnline = !!s.opponentOnline; App.opponentIsBot = !!s.isBot; App.isBotGame = !!s.isBot;
    App.inc = s.inc;
    App.myTime = App.myColor === 'w' ? s.timeW : s.timeB; App.oppTime = App.myColor === 'w' ? s.timeB : s.timeW;
    App.currentFen = s.fen;
    this.moveHistory = []; this.moveFens = []; this.viewIndex = -1; this.lastMove = null;
    App.gameEnded = !!s.finished; App.gameActive = !s.finished;
    App.currentGameIsArena = !!s.arenaId; App.currentArenaId = s.arenaId || null; App.currentArenaName = s.arenaName || null;
    this.lastBoardHash = '';
    document.getElementById('bottomName').innerHTML = Utils.nickHtml(App.me.username, App.me.isAdmin, App.me.isMod, App.me.isBot);
    document.getElementById('bottomRating').textContent = App.me.rating;
    document.getElementById('bottomDot').className = 'dot ' + (App.myColor === 'w' ? 'w' : 'b');
    document.getElementById('topName').innerHTML = Utils.onlineDotHtml(App.opponentOnline) + Utils.nickHtml(App.opponentName, App.opponentIsAdmin, false, App.opponentIsBot);
    document.getElementById('topRating').textContent = App.opponentRating || '';
    document.getElementById('topDot').className = 'dot ' + (App.myColor === 'w' ? 'b' : 'w');
    this.updateTimers();
    document.getElementById('chatMessages').innerHTML = '';
    if (Array.isArray(s.chat)) s.chat.forEach(m => this.onChatMessage(m));
    Router.go('game', lobbyId);
    this.renderBoard(); this.renderMoves(); this.updateTurnIndicator();
    if (s.finished) this.hideResultBar();
    this.updateBackToGameBtn();
    try { localStorage.setItem('kingside_active_lobby', lobbyId); } catch (e) {}
  },
  renderBoard() {
    const fenToShow = (this.viewIndex >= 0 && this.viewIndex < this.moveFens.length) ? this.moveFens[this.viewIndex] : App.currentFen;
    const hash = fenToShow + '|' + (this.selected ? this.selected.join(',') : '') + '|' + this.viewIndex + '|' +
      (this.lastMove ? this.lastMove.from.join(',') + this.lastMove.to.join(',') : '') + '|' + App.myColor + '|' + this.boardFlipped +
      '|' + this.legalMoves.map(m => m.join(',')).join(';') + '|' +
      (this.premove ? this.premove.from.join(',') + '>' + this.premove.to.join(',') : '') + '|' + (this.dragging ? 'drag' : '');
    if (hash === this.lastBoardHash) return;
    this.lastBoardHash = hash;
    const state = Chess.parseFen(fenToShow);
    const boardEl = document.getElementById('board');
    boardEl.innerHTML = '';
    const flip = (App.myColor === 'b') !== this.boardFlipped;
    const interactive = App.gameActive && !App.gameEnded && this.viewIndex === -1;
    for (let dr = 0; dr < 8; dr++) for (let dc = 0; dc < 8; dc++) {
      const r = flip ? 7 - dr : dr; const c = flip ? 7 - dc : dc;
      const sq = document.createElement('div');
      sq.className = 'sq ' + ((r + c) % 2 ? 'dark' : 'light');
      sq.dataset.r = r; sq.dataset.c = c;
      if (this.lastMove && this.viewIndex === -1) { if ((this.lastMove.from[0] === r && this.lastMove.from[1] === c) || (this.lastMove.to[0] === r && this.lastMove.to[1] === c)) sq.classList.add('lastmove'); }
      const isWhiteTurn = state.turn === 'w';
      if (Chess.inCheck(state, isWhiteTurn)) { const k = Chess.findKing(state, isWhiteTurn); if (k && k[0] === r && k[1] === c) sq.classList.add('check'); }
      if (this.selected && this.selected[0] === r && this.selected[1] === c) sq.classList.add('sel');
      if (interactive) { const isLegal = this.legalMoves.some(([mr, mc]) => mr === r && mc === c); if (isLegal) { sq.classList.add('hint'); if (state.board[r][c]) sq.classList.add('capture'); } }
      if (this.premove) { if (this.premove.to[0] === r && this.premove.to[1] === c) sq.classList.add('premove-target'); if (this.premove.from[0] === r && this.premove.from[1] === c) sq.classList.add('premove-from'); }
      const p = state.board[r][c];
      if (p) {
        const piece = document.createElement('span');
        piece.className = 'piece ' + (Chess.isWhite(p) ? 'w' : 'b');
        piece.innerHTML = Chess.pieceSvg(p);
        if (this.dragging && this.dragging.from[0] === r && this.dragging.from[1] === c) piece.classList.add('dragging');
        sq.appendChild(piece);
      }
      if (dr === 7) { const e = document.createElement('span'); e.className='coord-f'; e.textContent = String.fromCharCode(97 + c); sq.appendChild(e); }
      if (dc === 0) { const e = document.createElement('span'); e.className='coord-r'; e.textContent = 8 - r; sq.appendChild(e); }
      boardEl.appendChild(sq);
    }
    this.updateTurnIndicator(state);
  },
  renderMoves() {
    const el = document.getElementById('movesList'); if (!el) return;
    el.innerHTML = '';
    for (let i = 0; i < this.moveHistory.length; i += 2) {
      const row = document.createElement('div'); row.className = 'mvRow';
      const num = (i / 2) + 1, w = this.moveHistory[i] || '', b = this.moveHistory[i + 1] || '';
      const activeW = this.viewIndex === i, activeB = this.viewIndex === i + 1;
      row.innerHTML = `<span class="num">${num}.</span><span class="mv ${activeW ? 'current' : ''}" onclick="Game.jumpToMove(${i})">${w}</span><span class="mv ${activeB ? 'current' : ''}" onclick="Game.jumpToMove(${i+1})">${b}</span>`;
      el.appendChild(row);
    }
    el.scrollTop = el.scrollHeight;
  },
  jumpToMove(idx) { if (idx < 0 || idx >= this.moveHistory.length) return; this.viewIndex = idx; this.lastBoardHash = ''; this.renderBoard(); this.renderMoves(); },
  gotoMove(where) {
    if (!this.moveHistory.length) return;
    if (where === 'first') this.viewIndex = 0;
    else if (where === 'last') this.viewIndex = -1;
    else if (where === 'prev') this.viewIndex = this.viewIndex === -1 ? this.moveHistory.length - 2 : Math.max(0, this.viewIndex - 1);
    else if (where === 'next') { if (this.viewIndex === -1) return; this.viewIndex++; if (this.viewIndex >= this.moveHistory.length - 1) this.viewIndex = -1; }
    this.lastBoardHash = ''; this.renderBoard(); this.renderMoves();
  },
  updateTurnIndicator(state) {
    if (!state) state = Chess.parseFen(App.currentFen);
    const isMy = state.turn === App.myColor;
    this.clockTurn = state.turn;
    if (App.gameActive && !App.gameEnded) { this.clockSyncedAt = performance.now(); this.clockMyAtSync = App.myTime; this.clockOppAtSync = App.oppTime; if (!this.clockLoopRunning) this.startClockLoop(); }
    document.getElementById('topStrip').classList.toggle('active', App.gameActive && !App.gameEnded && state.turn !== App.myColor);
    document.getElementById('bottomStrip').classList.toggle('active', App.gameActive && !App.gameEnded && state.turn === App.myColor);
    document.getElementById('topClock').classList.toggle('active', App.gameActive && !App.gameEnded && state.turn !== App.myColor);
    document.getElementById('bottomClock').classList.toggle('active', App.gameActive && !App.gameEnded && state.turn === App.myColor);
    const bar = document.getElementById('statusBar'); if (!bar) return;
    if (App.gameEnded) { bar.className = 'statusYellow'; bar.textContent = 'Партия завершена'; }
    else if (App.gameActive) { const who = state.turn === 'w' ? 'Белые' : 'Чёрные'; bar.className = 'statusGreen'; let txt = `${who} — ${isMy ? 'ваш ход' : 'ход соперника'}`; if (this.premove) txt += ' · премьов'; bar.textContent = txt; }
  },
  startClockLoop() {
    if (this.clockLoopRunning) return; this.clockLoopRunning = true;
    const self = this;
    function tick() {
      if (!App.gameActive || App.gameEnded) { self.clockLoopRunning = false; return; }
      const elapsed = (performance.now() - self.clockSyncedAt) / 1000;
      let m = self.clockMyAtSync, o = self.clockOppAtSync;
      if (self.clockTurn === App.myColor) m = Math.max(0, m - elapsed); else o = Math.max(0, o - elapsed);
      App.myTime = m; App.oppTime = o;
      const tt = document.getElementById('topTime'); const bt = document.getElementById('bottomTime');
      if (tt) tt.textContent = Utils.formatTime(App.oppTime);
      if (bt) bt.textContent = Utils.formatTime(App.myTime);
      document.getElementById('topClock').classList.toggle('low', App.oppTime <= 20);
      document.getElementById('bottomClock').classList.toggle('low', App.myTime <= 20);
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  },
  updateTimersFromServer(timeW, timeB, serverNow, turn) {
    this.clockSyncedAt = performance.now();
    this.clockMyAtSync = App.myColor === 'w' ? timeW : timeB;
    this.clockOppAtSync = App.myColor === 'w' ? timeB : timeW;
    if (turn) this.clockTurn = turn;
    App.myTime = this.clockMyAtSync; App.oppTime = this.clockOppAtSync;
    if (!this.clockLoopRunning) this.startClockLoop();
  },
  updateTimers() {
    document.getElementById('topTime').textContent = Utils.formatTime(App.oppTime);
    document.getElementById('bottomTime').textContent = Utils.formatTime(App.myTime);
    document.getElementById('topClock').classList.toggle('low', App.oppTime <= 20);
    document.getElementById('bottomClock').classList.toggle('low', App.myTime <= 20);
  },
  onSquareClick(r, c) {
    if (!App.gameActive || App.gameEnded || this.viewIndex !== -1) return;
    const state = Chess.parseFen(App.currentFen);
    const myTurn = state.turn === App.myColor;
    if (!myTurn) {
      const p = state.board[r][c]; const isMyPiece = p && Chess.isWhite(p) === (App.myColor === 'w');
      if (this.selected) { const from = this.selected; if (from[0] === r && from[1] === c) { this.selected = null; this.legalMoves = []; this.lastBoardHash = ''; this.renderBoard(); return; } const piece = state.board[from[0]][from[1]]; if (piece && Chess.isWhite(piece) === (App.myColor === 'w')) { this.premove = { from, to: [r, c], san: '' }; this.selected = null; this.legalMoves = []; this.lastBoardHash = ''; this.renderBoard(); return; } else { this.selected = null; this.legalMoves = []; } }
      if (isMyPiece) { this.selected = [r, c]; this.legalMoves = Chess.legalMovesFor(state, r, c); this.lastBoardHash = ''; this.renderBoard(); }
      else { this.selected = null; this.legalMoves = []; this.lastBoardHash = ''; this.renderBoard(); }
      return;
    }
    if (this.premove) { if (this.premove.to[0] === r && this.premove.to[1] === c) { this.premove = null; this.lastBoardHash = ''; this.renderBoard(); return; } }
    if (this.selected) { const isLegal = this.legalMoves.some(([mr, mc]) => mr === r && mc === c); if (isLegal) { const from = this.selected; this.selected = null; this.legalMoves = []; this.applyUserMove(from, [r, c], false); return; } }
    const p = state.board[r][c];
    if (p && Chess.isWhite(p) === (App.myColor === 'w')) { this.selected = [r, c]; this.legalMoves = Chess.legalMovesFor(state, r, c); }
    else { this.selected = null; this.legalMoves = []; }
    this.lastBoardHash = ''; this.renderBoard();
  },
  applyUserMove(from, to, isPremove) {
    const state = Chess.parseFen(App.currentFen);
    const legal = Chess.legalMovesFor(state, from[0], from[1]);
    const isLegal = legal.some(([r, c]) => r === to[0] && c === to[1]);
    if (!isLegal) return false;
    const san = Chess.toSAN(state, from, to);
    if (isPremove) { this.premove = { from, to, san }; this.lastBoardHash = ''; this.renderBoard(); return true; }
    const nextState = Chess.applyMove(state, from, to);
    const newFen = Chess.toFen(nextState);
    App.currentFen = newFen; this.lastMove = { from, to };
    this.moveHistory.push(san); this.moveFens.push(newFen); this.premove = null;
    this.renderMoves(); this.lastBoardHash = ''; this.renderBoard();
    App.socket.emit('move', { lobbyId: App.lobbyId, fen: newFen, turn: nextState.turn, san });
    Sounds.moveBySan(san);
    this.checkGameEnd(nextState);
    return true;
  },
  checkGameEnd(state) {
    const sideToMoveWhite = state.turn === 'w';
    if (!Chess.hasAnyLegalMove(state, sideToMoveWhite)) {
      if (Chess.inCheck(state, sideToMoveWhite)) { Sounds.mate(); this.endGame(sideToMoveWhite ? 'b' : 'w', 'Мат', true, App.currentGameIsArena); }
      else { Sounds.draw(); this.endGame(null, 'Пат', true, App.currentGameIsArena); }
    }
  },
  tryApplyPremove() {
    if (!this.premove) return;
    const state = Chess.parseFen(App.currentFen);
    if (state.turn !== App.myColor) return;
    const p = state.board[this.premove.from[0]][this.premove.from[1]];
    if (!p || Chess.isWhite(p) !== (App.myColor === 'w')) { this.premove = null; this.lastBoardHash = ''; this.renderBoard(); return; }
    const leg = Chess.legalMovesFor(state, this.premove.from[0], this.premove.from[1]);
    const ok = leg.some(([r, c]) => r === this.premove.to[0] && c === this.premove.to[1]);
    if (!ok) { this.premove = null; this.lastBoardHash = ''; this.renderBoard(); return; }
    const mv = this.premove; this.premove = null;
    setTimeout(() => { this.applyUserMove(mv.from, mv.to, false); }, 50);
  },
  onMouseDown(ev) {
    if (ev.button !== 0) return;
    const sq = ev.target.closest('.sq'); if (!sq || sq.dataset.r == null) return;
    const r = +sq.dataset.r, c = +sq.dataset.c;
    const state = Chess.parseFen(App.currentFen);
    const p = state.board[r][c]; if (!p) return;
    const myTurn = state.turn === App.myColor, sameColor = Chess.isWhite(p) === (App.myColor === 'w');
    if (myTurn && sameColor) { const leg = Chess.legalMovesFor(state, r, c); if (!leg.length) return; this.selected = [r, c]; this.legalMoves = leg; this.dragging = { from: [r, c], active: false }; this.dragStartPos = { x: ev.clientX, y: ev.clientY }; this.lastBoardHash = ''; this.renderBoard(); this.startDragGhost(p, ev.clientX, ev.clientY); ev.preventDefault(); return; }
    if (!myTurn && sameColor) { const leg = Chess.legalMovesFor(state, r, c); if (!leg.length) return; this.selected = [r, c]; this.legalMoves = leg; this.dragging = { from: [r, c], active: false, premoveDrag: true }; this.dragStartPos = { x: ev.clientX, y: ev.clientY }; this.lastBoardHash = ''; this.renderBoard(); this.startDragGhost(p, ev.clientX, ev.clientY); ev.preventDefault(); }
  },
  startDragGhost(piece, x, y) {
    if (this.ghostEl) { this.ghostEl.remove(); this.ghostEl = null; }
    this.ghostEl = document.createElement('div');
    this.ghostEl.className = 'dragGhost ' + (Chess.isWhite(piece) ? 'w' : 'b');
    this.ghostEl.innerHTML = Chess.pieceSvg(piece);
    this.ghostEl.style.left = x + 'px'; this.ghostEl.style.top = y + 'px'; this.ghostEl.style.display = 'none';
    document.body.appendChild(this.ghostEl);
  },
  moveGhost(x, y) { if (!this.ghostEl) return; this.ghostEl.style.display = ''; this.ghostEl.style.left = x + 'px'; this.ghostEl.style.top = y + 'px'; },
  clearGhost() { if (this.ghostEl) { this.ghostEl.remove(); this.ghostEl = null; } },
  boardSquareFromEvent(ev) { const el = document.elementFromPoint(ev.clientX, ev.clientY); if (!el) return null; const sq = el.closest ? el.closest('.sq') : null; if (!sq || sq.dataset.r == null) return null; return [+sq.dataset.r, +sq.dataset.c]; },
  onMouseMove(ev) {
    if (!this.dragging) return;
    if (!this.dragging.active) { if (Math.abs(ev.clientX - this.dragStartPos.x) < 5 && Math.abs(ev.clientY - this.dragStartPos.y) < 5) return; this.dragging.active = true; this.lastBoardHash = ''; this.renderBoard(); }
    this.moveGhost(ev.clientX, ev.clientY);
  },
  onMouseUp(ev) {
    if (!this.dragging) { this.dragStartPos = null; return; }
    if (!this.dragging.active) { this.dragging = null; this.clearGhost(); return; }
    const target = this.boardSquareFromEvent(ev);
    const wasPremove = !!this.dragging.premoveDrag;
    const from = this.dragging.from;
    this.dragging = null; this.clearGhost(); this.dragStartPos = null;
    if (!target) { this.selected = null; this.legalMoves = []; this.lastBoardHash = ''; this.renderBoard(); return; }
    if (target[0] === from[0] && target[1] === from[1]) { this.selected = from; this.legalMoves = Chess.legalMovesFor(Chess.parseFen(App.currentFen), from[0], from[1]); this.lastBoardHash = ''; this.renderBoard(); return; }
    if (wasPremove) { this.premove = { from, to: target, san: '' }; this.selected = null; this.legalMoves = []; this.lastBoardHash = ''; this.renderBoard(); return; }
    const latestState = Chess.parseFen(App.currentFen);
    const latestPiece = latestState.board[from[0]][from[1]];
    const latestIsMine = latestPiece && Chess.isWhite(latestPiece) === (App.myColor === 'w');
    if (latestState.turn !== App.myColor) {
      // The opponent may have moved while the pointer was held. Only queue a premove
      // if the exact source square still contains one of our pieces.
      if (latestIsMine) this.premove = { from, to: target, san: '' };
      else this.premove = null;
      this.selected = null; this.legalMoves = []; this.lastBoardHash = ''; this.renderBoard();
      return;
    }
    const ok = this.applyUserMove(from, target, false);
    if (!ok) { this.selected = null; this.legalMoves = []; this.lastBoardHash = ''; this.renderBoard(); }
  },
  flipBoard() { this.boardFlipped = !this.boardFlipped; this.lastBoardHash = ''; this.renderBoard(); },
  resign() { if (!App.gameActive || App.gameEnded) return; if (!confirm('Точно сдаться?')) return; App.socket.emit('resign', { lobbyId: App.lobbyId }); this.endGame(App.myColor === 'w' ? 'b' : 'w', 'Сдача', true, App.currentGameIsArena); },
  offerDraw() {
    if (!App.gameActive || App.gameEnded) return;
    if (this.pendingDrawOffer) { alert('Ничья уже предложена'); return; }
    App.socket.emit('drawOffer', { lobbyId: App.lobbyId });
    this.pendingDrawOffer = true;
    const bar = document.getElementById('statusBar'); if (bar) { bar.className = 'statusYellow'; bar.textContent = 'Ничья предложена. Ожидание соперника...'; }
  },
  endGame(winner, reason, fromServer, isArena) {
    if (App.gameEnded) return;
    App.gameEnded = true; App.gameActive = false;
    this.premove = null; this.rematchRequested = false; this.stopRematchSpinner();
    if (typeof isArena === 'boolean') App.currentGameIsArena = isArena;
    this.showResultBar(winner, reason);
    Banners.hideDraw();
    if (!fromServer) App.socket.emit('gameOver', { lobbyId: App.lobbyId, result: winner || 'draw' });
    App.socket.emit('getProfile', { username: App.me.username }, (res) => { if (res && res.ok) { App.me = res.user; App.updateTopbarUser(); } });
    Stats.refresh();
    if (Router.current && Router.current.name === 'lobby') Lobby.render();
  },
  requestRematch() {
    if (!App.lobbyId) { const saved = localStorage.getItem('kingside_last_lobby'); if (saved) App.lobbyId = saved; }
    if (Banners.rematchFrom) { App.socket.emit('rematchRequest', { lobbyId: App.lobbyId }, (res) => { if (res && res.ok && res.started) Banners.hideRematch(); }); Banners.hideRematch(); return; }
    if (this.rematchRequested) { alert('Реванш уже предложен'); return; }
    this.rematchRequested = true; this.startRematchSpinner();
    App.socket.emit('rematchRequest', { lobbyId: App.lobbyId }, (res) => {
      if (!res || !res.ok) { this.stopRematchSpinner(); this.rematchRequested = false; const bar = document.getElementById('statusBar'); if (bar) { bar.className = 'statusYellow'; bar.textContent = (res && res.msg) || 'Ошибка реванша'; } const btn = document.getElementById('grRematchBtn'); if (btn) { btn.disabled = false; btn.textContent = 'РЕВАНШ'; } return; }
      if (res.declined) { this.stopRematchSpinner(); this.rematchRequested = false; const bar = document.getElementById('statusBar'); if (bar) { bar.className = 'statusYellow'; bar.textContent = 'Бот отклонил реванш'; } const btn = document.getElementById('grRematchBtn'); if (btn) { btn.disabled = false; btn.textContent = 'РЕВАНШ'; } return; }
      if (res.started) { this.stopRematchSpinner(); this.rematchRequested = false; return; }
    });
  },
  toggleArenaPause() {
    if (!App.currentArenaId) return;
    App.socket.emit('pauseArena', { arenaId: App.currentArenaId }, (res) => {
      if (!res || !res.ok) { alert((res && res.msg) || 'Ошибка'); return; }
      const pauseBtn = document.getElementById('grPauseBtn'); if (pauseBtn) pauseBtn.textContent = res.paused ? '▶ ПРОДОЛЖИТЬ' : '⏸ ПАУЗА';
      Arena.lastStateHash = ''; Arena.loadPage();
    });
  },
  findNewOpponent() { this.hideResultBar(); this.cleanupAndLeave(); },
  openOpponentProfile() { if (App.opponentName && App.opponentName !== '—') Router.go('profile', App.opponentName); },
  sendChat(e) {
    e.preventDefault();
    const input = document.getElementById('chatInput'); const text = input.value.trim();
    if (!text || !App.lobbyId) return;
    App.socket.emit('chatMessage', { lobbyId: App.lobbyId, text });
    input.value = '';
  },
  onChatMessage(msg) {
    const box = document.getElementById('chatMessages'); if (!box) return;
    if (msg.id && this.chatMsgIds.has(msg.id)) return; if (msg.id) this.chatMsgIds.add(msg.id);
    const div = document.createElement('div');
    div.className = 'msg'; div.dataset.msgId = msg.id || '';
    const time = Utils.fmtMskHM(msg.ts);
    let modHtml = '';
    if (App.me && App.me.isMod) modHtml = `<span class="modBtn" title="Модерация">⚙</span>`;
    div.innerHTML = `<span class="u">${Utils.nickHtml(msg.user, msg.userIsAdmin, msg.userIsMod)}:</span> ${Utils.escapeHtml(msg.text)} <span class="t">${time}</span>${modHtml}`;
    if (App.me && App.me.isMod) { const btn = div.querySelector('.modBtn'); if (btn) btn.addEventListener('click', (ev) => { ev.stopPropagation(); Mod.openMenu(ev, msg.id, msg.user, 'game', App.lobbyId); }); }
    box.appendChild(div);
    while (box.children.length > 50) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  },
  onChatDeleted(msgId) {
    const el = document.querySelector(`#chatMessages .msg[data-msg-id="${msgId}"]`); if (el) el.remove();
    const el2 = document.querySelector(`#arenaChatMessages .msg[data-msg-id="${msgId}"]`); if (el2) el2.remove();
  },
  onDrawDeclined() { const bar = document.getElementById('statusBar'); if (bar) { bar.className = 'statusYellow'; bar.textContent = 'Соперник отклонил ничью'; } this.pendingDrawOffer = false; },
  onRematchDeclined() {
    this.rematchRequested = false; this.stopRematchSpinner();
    const btn = document.getElementById('grRematchBtn'); if (btn) { btn.disabled = false; btn.classList.remove('accept'); btn.textContent = 'РЕВАНШ'; }
    const bar = document.getElementById('statusBar'); if (bar) { bar.className = 'statusYellow'; bar.textContent = 'Соперник отклонил реванш'; }
  },
  onOpponentOnline(username) {
    if (username === App.opponentName) { App.opponentOnline = true; const strip = document.getElementById('topName'); if (strip) strip.innerHTML = Utils.onlineDotHtml(true) + Utils.nickHtml(App.opponentName, App.opponentIsAdmin, false, App.opponentIsBot); }
  },
  onOpponentOffline(username) {
    if (username === App.opponentName) { App.opponentOnline = false; const strip = document.getElementById('topName'); if (strip) strip.innerHTML = Utils.onlineDotHtml(false) + Utils.nickHtml(App.opponentName, App.opponentIsAdmin, false, App.opponentIsBot); }
  },
  onOpponentLeft() { if (!App.gameActive) return; alert('Соперник отключился'); this.updateBackToGameBtn(); },
  onGameStart(payload) {
    if (payload.lobbyId && payload.lobbyId.startsWith('sp_')) {
      console.warn('[Game] Получен gameStart для self-play, игнорируем');
      return;
    }
    if (payload.isSelfPlay) {
      console.warn('[Game] Получен gameStart с isSelfPlay, игнорируем');
      return;
    }
    if (App.gameActive && !App.gameEnded && App.lobbyId && payload.lobbyId && payload.lobbyId !== App.lobbyId) {
      console.warn('[Game] Игнорирую gameStart для чужого lobbyId', payload.lobbyId, 'текущий', App.lobbyId);
      return;
    }

    const { color, opponent, opponentRating, time, inc, lobbyId, fen, chat, arenaId, arenaName, opponentIsAdmin, opponentIsMod, opponentOnline, opponentIsBot, isBot: isBotFlag } = payload;
    if (lobbyId) App.lobbyId = lobbyId;
    App.myColor = color || 'w'; App.inc = inc || 0;
    App.opponentName = opponent || 'Соперник'; App.opponentRating = opponentRating || null;
    App.opponentIsAdmin = (typeof opponentIsAdmin === 'boolean') ? opponentIsAdmin : (App.opponentName === 'PeshkaSasha');
    App.opponentOnline = (typeof opponentOnline === 'boolean') ? opponentOnline : true;
    App.opponentIsBot = !!(opponentIsBot || isBotFlag);
    App.isBotGame = !!isBotFlag || App.opponentIsBot;
    App.myTime = time * 60; App.oppTime = time * 60;
    App.currentFen = fen || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    App.gameActive = true; App.gameEnded = false;
    App.currentGameIsArena = !!arenaId; App.currentArenaId = arenaId || null; App.currentArenaName = arenaName || null;
    this.reset(); this.hideResultBar();
    document.getElementById('bottomName').innerHTML = Utils.nickHtml(App.me.username, App.me.isAdmin, App.me.isMod, App.me.isBot);
    document.getElementById('bottomRating').textContent = App.me.rating;
    document.getElementById('bottomDot').className = 'dot ' + (App.myColor === 'w' ? 'w' : 'b');
    document.getElementById('bottomTime').textContent = Utils.formatTime(time * 60);
    document.getElementById('topName').innerHTML = Utils.onlineDotHtml(App.opponentOnline) + Utils.nickHtml(App.opponentName, App.opponentIsAdmin, opponentIsMod, App.opponentIsBot);
    document.getElementById('topRating').textContent = App.opponentRating || '';
    document.getElementById('topDot').className = 'dot ' + (App.myColor === 'w' ? 'b' : 'w');
    document.getElementById('topTime').textContent = Utils.formatTime(time * 60);
    const bar = document.getElementById('statusBar');
    if (bar) { bar.className = 'statusGreen'; bar.textContent = App.isBotGame ? `Игра с ботом ${Utils.escapeHtml(App.opponentName)}. Вы — ${App.myColor === 'w' ? 'белые' : 'чёрные'}` : `Игра началась. Вы — ${App.myColor === 'w' ? 'белые' : 'чёрные'}`; }
    document.getElementById('chatMessages').innerHTML = '';
    if (Array.isArray(chat)) chat.forEach(m => this.onChatMessage(m));
    Router.go('game'); this.renderBoard(); this.renderMoves(); this.updateTimers(); this.updateBackToGameBtn();
    if (Router.current && Router.current.name === 'lobby') Lobby.render();
    try { localStorage.setItem('kingside_active_lobby', App.lobbyId); localStorage.setItem('kingside_last_lobby', App.lobbyId); } catch (e) {}
    Sounds.start();
  },
  onBoardUpdate({ lobbyId, fen, san, from, to }) {
    if (!lobbyId || lobbyId !== App.lobbyId) return;
    if (!App.gameActive || App.gameEnded) return;
    const prevFen = App.currentFen; App.currentFen = fen;
    this.selected = null; this.legalMoves = []; this.viewIndex = -1;
    if (from && to) { this.lastMove = { from, to }; if (!san) { try { const prevState = Chess.parseFen(prevFen); san = Chess.toSAN(prevState, from, to); } catch (e) {} } }
    if (san) { this.moveHistory.push(san); this.moveFens.push(fen); }
    this.renderMoves(); this.lastBoardHash = ''; this.renderBoard();
    const state = Chess.parseFen(App.currentFen);
    if (san) Sounds.moveBySan(san);
    this.checkGameEnd(state); this.tryApplyPremove();
  },
  onTimeUpdate({ lobbyId, timeW, timeB, serverNow }) {
    if (!lobbyId || lobbyId !== App.lobbyId) return;
    if (!App.gameActive || App.gameEnded) return;
    const state = Chess.parseFen(App.currentFen);
    this.updateTimersFromServer(timeW, timeB, serverNow, state.turn);
  },
  onGameEnded({ lobbyId, result, reason, isArena, arenaId, isBot }) {
    if (!lobbyId || lobbyId !== App.lobbyId) return;
    if (App.gameEnded) return;
    let winner = null;
    if (result === 'w') winner = 'w'; else if (result === 'b') winner = 'b';
    if (reason !== 'Мат' && reason !== 'Пат') { if (!winner) Sounds.draw(); else if (winner === App.myColor) Sounds.win(); else Sounds.lose(); }
    if (typeof isArena === 'boolean') App.currentGameIsArena = isArena;
    if (typeof isBot === 'boolean') App.isBotGame = isBot;
    if (arenaId) App.currentArenaId = arenaId;
    this.endGame(winner, reason, true, App.currentGameIsArena);
  }
};

// ============================================================
// BOOT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  window.App = App; window.Router = Router; window.Lobby = Lobby; window.Bot = Bot;
  window.Watch = Watch; window.Arena = Arena; window.Profile = Profile; window.Community = Community;
  window.Game = Game; window.Banners = Banners; window.Mod = Mod; window.Utils = Utils;
  window.UserMenu = UserMenu; window.Inbox = Inbox; window.Ping = Ping; window.Auth = Auth;
  App.init();
});

(function() {
  let hoverTimer = null, hoverName = '';
  function ensureCard() { let card = document.getElementById('playerHoverCard'); if (!card) { card = document.createElement('div'); card.id = 'playerHoverCard'; document.body.appendChild(card); } return card; }
  function show(target) {
    const username = target && target.dataset ? target.dataset.player : ''; if (!username) return;
    hoverName = username; clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      const card = ensureCard(); const r = target.getBoundingClientRect(); const cardW = 300;
      let left = r.left; if (left + cardW + 8 > window.innerWidth) left = window.innerWidth - cardW - 8; if (left < 8) left = 8;
      card.style.left = left + 'px'; card.style.top = Math.min(window.innerHeight - 180, r.bottom + 7) + 'px';
      card.style.display = 'block';
      card.innerHTML = `<div class="phName">${Utils.escapeHtml(username)}</div><div style="color:var(--muted)">Загрузка статистики…</div>`;
      App.socket.emit('getPlayerCard', { username }, (res) => {
        if (hoverName !== username || !res || !res.ok) return;
        const u = res.user;
        card.innerHTML = `<div class="phName">${u.online ? '🟢' : '⚪'} ${Utils.nickHtml(u.username,u.isAdmin,u.isMod,u.isBot)}</div>
          <div class="phMeta"><span>♟ ${Number(u.rating)||1200}</span><span>🏆 ${Number(u.games)||0} партий</span><span>${u.online ? '● В сети' : '○ Не в сети'}</span></div>
          <div class="phStats"><div class="phStat">♔ ${Number(u.wins)||0} побед</div><div class="phStat">½ ${Number(u.draws)||0} ничьих</div><div class="phStat">♚ ${Number(u.losses)||0} пораж.</div><div class="phStat">${u.games ? Math.round((u.wins/u.games)*100) : 0}% побед</div></div>`;
      });
    }, 250);
  }
  document.addEventListener('mouseover', e => { const n = e.target.closest && e.target.closest('[data-player]'); if (n) show(n); });
  document.addEventListener('mouseout', e => { const n = e.target.closest && e.target.closest('[data-player]'); if (n && !n.contains(e.relatedTarget)) { clearTimeout(hoverTimer); hoverName = ''; const c = document.getElementById('playerHoverCard'); if (c) c.style.display = 'none'; } });
})();
