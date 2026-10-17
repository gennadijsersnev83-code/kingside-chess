'use strict';

/**
 * watcher-worker.js — отдельный поток для self-play тренера Watcher.
 * Не блокирует сервер. Получает задачи через parentPort.
 */

const { parentPort } = require('worker_threads');

let watcher = null;

function initWatcher() {
  if (!watcher) {
    try {
      watcher = require('./watcher-learning');
      watcher.loadWeights(); // загрузка из файла (или БД — если передашь)
    } catch (e) {
      parentPort.postMessage({ type: 'error', msg: 'Init failed: ' + e.message });
      throw e;
    }
  }
}

parentPort.on('message', (msg) => {
  try {
    initWatcher();

    if (msg.type === 'playGames') {
      // Сыграть N партий self-play
      const n = msg.count || 10;
      const results = { w: 0, b: 0, d: 0 };
      for (let i = 0; i < n; i++) {
        const r = watcher.playSelfPlayGame();
        if (r === 1) results.w++;
        else if (r === -1) results.b++;
        else results.d++;
      }
      // Сохранить веса после серии
      watcher.saveData();
      const stats = watcher.getStats();
      parentPort.postMessage({
        type: 'gamesDone',
        played: n,
        results,
        stats,
      });

    } else if (msg.type === 'getStats') {
      parentPort.postMessage({ type: 'stats', stats: watcher.getStats() });

    } else if (msg.type === 'saveData') {
      watcher.saveData();
      parentPort.postMessage({ type: 'saved' });

    } else if (msg.type === 'stop') {
      if (watcher) watcher.saveData();
      parentPort.postMessage({ type: 'stopped' });
      process.exit(0);
    }
  } catch (e) {
    parentPort.postMessage({ type: 'error', msg: e.message, stack: e.stack });
  }
});

parentPort.postMessage({ type: 'ready' });
