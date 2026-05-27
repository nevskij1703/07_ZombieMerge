import Phaser from 'phaser';
import { SceneKey } from './sceneKeys';

// Точка инициализации. Пока ассетов нет — сразу уходим в базовую сцену.
// Позже здесь будет загрузка atlas/spine/audio и инициализация сейва.
export class BootScene extends Phaser.Scene {
  constructor() {
    super(SceneKey.Boot);
  }

  create(): void {
    this.scene.start(SceneKey.Base);
  }
}
