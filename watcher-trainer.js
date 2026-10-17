'use strict';

const watcher = require('./watcher-learning');

let running = true;

process.on('SIGINT', () => {
  console.log('\n[Trainer] Останавливаюсь, сохраняю веса...');
  running = false;
});

process.on('SIGTERM', () => {
  running = false;
});

async function main() {
  watcher.loadWeights();
  console.log('[Trainer] Начинаю self-play. Ctrl+C чтобы остановить.');

  let n = 0;
  let lastSave = Date.now();

  while (running) {
    n++;
    try {
      const result = watcher.playSelfPlayGame();
      const s = watcher.getStats();

      // Логировать каждые 10 партий, чтобы не спамить
      if (n % 10 === 0 || n <= 5) {
        console.log(`[Trainer] #${n} → ${result === 1 ? 'белые' : result === -1 ? 'чёрные' : 'ничья'}, W/L/D = ${s.wins}/${s.losses}/${s.draws}`);
      }
    } catch (e) {
      console.error('[Trainer] Ошибка партии:', e.message);
    }

    // Сохранять раз в минуту
    if (Date.now() - lastSave > 60 * 1000) {
      watcher.saveData();
      lastSave = Date.now();
    }

    // Пауза, чтобы не грузить CPU на 100%
    await new Promise(r => setTimeout(r, 300));
  }

  watcher.saveData();
  console.log('[Trainer] Остановлен, веса сохранены.');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
