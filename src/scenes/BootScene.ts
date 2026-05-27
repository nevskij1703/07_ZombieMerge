import Phaser from 'phaser';
import { SceneKey } from './sceneKeys';
import { load } from '../core/storage';
import { migrationsSelfTest } from '../core/migrations';

// Точка инициализации. Пока ассетов нет — сразу уходим в базовую сцену.
// Позже здесь будет загрузка atlas/spine/audio и инициализация сейва.
export class BootScene extends Phaser.Scene {
  constructor() {
    super(SceneKey.Boot);
  }

  create(): void {
    if (import.meta.env.DEV) {
      try {
        migrationsSelfTest();
        console.info('[migrations] self-test OK');
      } catch (e) {
        console.error(e);
      }
    }
    load();
    this.scene.start(SceneKey.Base);
  }
}
