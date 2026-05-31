// Визуальные эффекты для мердж-поля: ленивая генерация radial-gradient текстур,
// разлетающиеся искры, центральная вспышка + shockwave для мерджа, мини-салют для
// открытия лутбокса. Все функции — pure: работают с переданной `scene`, не зависят
// от состояния поля. Вызываются из `MergeBoard` (`applyMerge`, `playLootboxOpenVfx`).
//
// Архитектурно: VFX отделены от tile-логики, чтобы:
//   1) Не блокировать input — каждая Phaser-tween живёт независимо;
//   2) Кешировать canvas-текстуры (radial gradient) глобально на `scene.textures`,
//      рендерить искры через Image (batch single draw call), а не Arc (per-object
//      vertex submission).

import Phaser from 'phaser';

/**
 * Лениво создать 3 canvas-текстуры для VFX мерджа. Все три — radial gradient.
 * Кешируются в `scene.textures` глобально, повторные вызовы — no-op.
 *
 *   • `merge.spark`     — 32×32 жёлтый soft-dot для летящих искр (8 на мердж).
 *   • `merge.flash`     — 128×128 яркий центральный круг для вспышки.
 *   • `merge.shockwave` — 512×512 кольцо с резкой внешней гранью + soft inward.
 *
 * Использовать Image (texture-based) вместо Arc/Circle (Graphics) даёт batch
 * rendering: Phaser отправляет sparks одной текстуры одним draw call в GPU.
 */
export function ensureMergeVfxTextures(scene: Phaser.Scene): void {
  makeRadialTexture(scene, 'merge.spark', 32, [
    [0.0, 'rgba(255, 244, 179, 1.0)'],
    [0.5, 'rgba(255, 244, 179, 0.55)'],
    [1.0, 'rgba(255, 244, 179, 0.0)'],
  ]);
  makeRadialTexture(scene, 'merge.flash', 128, [
    [0.0, 'rgba(255, 255, 255, 1.0)'],
    [0.6, 'rgba(255, 255, 255, 0.9)'],
    [1.0, 'rgba(255, 255, 255, 0.0)'],
  ]);
  makeRadialTexture(scene, 'merge.shockwave', 512, [
    [0.0, 'rgba(255, 255, 255, 0.0)'],
    [0.55, 'rgba(255, 255, 255, 0.04)'],
    [0.82, 'rgba(255, 255, 255, 0.35)'],
    [0.94, 'rgba(255, 255, 255, 1.0)'],
    [1.0, 'rgba(255, 255, 255, 0.0)'],
  ]);
}

/** Один helper для создания radial-gradient PNG-текстуры через canvas. */
function makeRadialTexture(
  scene: Phaser.Scene,
  key: string,
  size: number,
  stops: Array<[number, string]>,
): void {
  if (scene.textures.exists(key)) return;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const c = size / 2;
  const r = size / 2 - 1;
  const grad = ctx.createRadialGradient(c, c, 0, c, c, r);
  for (const [stop, color] of stops) grad.addColorStop(stop, color);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.fill();
  scene.textures.addCanvas(key, canvas);
}

/**
 * 8 «искр» (Image из `merge.spark`, ADD-blend) летят к `target` с разных
 * радиусов 1.0-1.6 × cellSize. duration варьируется per-spark (65-100%
 * базового) — частицы не приходят в один кадр.
 */
export function spawnMergeSparks(
  scene: Phaser.Scene,
  cellSize: number,
  target: { x: number; y: number },
  duration: number,
): void {
  const COUNT = 8;
  for (let i = 0; i < COUNT; i++) {
    const angle = (Math.PI * 2 * i) / COUNT + (Math.random() - 0.5) * 0.4;
    const radius = cellSize * (1.0 + Math.random() * 0.6);
    const sx = target.x + Math.cos(angle) * radius;
    const sy = target.y + Math.sin(angle) * radius;
    const sizePx = 7 + Math.random() * 4; // 7-11 px видимый диаметр
    const spark = scene.add
      .image(sx, sy, 'merge.spark')
      .setOrigin(0.5)
      .setDepth(40)
      .setBlendMode(Phaser.BlendModes.ADD);
    spark.setDisplaySize(sizePx, sizePx);
    scene.tweens.add({
      targets: spark,
      x: target.x,
      y: target.y,
      scaleX: spark.scaleX * 0.2,
      scaleY: spark.scaleY * 0.2,
      alpha: 0,
      duration: duration * (0.65 + Math.random() * 0.35),
      ease: 'Quad.In',
      onComplete: () => spark.destroy(),
    });
  }
}

/** 12 «искр» (ADD-blend Image из `merge.spark`) разлетаются НАРУЖУ от центра.
 *  Используется при открытии лутбокса (мини-салют). */
export function spawnLootboxFireworks(
  scene: Phaser.Scene,
  cellSize: number,
  center: { x: number; y: number },
): void {
  const COUNT = 12;
  for (let i = 0; i < COUNT; i++) {
    const angle = (Math.PI * 2 * i) / COUNT + (Math.random() - 0.5) * 0.3;
    const distance = cellSize * (0.9 + Math.random() * 0.5); // 0.9-1.4 × cellSize
    const sizePx = 7 + Math.random() * 4;
    const spark = scene.add
      .image(center.x, center.y, 'merge.spark')
      .setOrigin(0.5)
      .setDepth(40)
      .setBlendMode(Phaser.BlendModes.ADD);
    spark.setDisplaySize(sizePx, sizePx);
    scene.tweens.add({
      targets: spark,
      x: center.x + Math.cos(angle) * distance,
      y: center.y + Math.sin(angle) * distance,
      scaleX: spark.scaleX * 0.2,
      scaleY: spark.scaleY * 0.2,
      alpha: 0,
      duration: 380 + Math.random() * 140,
      ease: 'Quad.Out',
      onComplete: () => spark.destroy(),
    });
  }
}

/**
 * VFX мерджа двух плиток (~440 ms всего). НЕ блокирует input и НЕ блокирует
 * параллельные мерджи — каждый VFX живёт независимо.
 *   Phase 1 (0-60ms):    fromTile долетает до центра to-ячейки (если был drag).
 *   Phase 2 (60-180ms):  расходятся ±25% cellSize по X («накапливают энергию»).
 *   Phase 3 (180-330ms): тряска (yoyo по 25ms, 3 repeat) с мелким смещением по Y.
 *   Phase 4 (330-440ms): резкое схождение в центр, scale → 0.3, alpha → 0.
 *   Phase 5 (440+ms):    вспышка ADD-blend круга, fade-in новой плитки tier+1.
 *   Параллельно (0-580ms): 8 «искр» с радиусов 1.0-1.6 × cellSize летят к центру.
 *
 * `newTile` уже создан вызывающим кодом и помечен alpha=0/scale=0.5. Если до
 * завершения фазы 5 он успел стать частью другого мерджа (data 'finalized' === true)
 * или был destroy'ed — пропускаем fade-in, не дёргаем повторно.
 */
export function playMergeVfx(
  scene: Phaser.Scene,
  cellSize: number,
  fromTile: Phaser.GameObjects.Container,
  toTile: Phaser.GameObjects.Container,
  toCenter: { x: number; y: number },
  newTile: Phaser.GameObjects.Container,
): void {
  // Поднимаем участников поверх остальных плиток.
  fromTile.setDepth(50);
  toTile.setDepth(50);

  // Искорки.
  spawnMergeSparks(scene, cellSize, toCenter, 580);

  // Phase 1: from → центр.
  scene.tweens.add({
    targets: fromTile,
    x: toCenter.x,
    y: toCenter.y,
    duration: 60,
    ease: 'Sine.Out',
  });

  // Phase 2: разъезд (через 60ms).
  scene.time.delayedCall(60, () => {
    if (!fromTile.active || !toTile.active) return;
    scene.tweens.add({
      targets: fromTile,
      x: toCenter.x - cellSize * 0.25,
      duration: 120,
      ease: 'Sine.Out',
    });
    scene.tweens.add({
      targets: toTile,
      x: toCenter.x + cellSize * 0.25,
      duration: 120,
      ease: 'Sine.Out',
    });
  });

  // Phase 3: тряска (через 180ms, длится 150ms = 3 yoyo по 25ms).
  scene.time.delayedCall(180, () => {
    if (!fromTile.active || !toTile.active) return;
    scene.tweens.add({
      targets: fromTile,
      y: toCenter.y + 4,
      x: toCenter.x - cellSize * 0.25 - 3,
      duration: 25,
      yoyo: true,
      repeat: 2,
      ease: 'Sine.InOut',
    });
    scene.tweens.add({
      targets: toTile,
      y: toCenter.y - 4,
      x: toCenter.x + cellSize * 0.25 + 3,
      duration: 25,
      yoyo: true,
      repeat: 2,
      ease: 'Sine.InOut',
      delay: 12, // фаза смещена — обе плитки трясутся «не в такт»
    });
  });

  // Phase 4: схождение (через 330ms).
  scene.time.delayedCall(330, () => {
    if (!fromTile.active || !toTile.active) return;
    scene.tweens.killTweensOf(fromTile);
    scene.tweens.killTweensOf(toTile);
    scene.tweens.add({
      targets: [fromTile, toTile],
      x: toCenter.x,
      y: toCenter.y,
      scaleX: 0.3,
      scaleY: 0.3,
      alpha: 0,
      duration: 110,
      ease: 'Quad.In',
      onComplete: () => {
        // Phase 5a: центральная вспышка (Image из shared `merge.flash` текстуры,
        // ADD-blend — даёт яркую засветку поверх вспышки).
        const flash = scene.add
          .image(toCenter.x, toCenter.y, 'merge.flash')
          .setOrigin(0.5)
          .setDepth(60)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setAlpha(0.9);
        flash.setDisplaySize(cellSize * 0.24, cellSize * 0.24);
        scene.tweens.add({
          targets: flash,
          displayWidth: cellSize * 1.44,
          displayHeight: cellSize * 1.44,
          alpha: 0,
          duration: 200,
          ease: 'Quad.Out',
          onComplete: () => flash.destroy(),
        });
        // Phase 5b: shockwave — кольцо с резким внешним фронтом и мягким
        // fade к центру. Расширяется от cs*0.4 до cs*2.5 за 380ms.
        const wave = scene.add
          .image(toCenter.x, toCenter.y, 'merge.shockwave')
          .setOrigin(0.5)
          .setDepth(55)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setAlpha(0.85);
        wave.setDisplaySize(cellSize * 0.4, cellSize * 0.4);
        scene.tweens.add({
          targets: wave,
          displayWidth: cellSize * 2.5,
          displayHeight: cellSize * 2.5,
          alpha: 0,
          duration: 380,
          ease: 'Quad.Out',
          onComplete: () => wave.destroy(),
        });
        // Появление новой плитки — только если ещё актуальна (не была
        // подхвачена другим мерджем как `oldToTile` и не destroy'ed).
        if (newTile.active && !newTile.getData('finalized')) {
          scene.tweens.add({
            targets: newTile,
            alpha: 1,
            scaleX: { from: 0.5, to: 1 },
            scaleY: { from: 0.5, to: 1 },
            duration: 180,
            ease: 'Back.Out',
          });
        }
        // Старые tiles уничтожаем (если ещё живы — другой мердж мог их
        // использовать как oldToTile и destroy раньше, но это маловероятно).
        if (fromTile.active) fromTile.destroy();
        if (toTile.active) toTile.destroy();
      },
    });
  });
}

/**
 * Анимация «лутбокс распахивается» (~180 ms): старая плитка-лутбокс пухнет до
 * scale 1.3 за 80ms (Quad.Out), потом схлопывается до 0/alpha=0 за 100ms (Quad.In),
 * destroy. Параллельно — мини-салют 12 искр НАРУЖУ.
 *
 * Спавн новой weapon-плитки и её fade-in делает caller через delayedCall(180),
 * потому что это требует state-доступа (this.field.cells[index], this.makeTile,
 * this.tileByIndex). Здесь — только анимация старого + салют.
 */
export function playLootboxBurst(
  scene: Phaser.Scene,
  cellSize: number,
  oldTile: Phaser.GameObjects.Container,
  center: { x: number; y: number },
): void {
  // Phase 1: пухнем.
  scene.tweens.add({
    targets: oldTile,
    scaleX: 1.3,
    scaleY: 1.3,
    duration: 80,
    ease: 'Quad.Out',
    onComplete: () => {
      // Phase 2: схлопываемся и destroy.
      if (!oldTile.active) return;
      scene.tweens.add({
        targets: oldTile,
        scaleX: 0,
        scaleY: 0,
        alpha: 0,
        duration: 100,
        ease: 'Quad.In',
        onComplete: () => {
          if (oldTile.active) oldTile.destroy();
        },
      });
    },
  });

  // Параллельно — мини-салют наружу от центра.
  spawnLootboxFireworks(scene, cellSize, center);
}
