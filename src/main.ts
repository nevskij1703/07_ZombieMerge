import Phaser from 'phaser';
import { gameConfig } from './config/gameConfig';
import { generateLevel, getFieldSize } from './core/levelGen';
import { simulateBattle } from './core/battleSim';
import { laneArsenals, applyBattleResult } from './core/progression';
import { getState, save } from './core/storage';

const game = new Phaser.Game(gameConfig);

// Держим input-координаты в синхроне с реальным положением/размером канваса.
// Phaser обновляет canvasBounds (трансформацию экран->игра) на window 'resize'. Но если
// контейнер меняет размер БЕЗ этого события (встроенное превью/iframe, появление скроллбара,
// адресная строка/клавиатура на мобиле), bounds устаревают и клики промахиваются (смещение).
// refresh() пересчитывает FIT + canvasBounds. На pointerdown — гарантируем актуальность перед
// тем как Phaser обработает клик (он делает это на следующем кадре, читая свежие bounds).
game.events.once('ready', () => {
  const refresh = (): void => {
    game.scale.refresh();
  };
  window.addEventListener('resize', refresh);
  window.addEventListener('scroll', refresh, true);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(refresh).observe(document.documentElement);
  }
  game.canvas?.addEventListener('pointerdown', refresh);
});

// Dev-инструменты вырезаются из release (Vite tree-shaking по import.meta.env.DEV).
if (import.meta.env.DEV) {
  const w = window as unknown as Record<string, unknown>;
  w.__game = game;
  w.__zm = { generateLevel, getFieldSize, simulateBattle, laneArsenals, applyBattleResult, getState, save };
  void import('./ui/devPanel').then((m) => m.initDevPanel(game));
}
