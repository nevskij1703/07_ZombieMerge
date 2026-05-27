import Phaser from 'phaser';
import { SceneKey } from './sceneKeys';
import { DESIGN_WIDTH, DESIGN_HEIGHT, COLORS } from '../config/constants';

// Главный экран базы (вид сверху). Пока — заглушка-каркас на примитивах,
// чтобы убедиться что рендер и масштабирование работают. Мердж-поле, Мастерская,
// HUD и кнопка «В бой» появятся на этапах 5–6.
export class BaseScene extends Phaser.Scene {
  constructor() {
    super(SceneKey.Base);
  }

  create(): void {
    const cx = DESIGN_WIDTH / 2;

    // Зоны экрана: город (сверху) / забор / база (снизу).
    this.add.rectangle(cx, 200, DESIGN_WIDTH, 400, COLORS.city).setOrigin(0.5);
    this.add.rectangle(cx, 410, DESIGN_WIDTH, 20, COLORS.fence).setOrigin(0.5);
    this.add
      .rectangle(cx, DESIGN_HEIGHT - 320, DESIGN_WIDTH, 640, COLORS.base)
      .setOrigin(0.5);

    this.add
      .text(cx, 90, 'ZombieMerge', {
        fontFamily: 'monospace',
        fontSize: '52px',
        color: '#9fe870',
      })
      .setOrigin(0.5);

    this.add
      .text(cx, DESIGN_HEIGHT / 2 + 120, 'каркас работает', {
        fontFamily: 'monospace',
        fontSize: '30px',
        color: '#cccccc',
      })
      .setOrigin(0.5);
  }
}
