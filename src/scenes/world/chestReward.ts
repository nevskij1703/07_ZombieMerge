// Визуал сундука: открытие лида + рендер контента (оружие / лутбокс / scrap).
// Не управляет state — только рисует Phaser-объекты. Caller отвечает за:
//   • mutation lane state (chestOpened, reachedChest, scrapCollected, …);
//   • push объектов в `battleNodes` для cleanup'а после боя.

import Phaser from 'phaser';
import { TIER_COLORS, WEAPON_FRAME_PX, LOOTBOX_ICON_SCALE } from '../../config/constants';
import type { ChestDef } from '../../types';

/**
 * Анимация открытия сундука: лид взлетает + поворачивается, body перекрашивается
 * в жёлтый, всё чуть «прыгает» (scale yoyo).
 *
 * `chest` — Container из buildLaneRuntime с children: chestBody + chestLid (Rectangle).
 * Body/lid берём через `chest.getData('body'|'lid')`.
 */
export function openChestVisual(
  scene: Phaser.Scene,
  chest: Phaser.GameObjects.Container,
): void {
  const lid = chest.getData('lid') as Phaser.GameObjects.Rectangle | undefined;
  const body = chest.getData('body') as Phaser.GameObjects.Rectangle | undefined;
  body?.setFillStyle(0xf2c63a);
  if (lid) {
    scene.tweens.add({
      targets: lid,
      y: lid.y - 26,
      angle: -28,
      duration: 260,
      ease: 'Back.Out',
    });
  }
  scene.tweens.add({ targets: chest, scale: 1.12, yoyo: true, duration: 160 });
}

/**
 * Отрисовать награду сундука над линией. Возвращает container с визуалом —
 * caller добавляет в `battleNodes` для cleanup'а. Container уже имеет scale 0 +
 * анимирующий «pop» tween (Back.Out, 240ms).
 *
 * Логика выбора визуала (по `chestDef.reward`):
 *   • 'weapon' с загруженной weapon.t<N> иконкой → PNG-иконка + tier-digit (как
 *     в merge-плитке);
 *   • 'lootbox' с загруженной ui.lootbox_<kind> иконкой → PNG лутбокса
 *     (с учётом LOOTBOX_ICON_SCALE);
 *   • fallback (PNG не загружен / scrap-награда) → цветной квадратик с label.
 */
export function renderChestContent(
  scene: Phaser.Scene,
  chestDef: ChestDef,
  cx: number,
  topY: number,
): Phaser.GameObjects.Container {
  const size = 54;
  const y = topY - size / 2 - 18;
  const container = scene.add.container(cx, y).setDepth(15);

  // Weapon-награда: PNG из weapon.t<N> + tier-digit в углу (тот же стиль, что на
  // merge-плитке). Если PNG не загружено — fallthrough в final-block fallback.
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
      // Tier digit — Inter Black 900, чёрный полупрозрачный (тот же стиль, что
      // в merge-плитке: читаемо на любой подложке). Без обводки, в правом нижнем
      // углу. Размер пропорционален size (54 here = ~13px против 32px@136 в merge).
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
      popInContainer(scene, container);
      return container;
    }
  }

  // Lootbox-награда: PNG лутбокса + LOOTBOX_ICON_SCALE усадка.
  if (chestDef.reward === 'lootbox' && chestDef.lootboxKind) {
    const texKey = `ui.lootbox_${chestDef.lootboxKind}`;
    if (scene.textures.exists(texKey)) {
      const target = size * LOOTBOX_ICON_SCALE;
      const img = scene.add.image(0, 0, texKey).setOrigin(0.5);
      img.setDisplaySize(target, target);
      container.add(img);
      popInContainer(scene, container);
      return container;
    }
  }

  // Scrap / lootbox-fallback / weapon-fallback: цветной квадратик с подписью.
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
  popInContainer(scene, container);
  return container;
}

/** Pop-in анимация: scale 0 → 1, Back.Out, 240ms. Один helper для трёх веток выше. */
function popInContainer(scene: Phaser.Scene, container: Phaser.GameObjects.Container): void {
  container.setScale(0);
  scene.tweens.add({ targets: container, scale: 1, duration: 240, ease: 'Back.Out' });
}
