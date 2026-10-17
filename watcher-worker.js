'use strict';

const { parentPort } = require('worker_threads');

let watcher = null;

function initWatcher() {
  if (!watcher) {
    try {
      watcher = require('./watcher-learning');
      watcher.loadWeights();
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
      const n = msg.count || 10;
      let w = 0, b = 0, d = 0;
      let lastGame = null;

      for (let i = 0; i < n; i++) {
        const game = watcher.playSelfPlayGame();
        const r = game.result;
        if (r === 1) w++;
        else if (r === -1) b++;
        else d++;
        lastGame = game;
      }
      watcher.saveData();

      parentPort.postMessage({
        type: 'gamesDone',
        played: n,
        results: { w, b, d },
        stats: watcher.getStats(),
        gameLog: lastGame ? lastGame.moveLog : [],
        gameResult: lastGame ? lastGame.result : 0
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
