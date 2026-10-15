/* app.js — вся клиентская логика Kingside
 *
 * Структура:
 *   - Utils        — общие утилиты (escape, fmt, nickHtml, ...)
 *   - Sounds       — звуки
 *   - Chess        — клиентская шахматная логика (для отрисовки)
 *   - Router       — hash-роутинг (#/lobby, #/arena/xyz, #/profile/Ivan, #/game/id)
 *   - Socket       — обёртка
 *   - App          — общее состояние (me, lobbyId, ...)
 *   - TopArenas    — список «идут сейчас»
 *   - Stats        — статистика
 *   - Lobby        — лобби и зал ожидания
 *   - Bot          — диалог игры с ботом
 *   - Watch        — просмотр партий
 *   - Arena        — арены (список + страница)
 *   - Profile      — профиль
 *   - Community    — сообщество
 *   - Game         — партия
 *   - Banners      — плавающие баннеры реванша и ничьей
 */

'use strict';

// ============================================================
// UTILS
// ============================================================
const Utils = {
  MSK_TZ: 'Europe/Moscow',
  fmtMskHM(ts) {
    return new Intl.DateTimeFormat('ru-RU', { timeZone: this.MSK_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts));
  },
  escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  },
  nickHtml(username, isAdminFlag, isModFlag, isBotFlag) {
    if (!username) return '';
    const admin = (typeof isAdminFlag === 'boolean') ? isAdminFlag : (username === 'PeshkaSasha' || username === 'admin');
    const mod = (typeof isModFlag === 'boolean') ? isModFlag : false;
    const bot = !!isBotFlag;
    const crown = admin ? '<span class="crown">👑</span>' : '';
    const mark = (!admin && mod) ? '<span class="modMark" title="Модератор">!</span>' : '';
    const botTag = bot ? '<span class="botBadge" style="margin-right:4px">🤖 BOT</span>' : '';
    return `<span class="playerNick" data-player="${this.escapeHtml(username)}">${botTag}${crown}${mark}${this.escapeHtml(username)}</span>`;
  },
  onlineDotHtml(online) {
    return online
      ? '<span class="onlineDot" title="В сети"></span>'
      : '<span class="offlineDot" title="Не в сети"></span>';
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
  genId() {
    return Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6);
  }
};

// ============================================================
// SOUNDS
// ============================================================
const Sounds = (function() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  let ctx = null;
  function ensure() {
    if (!ctx) ctx = new AudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function playTone(freq, dur, type, vol, delay) {
    try {
      const c = ensure();
      const t0 = c.currentTime + (delay || 0);
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(vol || 0.15, t0 + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain); gain.connect(c.destination);
      osc.start(t0); osc.stop(t0 + dur + 0.02);
    } catch (e) {}
  }
  const last = { move:0, capture:0, check:0, mate:0, draw:0, win:0, lose:0, start:0 };
  const COOLDOWN = 180;
  function can(key) {
    const now = performance.now();
    if (now - last[key] < COOLDOWN) return false;
    last[key] = now;
    return true;
  }
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
    initOnFirstClick() {
      window.addEventListener('pointerdown', () => ensure(), { once: true });
    }
  };
})();

// ============================================================
// CHESS (клиентская логика — только для отрисовки/подсветки/валидации UI)
// ============================================================
const Chess = {
  EMOJI: { 'K':'♔','Q':'♕','R':'♖','B':'♗','N':'♘','P':'♙','k':'♚','q':'♛','r':'♜','b':'♝','n':'♞','p':'♟' },
  parseFen(fen) {
    const parts = fen.split(' ');
    const board = Array.from({length:8}, () => Array(8).fill(null));
    parts[0].split('/').forEach((row, r) => {
      let f = 0;
      for (const ch of row) { if (/\d/.test(ch)) f += +ch; else board[r][f++] = ch; }
    });
    return { board, turn: parts[1], castling: parts[2], ep: parts[3], half: +parts[4] || 0, full: +parts[5] || 1 };
  },
  toFen(state) {
    const rows = state.board.map(r => {
      let s = '', e = 0;
      for (const c of r) { if (c) { if (e) { s += e; e = 0; } s += c; } else e++; }
      if (e) s += e;
      return s;
    }).join('/');
    return [rows, state.turn, state.castling, state.ep, state.half, state.full].join(' ');
  },
  isWhite(p) { return !!p && p === p.toUpperCase(); },
  inBoard(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; },
  pseudoMoves(state, r, c) {
    const p = state.board[r][c]; if (!p) return [];
    const moves = []; const white = this.isWhite(p); const type = p.toLowerCase();
    const dir = white ? -1 : 1;
    const add = (rr, cc) => {
      if (!this.inBoard(rr, cc)) return false;
      const t = state.board[rr][cc];
      if (t && this.isWhite(t) === white) return false;
      moves.push([rr, cc]);
      return !t;
    };
    if (type === 'p') {
      const startRow = white ? 6 : 1, oneR = r + dir;
      if (this.inBoard(oneR, c) && !state.board[oneR][c]) {
        moves.push([oneR, c]);
        const twoR = r + 2 * dir;
        if (r === startRow && this.inBoard(twoR, c) && !state.board[twoR][c]) moves.push([twoR, c]);
      }
      for (const dc of [-1, 1]) {
        const rr = r + dir, cc = c + dc;
        if (!this.inBoard(rr, cc)) continue;
        const t = state.board[rr][cc];
        if (t && this.isWhite(t) !== white) moves.push([rr, cc]);
        const epTarget = String.fromCharCode(97 + cc) + (8 - rr);
        if (state.ep && state.ep === epTarget && !t) moves.push([rr, cc]);
      }
    } else if (type === 'n') {
      [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]].forEach(([dr,dc]) => add(r+dr, c+dc));
    } else if (type === 'k') {
      [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]].forEach(([dr,dc]) => add(r+dr, c+dc));
      if (white && r === 7 && c === 4 && !this.isAttacked(state, 7, 4, false)) {
        if (state.castling.includes('K') && !state.board[7][5] && !state.board[7][6] && state.board[7][7] === 'R'
            && !this.isAttacked(state, 7, 5, false) && !this.isAttacked(state, 7, 6, false)) moves.push([7, 6]);
        if (state.castling.includes('Q') && !state.board[7][3] && !state.board[7][2] && !state.board[7][1] && state.board[7][0] === 'R'
            && !this.isAttacked(state, 7, 3, false) && !this.isAttacked(state, 7, 2, false)) moves.push([7, 2]);
      }
      if (!white && r === 0 && c === 4 && !this.isAttacked(state, 0, 4, true)) {
        if (state.castling.includes('k') && !state.board[0][5] && !state.board[0][6] && state.board[0][7] === 'r'
            && !this.isAttacked(state, 0, 5, true) && !this.isAttacked(state, 0, 6, true)) moves.push([0, 6]);
        if (state.castling.includes('q') && !state.board[0][3] && !state.board[0][2] && !state.board[0][1] && state.board[0][0] === 'r'
            && !this.isAttacked(state, 0, 3, true) && !this.isAttacked(state, 0, 2, true)) moves.push([0, 2]);
      }
    } else {
      const dirs = [];
      if (type === 'r' || type === 'q') dirs.push([-1,0],[1,0],[0,-1],[0,1]);
      if (type === 'b' || type === 'q') dirs.push([-1,-1],[-1,1],[1,-1],[1,1]);
      for (const [dr, dc] of dirs) { let rr = r + dr, cc = c + dc; while (add(rr, cc)) { rr += dr; cc += dc; } }
    }
    return moves;
  },
  findKing(state, white) {
    const k = white ? 'K' : 'k';
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (state.board[r][c] === k) return [r, c];
    return null;
  },
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
  inCheck(state, white) {
    const k = this.findKing(state, white);
    if (!k) return false;
    return this.isAttacked(state, k[0], k[1], !white);
  },
  applyMove(state, from, to) {
    const copy = { board: state.board.map(row => row.slice()), turn: state.turn, castling: state.castling, ep: state.ep, half: state.half, full: state.full };
    const [fr, fc] = from, [tr, tc] = to;
    const p = copy.board[fr][fc]; const white = this.isWhite(p); const type = p.toLowerCase();
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
  pieceSAN(p) {
    const t = p.toLowerCase();
    if (t === 'n') return 'N'; if (t === 'b') return 'B';
    if (t === 'r') return 'R'; if (t === 'q') return 'Q';
    if (t === 'k') return 'K'; return '';
  },
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
// APP — общее состояние
// ============================================================
const App = {
  socket: null,
  me: null,
  lobbyId: null,
  myColor: 'w',
  myTime: 0, oppTime: 0, inc: 0,
  gameActive: false,
  gameEnded: false,
  opponentName: '—',
  opponentRating: null,
  opponentIsAdmin: false,
  opponentOnline: true,
  opponentIsBot: false,
  isBotGame: false,
  currentFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  currentGameIsArena: false,
  currentArenaId: null,
  currentArenaName: null,
  profileViewing: null,
  botLevels: [],
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
    this.socket = io({
      transports: ['websocket', 'polling'],
      upgrade: true,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000
    });
    Sounds.initOnFirstClick();
    this.bindSocket();
    Router.init();
    TopArenas.init();
    Stats.init();
    Lobby.init();
    Bot.init();
    Watch.init();
    Arena.init();
    Profile.init();
    Community.init();
    Game.init();
    Banners.init();
    this.tryAutoLogin();
    this.scheduleArenaClock();
  },

  updateTopbarUser() {
    if (!this.me) return;
    document.getElementById('userBtn').style.display = 'flex';
    document.getElementById('logoutBtn').style.display = 'block';
    document.getElementById('userName').innerHTML = Utils.nickHtml(this.me.username, this.me.isAdmin, this.me.isMod, this.me.isBot) + ' (' + this.me.rating + ')';
    document.getElementById('userAvatar').textContent = this.me.username.charAt(0).toUpperCase();
  },

  doLogin() {
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    if (!username || !password) { document.getElementById('loginMsg').textContent = 'Введите логин и пароль'; return; }
    this.socket.emit('register', { username, password }, (res) => {
      if (!res || !res.ok) { document.getElementById('loginMsg').textContent = (res && res.msg) || 'Ошибка'; return; }
      this.me = res.user;
      try { localStorage.setItem('kingside_login', JSON.stringify({ username, password })); } catch (e) {}
      this.updateTopbarUser();
      Router.go('lobby');
      this.tryResumeGame();
    });
  },

  logout() {
    try {
      localStorage.removeItem('kingside_login');
      localStorage.removeItem('kingside_active_lobby');
    } catch (e) {}
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
      this.updateTopbarUser();
      Router.go('lobby');
      this.tryResumeGame();
    });
  },

  tryResumeGame() {
    let saved = null;
    try { saved = localStorage.getItem('kingside_active_lobby'); } catch (e) {}
    if (!saved) return;
    this.socket.emit('getGameState', { lobbyId: saved }, (res) => {
      if (!res || !res.ok) {
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
      const nowLine = scroller.querySelector('.nowLine');
      if (!nowLine) return;
      const timeRow = scroller.querySelector('.timeRow');
      if (!timeRow) return;
      const firstCell = timeRow.querySelector('.timeCell');
      if (!firstCell) return;
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
    s.on('connect', () => {
      s.emit('stats', () => {});
    });
    s.on('stats', (st) => Stats.onStats(st));
    s.on('communityOnline', (players) => Community.render(players));
    s.on('lobbiesUpdate', () => Lobby.refreshIfActive());
    s.on('connect_error', () => console.warn('Не удалось подключиться'));
    s.on('gameStart', (payload) => Game.onGameStart(payload));
    s.on('boardUpdate', (payload) => {
      Game.onBoardUpdate(payload);
      Watch.onBoardUpdate(payload);
    });
    s.on('timeUpdate', (payload) => {
      Game.onTimeUpdate(payload);
      Watch.onTimeUpdate(payload);
    });
    s.on('gameEnded', (payload) => {
      Game.onGameEnded(payload);
      Watch.onGameEnded(payload);
    });
    s.on('chatMessage', (msg) => {
      Game.onChatMessage(msg);
      Watch.onChatMessage(msg);
    });
    s.on('chatMessageDeleted', ({ msgId }) => Game.onChatDeleted(msgId));
    s.on('chatError', ({ msg }) => alert(msg));
    s.on('drawOffered', ({ from }) => Banners.showDrawOffer(from));
    s.on('drawDeclined', () => Game.onDrawDeclined());
    s.on('rematchOffered', ({ from }) => Banners.showRematch(from));
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
  },

  onModAction(info) {
    if (!info || !this.me) return;
    if (info.action === 'mute' && info.target === this.me.username) alert(`Вы заглушены на ${info.minutes} мин. модератором ${info.by}.`);
    if (info.action === 'unmute' && info.target === this.me.username) alert('С вас снят мут.');
  }
};

// ============================================================
// ROUTER — hash-роутинг
// ============================================================
const Router = {
  current: { name: 'lobby', param: null },

  init() {
    window.addEventListener('hashchange', () => this.handle());
    this.handle();
  },

  go(name, param) {
    const path = param ? `#/${name}/${encodeURIComponent(param)}` : `#/${name}`;
    if (location.hash === path) this.handle();
    else location.hash = path;
  },

  handle() {
    const hash = location.hash.replace(/^#\/?/, '');
    const parts = hash.split('/').filter(Boolean);
    const name = parts[0] || (App.me ? 'lobby' : 'login');
    const param = parts[1] ? decodeURIComponent(parts[1]) : null;
    this.current = { name, param };
    this.apply();
  },

  apply() {
    const { name, param } = this.current;
    if (!App.me && name !== 'login') { this.show('loginScreen'); return; }

    // Если уходим со страницы арены — покидаем комнату.
    if (name !== 'arenaPage' && Arena.currentArenaId) {
      Arena.leaveRoom();
    }

    const map = {
      login: 'loginScreen',
      lobby: 'lobbyScreen',
      watch: 'watchScreen',
      arenas: 'arenasScreen',
      arenaPage: 'arenaPageScreen',
      profile: 'profileScreen',
      community: 'communityScreen',
      game: 'gameScreen'
    };
    const screenId = map[name];
    if (!screenId) { this.show('loginScreen'); return; }
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
    }
  },

  show(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const el = document.getElementById(screenId);
    if (el) el.classList.add('active');
  }
};

// ============================================================
// TOP ARENAS
// ============================================================
const TopArenas = {
  lastHash: '',
  timer: null,
  init() {
    this.timer = setInterval(() => {
      if (document.hidden) return;
      if (!document.getElementById('lobbyScreen').classList.contains('active')) return;
      this.refresh();
    }, 5000);
  },
  refresh() {
    App.socket.emit('getTopArenas', (list) => {
      const box = document.getElementById('topArenasBox');
      if (!box) return;
      const hash = JSON.stringify(list);
      if (hash === this.lastHash) return;
      this.lastHash = hash;
      if (!list || !list.length) {
        box.innerHTML = '<div class="arenaEmpty" style="padding:20px 0">Сейчас активных арен нет</div>';
        return;
      }
      box.innerHTML = list.map(a => {
        const cls = 'topArenaCard' + (a.phase === 'live' ? ' live' : '');
        const phaseText = a.phase === 'live' ? 'идёт сейчас' : 'ждёт старта';
        const botTag = a.botFriendly ? ' 🤖' : '';
        return `<div class="${cls}" onclick="Router.go('arenaPage', '${Utils.escapeHtml(a.id)}')">
          <div class="taName">${Utils.escapeHtml(a.name)}${botTag}</div>
          <div class="taInfo"><span>${a.timeControl}+${a.increment}</span><span><b>${a.participantsCount}</b> 👥 · ${phaseText}</span></div>
        </div>`;
      }).join('');
    });
  }
};

// ============================================================
// STATS
// ============================================================
const Stats = {
  init() {},
  refresh() {
    App.socket.emit('getStats', (s) => this.onStats(s));
  },
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
  currentTab: 'create',
  known: new Map(),
  disappeared: new Map(),
  init() {
    document.querySelectorAll('[data-tab]').forEach(b => {
      b.onclick = () => this.switchTab(b.dataset.tab);
    });
  },
  enter() {
    TopArenas.refresh();
    Stats.refresh();
    this.render();
  },
  switchTab(tab) {
    this.currentTab = tab;
    document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    this.render();
  },
  refreshIfActive() {
    if (document.getElementById('lobbyScreen').classList.contains('active') && this.currentTab === 'waiting') this.render();
  },
  render() {
    const el = document.getElementById('lobbyTabContent');
    if (!el) return;
    if (this.currentTab === 'create') {
      el.innerHTML = `
        <div class="quickGrid">
          ${[
            {t:1,i:0,name:'Пуля'},{t:2,i:1,name:'Пуля'},
            {t:3,i:0,name:'Блиц'},{t:3,i:2,name:'Блиц'},{t:5,i:0,name:'Блиц'},{t:5,i:3,name:'Блиц'},
            {t:10,i:0,name:'Рапид'},{t:10,i:5,name:'Рапид'},{t:15,i:10,name:'Рапид'},
            {t:30,i:0,name:'Классика'},{t:30,i:20,name:'Классика'}
          ].map(({t,i,name}) =>
            `<button class="quickBtn" onclick="Lobby.quickStart(${t},${i})"><div class="qb-time">${t}+${i}</div><div class="qb-name">${name}</div></button>`
          ).join('')}
          <button class="quickBtn custom" onclick="Lobby.showCustom()"><div class="qb-time">Своя</div><div class="qb-name">игра</div></button>
        </div>
        <div id="customGamePanel" style="display:none; margin-top:14px; padding:14px; background:var(--panel-2); border-radius:6px;">
          <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
            <label style="color:var(--muted);font-size:13px;">Минуты:</label>
            <input id="customMin" type="number" value="5" min="1" max="60" style="width:70px;">
            <label style="color:var(--muted);font-size:13px;">Инкремент:</label>
            <input id="customInc" type="number" value="0" min="0" max="60" style="width:70px;">
            <button class="primary" onclick="Lobby.createCustom()" style="padding:8px 18px;">Создать</button>
          </div>
        </div>`;
      return;
    }
    this.renderWaiting();
  },
  renderWaiting() {
    const el = document.getElementById('lobbyTabContent');
    App.socket.emit('getLobbies', (list) => {
      el.innerHTML = '';
      const current = new Map();
      if (list && list.length) for (const l of list) if (l.status === 'waiting') current.set(l.id, l);
      const now = Date.now();
      for (const [id, data] of this.known) if (!current.has(id)) this.disappeared.set(id, { data, removedAt: now + 5000 });
      this.known = current;
      for (const [id, info] of this.disappeared) if (Date.now() > info.removedAt) this.disappeared.delete(id);
      const allItems = [];
      for (const [id, l] of current) allItems.push({ kind: 'waiting', id, data: l });
      for (const [id, info] of this.disappeared) allItems.push({ kind: 'started', id, data: info.data });
      if (!allItems.length) {
        el.innerHTML = `
          <div class="lobbyHeader">
            <div></div><div class="hRating">Рейтинг</div><div>Игрок</div><div class="hTime">Время</div><div class="hMode">Режим</div>
          </div>
          <div class="arenaEmpty" style="padding:30px 20px;">Нет активных вызовов. Нажми «Создать запрос на игру» справа.</div>`;
        return;
      }
      allItems.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'started' ? -1 : 1;
        return (b.data.time || 0) - (a.data.time || 0);
      });
      const header = document.createElement('div');
      header.className = 'lobbyHeader';
      header.innerHTML = `<div></div><div class="hRating">Рейтинг</div><div>Игрок</div><div class="hTime">Время</div><div class="hMode">Режим</div>`;
      el.appendChild(header);
      const wrap = document.createElement('div'); wrap.className = 'lobbyList';
      for (const item of allItems) {
        const l = item.data;
        const isMine = App.me && l.host === App.me.username;
        const row = document.createElement('div');
        const isStarted = item.kind === 'started';
        row.className = 'lobbyRow' + (isMine && !isStarted ? ' mine' : '') + (isStarted ? ' started' : '');
        const circleCls = isStarted ? 'white' : 'black';
        const rating = l.hostRating || '';
        const modeName = 'Рейтинговая';
        const modeIcon = '♟';
        if (isStarted) {
          row.innerHTML = `
            <div class="lColor ${circleCls}"></div>
            <div class="lRating muted">—</div>
            <div class="lName">${Utils.nickHtml(l.host, l.hostIsAdmin, l.hostIsMod)}<span class="mineTag">(началась)</span></div>
            <div class="lTime">${l.time}+${l.inc}</div>
            <div class="lMode"><span class="modeIcon">${modeIcon}</span>${modeName}</div>`;
        } else {
          row.title = isMine ? 'Нажми, чтобы отменить свой вызов' : 'Нажми, чтобы начать партию';
          row.innerHTML = `
            <div class="lColor ${circleCls}"></div>
            <div class="lRating muted">${rating || '—'}</div>
            <div class="lName">${Utils.nickHtml(l.host, l.hostIsAdmin, l.hostIsMod, l.isBot)}${isMine ? '<span class="mineTag">(ваш)</span>' : ''}</div>
            <div class="lTime">${l.time}+${l.inc}</div>
            <div class="lMode"><span class="modeIcon">${modeIcon}</span>${modeName}</div>`;
          row.onclick = () => this.onRowClick(l, isMine);
        }
        wrap.appendChild(row);
      }
      el.appendChild(wrap);
      if (this.disappeared.size) setTimeout(() => { if (this.currentTab === 'waiting') this.render(); }, 5200);
    });
  },
  onRowClick(l, isMine) {
    if (isMine) {
      App.socket.emit('cancelLobby', { id: l.id }, () => this.render());
      return;
    }
    App.socket.emit('joinLobby', { id: l.id }, (r) => {
      if (!r || !r.ok) { alert((r && r.msg) || 'Ошибка'); return; }
      App.lobbyId = r.id || l.id;
    });
  },
  quickStart(time, inc) {
    App.socket.emit('createLobby', { time, inc }, (res) => {
      if (!res || !res.ok) { alert((res && res.msg) || 'Ошибка'); return; }
      if (res.matched) { App.lobbyId = res.id; return; }
      App.lobbyId = res.id;
      App.myColor = 'w';
      App.currentFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      App.gameActive = false;
      App.gameEnded = false;
      App.opponentName = '—';
      App.opponentRating = null;
      App.opponentIsAdmin = false;
      App.opponentIsBot = false;
      App.isBotGame = false;
      App.currentGameIsArena = false;
      App.currentArenaName = null;
      Game.reset();
      Game.resetUI();
      Game.hideResultBar();
      Router.go('game');
      Game.renderBoard();
      Game.renderMoves();
      const bar = document.getElementById('statusBar');
      bar.className = 'statusGreen';
      bar.textContent = 'Ожидание соперника...';
    });
  },
  showCustom() {
    const p = document.getElementById('customGamePanel');
    if (p) p.style.display = p.style.display === 'none' ? 'block' : 'none';
  },
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
  init() {
    const dlg = document.getElementById('botDialog');
    if (dlg) dlg.addEventListener('click', (e) => { if (e.target === dlg) this.closeDialog(); });
  },
  openDialog() {
    const dlg = document.getElementById('botDialog');
    if (!dlg) return;
    App.socket.emit('getBots', (list) => {
      if (Array.isArray(list)) {
        App.botLevels = list.map(b => ({
          level: b.level, name: b.name, title: b.title, desc: b.desc || '',
          rating: b.rating, initialRating: b.initialRating,
          games: b.games || 0, wins: b.wins || 0, losses: b.losses || 0, draws: b.draws || 0,
          isMaster: b.level === 4
        }));
      }
      this.render();
      dlg.classList.add('show');
    });
  },
  closeDialog() {
    const dlg = document.getElementById('botDialog');
    if (dlg) dlg.classList.remove('show');
  },
  render() {
    const levelsEl = document.getElementById('botLevels');
    const timesEl = document.getElementById('botTimes');
    if (!levelsEl || !timesEl) return;
    if (!App.botLevels.length) {
      App.socket.emit('getBots', (list) => {
        if (Array.isArray(list)) {
          App.botLevels = list.map(b => ({
            level: b.level, name: b.name, title: b.title, desc: b.desc || '',
            rating: b.rating, initialRating: b.initialRating,
            games: b.games || 0, wins: b.wins || 0, losses: b.losses || 0, draws: b.draws || 0,
            isMaster: b.level === 4
          }));
          this.render();
        }
      });
      return;
    }
    const st = App.botDialogState;
    levelsEl.innerHTML = App.botLevels.map(l => {
      const active = st.level === l.level;
      const cls = active ? 'active' : '';
      const extra = l.isMaster ? 'masterBtn' : '';
      const delta = l.rating - l.initialRating;
      const deltaStr = (delta !== 0 && l.games > 0)
        ? ` <span style="font-size:10px;color:${delta > 0 ? '#6ee787' : '#ff7b7b'}">(${delta > 0 ? '+' : ''}${delta})</span>`
        : '';
      return `<button data-level="${l.level}" class="${cls} ${extra}">
        <div class="btitle">${l.title}${deltaStr}</div>
        <div class="brating">${l.rating}${l.games ? ` · ${l.games} партий` : ''}</div>
      </button>`;
    }).join('');
    timesEl.innerHTML = App.botTimes.map(t => {
      const active = st.time === t.t && st.inc === t.i;
      return `<button data-t="${t.t}" data-i="${t.i}" class="${active ? 'active' : ''}">${t.label}</button>`;
    }).join('');
    levelsEl.querySelectorAll('button').forEach(b => b.onclick = () => {
      App.botDialogState.level = +b.dataset.level; this.render();
    });
    timesEl.querySelectorAll('button').forEach(b => b.onclick = () => {
      App.botDialogState.time = +b.dataset.t;
      App.botDialogState.inc = +b.dataset.i;
      this.render();
    });
  },
  startGame() {
    const bot = App.botLevels.find(b => b.level === App.botDialogState.level);
    if (!bot) return;
    App.socket.emit('playWithBot', {
      time: App.botDialogState.time,
      inc: App.botDialogState.inc,
      botName: bot.name
    }, (res) => {
      if (!res || !res.ok) { alert((res && res.msg) || 'Ошибка'); return; }
      this.closeDialog();
    });
  }
};

// ============================================================
// WATCH
// ============================================================
const Watch = {
  watchingGameId: null,
  watchingGame: null,
  lastHash: '',
  lastBoardHash: '',
  watchClockHandle: null,
  watchClockSyncedAt: 0,
  watchClockW: 0, watchClockB: 0, watchClockTurn: 'w',
  requestId: 0,

  init() {},
  enter(gameId) {
    this.refresh(true);
    if (gameId) this.watch(gameId);
  },
  refresh(force) {
    App.socket.emit('getLiveGames', (list) => {
      const box = document.getElementById('watchListBody');
      if (!box) return;
      const hash = JSON.stringify(list);
      if (hash === this.lastHash && !force) return;
      this.lastHash = hash;
      if (!list || !list.length) {
        box.innerHTML = '<div class="arenasEmpty" style="padding:20px 10px;">Пока никто не играет</div>';
        return;
      }
      box.innerHTML = list.map(g => {
        const cls = 'watchRow' + (g.isArena ? ' isArena' : '');
        const arenaTag = g.isArena ? ` · ${Utils.escapeHtml(g.arenaName || 'турнир')}` : '';
        return `<div class="${cls}" onclick="Watch.watch('${g.id}')">
          <div class="wrPlayers"><span><span class="liveDot"></span>⚪ ${Utils.nickHtml(g.white, g.whiteIsAdmin, g.whiteIsMod)}${g.whiteRating ? ' <span class="prat">('+g.whiteRating+')</span>' : ''}</span><span>${Utils.formatTime(g.timeW)}</span></div>
          <div class="wrPlayers"><span>⚫ ${Utils.nickHtml(g.black, g.blackIsAdmin, g.blackIsMod)}${g.blackRating ? ' <span class="prat">('+g.blackRating+')</span>' : ''}</span><span>${Utils.formatTime(g.timeB)}</span></div>
          <div class="wrMeta"><span>${g.timeControl}+${g.increment}${arenaTag}</span><span>ход: <b>${g.turn === 'w' ? 'белые' : 'чёрные'}</b> ${Utils.watchersHtml(g.watchersCount)}</span></div>
        </div>`;
      }).join('');
    });
  },
  watch(id) {
    if (this.watchingGameId === id) {
      if (Router.current.name !== 'watch') Router.go('watch', id);
      return;
    }
    if (this.watchingGameId) App.socket.emit('unwatchGame', { id: this.watchingGameId });
    this.watchingGameId = id;
    this.watchingGame = null;
    this.lastBoardHash = '';
    if (Router.current.name !== 'watch') {
      Router.go('watch', id);
      return;
    }
    const reqId = ++this.requestId;
    App.socket.emit('watchGame', { id }, (res) => {
      if (reqId !== this.requestId) return;
      if (!res || !res.ok) { alert((res && res.msg) || 'Не удалось начать просмотр'); this.watchingGameId = null; return; }
      this.watchingGame = res.game;
      this.lastBoardHash = '';
      this.renderBoard();
    });
  },
  stop() {
    if (this.watchingGameId) App.socket.emit('unwatchGame', { id: this.watchingGameId });
    this.watchingGameId = null;
    this.watchingGame = null;
    this.lastBoardHash = '';
    if (this.watchClockHandle) { cancelAnimationFrame(this.watchClockHandle); this.watchClockHandle = null; }
    this.renderBoard();
    if (Router.current.name === 'watch') Router.go('watch');
  },
  renderBoard() {
    const box = document.getElementById('watchBoardBox');
    if (!box) return;
    if (!this.watchingGame) {
      box.innerHTML = '<div class="wbEmpty">Выбери партию слева</div>';
      return;
    }
    const g = this.watchingGame;
    const state = Chess.parseFen(g.fen);
    // Доска зрителя не переворачивается автоматически — всегда белые снизу.
    const flip = false;
    const hash = g.id + '|' + g.fen + '|' + g.turn + '|' + flip + '|' + (g.watchersCount || 0) + '|' + (g.finished ? 'F' : 'A');
    if (hash === this.lastBoardHash) return;
    this.lastBoardHash = hash;
    const whiteActive = g.turn === 'w', blackActive = g.turn === 'b';
    let squares = '';
    for (let dr = 0; dr < 8; dr++) for (let dc = 0; dc < 8; dc++) {
      const r = flip ? 7 - dr : dr, c = flip ? 7 - dc : dc;
      const cls = 'sq ' + ((r + c) % 2 ? 'dark' : 'light');
      const p = state.board[r][c];
      let inner = '';
      if (p) { const isW = p === p.toUpperCase(); inner = `<span class="piece ${isW?'w':'b'}">${Chess.EMOJI[p]}</span>`; }
      let coords = '';
      if (dr === 7) coords += `<span class="coord-f">${String.fromCharCode(97 + c)}</span>`;
      if (dc === 0) coords += `<span class="coord-r">${8 - r}</span>`;
      squares += `<div class="${cls}">${inner}${coords}</div>`;
    }
    const finishedLine = g.finished
      ? `<div style="text-align:center; margin-top:10px; padding:8px 12px; background:rgba(98,153,36,.12); border-left:3px solid var(--green); border-radius:4px; color:var(--text-bright); font-size:13px;">✅ Партия завершена${g.reason ? ' · ' + Utils.escapeHtml(g.reason) : ''}</div>`
      : '';
    box.innerHTML = `
      <div class="wbHeader">
        <div style="min-width:0; flex:1">
          <div class="wbTitle">Партия ${g.isArena ? 'турнира' : ''}</div>
          <div class="wbSub">${g.timeControl}+${g.increment}${g.arenaName ? ' · '+Utils.escapeHtml(g.arenaName) : ''}</div>
        </div>
        <button class="secondary" onclick="Watch.stop()" style="flex-shrink:0">✕ Выйти</button>
      </div>
      <div class="wbPlayers">
        <div class="wbPlayer ${blackActive?'active':''}">
          <span style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
            <span class="name">⚫ ${Utils.nickHtml(g.black, g.blackIsAdmin, g.blackIsMod)}</span>${g.blackRating ? `<span class="rating">(${g.blackRating})</span>` : ''}
          </span>
          <span class="time" id="watchTimeB">${Utils.formatTime(g.timeB)}</span>
        </div>
        <div class="wbPlayer ${whiteActive?'active':''}">
          <span style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
            <span class="name">⚪ ${Utils.nickHtml(g.white, g.whiteIsAdmin, g.whiteIsMod)}</span>${g.whiteRating ? `<span class="rating">(${g.whiteRating})</span>` : ''}
          </span>
          <span class="time" id="watchTimeW">${Utils.formatTime(g.timeW)}</span>
        </div>
      </div>
      <div class="wbBoardWrap"><div class="wbBoard">${squares}</div></div>
      ${finishedLine}
      <div style="text-align:center; margin-top:8px; font-size:12px; color:var(--muted); ${g.watchersCount > 0 ? '' : 'display:none;'}">
        👁 Зрителей: <b style="color:var(--accent)">${g.watchersCount || 0}</b>
      </div>`;
    this.startClock();
  },
  startClock() {
    if (this.watchClockHandle) cancelAnimationFrame(this.watchClockHandle);
    this.watchClockSyncedAt = performance.now();
    if (this.watchingGame) {
      this.watchClockW = this.watchingGame.timeW;
      this.watchClockB = this.watchingGame.timeB;
      this.watchClockTurn = this.watchingGame.turn;
    }
    const self = this;
    function tick() {
      if (!self.watchingGame) { self.watchClockHandle = null; return; }
      const elapsed = (performance.now() - self.watchClockSyncedAt) / 1000;
      let w = self.watchClockW, b = self.watchClockB;
      if (self.watchClockTurn === 'w') w = Math.max(0, w - elapsed);
      else b = Math.max(0, b - elapsed);
      const elW = document.getElementById('watchTimeW');
      const elB = document.getElementById('watchTimeB');
      if (elW) elW.textContent = Utils.formatTime(w);
      if (elB) elB.textContent = Utils.formatTime(b);
      self.watchClockHandle = requestAnimationFrame(tick);
    }
    this.watchClockHandle = requestAnimationFrame(tick);
  },
  onWatchersUpdate(lobbyId, count) {
    if (this.watchingGame && this.watchingGame.id === lobbyId) {
      this.watchingGame.watchersCount = count;
      this.lastBoardHash = '';
      this.renderBoard();
    }
    if (document.getElementById('watchScreen').classList.contains('active')) this.refresh(false);
  },
  onBoardUpdate({ lobbyId, fen, turn, san }) {
    if (!this.watchingGame || this.watchingGame.id !== lobbyId) return;
    this.watchingGame.fen = fen;
    if (turn) this.watchingGame.turn = turn;
    this.lastBoardHash = '';
    this.renderBoard();
  },
  onTimeUpdate({ lobbyId, timeW, timeB, serverNow }) {
    if (!this.watchingGame || this.watchingGame.id !== lobbyId) return;
    this.watchingGame.timeW = timeW;
    this.watchingGame.timeB = timeB;
    this.watchClockSyncedAt = performance.now();
    this.watchClockW = timeW;
    this.watchClockB = timeB;
    // turn мог не прийти — оставляем текущий
  },
  onGameEnded({ lobbyId, result, reason }) {
    if (!this.watchingGame || this.watchingGame.id !== lobbyId) return;
    this.watchingGame.finished = true;
    this.watchingGame.result = result;
    this.watchingGame.reason = reason;
    this.lastBoardHash = '';
    this.renderBoard();
    this.refresh(false);
  },
  onChatMessage(msg) {
    // Чат зрителям сервер не рассылает в watch-комнату — заглушка на будущее.
    if (!this.watchingGame || this.watchingGame.id !== msg.lobbyId) return;
  }
};

// ============================================================
// ARENA
// ============================================================
const Arena = {
  cache: [],
  statesCache: {},
  serverOffsetMs: 0,
  currentArenaId: null,
  currentArenaState: null,
  lastListHash: '',
  lastStateHash: '',
  lastGamesHash: '',
  loadBusy: false,
  pageRefreshHandle: null,
  statusTickHandle: null,
  gamesRefreshHandle: null,
  refreshHandle: null,

  init() {},
  enterList() {
    this.refresh(true);
  },
  enterPage(arenaId) {
    if (!arenaId) { Router.go('arenas'); return; }
    if (this.currentArenaId && this.currentArenaId !== arenaId) {
      App.socket.emit('leaveArenaRoom', { arenaId: this.currentArenaId });
    }
    this.currentArenaId = arenaId;
    document.getElementById('arenaChatMessages').innerHTML = '';
    this.lastStateHash = ''; this.lastGamesHash = '';
    App.socket.emit('joinArenaRoom', { arenaId }, (res) => {
      if (res && res.ok && Array.isArray(res.chat)) {
        const box = document.getElementById('arenaChatMessages');
        box.innerHTML = '';
        res.chat.forEach(m => this.renderChatMsg(m));
      }
    });
    this.loadPage();
    if (this.pageRefreshHandle) clearInterval(this.pageRefreshHandle);
    this.pageRefreshHandle = setInterval(() => {
      if (document.getElementById('arenaPageScreen').classList.contains('active')) this.loadPage();
    }, 5000);
    if (this.statusTickHandle) clearInterval(this.statusTickHandle);
    this.statusTickHandle = setInterval(() => this.tickStatus(), 1000);
    if (this.gamesRefreshHandle) clearInterval(this.gamesRefreshHandle);
    this.gamesRefreshHandle = setInterval(() => {
      if (document.getElementById('arenaPageScreen').classList.contains('active')) this.renderGamesList();
    }, 3000);
  },
  leaveRoom() {
    if (this.currentArenaId) {
      App.socket.emit('leaveArenaRoom', { arenaId: this.currentArenaId });
      this.currentArenaId = null;
    }
    if (this.pageRefreshHandle) { clearInterval(this.pageRefreshHandle); this.pageRefreshHandle = null; }
    if (this.statusTickHandle) { clearInterval(this.statusTickHandle); this.statusTickHandle = null; }
    if (this.gamesRefreshHandle) { clearInterval(this.gamesRefreshHandle); this.gamesRefreshHandle = null; }
  },
  refresh(force) {
    if (!force && !document.getElementById('arenasScreen').classList.contains('active')) return;
    App.socket.emit('getArenas', (res) => {
      const list = (res && res.list) || [];
      const serverNow = (res && res.serverNow) || Date.now();
      this.serverOffsetMs = serverNow - Date.now();
      this.cache = list;
      App.socket.emit('getMyArenaStates', (r2) => {
        this.statesCache = (r2 && r2.states) || {};
        if (r2 && r2.serverNow) this.serverOffsetMs = r2.serverNow - Date.now();
        const hash = JSON.stringify(this.cache) + '|' + JSON.stringify(this.statesCache);
        if (hash === this.lastListHash && !force) return;
        this.lastListHash = hash;
        this.renderGrid();
      });
    });
    if (this.refreshHandle) clearInterval(this.refreshHandle);
    this.refreshHandle = setInterval(() => {
      if (!document.getElementById('arenasScreen').classList.contains('active')) return;
      App.socket.emit('getArenas', (res) => {
        const list = (res && res.list) || [];
        const serverNow = (res && res.serverNow) || Date.now();
        this.serverOffsetMs = serverNow - Date.now();
        this.cache = list;
        App.socket.emit('getMyArenaStates', (r2) => {
          this.statesCache = (r2 && r2.states) || {};
          const hash = JSON.stringify(this.cache) + '|' + JSON.stringify(this.statesCache);
          if (hash === this.lastListHash) return;
          this.lastListHash = hash;
          this.renderGrid();
        });
      });
    }, 30000);
  },
  renderGrid() {
    const wrap = document.getElementById('arenasGridWrap');
    if (!wrap) return;
    if (!this.cache || !this.cache.length) {
      wrap.innerHTML = '<div class="arenasEmpty">Нет доступных арен</div>';
      return;
    }
    const localNow = Date.now();
    const toClient = (ts) => ts - this.serverOffsetMs;
    const isMobile = window.matchMedia('(max-width: 700px)').matches;
    const SLOT_PX = isMobile ? 60 : 90;
    const SLOT_MS = 10 * 60 * 1000;
    const COLS = isMobile ? 48 : 72;
    const startMs = Math.floor(localNow / SLOT_MS) * SLOT_MS;
    const endMs = startMs + COLS * SLOT_MS;
    window.__arenaStartMs = startMs;
    window.__arenaSlotPx = SLOT_PX;
    const toPx = (ts) => ((ts - startMs) / SLOT_MS) * SLOT_PX;
    const visible = this.cache
      .map(a => ({ ...a, clientStartsAt: toClient(a.startsAt), clientEndsAt: toClient(a.endsAt) }))
      .filter(a => a.clientEndsAt > startMs && a.clientStartsAt < endMs)
      .sort((a, b) => a.clientStartsAt - b.clientStartsAt);
    const rows = [];
    for (const arena of visible) {
      let placed = false;
      for (const row of rows) {
        const last = row[row.length - 1];
        if (last.clientEndsAt <= arena.clientStartsAt) { row.push(arena); placed = true; break; }
      }
      if (!placed) rows.push([arena]);
    }
    const rowWidth = COLS * SLOT_PX;
    let html = '<div class="arenasScroller"><div class="timeRow" style="width:' + rowWidth + 'px;">';
    for (let i = 0; i < COLS; i++) {
      const t = startMs + i * SLOT_MS;
      const isNow = t <= localNow && localNow < t + SLOT_MS;
      html += '<div class="timeCell' + (isNow ? ' now' : '') + '" style="width:' + SLOT_PX + 'px;min-width:' + SLOT_PX + 'px;">' + Utils.fmtMskHM(t) + '</div>';
    }
    html += '</div>';
    for (const row of rows) {
      html += '<div class="arenaRowGrid" style="width:' + rowWidth + 'px;">';
      for (const arena of row) {
        const left = toPx(arena.clientStartsAt);
        const width = toPx(arena.clientEndsAt) - left;
        const isPast = arena.clientEndsAt < localNow;
        const isLive = arena.status === 'live';
        const colorClass = arena.color || 'blitz';
        const myState = this.statesCache[arena.id];
        const joined = myState && myState.joined;
        const cls = 'arenaBlock ' + colorClass + (isPast && !isLive ? ' past' : '') + (isLive ? ' live' : '') + (joined ? ' joined' : '') + (arena.botFriendly ? ' botFriendly' : '');
        const tinfo = arena.timeControl + '+' + arena.increment;
        const participantsCount = (myState && myState.participantsCount) || 0;
        const showInfo = width >= 50;
        const dur = Math.round((arena.clientEndsAt - arena.clientStartsAt) / 60000);
        const botMark = arena.botFriendly ? '🤖 ' : '';
        html += '<div class="' + cls + '" '
              + 'style="left:' + left.toFixed(2) + 'px; width:' + width.toFixed(2) + 'px; cursor:pointer" '
              + 'onclick="Router.go(\'arenaPage\', \'' + Utils.escapeHtml(arena.id) + '\')" '
              + 'title="' + Utils.escapeHtml(botMark + arena.name) + ' · ' + tinfo + ' · ' + Utils.fmtMskHM(arena.clientStartsAt) + '–' + Utils.fmtMskHM(arena.clientEndsAt) + ' МСК (' + dur + ' мин)">'
              + '<div class="tname">' + botMark + Utils.escapeHtml(arena.name) + '</div>'
              + (showInfo ? '<div class="tinfo"><span>' + tinfo + '</span><span>👥 ' + participantsCount + '</span></div>' : '')
              + '</div>';
      }
      html += '</div>';
    }
    const nowLeft = toPx(localNow);
    html += '<div class="nowLine" style="left:' + nowLeft.toFixed(2) + 'px;"></div></div>';
    wrap.innerHTML = html;
    const scroller = wrap.querySelector('.arenasScroller');
    if (scroller) scroller.scrollLeft = Math.max(0, nowLeft - scroller.clientWidth / 4);
  },
  loadPage() {
    if (!this.currentArenaId || this.loadBusy) return;
    this.loadBusy = true;
    const arena = this.cache.find(a => a.id === this.currentArenaId);
    if (!arena) {
      App.socket.emit('getArenas', (res) => {
        this.cache = (res && res.list) || [];
        if (res && res.serverNow) this.serverOffsetMs = res.serverNow - Date.now();
        this.loadBusy = false;
        if (this.cache.find(x => x.id === this.currentArenaId)) this.loadPage();
      });
      return;
    }
    App.socket.emit('getArenaState', { arenaId: this.currentArenaId }, (state) => {
      this.loadBusy = false;
      this.currentArenaState = state;
      if (state.serverNow) this.serverOffsetMs = state.serverNow - Date.now();
      this.renderPage(arena, state);
      this.updateJoinButton(state);
      this.renderPairingBox(state);
      const stateHash = JSON.stringify(state.participants) + '|' + state.paused + '|' + state.phase;
      if (stateHash !== this.lastStateHash) {
        this.lastStateHash = stateHash;
        this.renderParticipants(arena, state);
      }
      this.tickStatus();
    });
  },
  tickStatus() {
    if (!this.currentArenaId) return;
    const row = document.getElementById('arenaStatusRow');
    const lbl = document.getElementById('arenaStatusLabel');
    const time = document.getElementById('arenaStatusTime');
    if (!row || !lbl || !time) return;
    const state = this.currentArenaState;
    if (!state) return;
    const serverNow = Date.now() + this.serverOffsetMs;
    row.classList.remove('live', 'finished');
    if (state.phase === 'finished') {
      row.classList.add('finished');
      lbl.textContent = 'Завершена:'; time.textContent = '00:00';
      return;
    }
    if (state.phase === 'waiting') {
      lbl.textContent = 'До начала:';
      time.textContent = Utils.formatMMSS(Math.max(0, state.startsAt - serverNow));
      return;
    }
    if (state.phase === 'live') {
      row.classList.add('live');
      lbl.textContent = 'До конца:';
      time.textContent = Utils.formatMMSS(Math.max(0, state.endsAt - serverNow));
      return;
    }
  },
  renderPage(arena, state) {
    document.getElementById('arenaPageName').textContent = arena.name;
    const phaseText = { 'waiting':'Начало в '+Utils.fmtMskHM(arena.startsAt)+' МСК', 'live':'Идёт сейчас', 'finished':'Завершена' }[state.phase] || '';
    document.getElementById('arenaPageSub').textContent = `${arena.timeControl}+${arena.increment} · ${phaseText}`;
    document.getElementById('aInfoTitle').textContent = arena.name;
    document.getElementById('aInfoTime').textContent = Utils.fmtMskHM(arena.startsAt) + ' – ' + Utils.fmtMskHM(arena.endsAt) + ' МСК';
    document.getElementById('aInfoDesc').textContent = arena.description;
    if (state.top3 && state.top3.length) this.showWinnerBanner(state.top3);
    else document.getElementById('arenaWinnerBanner').style.display = 'none';
  },
  updateJoinButton(state) {
    const wrap = document.getElementById('arenaJoinBtnWrap');
    if (state.phase === 'finished') {
      wrap.innerHTML = `<button class="secondary" disabled style="width:180px;">ЗАВЕРШЕНА</button>`;
      return;
    }
    if (state.phase === 'waiting') {
      if (state.joined) wrap.innerHTML = `<button class="secondary arenaJoinBtn" onclick="Arena.leaveCurrent()">ОТМЕНИТЬ</button>`;
      else wrap.innerHTML = `<button class="primary arenaJoinBtn" onclick="Arena.joinCurrent()">УЧАСТВОВАТЬ</button>`;
      return;
    }
    if (state.joined) {
      if (state.paused) wrap.innerHTML = `<button class="primary arenaJoinBtn" onclick="Arena.pauseCurrent()">▶ ПРОДОЛЖИТЬ</button>`;
      else wrap.innerHTML = `<button class="secondary arenaJoinBtn" onclick="Arena.pauseCurrent()">⏸ ПАУЗА</button>`;
    } else {
      wrap.innerHTML = `<button class="primary arenaJoinBtn" onclick="Arena.joinCurrent()">УЧАСТВОВАТЬ</button>`;
    }
  },
  renderPairingBox(state) {
    const box = document.getElementById('arenaPairingBox');
    if (!box) return;
    if (state.phase !== 'live') { box.style.display = 'none'; return; }
    if (!state.joined) {
      box.style.display = 'flex'; box.classList.remove('searching');
      box.innerHTML = `<span>Нажмите «УЧАСТВОВАТЬ» для жеребьёвки.</span>`;
      return;
    }
    if (state.paused) {
      box.style.display = 'flex'; box.classList.remove('searching');
      box.innerHTML = `<span>⏸ – Вы на паузе.</span>`;
      return;
    }
    if (state.pairingNow) {
      box.style.display = 'flex'; box.classList.add('searching');
      box.innerHTML = `<div class="spinner"></div><span>Идёт жеребьёвка: <b>${Utils.escapeHtml(state.pairingNow)}</b></span>`;
      return;
    }
    box.style.display = 'flex'; box.classList.add('searching');
    box.innerHTML = `<div class="spinner"></div><span>Ожидайте, идёт жеребьёвка…</span>`;
  },
  renderParticipants(arena, state) {
    const body = document.getElementById('arenaTableBody');
    const list = state.participants || [];
    if (!list.length) {
      body.innerHTML = '<div class="arenasEmpty" style="padding:20px;">Пока никто не зарегистрировался</div>';
      return;
    }
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
  filterParticipants() {
    if (this.currentArenaState && this.currentArenaId) {
      const arena = this.cache.find(a => a.id === this.currentArenaId);
      if (arena) this.renderParticipants(arena, this.currentArenaState);
    }
  },
  renderGamesList() {
    const topEl = document.getElementById('arenaTopGame');
    const listEl = document.getElementById('arenaGamesList');
    if (!topEl || !listEl) return;
    App.socket.emit('getArenaGames', { arenaId: this.currentArenaId }, (res) => {
      if (!res || typeof res !== 'object') return;
      const live = res.live || [], done = res.done || [];
      const pcEl = document.getElementById('arenaParticipantsCount');
      const vcEl = document.getElementById('arenaViewersCount');
      if (pcEl) pcEl.textContent = res.participantsCount || 0;
      if (vcEl) vcEl.textContent = res.chatViewersCount || 0;
      const hash = JSON.stringify({ live: live.map(g => [g.lobbyId, g.fen, g.timeW, g.timeB]), done: done.slice(0, 30).map(g => [g.white, g.black, g.result, g.finishedAt]) });
      if (hash === this.lastGamesHash) return;
      this.lastGamesHash = hash;
      if (live.length) {
        const g = live[0];
        topEl.innerHTML = this.renderTopGame(g);
        const link = topEl.querySelector('.arenaTopGameLink');
        if (link) link.onclick = () => Watch.watch(g.lobbyId);
      } else {
        topEl.innerHTML = '<div class="arenaTopGameEmpty">Сейчас никто не играет</div>';
      }
      if (!done.length) {
        listEl.innerHTML = '<div class="arenasEmpty" style="padding:20px 10px;">Пока нет партий</div>';
        return;
      }
      listEl.innerHTML = done.slice(0, 50).map(g => {
        const resChar = g.result === 'w' ? '1-0' : (g.result === 'b' ? '0-1' : '½-½');
        const resCls = g.result === 'draw' ? 'd' : 'w';
        const dateStr = Utils.fmtMskHM(g.finishedAt);
        const wR = g.whiteRating ? `<span class="rating"> ${g.whiteRating}</span>` : '';
        const bR = g.blackRating ? `<span class="rating"> ${g.blackRating}</span>` : '';
        return `<div class="arenaGameCard"><div class="row1"><span class="name">⚪ ${Utils.nickHtml(g.white, g.whiteIsAdmin, g.whiteIsMod)}${wR}</span><span class="res ${resCls}">${resChar}</span></div><div class="row1"><span class="name">⚫ ${Utils.nickHtml(g.black, g.blackIsAdmin, g.blackIsMod)}${bR}</span></div><div class="row2"><span>завершена</span><span>${dateStr}</span></div></div>`;
      }).join('');
    });
  },
  renderTopGame(g) {
    const state = Chess.parseFen(g.fen);
    let squares = '';
    for (let dr = 0; dr < 8; dr++) for (let dc = 0; dc < 8; dc++) {
      const cls = 'sq ' + ((dr + dc) % 2 ? 'dark' : 'light');
      const p = state.board[dr][dc];
      let inner = '';
      if (p) { const isW = p === p.toUpperCase(); inner = `<span class="piece ${isW ? 'w' : 'b'}">${Chess.EMOJI[p]}</span>`; }
      squares += `<div class="${cls}">${inner}</div>`;
    }
    const whiteActive = g.turn === 'w', blackActive = g.turn === 'b';
    const wR = g.whiteRating ? `<span class="prat">${g.whiteRating}</span>` : '';
    const bR = g.blackRating ? `<span class="prat">${g.blackRating}</span>` : '';
    return `<div class="arenaTopGamePlayers"><span class="playerRow">⚫ <span class="name">${Utils.nickHtml(g.black, g.blackIsAdmin, g.blackIsMod)}</span>${bR}</span><span class="time" style="${blackActive ? 'color:var(--green-2);' : ''}">${Utils.formatTime(g.timeB)}</span></div><div class="arenaTopGameBoard">${squares}</div><div class="arenaTopGamePlayers"><span class="playerRow">⚪ <span class="name">${Utils.nickHtml(g.white, g.whiteIsAdmin, g.whiteIsMod)}</span>${wR}</span><span class="time" style="${whiteActive ? 'color:var(--green-2);' : ''}">${Utils.formatTime(g.timeW)}</span></div><div class="arenaTopGameLink">▶ – Смотреть партию</div>`;
  },
  showWinnerBanner(top3) {
    const banner = document.getElementById('arenaWinnerBanner');
    const podium = document.getElementById('awbPodium');
    const medals = ['gold','silver','bronze'], places = ['🥇','🥈','🥉'];
    const order = top3.length >= 3 ? [1,0,2] : top3.map((_,i)=>i);
    podium.innerHTML = order.map(i => {
      const p = top3[i]; if (!p) return '';
      return `<div class="awbItem ${medals[i]}"><div class="place">${places[i]}</div><div class="n">${Utils.nickHtml(p.username, p.username === 'PeshkaSasha')}</div><div class="s">${p.score}</div></div>`;
    }).join('');
    banner.style.display = 'block';
  },
  joinCurrent() {
    if (!this.currentArenaId) return;
    App.socket.emit('joinArena', { arenaId: this.currentArenaId }, (res) => {
      if (!res || !res.ok) { alert((res && res.msg) || 'Ошибка'); return; }
      this.lastStateHash = ''; this.lastGamesHash = '';
      this.loadPage();
      this.refresh(true);
      this.renderGamesList();
    });
  },
  pauseCurrent() {
    if (!this.currentArenaId) return;
    App.socket.emit('pauseArena', { arenaId: this.currentArenaId }, (res) => {
      if (!res || !res.ok) { alert((res && res.msg) || 'Ошибка'); return; }
      this.lastStateHash = '';
      this.loadPage();
      this.refresh(true);
    });
  },
  leaveCurrent() {
    if (!this.currentArenaId) return;
    if (!confirm('Отменить участие?')) return;
    App.socket.emit('leaveArena', { arenaId: this.currentArenaId }, (res) => {
      if (!res || !res.ok) { alert((res && res.msg) || 'Ошибка'); return; }
      this.lastStateHash = '';
      this.loadPage();
      this.refresh(true);
    });
  },
  sendChat(e) {
    e.preventDefault();
    const input = document.getElementById('arenaChatInput');
    const text = input.value.trim();
    if (!text || !this.currentArenaId) return;
    App.socket.emit('arenaChat', { arenaId: this.currentArenaId, text });
    input.value = '';
  },
  onChatMessage(msg) {
    if (this.currentArenaId && msg.arenaId === this.currentArenaId) this.renderChatMsg(msg);
  },
  renderChatMsg(msg) {
    const box = document.getElementById('arenaChatMessages');
    if (!box) return;
    const div = document.createElement('div');
    if (msg.system) {
      div.className = 'msg sys'; div.textContent = msg.text;
    } else {
      div.className = 'msg'; div.dataset.msgId = msg.id || '';
      const time = Utils.fmtMskHM(msg.ts);
      let modHtml = '';
      if (App.me && App.me.isMod) modHtml = `<span class="modBtn always" title="Модерация" style="cursor:pointer;color:var(--muted);margin-left:6px;">⚙</span>`;
      div.innerHTML = `<span class="u">${Utils.nickHtml(msg.user, msg.userIsAdmin, msg.userIsMod)}:</span> ${Utils.escapeHtml(msg.text)} <span class="t">${time}</span>${modHtml}`;
      if (App.me && App.me.isMod) {
        const btn = div.querySelector('.modBtn');
        if (btn) btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          Mod.openMenu(ev, msg.id, msg.user, 'arena', this.currentArenaId);
        });
      }
    }
    box.appendChild(div);
    while (box.children.length > 200) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  },
  onUpdate(arenaId) {
    if (this.currentArenaId === arenaId) {
      this.lastStateHash = ''; this.lastGamesHash = '';
      if (document.getElementById('arenaPageScreen').classList.contains('active')) {
        this.loadPage();
        this.renderGamesList();
      }
    }
    if (document.getElementById('arenasScreen').classList.contains('active')) this.refresh();
    if (document.getElementById('lobbyScreen').classList.contains('active')) TopArenas.refresh();
  },
  onFinished(arenaId, top3) {
    if (this.currentArenaId === arenaId) {
      this.lastStateHash = ''; this.lastGamesHash = '';
      if (document.getElementById('arenaPageScreen').classList.contains('active')) {
        this.loadPage();
        this.renderGamesList();
      }
      if (top3 && top3.length) this.showWinnerBanner(top3);
    }
    if (document.getElementById('arenasScreen').classList.contains('active')) this.refresh();
    if (document.getElementById('lobbyScreen').classList.contains('active')) TopArenas.refresh();
  }
};

// ============================================================
// PROFILE
// ============================================================
const Profile = {
  gamesVisible: false,
  init() {},
  enter(username) {
    const target = username || (App.me && App.me.username);
    if (!target) return;
    App.profileViewing = target;
    this.gamesVisible = false;
    const wrap = document.getElementById('profileGamesWrap');
    const btn = document.getElementById('showGamesBtn');
    if (wrap) wrap.classList.add('profileGamesHidden');
    if (btn) btn.textContent = '📜 Показать партии';
    App.socket.emit('getProfile', { username: target }, (res) => {
      if (!res || !res.ok) { alert((res && res.msg) || 'Ошибка'); return; }
      this.render(res.user, res.games, res.history, res.categoryHistory);
    });
  },
  toggleGames() {
    this.gamesVisible = !this.gamesVisible;
    const wrap = document.getElementById('profileGamesWrap');
    const btn = document.getElementById('showGamesBtn');
    if (this.gamesVisible) {
      wrap.classList.remove('profileGamesHidden');
      btn.textContent = '📜 Скрыть партии';
    } else {
      wrap.classList.add('profileGamesHidden');
      btn.textContent = '📜 Показать партии';
    }
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
    if (user.mutedUntil && user.mutedUntil > Date.now()) {
      const mins = Math.ceil((user.mutedUntil - Date.now())/60000);
      badges.push(`<span class="muteBadge">🔇 – Мут ${mins} мин</span>`);
    }
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
        { key:'classical', name:'Классика', icon:'🐢' },
        { key:'rapid', name:'Рапид', icon:'⏱' },
        { key:'blitz', name:'Блиц', icon:'⚡' },
        { key:'bullet', name:'Пуля', icon:'🔫' }
      ];
      catEl.innerHTML = cats.map(c => {
        const r = user.categories[c.key] || { rating:user.rating, games:0 };
        return `<div class="catCard ${c.key}"><div class="catIcon">${c.icon}</div><div class="catName">${c.name}</div><div class="catRating">${r.rating}</div><div style="font-size:11px;color:var(--muted);margin-top:2px;">${r.games||0} партий</div></div>`;
      }).join('');
    } else catEl.innerHTML = '';
    this.renderChart(history, categoryHistory || games, user.username);
    this.renderGamesList(games, user.username);
  },
  renderChart(history, games, username) {
    const wrap = document.getElementById('ratingChartWrap');
    const categories = [
      { key:'classical', label:'Классика', color:'#a78bfa' },
      { key:'rapid', label:'Рапид', color:'#38bdf8' },
      { key:'blitz', label:'Блиц', color:'#4ade80' },
      { key:'bullet', label:'Пуля', color:'#fb7185' }
    ];
    const usable = (games || []).filter(g =>
      g.category && categories.some(c => c.key === g.category) &&
      Number.isFinite(Number(g.finishedAt))
    );
    const series = categories.map(c => {
      const rows = usable.filter(g => g.category === c.key)
        .sort((a,b) => Number(a.finishedAt) - Number(b.finishedAt))
        .map(g => ({ ts: Number(g.finishedAt), rating: Number(g.white === username ? g.whiteAfter : g.blackAfter) }))
        .filter(p => Number.isFinite(p.rating));
      return { ...c, rows };
    }).filter(s => s.rows.length);
    if (!series.length) {
      wrap.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:20px 0;text-align:center">Недостаточно данных для графика</div>';
      return;
    }
    const W = 900, H = 300, PL = 58, PR = 18, PT = 28, PB = 34;
    const IW = W - PL - PR, IH = H - PT - PB;
    const grid = [];
    for (let i=0; i<=4; i++) {
      const yy = PT + IH*i/4;
      grid.push(`<line x1="${PL}" y1="${yy}" x2="${W-PR}" y2="${yy}" stroke="#3a3833" stroke-width="1"/>`);
    }
    const paths = series.map(s => {
      const vals = s.rows.map(p => p.rating);
      const lo = Math.floor((Math.min(...vals)-30)/50)*50;
      const hi = Math.ceil((Math.max(...vals)+30)/50)*50;
      const span = Math.max(100, hi-lo);
      const px = (p,i) => PL + (s.rows.length < 2 ? IW/2 : (i/(s.rows.length-1))*IW);
      const py = p => PT + IH - ((p.rating-lo)/span)*IH;
      const d = s.rows.map((p,i) => `${i?'L':'M'}${px(p,i).toFixed(1)},${py(p).toFixed(1)}`).join(' ');
      const dash = s.key === 'classical' ? '' : ' stroke-dasharray="7 4"';
      const dots = s.rows.length === 1 ? `<circle cx="${px(s.rows[0],0)}" cy="${py(s.rows[0])}" r="3.5" fill="${s.color}"/>` : '';
      const yLabels = [0,1,2,3,4].map(i => {
        const val = Math.round(hi - span*i/4);
        return `<text x="${PL-8}" y="${PT+IH*i/4+4}" fill="${s.color}" opacity=".78" font-size="10" text-anchor="end">${val}</text>`;
      }).join('');
      const dateLabel = ts => ts ? new Date(ts).toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit'}) : '';
      const first = dateLabel(s.rows[0].ts), last = dateLabel(s.rows[s.rows.length-1].ts);
      const xLabels = `<text x="${PL}" y="${H-10}" fill="#7d7a72" font-size="10" text-anchor="start">${first}</text><text x="${W-PR}" y="${H-10}" fill="#7d7a72" font-size="10" text-anchor="end">${last}</text>`;
      return `<g><title>${s.label}: ${s.rows.length} партий; шкала ${lo}–${hi}</title>${yLabels}${xLabels}<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.2"${dash} stroke-linejoin="round" stroke-linecap="round"/>${dots}</g>`;
    }).join('');
    const legend = categories.map(c => {
      const found = series.find(s => s.key === c.key);
      return `<span style="display:inline-flex;align-items:center;gap:5px;color:${found?c.color:'#777'};font-size:11px;opacity:${found?1:.45};white-space:nowrap"><i style="display:inline-block;width:18px;border-top:2px ${c.key==='classical'?'solid':'dashed'} ${c.color}"></i>${c.label}${found?' ('+found.rows.length+')':''}</span>`;
    }).join('');
    wrap.innerHTML = `<div style="display:flex;gap:12px;flex-wrap:wrap;margin:0 0 8px">${legend}</div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="История рейтингов" style="width:100%;height:auto;max-height:320px;display:block">${grid.join('')}${paths}</svg>
      <div style="color:var(--muted);font-size:11px;margin-top:5px;text-align:center">Каждая категория масштабируется отдельно</div>`;
  },
  renderGamesList(games, username) {
    const el = document.getElementById('gamesList');
    if (!games || !games.length) {
      el.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;padding:16px">Партий пока нет</div>';
      return;
    }
    el.innerHTML = '';
    games.forEach(g => {
      const iAmWhite = g.white === username;
      const myBefore = iAmWhite ? g.whiteBefore : g.blackBefore;
      const myAfter = iAmWhite ? g.whiteAfter : g.blackAfter;
      const delta = myAfter - myBefore;
      const opp = iAmWhite ? g.black : g.white;
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
      const row = document.createElement('div');
      row.className = 'gameRow';
      row.innerHTML = `<span class="res ${resClass}">${resChar}</span><span class="opp">${iAmWhite?'⚪':'⚫'} против <b>${Utils.nickHtml(opp, opp==='PeshkaSasha')}</b>${catBadge}${botBadge}</span><span class="delta ${deltaClass}">${deltaStr} (${myAfter})</span><span class="date">${dateStr}</span>`;
      el.appendChild(row);
    });
  }
};

// ============================================================
// COMMUNITY
// ============================================================
const Community = {
  init() {},
  enter() {
    App.socket.emit('getCommunityOnline', (players) => this.render(players));
  },
  render(players) {
    const list = document.getElementById('communityOnlineList');
    const count = document.getElementById('communityOnlineCount');
    if (!list || !count) return;
    players = Array.isArray(players) ? players : [];
    count.textContent = `В сети: ${players.length}`;
    list.innerHTML = players.map(u =>
      `<div class="communityPlayer" data-player="${Utils.escapeHtml(u.username)}" onclick="Router.go('profile', '${Utils.escapeHtml(u.username)}')"><div class="communityAvatar">${u.isBot ? '🤖' : Utils.escapeHtml(u.username.charAt(0).toUpperCase())}</div><div style="min-width:0"><div class="cpName">${Utils.onlineDotHtml(true)}${Utils.nickHtml(u.username,u.isAdmin,u.isMod,u.isBot)}</div><div class="cpSub">${u.isBot ? 'Бот' : 'Игрок'} · ${Number(u.rating)||1200} рейтинга</div></div></div>`
    ).join('') || '<div style="color:var(--muted)">Сейчас никого нет в сети.</div>';
  }
};

// ============================================================
// MOD MENU (общий для чата партии и чата арены)
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
    document.body.appendChild(menu);
    this.el = menu;
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
// BANNERS (rematch / draw)
// ============================================================
const Banners = {
  rematchFrom: null,
  drawFrom: null,
  init() {
    const rAccept = document.getElementById('rematchBannerAccept');
    const rDecline = document.getElementById('rematchBannerDecline');
    const dAccept = document.getElementById('drawOfferBannerAccept');
    const dDecline = document.getElementById('drawOfferBannerDecline');
    if (rAccept) rAccept.onclick = () => {
      if (!App.lobbyId) return;
      App.socket.emit('rematchRequest', { lobbyId: App.lobbyId }, (res) => {
        if (res && res.ok && res.started) {
          // сервер сам пришлёт gameStart
        }
      });
      this.hideRematch();
    };
    if (rDecline) rDecline.onclick = () => {
      if (App.lobbyId) App.socket.emit('rematchDecline', { lobbyId: App.lobbyId });
      this.hideRematch();
    };
    if (dAccept) dAccept.onclick = () => {
      if (App.lobbyId) App.socket.emit('drawAccept', { lobbyId: App.lobbyId });
      this.hideDraw();
    };
    if (dDecline) dDecline.onclick = () => {
      if (App.lobbyId) App.socket.emit('drawDecline', { lobbyId: App.lobbyId });
      this.hideDraw();
    };
  },
  showRematch(from) {
    this.rematchFrom = from;
    const b = document.getElementById('rematchBanner');
    const t = document.getElementById('rematchBannerText');
    if (!b || !t) return;
    t.textContent = `⚔ ${from} предлагает реванш`;
    b.style.display = 'flex';
    // Меняем кнопку на странице партии
    const btn = document.getElementById('grRematchBtn');
    if (btn) {
      btn.classList.add('accept');
      btn.textContent = 'ПРИНЯТЬ РЕВАНШ';
    }
  },
  hideRematch() {
    this.rematchFrom = null;
    const b = document.getElementById('rematchBanner');
    if (b) b.style.display = 'none';
  },
  showDrawOffer(from) {
    this.drawFrom = from;
    const b = document.getElementById('drawOfferBanner');
    const t = document.getElementById('drawOfferBannerText');
    if (!b || !t) return;
    t.textContent = `½ ${from} предлагает ничью`;
    b.style.display = 'flex';
  },
  hideDraw() {
    this.drawFrom = null;
    const b = document.getElementById('drawOfferBanner');
    if (b) b.style.display = 'none';
  }
};

// ============================================================
// GAME
// ============================================================
const Game = {
  selected: null,
  legalMoves: [],
  moveHistory: [],
  moveFens: [],
  viewIndex: -1,
  lastMove: null,
  boardFlipped: false,
  pendingDrawOffer: false,
  rematchRequested: false,
  lastBoardHash: '',
  dragging: null,
  dragStartPos: null,
  premove: null,
  ghostEl: null,
  clockLoopRunning: false,
  clockSyncedAt: 0,
  clockMyAtSync: 0,
  clockOppAtSync: 0,
  clockTurn: 'w',
  chatMsgIds: new Set(),

  init() {
    const board = document.getElementById('board');
    if (!board) return;
    board.addEventListener('click', (ev) => {
      if (this.dragStartPos && (Math.abs(ev.clientX - this.dragStartPos.x) > 6 || Math.abs(ev.clientY - this.dragStartPos.y) > 6)) { this.dragStartPos = null; return; }
      this.dragStartPos = null;
      const sq = ev.target.closest('.sq'); if (!sq || sq.dataset.r == null) return;
      this.onSquareClick(+sq.dataset.r, +sq.dataset.c);
    });
    board.addEventListener('mousedown', (ev) => this.onMouseDown(ev));
    document.addEventListener('mousemove', (ev) => this.onMouseMove(ev));
    document.addEventListener('mouseup', (ev) => this.onMouseUp(ev));
    const pw = document.getElementById('password');
    if (pw) pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') App.doLogin(); });
  },

  enter(lobbyId) {
    if (lobbyId && (!App.lobbyId || App.lobbyId !== lobbyId)) {
      // Открыли по прямой ссылке #/game/xyz — попробуем восстановить
      App.lobbyId = lobbyId;
      App.socket.emit('getGameState', { lobbyId }, (res) => {
        if (!res || !res.ok) { alert((res && res.msg) || 'Партия не найдена'); Router.go('lobby'); return; }
        this.applyGameStateFromServer(res.state, lobbyId);
      });
      return;
    }
    this.renderBoard();
    this.renderMoves();
    this.updateTimers();
  },

  reset() {
    this.selected = null;
    this.legalMoves = [];
    this.moveHistory = [];
    this.moveFens = [];
    this.viewIndex = -1;
    this.lastMove = null;
    this.boardFlipped = false;
    this.premove = null;
    this.lastBoardHash = '';
    this.pendingDrawOffer = false;
    this.rematchRequested = false;
    this.chatMsgIds.clear();
    const box = document.getElementById('chatMessages');
    if (box) box.innerHTML = '';
  },

  resetUI() {
    document.getElementById('topName').textContent = '—';
    document.getElementById('topRating').textContent = '';
    document.getElementById('topDot').className = 'dot';
    document.getElementById('topTime').textContent = '--:--';
    document.getElementById('bottomName').innerHTML = App.me ? Utils.nickHtml(App.me.username, App.me.isAdmin, App.me.isMod, App.me.isBot) : '—';
    document.getElementById('bottomRating').textContent = App.me ? App.me.rating : '';
    document.getElementById('bottomDot').className = 'dot';
    document.getElementById('bottomTime').textContent = '--:--';
  },

  hideResultBar() {
    document.getElementById('gameResultCompact').classList.remove('show');
    document.getElementById('bigActionsRow').style.display = '';
    document.getElementById('movesPanel').classList.remove('compact');
    const btn = document.getElementById('grRematchBtn');
    if (btn) { btn.classList.remove('accept'); btn.disabled = false; btn.textContent = 'РЕВАНШ'; }
  },

  showResultBar(winner, reason) {
    const bar = document.getElementById('gameResultCompact');
    const title = document.getElementById('grTitleCompact');
    const sub = document.getElementById('grSubCompact');
    let text, cls;
    if (!winner) { text = '½ – Ничья'; cls = ''; }
    else if (winner === App.myColor) { text = (App.myColor === 'w' ? '1-0' : '0-1') + ' – Победа'; cls = 'win'; }
    else { text = (App.myColor === 'w' ? '0-1' : '1-0') + ' – Поражение'; cls = 'lose'; }
    title.textContent = text; title.className = 'grTitle ' + cls;
    sub.textContent = reason || '';
    const rematchBtn = document.getElementById('grRematchBtn');
    const pauseBtn = document.getElementById('grPauseBtn');
    const findBtn = document.getElementById('grFindBtn');
    if (App.currentGameIsArena) {
      rematchBtn.style.display = 'none';
      pauseBtn.style.display = 'block';
      pauseBtn.textContent = (Arena.currentArenaState && Arena.currentArenaState.paused) ? '▶ ПРОДОЛЖИТЬ' : '⏸ ПАУЗА';
      findBtn.textContent = 'ПЕРЕЙТИ В ТУРНИР';
      findBtn.onclick = () => {
        const arenaId = App.currentArenaId;
        if (!arenaId) { this.hideResultBar(); Router.go('arenas'); return; }
        App.socket.emit('continueArenaPairing', { arenaId }, (res) => {
          if (!res || !res.ok) { alert((res && res.msg) || 'Не удалось вернуться в турнир'); return; }
          this.hideResultBar();
          Router.go('arenaPage', arenaId);
        });
      };
    } else {
      rematchBtn.style.display = 'block';
      pauseBtn.style.display = 'none';
      rematchBtn.disabled = false;
      if (Banners.rematchFrom) {
        rematchBtn.classList.add('accept');
        rematchBtn.textContent = 'ПРИНЯТЬ РЕВАНШ';
      } else {
        rematchBtn.classList.remove('accept');
        rematchBtn.textContent = 'РЕВАНШ';
      }
      findBtn.textContent = 'НАЙТИ ДРУГОГО СОПЕРНИКА';
      findBtn.onclick = () => { this.hideResultBar(); this.cleanupAndLeave(); };
    }
    bar.classList.add('show');
    document.getElementById('movesPanel').classList.add('compact');
    document.getElementById('bigActionsRow').style.display = 'none';
  },

  cleanupAndLeave() {
    this.reset();
    App.lobbyId = null;
    App.gameActive = false;
    App.gameEnded = false;
    App.currentGameIsArena = false;
    App.currentArenaId = null;
    App.currentArenaName = null;
    try { localStorage.removeItem('kingside_active_lobby'); } catch (e) {}
    this.updateBackToGameBtn();
    Router.go('lobby');
    Lobby.switchTab('create');
  },

  updateBackToGameBtn() {
    const btn = document.getElementById('backToGameBtn');
    if (!btn) return;
    if (App.gameActive && !App.gameEnded && App.lobbyId) btn.classList.add('show');
    else btn.classList.remove('show');
  },

  applyGameStateFromServer(s, lobbyId) {
    App.lobbyId = lobbyId;
    App.myColor = s.myColor;
    App.opponentName = s.opponent;
    App.opponentRating = s.opponentRating;
    App.opponentIsAdmin = s.opponentIsAdmin;
    App.opponentOnline = !!s.opponentOnline;
    App.opponentIsBot = !!s.isBot;
    App.isBotGame = !!s.isBot;
    App.inc = s.inc;
    App.myTime = App.myColor === 'w' ? s.timeW : s.timeB;
    App.oppTime = App.myColor === 'w' ? s.timeB : s.timeW;
    App.currentFen = s.fen;
    this.moveHistory = []; this.moveFens = []; this.viewIndex = -1; this.lastMove = null;
    App.gameEnded = !!s.finished;
    App.gameActive = !s.finished;
    App.currentGameIsArena = !!s.arenaId;
    App.currentArenaId = s.arenaId || null;
    App.currentArenaName = s.arenaName || null;
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
    this.renderBoard(); this.renderMoves();
    this.updateTurnIndicator();
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
    for (let dr = 0; dr < 8; dr++) {
      for (let dc = 0; dc < 8; dc++) {
        const r = flip ? 7 - dr : dr;
        const c = flip ? 7 - dc : dc;
        const sq = document.createElement('div');
        sq.className = 'sq ' + ((r + c) % 2 ? 'dark' : 'light');
        sq.dataset.r = r; sq.dataset.c = c;
        if (this.lastMove && this.viewIndex === -1) {
          if ((this.lastMove.from[0] === r && this.lastMove.from[1] === c) ||
              (this.lastMove.to[0] === r && this.lastMove.to[1] === c)) sq.classList.add('lastmove');
        }
        const isWhiteTurn = state.turn === 'w';
        if (Chess.inCheck(state, isWhiteTurn)) {
          const k = Chess.findKing(state, isWhiteTurn);
          if (k && k[0] === r && k[1] === c) sq.classList.add('check');
        }
        if (this.selected && this.selected[0] === r && this.selected[1] === c) sq.classList.add('sel');
        if (interactive) {
          const isLegal = this.legalMoves.some(([mr, mc]) => mr === r && mc === c);
          if (isLegal) { sq.classList.add('hint'); if (state.board[r][c]) sq.classList.add('capture'); }
        }
        if (this.premove) {
          if (this.premove.to[0] === r && this.premove.to[1] === c) sq.classList.add('premove-target');
          if (this.premove.from[0] === r && this.premove.from[1] === c) sq.classList.add('premove-from');
        }
        const p = state.board[r][c];
        if (p) {
          const piece = document.createElement('span');
          piece.className = 'piece ' + (Chess.isWhite(p) ? 'w' : 'b');
          piece.textContent = Chess.EMOJI[p];
          if (this.dragging && this.dragging.from[0] === r && this.dragging.from[1] === c) piece.classList.add('dragging');
          sq.appendChild(piece);
        }
        if (dr === 7) { const e = document.createElement('span'); e.className='coord-f'; e.textContent = String.fromCharCode(97 + c); sq.appendChild(e); }
        if (dc === 0) { const e = document.createElement('span'); e.className='coord-r'; e.textContent = 8 - r; sq.appendChild(e); }
        boardEl.appendChild(sq);
      }
    }
    this.updateTurnIndicator(state);
  },

  renderMoves() {
    const el = document.getElementById('movesList');
    if (!el) return;
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

  jumpToMove(idx) {
    if (idx < 0 || idx >= this.moveHistory.length) return;
    this.viewIndex = idx;
    this.lastBoardHash = '';
    this.renderBoard();
    this.renderMoves();
  },

  gotoMove(where) {
    if (!this.moveHistory.length) return;
    if (where === 'first') this.viewIndex = 0;
    else if (where === 'last') this.viewIndex = -1;
    else if (where === 'prev') this.viewIndex = this.viewIndex === -1 ? this.moveHistory.length - 2 : Math.max(0, this.viewIndex - 1);
    else if (where === 'next') { if (this.viewIndex === -1) return; this.viewIndex++; if (this.viewIndex >= this.moveHistory.length - 1) this.viewIndex = -1; }
    this.lastBoardHash = '';
    this.renderBoard();
    this.renderMoves();
  },

  updateTurnIndicator(state) {
    if (!state) state = Chess.parseFen(App.currentFen);
    const isMy = state.turn === App.myColor;
    this.clockTurn = state.turn;
    if (App.gameActive && !App.gameEnded) {
      this.clockSyncedAt = performance.now();
      this.clockMyAtSync = App.myTime;
      this.clockOppAtSync = App.oppTime;
      if (!this.clockLoopRunning) this.startClockLoop();
    }
    document.getElementById('topStrip').classList.toggle('active', App.gameActive && !App.gameEnded && state.turn !== App.myColor);
    document.getElementById('bottomStrip').classList.toggle('active', App.gameActive && !App.gameEnded && state.turn === App.myColor);
    document.getElementById('topClock').classList.toggle('active', App.gameActive && !App.gameEnded && state.turn !== App.myColor);
    document.getElementById('bottomClock').classList.toggle('active', App.gameActive && !App.gameEnded && state.turn === App.myColor);
    const bar = document.getElementById('statusBar');
    if (App.gameEnded) { bar.className = 'statusYellow'; bar.textContent = 'Партия завершена'; }
    else if (App.gameActive) {
      const who = state.turn === 'w' ? 'Белые' : 'Чёрные';
      bar.className = 'statusGreen';
      let txt = `${who} — ${isMy ? 'ваш ход' : 'ход соперника'}`;
      if (this.premove) txt += ' · премьов';
      bar.textContent = txt;
    }
  },

  startClockLoop() {
    if (this.clockLoopRunning) return;
    this.clockLoopRunning = true;
    const self = this;
    function tick() {
      if (!App.gameActive || App.gameEnded) { self.clockLoopRunning = false; return; }
      const elapsed = (performance.now() - self.clockSyncedAt) / 1000;
      let m = self.clockMyAtSync, o = self.clockOppAtSync;
      if (self.clockTurn === App.myColor) m = Math.max(0, m - elapsed);
      else o = Math.max(0, o - elapsed);
      App.myTime = m; App.oppTime = o;
      const tt = document.getElementById('topTime');
      const bt = document.getElementById('bottomTime');
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
    App.myTime = this.clockMyAtSync;
    App.oppTime = this.clockOppAtSync;
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
      const p = state.board[r][c];
      const isMyPiece = p && Chess.isWhite(p) === (App.myColor === 'w');
      if (this.selected) {
        const from = this.selected;
        if (from[0] === r && from[1] === c) { this.selected = null; this.legalMoves = []; this.lastBoardHash = ''; this.renderBoard(); return; }
        const piece = state.board[from[0]][from[1]];
        if (piece && Chess.isWhite(piece) === (App.myColor === 'w')) {
          this.premove = { from, to: [r, c], san: '' };
          this.selected = null; this.legalMoves = [];
          this.lastBoardHash = ''; this.renderBoard();
          return;
        } else { this.selected = null; this.legalMoves = []; }
      }
      if (isMyPiece) { this.selected = [r, c]; this.legalMoves = Chess.legalMovesFor(state, r, c); this.lastBoardHash = ''; this.renderBoard(); }
      else { this.selected = null; this.legalMoves = []; this.lastBoardHash = ''; this.renderBoard(); }
      return;
    }
    if (this.premove) {
      if (this.premove.to[0] === r && this.premove.to[1] === c) { this.premove = null; this.lastBoardHash = ''; this.renderBoard(); return; }
    }
    if (this.selected) {
      const isLegal = this.legalMoves.some(([mr, mc]) => mr === r && mc === c);
      if (isLegal) {
        const from = this.selected;
        this.selected = null; this.legalMoves = [];
        this.applyUserMove(from, [r, c], false);
        return;
      }
    }
    const p = state.board[r][c];
    if (p && Chess.isWhite(p) === (App.myColor === 'w')) {
      this.selected = [r, c];
      this.legalMoves = Chess.legalMovesFor(state, r, c);
    } else { this.selected = null; this.legalMoves = []; }
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
    App.currentFen = newFen;
    this.lastMove = { from, to };
    this.moveHistory.push(san);
    this.moveFens.push(newFen);
    this.premove = null;
    this.renderMoves();
    this.lastBoardHash = ''; this.renderBoard();
    App.socket.emit('move', { lobbyId: App.lobbyId, fen: newFen, turn: nextState.turn, san });
    Sounds.moveBySan(san);
    this.checkGameEnd(nextState);
    return true;
  },

  checkGameEnd(state) {
    const sideToMoveWhite = state.turn === 'w';
    if (!Chess.hasAnyLegalMove(state, sideToMoveWhite)) {
      if (Chess.inCheck(state, sideToMoveWhite)) {
        Sounds.mate();
        this.endGame(sideToMoveWhite ? 'b' : 'w', 'Мат', true, App.currentGameIsArena);
      } else {
        Sounds.draw();
        this.endGame(null, 'Пат', true, App.currentGameIsArena);
      }
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
    const mv = this.premove;
    this.premove = null;
    setTimeout(() => { this.applyUserMove(mv.from, mv.to, false); }, 50);
  },

  onMouseDown(ev) {
    if (ev.button !== 0) return;
    const sq = ev.target.closest('.sq'); if (!sq || sq.dataset.r == null) return;
    const r = +sq.dataset.r, c = +sq.dataset.c;
    const state = Chess.parseFen(App.currentFen);
    const p = state.board[r][c]; if (!p) return;
    const myTurn = state.turn === App.myColor, sameColor = Chess.isWhite(p) === (App.myColor === 'w');
    if (myTurn && sameColor) {
      const leg = Chess.legalMovesFor(state, r, c);
      if (!leg.length) return;
      this.selected = [r, c]; this.legalMoves = leg;
      this.dragging = { from: [r, c], active: false };
      this.dragStartPos = { x: ev.clientX, y: ev.clientY };
      this.lastBoardHash = ''; this.renderBoard();
      this.startDragGhost(p, ev.clientX, ev.clientY);
      ev.preventDefault();
      return;
    }
    if (!myTurn && sameColor) {
      const leg = Chess.legalMovesFor(state, r, c);
      if (!leg.length) return;
      this.selected = [r, c]; this.legalMoves = leg;
      this.dragging = { from: [r, c], active: false, premoveDrag: true };
      this.dragStartPos = { x: ev.clientX, y: ev.clientY };
      this.lastBoardHash = ''; this.renderBoard();
      this.startDragGhost(p, ev.clientX, ev.clientY);
      ev.preventDefault();
    }
  },

  startDragGhost(piece, x, y) {
    if (this.ghostEl) { this.ghostEl.remove(); this.ghostEl = null; }
    this.ghostEl = document.createElement('div');
    this.ghostEl.className = 'dragGhost ' + (Chess.isWhite(piece) ? 'w' : 'b');
    this.ghostEl.textContent = Chess.EMOJI[piece];
    this.ghostEl.style.left = x + 'px';
    this.ghostEl.style.top = y + 'px';
    this.ghostEl.style.display = 'none';
    document.body.appendChild(this.ghostEl);
  },

  moveGhost(x, y) {
    if (!this.ghostEl) return;
    this.ghostEl.style.display = '';
    this.ghostEl.style.left = x + 'px';
    this.ghostEl.style.top = y + 'px';
  },

  clearGhost() { if (this.ghostEl) { this.ghostEl.remove(); this.ghostEl = null; } },

  boardSquareFromEvent(ev) {
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    if (!el) return null;
    const sq = el.closest ? el.closest('.sq') : null;
    if (!sq || sq.dataset.r == null) return null;
    return [+sq.dataset.r, +sq.dataset.c];
  },

  onMouseMove(ev) {
    if (!this.dragging) return;
    if (!this.dragging.active) {
      if (Math.abs(ev.clientX - this.dragStartPos.x) < 5 && Math.abs(ev.clientY - this.dragStartPos.y) < 5) return;
      this.dragging.active = true;
      this.lastBoardHash = '';
      this.renderBoard();
    }
    this.moveGhost(ev.clientX, ev.clientY);
  },

  onMouseUp(ev) {
    if (!this.dragging) { this.dragStartPos = null; return; }
    if (!this.dragging.active) { this.dragging = null; this.clearGhost(); return; }
    const target = this.boardSquareFromEvent(ev);
    const wasPremove = !!this.dragging.premoveDrag;
    const from = this.dragging.from;
    this.dragging = null;
    this.clearGhost();
    this.dragStartPos = null;
    if (!target) { this.selected = null; this.legalMoves = []; this.lastBoardHash = ''; this.renderBoard(); return; }
    if (target[0] === from[0] && target[1] === from[1]) {
      this.selected = from;
      this.legalMoves = Chess.legalMovesFor(Chess.parseFen(App.currentFen), from[0], from[1]);
      this.lastBoardHash = ''; this.renderBoard();
      return;
    }
    if (wasPremove) {
      this.premove = { from, to: target, san: '' };
      this.selected = null; this.legalMoves = [];
      this.lastBoardHash = ''; this.renderBoard();
      return;
    }
    const ok = this.applyUserMove(from, target, false);
    if (!ok) { this.selected = null; this.legalMoves = []; this.lastBoardHash = ''; this.renderBoard(); }
  },

  flipBoard() { this.boardFlipped = !this.boardFlipped; this.lastBoardHash = ''; this.renderBoard(); },

  resign() {
    if (!App.gameActive || App.gameEnded) return;
    if (!confirm('Точно сдаться?')) return;
    App.socket.emit('resign', { lobbyId: App.lobbyId });
    this.endGame(App.myColor === 'w' ? 'b' : 'w', 'Сдача', true, App.currentGameIsArena);
  },

  offerDraw() {
    if (!App.gameActive || App.gameEnded) return;
    if (this.pendingDrawOffer) { alert('Ничья уже предложена'); return; }
    App.socket.emit('drawOffer', { lobbyId: App.lobbyId });
    this.pendingDrawOffer = true;
    const bar = document.getElementById('statusBar');
    bar.className = 'statusYellow';
    bar.textContent = 'Ничья предложена. Ожидание соперника...';
  },

  endGame(winner, reason, fromServer, isArena) {
    if (App.gameEnded) return;
    App.gameEnded = true;
    App.gameActive = false;
    this.premove = null;
    this.rematchRequested = false;
    if (typeof isArena === 'boolean') App.currentGameIsArena = isArena;
    this.showResultBar(winner, reason);
    if (!fromServer) App.socket.emit('gameOver', { lobbyId: App.lobbyId, result: winner || 'draw' });
    App.socket.emit('getProfile', { username: App.me.username }, (res) => {
      if (res && res.ok) { App.me = res.user; App.updateTopbarUser(); }
    });
    Stats.refresh();
  },

  requestRematch() {
    if (!App.lobbyId) return;
    if (Banners.rematchFrom) {
      App.socket.emit('rematchRequest', { lobbyId: App.lobbyId }, (res) => {
        if (res && res.ok && res.started) Banners.hideRematch();
      });
      Banners.hideRematch();
      return;
    }
    if (this.rematchRequested) { alert('Реванш уже предложен'); return; }
    App.socket.emit('rematchRequest', { lobbyId: App.lobbyId }, (res) => {
      if (!res || !res.ok) { alert((res && res.msg) || 'Ошибка'); return; }
      if (res.declined) {
        const bar = document.getElementById('statusBar');
        bar.className = 'statusYellow';
        bar.textContent = 'Бот отклонил реванш';
        return;
      }
      if (res.started) return;
      this.rematchRequested = true;
      const btn = document.getElementById('grRematchBtn');
      btn.disabled = true; btn.textContent = 'ОЖИДАНИЕ...';
    });
  },

  toggleArenaPause() {
    if (!App.currentArenaId) return;
    App.socket.emit('pauseArena', { arenaId: App.currentArenaId }, (res) => {
      if (!res || !res.ok) { alert((res && res.msg) || 'Ошибка'); return; }
      const pauseBtn = document.getElementById('grPauseBtn');
      if (pauseBtn) pauseBtn.textContent = res.paused ? '▶ ПРОДОЛЖИТЬ' : '⏸ ПАУЗА';
      Arena.lastStateHash = '';
      Arena.loadPage();
    });
  },

  findNewOpponent() {
    this.hideResultBar();
    this.cleanupAndLeave();
  },

  openOpponentProfile() {
    if (App.opponentName && App.opponentName !== '—') Router.go('profile', App.opponentName);
  },

  sendChat(e) {
    e.preventDefault();
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text || !App.lobbyId) return;
    App.socket.emit('chatMessage', { lobbyId: App.lobbyId, text });
    input.value = '';
  },

  onChatMessage(msg) {
    const box = document.getElementById('chatMessages');
    if (!box) return;
    if (msg.id && this.chatMsgIds.has(msg.id)) return;
    if (msg.id) this.chatMsgIds.add(msg.id);
    const div = document.createElement('div');
    div.className = 'msg'; div.dataset.msgId = msg.id || '';
    const time = Utils.fmtMskHM(msg.ts);
    let modHtml = '';
    if (App.me && App.me.isMod) modHtml = `<span class="modBtn" title="Модерация">⚙</span>`;
    div.innerHTML = `<span class="u">${Utils.nickHtml(msg.user, msg.userIsAdmin, msg.userIsMod)}:</span> ${Utils.escapeHtml(msg.text)} <span class="t">${time}</span>${modHtml}`;
    if (App.me && App.me.isMod) {
      const btn = div.querySelector('.modBtn');
      if (btn) btn.addEventListener('click', (ev) => { ev.stopPropagation(); Mod.openMenu(ev, msg.id, msg.user, 'game', App.lobbyId); });
    }
    box.appendChild(div);
    while (box.children.length > 50) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  },

  onChatDeleted(msgId) {
    const el = document.querySelector(`#chatMessages .msg[data-msg-id="${msgId}"]`);
    if (el) el.remove();
    const el2 = document.querySelector(`#arenaChatMessages .msg[data-msg-id="${msgId}"]`);
    if (el2) el2.remove();
  },

  onDrawDeclined() {
    const bar = document.getElementById('statusBar');
    bar.className = 'statusYellow';
    bar.textContent = 'Соперник отклонил ничью';
    this.pendingDrawOffer = false;
  },

  onRematchDeclined() {
    this.rematchRequested = false;
    const btn = document.getElementById('grRematchBtn');
    if (btn) { btn.disabled = false; btn.classList.remove('accept'); btn.textContent = 'РЕВАНШ'; }
    const bar = document.getElementById('statusBar');
    bar.className = 'statusYellow';
    bar.textContent = 'Соперник отклонил реванш';
  },

  onOpponentOnline(username) {
    if (username === App.opponentName) {
      App.opponentOnline = true;
      const strip = document.getElementById('topName');
      if (strip) strip.innerHTML = Utils.onlineDotHtml(true) + Utils.nickHtml(App.opponentName, App.opponentIsAdmin, false, App.opponentIsBot);
    }
  },

  onOpponentOffline(username) {
    if (username === App.opponentName) {
      App.opponentOnline = false;
      const strip = document.getElementById('topName');
      if (strip) strip.innerHTML = Utils.onlineDotHtml(false) + Utils.nickHtml(App.opponentName, App.opponentIsAdmin, false, App.opponentIsBot);
    }
  },

  onOpponentLeft() {
    if (!App.gameActive) return;
    alert('Соперник отключился');
    this.updateBackToGameBtn();
  },

  onGameStart(payload) {
    const { color, opponent, opponentRating, time, inc, lobbyId, fen, chat, arenaId, arenaName,
            opponentIsAdmin, opponentIsMod, opponentOnline, opponentIsBot, isBot: isBotFlag } = payload;
    if (lobbyId) App.lobbyId = lobbyId;
    App.myColor = color || 'w';
    App.inc = inc || 0;
    App.opponentName = opponent || 'Соперник';
    App.opponentRating = opponentRating || null;
    App.opponentIsAdmin = (typeof opponentIsAdmin === 'boolean') ? opponentIsAdmin : (App.opponentName === 'PeshkaSasha');
    App.opponentOnline = (typeof opponentOnline === 'boolean') ? opponentOnline : true;
    App.opponentIsBot = !!(opponentIsBot || isBotFlag || (App.opponentName && (App.opponentName === 'BotEasy' || App.opponentName === 'BotMedium' || App.opponentName === 'BotHard' || App.opponentName === 'BotMaster')));
    App.isBotGame = !!isBotFlag || App.opponentIsBot;
    App.myTime = time * 60;
    App.oppTime = time * 60;
    App.currentFen = fen || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    App.gameActive = true;
    App.gameEnded = false;
    App.currentGameIsArena = !!arenaId;
    App.currentArenaId = arenaId || null;
    App.currentArenaName = arenaName || null;
    this.reset();
    this.hideResultBar();
    document.getElementById('bottomName').innerHTML = Utils.nickHtml(App.me.username, App.me.isAdmin, App.me.isMod, App.me.isBot);
    document.getElementById('bottomRating').textContent = App.me.rating;
    document.getElementById('bottomDot').className = 'dot ' + (App.myColor === 'w' ? 'w' : 'b');
    document.getElementById('bottomTime').textContent = Utils.formatTime(time * 60);
    document.getElementById('topName').innerHTML = Utils.onlineDotHtml(App.opponentOnline) + Utils.nickHtml(App.opponentName, App.opponentIsAdmin, opponentIsMod, App.opponentIsBot);
    document.getElementById('topRating').textContent = App.opponentRating || '';
    document.getElementById('topDot').className = 'dot ' + (App.myColor === 'w' ? 'b' : 'w');
    document.getElementById('topTime').textContent = Utils.formatTime(time * 60);
    const bar = document.getElementById('statusBar');
    bar.className = 'statusGreen';
    bar.textContent = App.isBotGame
      ? `Игра с ботом ${Utils.escapeHtml(App.opponentName)}. Вы — ${App.myColor === 'w' ? 'белые' : 'чёрные'}`
      : `Игра началась. Вы — ${App.myColor === 'w' ? 'белые' : 'чёрные'}`;
    document.getElementById('chatMessages').innerHTML = '';
    if (Array.isArray(chat)) chat.forEach(m => this.onChatMessage(m));
    Router.go('game');
    this.renderBoard();
    this.renderMoves();
    this.updateTimers();
    this.updateBackToGameBtn();
    try { localStorage.setItem('kingside_active_lobby', App.lobbyId); } catch (e) {}
    Sounds.start();
  },

  onBoardUpdate({ fen, san }) {
    if (!App.gameActive || App.gameEnded) return;
    App.currentFen = fen;
    this.selected = null;
    this.legalMoves = [];
    this.viewIndex = -1;
    if (san) { this.moveHistory.push(san); this.moveFens.push(fen); }
    this.renderMoves();
    this.lastBoardHash = '';
    this.renderBoard();
    const state = Chess.parseFen(App.currentFen);
    if (san) Sounds.moveBySan(san);
    this.checkGameEnd(state);
    this.tryApplyPremove();
  },

  onTimeUpdate({ timeW, timeB, serverNow }) {
    if (!App.gameActive || App.gameEnded) return;
    const state = Chess.parseFen(App.currentFen);
    this.updateTimersFromServer(timeW, timeB, serverNow, state.turn);
  },

  onGameEnded({ result, reason, isArena, arenaId, isBot }) {
    if (App.gameEnded) return;
    let winner = null;
    if (result === 'w') winner = 'w';
    else if (result === 'b') winner = 'b';
    if (reason !== 'Мат' && reason !== 'Пат') {
      if (!winner) Sounds.draw();
      else if (winner === App.myColor) Sounds.win();
      else Sounds.lose();
    }
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
  window.App = App;
  window.Router = Router;
  window.Lobby = Lobby;
  window.Bot = Bot;
  window.Watch = Watch;
  window.Arena = Arena;
  window.Profile = Profile;
  window.Community = Community;
  window.Game = Game;
  window.Banners = Banners;
  window.Mod = Mod;
  window.Utils = Utils;
  App.init();
});

// Глобальный перехват кликов по нику игрока — показать карточку профиля
(function() {
  let hoverTimer = null, hoverName = '';
  function ensureCard() {
    let card = document.getElementById('playerHoverCard');
    if (!card) { card = document.createElement('div'); card.id = 'playerHoverCard'; document.body.appendChild(card); }
    return card;
  }
  function show(target) {
    const username = target && target.dataset ? target.dataset.player : '';
    if (!username) return;
    hoverName = username;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      const card = ensureCard();
      const r = target.getBoundingClientRect();
      const cardW = 300;
      let left = r.left;
      if (left + cardW + 8 > window.innerWidth) left = window.innerWidth - cardW - 8;
      if (left < 8) left = 8;
      card.style.left = left + 'px';
      card.style.top = Math.min(window.innerHeight - 180, r.bottom + 7) + 'px';
      card.style.display = 'block';
      card.innerHTML = `<div class="phName">${Utils.escapeHtml(username)}</div><div style="color:var(--muted)">Загрузка статистики…</div>`;
      App.socket.emit('getPlayerCard', { username }, (res) => {
        if (hoverName !== username || !res || !res.ok) return;
        const u = res.user;
        card.innerHTML = `
          <div class="phName">${u.online ? '🟢' : '⚪'} ${Utils.nickHtml(u.username,u.isAdmin,u.isMod,u.isBot)}</div>
          <div class="phMeta">
            <span>♟ ${Number(u.rating)||1200}</span>
            <span>🏆 ${Number(u.games)||0} партий</span>
            <span>${u.online ? '● В сети' : '○ Не в сети'}</span>
          </div>
          <div class="phStats">
            <div class="phStat">♔ ${Number(u.wins)||0} побед</div>
            <div class="phStat">½ ${Number(u.draws)||0} ничьих</div>
            <div class="phStat">♚ ${Number(u.losses)||0} пораж.</div>
            <div class="phStat">${u.games ? Math.round((u.wins/u.games)*100) : 0}% побед</div>
          </div>`;
      });
    }, 250);
  }
  document.addEventListener('mouseover', e => {
    const n = e.target.closest && e.target.closest('[data-player]');
    if (n) show(n);
  });
  document.addEventListener('mouseout', e => {
    const n = e.target.closest && e.target.closest('[data-player]');
    if (n && !n.contains(e.relatedTarget)) {
      clearTimeout(hoverTimer);
      hoverName = '';
      const c = document.getElementById('playerHoverCard');
      if (c) c.style.display = 'none';
    }
  });
})();
