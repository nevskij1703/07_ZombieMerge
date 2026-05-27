import Phaser from 'phaser';
import { DESIGN_WIDTH, UI } from '../config/constants';
import { getState } from '../core/storage';
import { weaponName } from '../core/weapons';

/** Верхний бар: металлолом, алмазы, уровень, тир Мастерской. */
export class Hud {
  private readonly scrapText: Phaser.GameObjects.Text;
  private readonly infoText: Phaser.GameObjects.Text;

  constructor(scene: Phaser.Scene) {
    scene.add.rectangle(DESIGN_WIDTH / 2, 40, DESIGN_WIDTH, 80, UI.hudBg).setOrigin(0.5);
    this.scrapText = scene.add.text(20, 22, '', {
      fontFamily: 'monospace',
      fontSize: '28px',
      color: '#9fe870',
    });
    this.infoText = scene.add
      .text(DESIGN_WIDTH - 20, 24, '', {
        fontFamily: 'monospace',
        fontSize: '22px',
        color: '#cccccc',
      })
      .setOrigin(1, 0);
    this.refresh();
  }

  refresh(): void {
    const s = getState();
    this.scrapText.setText(`Лом: ${s.scrap}   ◆ ${s.diamonds}`);
    this.infoText.setText(`Ур.${s.level}   Цех: ${weaponName(s.workshopTier)}`);
  }
}
