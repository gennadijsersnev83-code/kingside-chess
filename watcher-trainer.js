'use strict';

const watcher = require('./watcher-learning');

async function main() {
  watcher.loadWeights();
  console.log('[Trainer] Начинаю self-play. Ctrl+C чтобы остановить.');

  let n = 0;
  let lastSave = Date.now();

  while (true) {
    n++;
    try {
      const result = watcher.playSelfPlayGame();
      const s = watcher.getStats();
      console.log(`[Trainer] #${n} → result=${result}, всего: ${s.games}, W/L/D=${s.wins}/${s.losses}/${s.draws}`);
    } catch (e) {
      console.error('[Trainer] Ошибка:', e.message);
    }

    if (Date.now() - lastSave > 60 * 1000) {
      watcher.saveData();
      lastSave = Date.now();
    }

    // Пауза, чтобы не грузить CPU на 100%
    await new Promise(r => setTimeout(r, 500));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
