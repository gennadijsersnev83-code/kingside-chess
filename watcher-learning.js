// watcher-learning.js
// Q-learning для Watcher. Учёт контроля времени + baseline eval (BotMedium).

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const QTABLE_PATH = path.join(DATA_DIR, 'watcher-qtable.json');
const MAX_STATES = 50000;
const SAVE_INTERVAL_MS = 5 * 60 * 1000;

const ALPHA = 0.1;
const GAMMA = 0.9;
const EPSILON_START = 1.0;
const EPSILON_END = 0.05;
const EPSILON_DECAY_GAMES = 1000;

// Контроль времени → короткий код
function timeControlCode(timeMin, inc) {
  if (timeMin < 3) return 'B';       // bullet
  if (timeMin < 10) return 'Z';      // blitz
  if (timeMin < 30) return 'R';      // rapid
  return 'C';                        // classical
}

// ======================= СОСТОЯНИЕ =======================
function encodeState(fen, botColor, timeControl) {
  try {
    const parts = fen.split(' ');
    const board = parts[0];
    const turn = parts[1];
    const fullmove = parseInt(parts[5] || '1', 10);

    let wp=0,wn=0,wb=0,wr=0,wq=0,bp=0,bn=0,bb=0,br=0,bq=0;
    for (const ch of board) {
      switch (ch) {
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

    return `${tc}${matBucket(wMat)}${matBucket(bMat)}${cntBucket(wCount)}${cntBucket(bCount)}${turnSign}${phase}`;
  } catch (e) { return 'ERR'; }
}

function encodeAction(from, to) {
  return String.fromCharCode(97 + from[1]) + (8 - from[0]) + String.fromCharCode(97 + to[1]) + (8 - to[0]);
}

// ======================= Q-TABLE =======================
let Q = new Map();
let totalGames = 0;
let saveHandle = null;
let dirty = false;

function ensureDataDir() {
  try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
  catch (e) { console.error('[Watcher] Не удалось создать data/:', e.message); }
}

function loadQTable() {
  ensureDataDir();
  try {
    if (fs.existsSync(QTABLE_PATH)) {
      const raw = fs.readFileSync(QTABLE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      Q = new Map();
      for (const [state, actions] of Object.entries(parsed.q || {})) {
        const m = new Map();
        for (const [act, val] of Object.entries(actions)) {
          m.set(act, { q: val.q || 0, v: val.v || 0, ev: val.ev || 0, lastUsed: val.lastUsed || Date.now() });
        }
        Q.set(state, m);
      }
      totalGames = parsed.totalGames || 0;
      console.log(`[Watcher] Q-таблица загружена: ${Q.size} состояний, ${totalGames} партий`);
    } else {
      console.log('[Watcher] Q-таблица пуста, начинаем с нуля');
    }
  } catch (e) {
    console.error('[Watcher] Ошибка загрузки Q-таблицы:', e.message);
    Q = new Map();
    totalGames = 0;
  }
}

function saveQTable() {
  if (!dirty) return;
  ensureDataDir();
  try {
    const obj = { q: {}, totalGames, savedAt: Date.now() };
    for (const [state, actions] of Q.entries()) {
      const a = {};
      for (const [act, val] of actions.entries()) a[act] = val;
      obj.q[state] = a;
    }
    fs.writeFileSync(QTABLE_PATH, JSON.stringify(obj));
    dirty = false;
    console.log(`[Watcher] Q-таблица сохранена: ${Q.size} состояний`);
  } catch (e) { console.error('[Watcher] Ошибка сохранения Q-таблицы:', e.message); }
}

function startAutoSave() {
  if (saveHandle) return;
  saveHandle = setInterval(saveQTable, SAVE_INTERVAL_MS);
}

function evictIfNeeded() {
  if (Q.size <= MAX_STATES) return;
  const entries = [...Q.entries()].map(([state, actions]) => {
    let totalV = 0;
    for (const a of actions.values()) totalV += a.v || 0;
    return { state, totalV };
  });
  entries.sort((a, b) => a.totalV - b.totalV);
  const toRemove = Q.size - MAX_STATES + Math.floor(MAX_STATES * 0.1);
  for (let i = 0; i < toRemove && i < entries.length; i++) Q.delete(entries[i].state);
  console.log(`[Watcher] Эвикция Q-таблицы: удалено ${toRemove} состояний`);
}

// ======================= ВЫБОР ХОДА =======================
function getEpsilon() {
  if (totalGames >= EPSILON_DECAY_GAMES) return EPSILON_END;
  const t = totalGames / EPSILON_DECAY_GAMES;
  return EPSILON_START + (EPSILON_END - EPSILON_START) * t;
}

// baselineEval — оценка позиции уровня BotMedium (передаётся извне)
// movesWithEval — [{from, to, eval}] — оценка после каждого хода
function pickMove(fen, botColor, timeControl, movesWithEval) {
  if (!movesWithEval || movesWithEval.length === 0) return null;
  const state = encodeState(fen, botColor, timeControl);
  const eps = getEpsilon();

  if (Math.random() < eps) {
    return movesWithEval[Math.floor(Math.random() * movesWithEval.length)];
  }
  const actions = Q.get(state);
  if (!actions || actions.size === 0) {
    // Нет данных — берём лучший по eval (baseline BotMedium), с небольшим шумом
    const sorted = movesWithEval.slice().sort((a, b) =>
      (botColor === 'w' ? b.eval - a.eval : a.eval - b.eval)
    );
    const noise = Math.random() < 0.3 ? 1 : 0;
    return sorted[Math.min(noise, sorted.length - 1)];
  }

  let best = null, bestScore = -Infinity;
  for (const mv of movesWithEval) {
    const act = encodeAction(mv.from, mv.to);
    const entry = actions.get(act);
    const qVal = entry ? entry.q : 0;
    // Комбинируем Q-value и baseline eval, чтобы даже «пустая» Q-таблица давала разумные ходы
    const baseline = (botColor === 'w' ? mv.eval : -mv.eval) / 100;
    const score = qVal * 0.7 + baseline * 0.3;
    if (score > bestScore) { bestScore = score; best = mv; }
  }
  return best;
}

// ======================= ОБНОВЛЕНИЕ Q =======================
function updateQ(state, action, reward, nextState, evalAfter) {
  if (!Q.has(state)) Q.set(state, new Map());
  const actions = Q.get(state);
  if (!actions.has(action)) actions.set(action, { q: 0, v: 0, ev: 0, lastUsed: Date.now() });
  const entry = actions.get(action);

  let maxNextQ = 0;
  const nextActions = Q.get(nextState);
  if (nextActions && nextActions.size > 0) {
    maxNextQ = -Infinity;
    for (const a of nextActions.values()) if (a.q > maxNextQ) maxNextQ = a.q;
    if (maxNextQ === -Infinity) maxNextQ = 0;
  }
  const newQ = entry.q + ALPHA * (reward + GAMMA * maxNextQ - entry.q);
  entry.q = newQ;
  entry.v = (entry.v || 0) + 1;
  if (typeof evalAfter === 'number') entry.ev = evalAfter;
  entry.lastUsed = Date.now();
  dirty = true;
  evictIfNeeded();
}

// ======================= НАБЛЮДЕНИЕ ЗА ЧУЖИМИ ХОДАМИ =======================
// Когда Watcher смотрит партию, он запоминает: (state, action) → (nextState, eval).
// Через N ходов награда = изменение eval для того же цвета.
function learnFromObservedMove(prevFen, move, newFen, moverColor, timeControl, evalAfter) {
  try {
    const stateBefore = encodeState(prevFen, moverColor, timeControl);
    const actionStr = encodeAction(move.from, move.to);
    const stateAfter = encodeState(newFen, moverColor, timeControl);
    const reward = (moverColor === 'w' ? evalAfter : -evalAfter) / 100;
    updateQ(stateBefore, actionStr, reward, stateAfter, evalAfter);
  } catch (e) { /* ignore */ }
}

function incrementGames() { totalGames++; dirty = true; }

function getStats() {
  return { states: Q.size, games: totalGames, epsilon: +getEpsilon().toFixed(3) };
}

module.exports = {
  encodeState,
  encodeAction,
  timeControlCode,
  pickMove,
  updateQ,
  learnFromObservedMove,
  incrementGames,
  loadQTable,
  saveQTable,
  startAutoSave,
  getStats
};
