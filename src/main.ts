import Phaser from 'phaser';
import { gameConfig } from './config/gameConfig';
import { generateLevel, getFieldSize } from './core/levelGen';
import { simulateBattle } from './core/battleSim';
import { laneArsenals, applyBattleResult } from './core/progression';
import { getState, save } from './core/storage';

const game = new Phaser.Game(gameConfig);

// Dev-инструменты вырезаются из release (Vite tree-shaking по import.meta.env.DEV).
if (import.meta.env.DEV) {
  const w = window as unknown as Record<string, unknown>;
  w.__game = game;
  w.__zm = { generateLevel, getFieldSize, simulateBattle, laneArsenals, applyBattleResult, getState, save };
  void import('./ui/devPanel').then((m) => m.initDevPanel(game));
}
