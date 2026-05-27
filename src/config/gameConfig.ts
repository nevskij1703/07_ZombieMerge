import Phaser from 'phaser';
import { DESIGN_WIDTH, DESIGN_HEIGHT, COLORS } from './constants';
import { BootScene } from '../scenes/BootScene';
import { BaseScene } from '../scenes/BaseScene';
import { BattleScene } from '../scenes/BattleScene';

export const gameConfig: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: COLORS.bg,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: DESIGN_WIDTH,
    height: DESIGN_HEIGHT,
  },
  render: {
    antialias: true,
    roundPixels: false,
  },
  scene: [BootScene, BaseScene, BattleScene],
};
