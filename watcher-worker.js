'use strict';

const { parentPort } = require('worker_threads');
const { Pool } = require('pg');

let watcher = null;
let dbPool = null;

async function initWatcher() {
  if (!watcher) {
    watcher = require('./watcher-learning');
    if (process.env.DATABASE_URL_WATCHER) {
      dbPool = new Pool({
        connectionString: process.env.DATABASE_URL_WATCHER,
        ssl: { rejectUnauthorized: false }
      });
      watcher.setPool(dbPool);
    } else {
      console.warn('[Worker] DATABASE_URL_WATCHER не задан!');
    }
    await watcher.loadWeights();
  }
}

parentPort.on('message', async (msg) => {
  try {
    await initWatcher();

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
      await watcher.saveData();

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
      await watcher.saveData();
      parentPort.postMessage({ type: 'saved' });

    } else if (msg.type === 'stop') {
      if (watcher) await watcher.saveData();
      if (dbPool) { try { await dbPool.end(); } catch (e) {} }
      parentPort.postMessage({ type: 'stopped' });
      process.exit(0);
    }
  } catch (e) {
    parentPort.postMessage({ type: 'error', msg: e.message, stack: e.stack });
  }
});

parentPort.postMessage({ type: 'ready' });
