'use strict';

/**
 * watcher-pool.js — управление worker-потоком self-play.
 * Запускает один worker, шлёт задачи, перезапускает при падении.
 */

const { Worker } = require('worker_threads');
const path = require('path');

class WatcherPool {
  constructor() {
    this.worker = null;
    this.ready = false;
    this.busy = false;
    this.queue = [];
    this.totalGames = 0;
    this.handler = null;
  }

  start() {
    if (this.worker) return;
    const workerPath = path.join(__dirname, 'watcher-worker.js');
    this.worker = new Worker(workerPath);

    this.worker.on('message', (msg) => {
      if (msg.type === 'ready') {
        this.ready = true;
        if (this.handler) this.handler({ type: 'ready' });
        this.flushQueue();
      } else if (msg.type === 'gamesDone') {
        this.busy = false;
        this.totalGames += msg.played;
        if (this.handler) this.handler({ type: 'gamesDone', ...msg, totalGames: this.totalGames });
        this.flushQueue();
      } else {
        if (msg.type === 'stopped') this.busy = false;
        if (this.handler) this.handler(msg);
        this.flushQueue();
      }
    });

    this.worker.on('error', (err) => {
      console.error('[WatcherPool] Worker error:', err.message);
      if (this.handler) this.handler({ type: 'error', msg: err.message });
      this.worker = null;
      this.ready = false;
      this.busy = false;
      setTimeout(() => this.start(), 5000);
    });

    this.worker.on('exit', (code) => {
      if (code !== 0) console.error(`[WatcherPool] Worker exit code: ${code}`);
      this.worker = null;
      this.ready = false;
      this.busy = false;
    });
  }

  flushQueue() {
    if (!this.ready || this.busy || !this.queue.length) return;
    const task = this.queue.shift();
    this.busy = true;
    this.worker.postMessage(task);
  }

  send(task) {
    this.queue.push(task);
    this.flushQueue();
  }

  playGames(count) {
    this.send({ type: 'playGames', count });
  }

  getStats() {
    this.send({ type: 'getStats' });
  }

  saveData() {
    this.send({ type: 'saveData' });
  }

  stop() {
    if (this.worker) {
      try { this.worker.postMessage({ type: 'stop' }); } catch (e) {}
      setTimeout(() => {
        if (this.worker) this.worker.terminate();
        this.worker = null;
        this.ready = false;
        this.busy = false;
      }, 1000);
    }
  }
}

module.exports = new WatcherPool();
