// watcher-learning.js
// Q-learning для Watcher с Double Q-learning, replay buffer и терминальной наградой.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const QTABLE_PATH = path.join(DATA_DIR, 'watcher-qtable.json');
const MAX_STATES = 200000;
const SAVE_INTERVAL_MS = 5 * 60 * 1000;

const ALPHA = 0.2;
const GAMMA = 0.99;
const EPSILON_START = 1.0;
const EPSILON_END = 0.03;
const EPSILON_DECAY_STEPS = 30000;   // затухание по сделанным ходам, не по партиям

// Replay buffer
const REPLAY_MAX = 50000;
const REPLAY_SAMPLE = 64;
const REPLAY_INTERVAL_STEPS = 200;   // каждые N ходов делаем batch-update

// ======================= КОНТРОЛЬ ВРЕМЕНИ =======================
function timeControlCode(timeMin, inc) {
  if (timeMin < 3) return 'B';       // bullet
  if (timeMin < 10) return 'Z';      // blitz
  if (timeMin < 30) return 'R';      // rapid
  return 'C';                        // classical
}

// ======================= ZOBRIST ХЕШ =======================
// Детерминированный хеш позиции. Не идеален, но различимость на порядки выше старой схемы.
const ZOBRIST = (() => {
  // xorshift32, чтобы хеш был воспроизводимым
  let seed = 0x9E3779B9 >>> 0;
  const rand32 = () => {
    seed ^= (seed << 13) >>> 0;
    seed ^= (seed >>> 17);
    seed ^= (seed << 5) >>> 0;
    return seed >>> 0;
  };
  const pieceKeys = {};
  const pieces = ['P','N','B','R','Q','K','p','n','b','r','q','k'];
  for (const p of pieces) {
    pieceKeys[p] = Array.from({ length: 64 }, () => rand32());
  }
  const turnKey = rand32();
  const castleKeys = Array.from({ length: 16 }, () => rand32());
  const epKeys = Array.from({ length: 8 }, () => rand32());
  return { pieceKeys, turnKey, castleKeys, epKeys };
})();

function zobristHash(board, turn, castling, ep) {
  let h = 0 >>> 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p) continue;
      const key = ZOBRIST.pieceKeys[p];
      if (key) h = (h ^ key[r * 8 + c]) >>> 0;
    }
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

// ======================= СОСТОЯНИЕ =======================
// Комбинируем: zobrist(позиция) + материал + число фигур + фаза + TC
// Это даёт десятки миллионов различимых состояний и при этом остаётся компактным.
function encodeState(fen, botColor, timeControl) {
  try {
    const parts = fen.split(' ');
    const boardStr = parts[0];
    const turn = parts[1];
    const castling = parts[2] || '-';
    const ep = parts[3] || '-';
    const fullmove = parseInt(parts[5] || '1', 10);

    // Парсим доску в матрицу для zobrist
    const board = Array.from({ length: 8 }, () => Array(8).fill(null));
    let r = 0, c = 0;
    for (const ch of boardStr) {
      if (ch === '/') { r++; c = 0; continue; }
      if (/\d/.test(ch)) { c += +ch; continue; }
      if (r < 8 && c < 8) board[r][c] = ch;
      c++;
    }

    let wp=0,wn=0,wb=0,wr=0,wq=0,bp=0,bn=0,bb=0,br=0,bq=0;
    for (let rr = 0; rr < 8; rr++) for (let cc = 0; cc < 8; cc++) {
      switch (board[rr][cc]) {
        case 'P': wp++; break; case 'N': wn++; break; case 'B': wb++; break; case 'R': wr++; break; case 'Q': wq++; break;
        case 'p': bp++; break; case 'n': bn++; break; case 'b': bb++; break; case 'r': br++; break; case 'q': bq++; break;
      }
    }
    const wMat = wp*1 + wn*3 + wb*3 + wr*5 + wq*9;
    const bMat = bp*1 + bn*3 + bb*3 + br*5 + bq*9;
    const wCount = wp+wn+wb+wr+wq;
    const bCount = bp+bn+bb+br+bq;

    const matBucket = (m) => m>=30?'A' : m>=20?'B' : m>=12?'C' : m>=6?'D' : m>=3?'E':'F';
    const cntBucket = (c) => c>=12?'a' : c>=8?'b' : c>=5?'c' : c>=3?'d':'e';
    const phase = fullmove < 10 ? 'O' : (fullmove < 25 ? 'M' : 'E');
    const turnSign = turn === botColor ? 'T' : 't';
    const tc = timeControlCode(timeControl && timeControl.time ? timeControl.time : 5, timeControl ? timeControl.inc : 0);

    const zh = zobristHash(board, turn, castling, ep).toString(36);

    return `${tc}${zh}${matBucket(wMat)}${matBucket(bMat)}${cntBucket(wCount)}${cntBucket(bCount)}${turnSign}${phase}`;
  } catch (e) { return 'ERR'; }
}

function encodeAction(from, to) {
  return String.fromCharCode(97 + from[1]) + (8 - from[0]) + String.fromCharCode(97 + to[1]) + (8 - to[0]);
}

// ======================= ДВОЙНАЯ Q-ТАБЛИЦА =======================
// Q_A и Q_B — две независимые таблицы, каждая обновляется по данным другой.
let QA = new Map();
let QB = new Map();
let totalGames = 0;
let totalSteps = 0;
let saveHandle = null;
let dirty = false;

// Текущая партия Watcher: сюда пишем (s, a, r, s') по мере ходов
let currentEpisode = null;

// Replay buffer
const replay = [];

function ensureDataDir() {
  try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
  catch (e) { console.error('[Watcher] Не удалось создать data/:', e.message); }
}

function getQEntry(table, state, action) {
  if (!table.has(state)) table.set(state, new Map());
  const actions = table.get(state);
  if (!actions.has(action)) actions.set(action, { q: 0, v: 0, ev: 0, lastUsed: Date.now() });
  return actions.get(action);
}

function getMaxQ(table, state) {
  const actions = table.get(state);
  if (!actions || actions.size === 0) return 0;
  let m = -Infinity;
  for (const a of actions.values()) if (a.q > m) m = a.q;
  return m === -Infinity ? 0 : m;
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

// ======================= ЗАГРУЗКА / СОХРАНЕНИЕ =======================
function loadQTable() {
  ensureDataDir();
  try {
    if (fs.existsSync(QTABLE_PATH)) {
      const raw = fs.readFileSync(QTABLE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      QA = new Map(); QB = new Map();
      if (parsed.qa) {
        for (const [state, actions] of Object.entries(parsed.qa)) {
          const m = new Map();
          for (const [act, val] of Object.entries(actions)) m.set(act, { q: val.q || 0, v: val.v || 0, ev: val.ev || 0, lastUsed: val.lastUsed || Date.now() });
          QA.set(state, m);
        }
      }
      if (parsed.qb) {
        for (const [state, actions] of Object.entries(parsed.qb)) {
          const m = new Map();
          for (const [act, val] of Object.entries(actions)) m.set(act, { q: val.q || 0, v: val.v || 0, ev: val.ev || 0, lastUsed: val.lastUsed || Date.now() });
          QB.set(state, m);
        }
      }
      totalGames = parsed.totalGames || 0;
      totalSteps = parsed.totalSteps || 0;
      console.log(`[Watcher] Q-таблицы загружены: QA=${QA.size}, QB=${QB.size}, партий=${totalGames}, ходов=${totalSteps}`);
    } else {
      console.log('[Watcher] Q-таблицы пусты, начинаем с нуля');
    }
  } catch (e) {
    console.error('[Watcher] Ошибка загрузки Q-таблиц:', e.message);
    QA = new Map(); QB = new Map();
    totalGames = 0; totalSteps = 0;
  }
}

function saveQTable() {
  if (!dirty) return;
  ensureDataDir();
  try {
    const obj = {
      qa: {}, qb: {},
      totalGames, totalSteps,
      savedAt: Date.now(),
      version: 2
    };
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
    fs.writeFileSync(QTABLE_PATH, JSON.stringify(obj));
    dirty = false;
    console.log(`[Watcher] Q-таблицы сохранены: QA=${QA.size}, QB=${QB.size}, партий=${totalGames}`);
  } catch (e) { console.error('[Watcher] Ошибка сохранения Q-таблиц:', e.message); }
}

function startAutoSave() {
  if (saveHandle) return;
  saveHandle = setInterval(saveQTable, SAVE_INTERVAL_MS);
}

function evictIfNeeded() {
  // Чистим обе таблицы по суммарной ценности
  const cleanTable = (table) => {
    if (table.size <= MAX_STATES) return;
    const entries = [...table.entries()].map(([state, actions]) => {
      let totalV = 0;
      for (const a of actions.values()) totalV += a.v || 0;
      return { state, totalV };
    });
    entries.sort((a, b) => a.totalV - b.totalV);
    const toRemove = table.size - MAX_STATES + Math.floor(MAX_STATES * 0.1);
    for (let i = 0; i < toRemove && i < entries.length; i++) table.delete(entries[i].state);
  };
  cleanTable(QA);
  cleanTable(QB);
}

// ======================= EPSILON =======================
function getEpsilon() {
  if (totalSteps >= EPSILON_DECAY_STEPS) return EPSILON_END;
  const t = totalSteps / EPSILON_DECAY_STEPS;
  return EPSILON_START + (EPSILON_END - EPSILON_START) * t;
}

// ======================= ВЫБОР ХОДА =======================
function pickMove(fen, botColor, timeControl, movesWithEval) {
  if (!movesWithEval || movesWithEval.length === 0) return null;
  const state = encodeState(fen, botColor, timeControl);
  const eps = getEpsilon();

  // Exploration
  if (Math.random() < eps) {
    return movesWithEval[Math.floor(Math.random() * movesWithEval.length)];
  }

  // Exploitation: суммируем Q_A и Q_B
  let best = null, bestScore = -Infinity;
  for (const mv of movesWithEval) {
    const act = encodeAction(mv.from, mv.to);
    const qa = QA.get(state)?.get(act)?.q ?? 0;
    const qb = QB.get(state)?.get(act)?.q ?? 0;
    const qAvg = (qa + qb) / 2;
    // Небольшой бонус за baseline eval — чтобы в начале, когда Q пустая, играл разумно
    const baseline = (botColor === 'w' ? mv.eval : -mv.eval) / 1000;
    const score = qAvg + baseline * 0.1;
    if (score > bestScore) { bestScore = score; best = mv; }
  }

  if (!best) {
    // Fallback — лучший по eval
    const sorted = movesWithEval.slice().sort((a, b) =>
      (botColor === 'w' ? b.eval - a.eval : a.eval - b.eval)
    );
    return sorted[0];
  }
  return best;
}

// ======================= ОБНОВЛЕНИЕ =======================
// Мягкое обновление с Double Q-learning
function updateQ(state, action, reward, nextState, evalAfter) {
  // Определяем, какую таблицу обновляем (случайно)
  const updateA = Math.random() < 0.5;
  const table = updateA ? QA : QB;
  const otherTable = updateA ? QB : QA;

  const entry = getQEntry(table, state, action);

  // Double Q: argmax берём из table, значение — из otherTable
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
  if (typeof evalAfter === 'number') entry.ev = evalAfter;
  entry.lastUsed = Date.now();

  totalSteps++;
  dirty = true;
  evictIfNeeded();
}

// ======================= ЭПИЗОД =======================
// Начинаем эпизод при первом ходе Watcher в партии
function startEpisode(botColor, timeControl) {
  currentEpisode = {
    botColor,
    timeControl,
    transitions: [],      // { state, action, reward, nextState, evalAfter }
    startedAt: Date.now()
  };
}

// Записываем переход в текущий эпизод + сразу обновляем Q (on-line)
function recordTransition(state, action, reward, nextState, evalAfter) {
  updateQ(state, action, reward, nextState, evalAfter);

  if (currentEpisode) {
    currentEpisode.transitions.push({ state, action, reward, nextState, evalAfter });
    if (currentEpisode.transitions.length > 400) currentEpisode.transitions.shift();
  }
  // Кладём в replay buffer
  replay.push({ state, action, reward, nextState, evalAfter });
  if (replay.length > REPLAY_MAX) replay.shift();

  // Периодический batch-update
  if (totalSteps % REPLAY_INTERVAL_STEPS === 0) batchUpdate();
}

// Batch-update из replay buffer — сглаживает обучение
function batchUpdate() {
  if (replay.length < REPLAY_SAMPLE) return;
  for (let i = 0; i < REPLAY_SAMPLE; i++) {
    const t = replay[Math.floor(Math.random() * replay.length)];
    updateQ(t.state, t.action, t.reward, t.nextState, t.evalAfter);
  }
}

// Завершение эпизода — разматываем терминальную награду назад с дисконтом.
// result: 'w' | 'b' | 'draw' — с чьей стороны (с точки зрения партии)
// botColor: 'w' | 'b' — за кого играл Watcher
function finishEpisode(result, botColor) {
  if (!currentEpisode) return;
  let terminalReward = 0;
  if (result === 'draw' || !result) terminalReward = 0;
  else if (result === botColor) terminalReward = 1.0;
  else terminalReward = -1.0;

  // Идём от последнего перехода к первому, накапливая дисконт
  const trans = currentEpisode.transitions;
  let discounted = terminalReward;
  for (let i = trans.length - 1; i >= 0; i--) {
    const t = trans[i];
    // Здесь обновляем с терминальной составляющей
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

    // Комбинированная награда: шаговая + затухающая терминальная
    const combinedReward = t.reward + discounted * 0.5;
    const target = combinedReward + GAMMA * maxNextQ;
    entry.q = entry.q + ALPHA * (target - entry.q);
    entry.v = (entry.v || 0) + 1;
    entry.lastUsed = Date.now();

    discounted *= GAMMA * 0.5;  // терминальный сигнал затухает быстрее
  }

  currentEpisode = null;
  totalGames++;
  dirty = true;
  console.log(`[Watcher] Эпизод завершён. Результат: ${result}, ходов: ${trans.length}. Всего партий: ${totalGames}`);
}

// ======================= НАБЛЮДЕНИЕ ЗА ЧУЖИМИ ХОДАМИ =======================
function learnFromObservedMove(prevFen, move, newFen, moverColor, timeControl, evalAfter) {
  try {
    const stateBefore = encodeState(prevFen, moverColor, timeControl);
    const actionStr = encodeAction(move.from, move.to);
    const stateAfter = encodeState(newFen, moverColor, timeControl);
    const reward = (moverColor === 'w' ? evalAfter : -evalAfter) / 1000;
    // Наблюдательные ходы обновляют Q с маленьким весом (через меньшее ALPHA)
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
    entry.q = entry.q + (ALPHA * 0.3) * (target - entry.q);
    entry.v = (entry.v || 0) + 1;
    entry.lastUsed = Date.now();
    dirty = true;
  } catch (e) { /* ignore */ }
}

function incrementGames() {
  // Оставлено для совместимости, но теперь игры считает finishEpisode
}

function getStats() {
  return {
    qaStates: QA.size, qbStates: QB.size,
    games: totalGames, steps: totalSteps,
    epsilon: +getEpsilon().toFixed(3),
    replaySize: replay.length,
    episodeActive: !!currentEpisode
  };
}

module.exports = {
  encodeState,
  encodeAction,
  timeControlCode,
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
  getStats
};
