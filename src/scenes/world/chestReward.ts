// Визуал сундука: смена спрайта close→opened + рендер контента с fly-up + glow +
// idle levitate. Не управляет state — только рисует Phaser-объекты. Caller отвечает
// за: mutation lane state (chestOpened, reachedChest, scrapCollected, …) и push
// объектов в `battleNodes` для cleanup'а после боя.

import Phaser from 'phaser';
import { TIER_COLORS, WEAPON_FRAME_PX, LOOTBOX_ICON_SCALE } from '../../config/constants';
import type { ChestDef } from '../../types';

/** Render-размеры PNG-сундука. Пропорции original: 995×1812 (≈ 1:1.82, очень
 *  «высокий» сундук с местом сверху для откидной крышки). Width 100 + сохранение
 *  aspect ratio → height 182. Origin якорится по НИЖНЕМУ краю (0.5, 1) в
 *  `battleTick.ts`, поэтому база сидит на chestRowY, верх уходит вверх. ~2× больше
 *  старых body+lid (~58×50). Используется в `buildLaneRuntime` для создания и в
 *  `openChestVisual` для re-apply'я после `setTexture`. */
export const CHEST_DISPLAY_W = 100;
export const CHEST_DISPLAY_H = 182;

/**
 * Открыть сундук: swap текстуры close→opened + лёгкий «bounce» по Y (импульс
 * вверх-вниз 200ms). Скейл re-apply после setTexture на случай, если в будущем
 * close/opened ассеты будут разных размеров (сейчас оба 995×1812 — но safer).
 */
export function openChestVisual(
  scene: Phaser.Scene,
  chest: Phaser.GameObjects.Image,
): void {
  if (scene.textures.exists('ui.chest_opened')) {
    chest.setTexture('ui.chest_opened');
    chest.setDisplaySize(CHEST_DISPLAY_W, CHEST_DISPLAY_H);
  }
  // Лёгкий импульс вверх для ощущения «открылся».
  const baseY = chest.y;
  scene.tweens.add({
    targets: chest,
    y: baseY - 6,
    duration: 110,
    yoyo: true,
    ease: 'Sine.Out',
  });
  // Лёгкая «вспышка» масштаба.
  const baseScaleX = chest.scaleX;
  const baseScaleY = chest.scaleY;
  scene.tweens.add({
    targets: chest,
    scaleX: baseScaleX * 1.06,
    scaleY: baseScaleY * 1.06,
    duration: 140,
    yoyo: true,
    ease: 'Sine.Out',
  });
}

/**
 * Отрисовать награду сундука над линией. Возвращает container — caller добавляет
 * в `battleNodes` для cleanup'а после боя. Анимация (3 фазы):
 *
 *   Phase 1 (FLY): container стартует ВНУТРИ сундука (chestRowY - h*0.4), невидим
 *                  (alpha=0, scale=0.3). Tween за 420ms вверх на ~110px (до
 *                  hover-Y), параллельно scale→1, alpha→1. Ease=Back.Out для
 *                  «выскакивает».
 *   Phase 2 (GLOW): одновременно с FLY — белый radial-gradient (merge.flash,
 *                  ADD-blend) расширяется от ~20px до ~150px и fade'ает за 550ms.
 *                  Даёт ощущение «магического» появления.
 *   Phase 3 (LEVITATE): после FLY — бесконечный yoyo: y ±5px (1300ms),
 *                  параллельно scale 1.0↔1.05 (1500ms), Sine.InOut. Награда
 *                  парит над сундуком, слегка пульсирует.
 *
 * Контент (по `chestDef.reward`):
 *   • 'weapon' с загруженной weapon.t<N> иконкой → PNG-иконка + tier-digit
 *     (стиль merge-плитки);
 *   • 'lootbox' с загруженной ui.lootbox_<kind> иконкой → PNG лутбокса
 *     (с LOOTBOX_ICON_SCALE);
 *   • fallback (PNG не загружен / scrap-награда) → цветной квадратик с label.
 */
export function renderChestContent(
  scene: Phaser.Scene,
  chestDef: ChestDef,
  cx: number,
  chestBaseY: number,
): Phaser.GameObjects.Container {
  const size = 54;
  // chestBaseY = низ видимого сундука (origin 0.5,1). Сундук растёт ВВЕРХ от
  // chestBaseY на CHEST_DISPLAY_H. Координаты:
  //   • startY (= -35% от высоты сундука): внутри тела, чуть выше середины —
  //     там, где «лежит» предмет до открытия.
  //   • hoverY (= -95% от высоты + ~20px): чуть выше крышки в открытом
  //     состоянии. Награда зависает там и покачивается. ~110-120px подъёма
  //     от startY — хорошо читаемое движение, не слишком долгое.
  const hoverY = chestBaseY - CHEST_DISPLAY_H * 0.95 - 18;
  const startY = chestBaseY - CHEST_DISPLAY_H * 0.35;
  const container = scene.add.container(cx, startY).setDepth(15).setScale(0.3).setAlpha(0);

  // Заполняем контент (children внутри container).
  populateRewardChildren(scene, container, chestDef, size);

  // Phase 1: FLY-UP (420ms) — наружу/вверх со scale+fade.
  scene.tweens.add({
    targets: container,
    y: hoverY,
    scaleX: 1,
    scaleY: 1,
    alpha: 1,
    duration: 420,
    ease: 'Back.Out',
    onComplete: () => {
      // Phase 3: LEVITATE — две бесконечные yoyo-цепочки (не блокируют друг друга).
      if (!container.active) return;
      scene.tweens.add({
        targets: container,
        y: hoverY - 5,
        duration: 1300,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.InOut',
      });
      scene.tweens.add({
        targets: container,
        scaleX: 1.05,
        scaleY: 1.05,
        duration: 1500,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.InOut',
      });
    },
  });

  // Phase 2: GLOW (550ms, ADD-blend круг) — параллельно с FLY-UP. Использует
  // shared текстуру `merge.flash` (создаётся в `ensureMergeVfxTextures` при
  // постройке MergeBoard'а в base UI — всегда доступна к моменту первого боя).
  if (scene.textures.exists('merge.flash')) {
    const glow = scene.add
      .image(cx, hoverY, 'merge.flash')
      .setOrigin(0.5)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setAlpha(0.85)
      .setDepth(14); // под наградой (depth 15), поверх остального
    glow.setDisplaySize(20, 20);
    scene.tweens.add({
      targets: glow,
      displayWidth: 150,
      displayHeight: 150,
      alpha: 0,
      duration: 550,
      ease: 'Quad.Out',
      onComplete: () => glow.destroy(),
    });
  }

  return container;
}

/**
 * Наполнить контейнер награды children'ами по правилу:
 *   • weapon + PNG-иконка загружена → иконка оружия + tier-digit;
 *   • lootbox + PNG-иконка загружена → PNG лутбокса (× LOOTBOX_ICON_SCALE);
 *   • иначе (scrap / fallback) → цветной квадратик с label.
 *
 * Все children позиционируются относительно центра container'а (0, 0). Caller
 * сам управляет позицией / scale / alpha container'а (см. fly-up + levitate).
 */
function populateRewardChildren(
  scene: Phaser.Scene,
  container: Phaser.GameObjects.Container,
  chestDef: ChestDef,
  size: number,
): void {
  // Weapon с PNG.
  if (chestDef.reward === 'weapon') {
    const t = chestDef.weaponTier ?? 1;
    const iconKey = `weapon.t${t}`;
    if (scene.textures.exists(iconKey)) {
      const tex = scene.textures.get(iconKey).getSourceImage();
      const iw = (tex as { width: number }).width ?? 1;
      const ih = (tex as { height: number }).height ?? 1;
      const target = size * 0.85;
      const scale = target / WEAPON_FRAME_PX;
      const icon = scene.add
        .image(0, 0, iconKey)
        .setOrigin(0.5)
        .setDisplaySize(iw * scale, ih * scale);
      // Tier digit — Inter Black 900, чёрный полупрозрачный (как в merge-плитке).
      const tierFont = Math.max(10, Math.round((size * 32) / 136));
      const tierBadge = scene.add
        .text(size * 0.35, size * 0.35, String(t), {
          fontFamily: 'Inter, Roboto, Arial Black, sans-serif',
          fontStyle: '900',
          fontSize: `${tierFont}px`,
          color: 'rgba(0, 0, 0, 0.30)',
        })
        .setOrigin(0.5);
      container.add([icon, tierBadge]);
      return;
    }
  }

  // Lootbox с PNG.
  if (chestDef.reward === 'lootbox' && chestDef.lootboxKind) {
    const texKey = `ui.lootbox_${chestDef.lootboxKind}`;
    if (scene.textures.exists(texKey)) {
      const target = size * LOOTBOX_ICON_SCALE;
      const img = scene.add.image(0, 0, texKey).setOrigin(0.5);
      img.setDisplaySize(target, target);
      container.add(img);
      return;
    }
  }

  // Fallback: цветной квадратик с подписью.
  let fillColor = 0x888888;
  let labelTxt = '';
  let labelColor = '#ffffff';
  let strokeColor = 0x000000;
  let strokeAlpha = 0.4;
  let labelFontFactor = 0.5;
  if (chestDef.reward === 'scrap') {
    fillColor = 0x6b7785;
    labelTxt = `+${chestDef.scrap ?? 0}`;
    labelColor = '#9fe870';
    labelFontFactor = 0.4;
  } else if (chestDef.reward === 'weapon') {
    const t = chestDef.weaponTier ?? 1;
    fillColor = TIER_COLORS[t] ?? 0x888888;
    labelTxt = String(t);
  } else if (chestDef.reward === 'lootbox') {
    const kind = chestDef.lootboxKind;
    fillColor = kind === 'elite' ? 0x9b59b6 : kind === 'medium' ? 0xd4a017 : 0x8a6a3a;
    labelTxt = '📦';
    strokeColor = 0xffffff;
    strokeAlpha = 0.7;
    labelFontFactor = 0.6;
  }
  const bg = scene.add
    .rectangle(0, 0, size, size, fillColor)
    .setOrigin(0.5)
    .setStrokeStyle(3, strokeColor, strokeAlpha);
  const label = scene.add
    .text(0, 0, labelTxt, {
      fontFamily: 'monospace',
      fontSize: `${Math.round(size * labelFontFactor)}px`,
      color: labelColor,
    })
    .setOrigin(0.5);
  label.setStroke('#000000', 3);
  container.add([bg, label]);
}
