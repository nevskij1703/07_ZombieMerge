// Базовый арт + дорога + градиенты + лампы. Всё, что относится к ВИЗУАЛЬНОЙ ЛОКАЦИИ
// базы и её аугментациям при бою. State:
//   • baseLocation — built из base.json (картинки base.gate_l / base.lamp_l / и т.д.)
//   • baseManifest — исходный манифест (для tileset lookup в road-генерации)
//   • baseRoadContainer — контейнер всех тайлов дороги (для редактора + global offset)
//   • baseRoadTopY — самая высокая Y-координата дороги в base-режиме (точка для extend)
//   • gradientTop / gradientBot — canvas-нарисованные тёмные затемнения сверху/снизу
//   • lampTweens — активные tween-ы мигания ламп (cleanup при закрытии ворот)
//
// Используется в WorldScene: вызывается на create() (init), goBattle (extendRoad +
// hideGradients), returnToBase (restoreGradients + closeGates + fadeLampsOff).

import Phaser from 'phaser';
import { DESIGN_WIDTH } from '../../config/constants';
import {
  parseLocation,
  buildLocation,
  findTileset,
  type BuiltLocation,
  type LocationManifest,
} from '../../art/locationLoader';
import { loadOverrides, applyOverride } from '../../editor/layoutOverrides';
import { GATE_Y } from './constants';

/** Контроллер base-арта. Создаётся в `WorldScene.create()` ОДИН РАЗ; persistent
 *  между боями. Все методы — safe to call даже если manifest не загружен (no-op). */
export class BaseArtController {
  private readonly scene: Phaser.Scene;
  baseLocation: BuiltLocation | null = null;
  baseManifest: LocationManifest | null = null;
  /** Самая высокая (наименьшая) Y, которую покрыла дорога в base-режиме. Точка
   *  старта для extend'а дороги при входе в бой. */
  baseRoadTopY = 0;
  baseRoadContainer: Phaser.GameObjects.Container | null = null;
  /** Активные tween-ы мигания ламп. Track'аем, чтобы при closeGates остановить + fadeOff. */
  private lampTweens: Phaser.Tweens.Tween[] = [];
  private gradientTop: Phaser.GameObjects.Image | null = null;
  private gradientBot: Phaser.GameObjects.Image | null = null;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  /** Построить всё: base art layers + дорогу + градиенты. Вызывается из `create()`.
   *  Idempotent для градиентов (textures.exists проверка), для арта/дороги — нет. */
  build(): void {
    this.buildBaseArt();
    this.buildBaseRoad();
    this.buildGradients();
  }

  /** Get base art image by id (для layout editor + open/close gates в WorldScene). */
  byId(id: string): Phaser.GameObjects.Image | undefined {
    return this.baseLocation?.byId.get(id);
  }

  /** Iterator всех base art elements — для регистрации в layout editor. */
  *entries(): IterableIterator<[string, Phaser.GameObjects.Image]> {
    if (!this.baseLocation) return;
    yield* this.baseLocation.byId.entries();
  }

  // ============================== Base art layers =============================

  private buildBaseArt(): void {
    const json = this.scene.cache.json.get('base-layout');
    if (!json) return;
    const manifest = parseLocation(json);
    this.baseManifest = manifest;
    if (manifest.layers.length === 0) return;
    this.baseLocation = buildLocation(
      this.scene,
      manifest,
      { originX: 0, originY: -2524, scale: 1, baseDepth: -50, texturePrefix: 'base' },
      loadOverrides(),
    );
    // Изначально ворота закрыты → лампы выключены (alpha 0). При открытии ворот в
    // startLampBlink() — fade-in; при закрытии в fadeLampsOff() — fade-out.
    for (const lamp of this.getLamps()) lamp.setAlpha(0);
  }

  // ============================== Lamp blink =================================

  /** Спрайты светящихся ламп из base-локации (l + r, в любом порядке). */
  private getLamps(): Phaser.GameObjects.Image[] {
    const out: Phaser.GameObjects.Image[] = [];
    const l = this.baseLocation?.byId.get('base.lamp_l');
    const r = this.baseLocation?.byId.get('base.lamp_r');
    if (l) out.push(l);
    if (r) out.push(r);
    return out;
  }

  /** Запустить мигание ламп: fade-in alpha→1 за время открытия ворот, затем yoyo 1↔0.5. */
  startLampBlink(): void {
    this.stopLampTweens();
    const lamps = this.getLamps();
    if (lamps.length === 0) return;
    const fadeIn = this.scene.tweens.add({
      targets: lamps,
      alpha: 1,
      duration: 600,
      ease: 'Sine.Out',
      onComplete: () => {
        const blink = this.scene.tweens.add({
          targets: lamps,
          alpha: 0.5,
          duration: 700,
          ease: 'Sine.InOut',
          yoyo: true,
          repeat: -1,
        });
        this.lampTweens.push(blink);
      },
    });
    this.lampTweens.push(fadeIn);
  }

  /** Погасить лампы (ворота закрылись): fade-out alpha→0 синхронно со схлопыванием ворот. */
  fadeLampsOff(): void {
    this.stopLampTweens();
    const lamps = this.getLamps();
    if (lamps.length === 0) return;
    this.scene.tweens.add({
      targets: lamps,
      alpha: 0,
      duration: 600,
      ease: 'Sine.InOut',
    });
  }

  /** Остановить все активные tweens на лампах (не трогает alpha — это делают вызывающие). */
  private stopLampTweens(): void {
    for (const t of this.lampTweens) t.stop();
    this.lampTweens = [];
    for (const lamp of this.getLamps()) this.scene.tweens.killTweensOf(lamp);
  }

  // ============================== Road =======================================

  private buildBaseRoad(): void {
    this.baseRoadContainer = this.scene.add.container(0, 0).setDepth(-49.5);
    this.baseRoadTopY = this.buildRoadStripe(GATE_Y, 0, false, null);
    // base.road не в `layers` манифеста (рендерится динамически здесь), поэтому
    // locationLoader не накладывает на него built-in manifest-override. Делаем явно,
    // чтобы команда-настройки (положение/depth) из base.json применялись и к road.
    const builtin = this.baseManifest?.overrides?.['base.road'];
    if (builtin) applyOverride(this.baseRoadContainer, builtin);
  }

  /**
   * Достроить дорогу ВЫШЕ baseRoadTopY до `targetTop`. Создаваемые тайлы пишутся
   * в `battleNodes` — после боя сцена их destroy'ит, оставив только base-часть.
   */
  extendRoadForBattle(targetTop: number, battleNodes: Phaser.GameObjects.GameObject[]): void {
    const baseTopWorld = this.baseRoadTopY + (this.baseRoadContainer?.y ?? 0);
    if (targetTop < baseTopWorld) {
      this.buildRoadStripe(baseTopWorld + 1, targetTop, true, battleNodes);
    }
  }

  private buildRoadStripe(
    bottomY: number,
    topY: number,
    intoBattle: boolean,
    battleNodes: Phaser.GameObjects.GameObject[] | null,
  ): number {
    const tilesetKey = 'base.road_l1';
    if (!this.scene.textures.exists(tilesetKey) || bottomY <= topY) return bottomY;
    const tileset = this.baseManifest ? findTileset(this.baseManifest, 'road_l1') : null;
    const sourceW = tileset?.width ?? 463;
    const sourceH = tileset?.height ?? 314;
    const aspect = sourceH / sourceW;
    const tileW = DESIGN_WIDTH / 2;
    const tileH = tileW * aspect;
    const stepY = tileH - 1;
    const overshoot = stepY * 0.6;
    const totalH = bottomY - topY + overshoot;
    const tileCount = Math.max(1, Math.ceil(totalH / stepY));
    const leftCx = DESIGN_WIDTH / 4;
    const rightCx = (3 * DESIGN_WIDTH) / 4;
    const container = this.baseRoadContainer;
    const dx = container?.x ?? 0;
    const dy = container?.y ?? 0;
    let topReached = bottomY;
    for (let i = 0; i < tileCount; i++) {
      const cy = bottomY - tileH / 2 - i * stepY;
      const left = this.scene.add
        .image(leftCx - dx, cy - dy, tilesetKey)
        .setOrigin(0.5)
        .setDisplaySize(tileW, tileH);
      const right = this.scene.add
        .image(rightCx - dx, cy - dy, tilesetKey)
        .setOrigin(0.5)
        .setDisplaySize(tileW, tileH)
        .setFlipX(true);
      if (container) container.add([left, right]);
      else {
        left.setDepth(-49.5);
        right.setDepth(-49.5);
      }
      if (intoBattle && battleNodes) battleNodes.push(left, right);
      topReached = cy - tileH / 2;
    }
    return topReached;
  }

  // ============================== Gradients ==================================

  /** Создать два canvas-градиента (top: затемнение под HUD, bot: затемнение под button row).
   *  Idempotent: повторный вызов не делает ничего, если текстуры уже созданы. */
  private buildGradients(): void {
    const make = (key: string, w: number, h: number, flipped: boolean): void => {
      if (this.scene.textures.exists(key)) return;
      const tex = this.scene.textures.createCanvas(key, w, h);
      if (!tex) return;
      const ctx = tex.getContext();
      const [y0, y1] = flipped ? [0, h] : [h, 0];
      const grd = ctx.createLinearGradient(0, y0, 0, y1);
      grd.addColorStop(0, 'rgba(0,0,0,0.5)');
      grd.addColorStop(0.5, 'rgba(0,0,0,0.5)');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, w, h);
      tex.refresh();
    };
    make('grad-top', DESIGN_WIDTH, 215, true);
    make('grad-bot', DESIGN_WIDTH, 222, false);
    this.gradientTop = this.scene.add
      .image(0, 0, 'grad-top')
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(250);
    this.gradientBot = this.scene.add
      .image(0, 1058, 'grad-bot')
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(99);
  }

  /** Скрыть/показать оба градиента (вызывается в goBattle/returnToBase). */
  setGradientsVisible(visible: boolean): void {
    this.gradientTop?.setVisible(visible);
    this.gradientBot?.setVisible(visible);
  }

  /** Открыть ворота (анимация, ~600ms). После завершения вызывается onComplete.
   *  Параллельно стартует мигание ламп. Идемпотентно безопасно — если ворот в
   *  локации нет, onComplete вызывается через delayedCall(600). */
  openGates(onComplete: () => void): void {
    const gateL = this.byId('base.gate_l') ?? null;
    const gateR = this.byId('base.gate_r') ?? null;
    const shdL = this.byId('base.gate_l_shd') ?? null;
    const shdR = this.byId('base.gate_r_shd') ?? null;
    const leftTargets = [gateL, shdL].filter((x): x is Phaser.GameObjects.Image => x != null);
    const rightTargets = [gateR, shdR].filter((x): x is Phaser.GameObjects.Image => x != null);
    if (leftTargets.length === 0 && rightTargets.length === 0) {
      onComplete();
      return;
    }
    // Запомнить исходные X для последующего закрытия.
    for (const obj of [...leftTargets, ...rightTargets]) {
      if (obj.getData('defaultX') == null) obj.setData('defaultX', obj.x);
    }
    this.startLampBlink();
    const off = 220;
    if (leftTargets.length > 0) {
      this.scene.tweens.add({ targets: leftTargets, x: `-=${off}`, duration: 600, ease: 'Sine.Out' });
    }
    if (rightTargets.length > 0) {
      this.scene.tweens.add({
        targets: rightTargets,
        x: `+=${off}`,
        duration: 600,
        ease: 'Sine.Out',
        onComplete,
      });
    } else {
      this.scene.time.delayedCall(600, onComplete);
    }
  }

  /** Закрыть ворота (анимация ~600ms) + fadeLampsOff. Вызывается в returnToBase. */
  closeGates(): void {
    for (const id of ['base.gate_l', 'base.gate_l_shd', 'base.gate_r', 'base.gate_r_shd']) {
      const obj = this.byId(id);
      if (!obj) continue;
      const def = obj.getData('defaultX');
      if (typeof def === 'number') {
        this.scene.tweens.add({ targets: obj, x: def, duration: 600, ease: 'Sine.InOut' });
      }
    }
    this.fadeLampsOff();
  }
}
