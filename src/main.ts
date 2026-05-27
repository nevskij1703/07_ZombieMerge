import Phaser from 'phaser';
import { gameConfig } from './config/gameConfig';

const game = new Phaser.Game(gameConfig);

// Dev-инструменты вырезаются из release (Vite tree-shaking по import.meta.env.DEV).
if (import.meta.env.DEV) {
  (window as unknown as { __game: Phaser.Game }).__game = game;
  void import('./ui/devPanel').then((m) => m.initDevPanel(game));
}
