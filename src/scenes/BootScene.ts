import Phaser from 'phaser';
import { SceneKey } from './sceneKeys';
import { load } from '../core/storage';
import { migrationsSelfTest } from '../core/migrations';
import { coreSelfTest, battleSelfTest, levelSanityTest } from '../core/selfTest';
import { parseLocation, uniqueImages, type LocationManifest } from '../art/locationLoader';

// Точка инициализации. Двухфазная загрузка:
//   1) JSON-манифесты локаций (base, ui).
//   2) Растровые тайлы + SVG-кнопки. SVG грузится с заданными width/height (Phaser-load.svg
//      рендерит SVG в текстуру нужного размера).
// Затем self-tests и переход в World.
export class BootScene extends Phaser.Scene {
  constructor() {
    super(SceneKey.Boot);
  }

  preload(): void {
    this.load.json('base-layout', './art/base/base.json');
    this.load.json('ui-layout', './art/ui/main.json');
  }

  create(): void {
    const baseJson = this.cache.json.get('base-layout');
    const uiJson = this.cache.json.get('ui-layout');

    if (baseJson) this.queueLocationAssets(parseLocation(baseJson), 'base', './art/base/images');
    if (uiJson) this.queueUiAssets(uiJson as LocationManifest);

    // Если что-то висит в очереди — стартуем загрузку. Иначе сразу финал.
    if (this.load.totalToLoad > 0) {
      this.load.once(Phaser.Loader.Events.COMPLETE, () => this.finishBoot());
      this.load.start();
    } else {
      this.finishBoot();
    }
  }

  private queueLocationAssets(manifest: LocationManifest, prefix: string, basePath: string): void {
    for (const name of uniqueImages(manifest)) {
      const key = `${prefix}.${name}`;
      if (!this.textures.exists(key)) {
        this.load.image(key, `${basePath}/${name}.png`);
      }
    }
  }

  /** UI грузит PNG-иконки + SVG-кнопки (SVG с конкретными размерами). */
  private queueUiAssets(manifest: LocationManifest & { svgs?: Array<{ image: string; width: number; height: number }> }): void {
    for (const t of manifest.tilesets ?? []) {
      const key = `ui.${t.image}`;
      if (!this.textures.exists(key)) {
        this.load.image(key, `./art/ui/images/${t.image}.png`);
      }
    }
    for (const s of manifest.svgs ?? []) {
      const key = `ui.${s.image}`;
      if (!this.textures.exists(key)) {
        this.load.svg(key, `./art/ui/images/${s.image}.svg`, { width: s.width * 2, height: s.height * 2 });
      }
    }
  }

  private finishBoot(): void {
    if (import.meta.env.DEV) {
      try {
        migrationsSelfTest();
        coreSelfTest();
        battleSelfTest();
        levelSanityTest();
        console.info('[selftest] migrations + core + battle + levels OK');
      } catch (e) {
        console.error(e);
      }
    }
    load();
    this.scene.start(SceneKey.World);
  }
}
