// bot-pool.js
// Пул воркеров для параллельных вычислений ходов ботов.
// Распределяет задачи по всем ядрам, не блокирует главный поток.

const { Worker } = require('worker_threads');
const os = require('os');
const path = require('path');

const POOL_SIZE = Math.max(2, Math.min(os.cpus().length, 8)); // 2–8 воркеров
const WORKER_PATH = path.join(__dirname, 'bot-worker.js');

class BotPool {
  constructor(size) {
    this.size = size;
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.taskId = 0;
    this.pending = new Map(); // id -> {resolve, reject}
    this._init();
  }

  _init() {
    for (let i = 0; i < this.size; i++) {
      const w = new Worker(WORKER_PATH);
      w.on('message', (msg) => this._onMessage(w, msg));
      w.on('error', (err) => {
        console.error('[bot-pool] worker error:', err.message);
        this._onWorkerDown(w);
      });
      w.on('exit', (code) => {
        if (code !== 0) console.error(`[bot-pool] worker exited with code ${code}`);
        this._onWorkerDown(w);
      });
      this.workers.push(w);
      this.idle.push(w);
    }
    console.log(`[bot-pool] Запущено воркеров: ${this.size}`);
  }

  _onMessage(worker, msg) {
    const { id } = msg;
    const task = this.pending.get(id);
    if (task) {
      this.pending.delete(id);
      if (msg.ok) task.resolve(msg.move);
      else task.reject(new Error(msg.error || 'worker error'));
    }
    this.idle.push(worker);
    this._processQueue();
  }

  _onWorkerDown(worker) {
    const idx = this.workers.indexOf(worker);
    if (idx >= 0) this.workers.splice(idx, 1);
    const idleIdx = this.idle.indexOf(worker);
    if (idleIdx >= 0) this.idle.splice(idleIdx, 1);
    // Пересоздаём воркер
    setTimeout(() => {
      const w = new Worker(WORKER_PATH);
      w.on('message', (m) => this._onMessage(w, m));
      w.on('error', (err) => { console.error('[bot-pool] worker error:', err.message); this._onWorkerDown(w); });
      w.on('exit', (code) => { if (code !== 0) console.error(`[bot-pool] worker exited ${code}`); this._onWorkerDown(w); });
      this.workers.push(w);
      this.idle.push(w);
      this._processQueue();
    }, 500);
  }

  _processQueue() {
    while (this.queue.length > 0 && this.idle.length > 0) {
      const task = this.queue.shift();
      const worker = this.idle.shift();
      const id = ++this.taskId;
      this.pending.set(id, task);
      worker.postMessage({ id, fen: task.fen, rating: task.rating, timeMin: task.timeMin });
    }
  }

  /**
   * Запрос хода бота.
   * @returns {Promise<{from:[number,number], to:[number,number]}|null>}
   */
  getMove(fen, rating, timeMin) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fen, rating, timeMin, resolve, reject });
      this._processQueue();
    });
  }

  /** Для graceful shutdown. */
  async terminate() {
    await Promise.all(this.workers.map(w => w.terminate()));
  }
}

module.exports = new BotPool(POOL_SIZE);
