// Чистые фабрики мердж-плиток: weapon tile + lootbox tile. Возвращают
// `Phaser.GameObjects.Container` с уже расставленными children (icon, tier-badge,
// «NEW!»-ярлык). Не управляют состоянием поля и `tileByIndex` — это делает caller.
//
// Логика рендера: иконка оружия по эталонному WEAPON_FRAME_PX (272), tier-цифра
// rgba(0,0,0,0.30) Inter Black 900 справа-снизу, размер шрифта адаптивный к
// cellSize. «NEW!»-ярлык — красный Inter Black 900 слева-сверху, показывается
// если tier ≥ NEW_BADGE_MIN_TIER и тира нет в battledTiers.

import Phaser from 'phaser';
import type { LootboxKind, WeaponTier } from '../../types';
import { UI, WEAPON_FRAME_PX, LOOTBOX_ICON_SCALE, NEW_BADGE_MIN_TIER } from '../../config/constants';
import { weaponName } from '../../core/weapons';

const REFERENCE_CELL_SIZE = 136; // figma 3×3 поля = эталон шрифтов

/**
 * Создать плитку оружия. `battledTiers` — список тиров, с которыми игрок уже
 * ходил в бой (см. SaveState.battledTiers); если `tier ≥ NEW_BADGE_MIN_TIER` и
 * тира нет в списке — плитка получает «NEW!»-ярлык слева-сверху.
 *
 * Container origin = центр плитки. Иконка оружия хранится в `tile.getData('icon')`
 * — используется в `MergeBoard.highlightTier` для preFX.addGlow.
 */
export function makeWeaponTile(
  scene: Phaser.Scene,
  center: { x: number; y: number },
  tier: WeaponTier,
  cellSize: number,
  battledTiers: WeaponTier[],
): Phaser.GameObjects.Container {
  const iconKey = `weapon.t${tier}`;
  const hasIcon = scene.textures.exists(iconKey);

  const children: Phaser.GameObjects.GameObject[] = [];
  let iconObj: Phaser.GameObjects.Image | null = null;

  if (hasIcon) {
    // Иконка оружия по центру слота. Масштаб — по эталонному фрейму Figma 272 px:
    // винтовка визуально длиннее ножа (см. WEAPON_FRAME_PX в constants.ts).
    const tex = scene.textures.get(iconKey).getSourceImage();
    const iconW = (tex as { width: number }).width ?? 1;
    const iconH = (tex as { height: number }).height ?? 1;
    const target = cellSize * 0.85;
    const scale = target / WEAPON_FRAME_PX;
    iconObj = scene.add
      .image(0, 0, iconKey)
      .setOrigin(0.5)
      .setDisplaySize(iconW * scale, iconH * scale);
    children.push(iconObj);
  } else {
    // Fallback (PNG-иконка не загружена): крупная цифра тира + название мелким текстом.
    const tierTxt = scene.add
      .text(0, -cellSize * 0.10, String(tier), {
        fontFamily: 'Inter, Roboto, Arial Black, sans-serif',
        fontStyle: '900',
        fontSize: `${Math.round(cellSize * 0.34)}px`,
        color: '#ffffff',
      })
      .setOrigin(0.5);
    tierTxt.setStroke('#000000', 4);
    const nameTxt = scene.add
      .text(0, cellSize * 0.27, weaponName(tier), {
        fontFamily: 'Inter, Roboto, Arial Black, sans-serif',
        fontSize: `${Math.round(cellSize * 0.12)}px`,
        color: '#ffffff',
      })
      .setOrigin(0.5);
    nameTxt.setStroke('#000000', 3);
    children.push(tierTxt, nameTxt);
  }

  // Цифра тира в правом нижнем углу: чистая надпись без обводки/тени, Inter Black
  // 900. Цвет `rgba(0,0,0,0.30)` — чёрный полупрозрачный, выбран как «универсальный»
  // на любую подложку (тёмный фон → силуэт виден за счёт полупрозрачности, светлый
  // → проступает как тёмная цифра). Размер шрифта АДАПТИВНЫЙ: 32px при cellSize
  // 136 (3×3 / 2×3 поле — эталон), на других полях пропорционально, мин 10px.
  const REFERENCE_BADGE_FONT = 32;
  const badgeFontPx = Math.max(
    10,
    Math.round((cellSize * REFERENCE_BADGE_FONT) / REFERENCE_CELL_SIZE),
  );
  const badgeOffset = cellSize * 0.35;
  const tierBadge = scene.add
    .text(badgeOffset, badgeOffset, String(tier), {
      fontFamily: 'Inter, Roboto, Arial Black, sans-serif',
      fontStyle: '900',
      fontSize: `${badgeFontPx}px`,
      color: 'rgba(0, 0, 0, 0.30)',
    })
    .setOrigin(0.5);
  children.push(tierBadge);

  // «NEW!»-ярлык слева-сверху, если этот тир ≥ NEW_BADGE_MIN_TIER и игрок ещё не
  // ходил с ним в бой. Список battledTiers пополняется в `WorldScene.goBattle`;
  // после возврата `board.relayout(state.field)` пересоздаст плитки и бейдж
  // пропадёт для тиров, попавших в список (даже если уровень не пройден).
  if (shouldShowNewBadge(tier, battledTiers)) {
    const NEW_BADGE_REF_FONT = 18; // px @ cellSize=136 (эталон 3×3 поля)
    const newFontPx = Math.max(
      9,
      Math.round((cellSize * NEW_BADGE_REF_FONT) / REFERENCE_CELL_SIZE),
    );
    const newBadge = scene.add
      .text(-cellSize * 0.42, -cellSize * 0.34, 'NEW!', {
        fontFamily: 'Inter, Roboto, Arial Black, sans-serif',
        fontStyle: '900',
        fontSize: `${newFontPx}px`,
        color: '#FF2D2D',
      })
      .setOrigin(0, 0.5);
    // Белая обводка для читаемости на любом фоне (тёмный/светлый/иконка оружия).
    newBadge.setStroke('#FFFFFF', Math.max(1, Math.round(newFontPx / 7)));
    // Лёгкий drop shadow — отделяет ярлык от подложки.
    newBadge.setShadow(0, 1, 'rgba(0,0,0,0.55)', 2, false, true);
    children.push(newBadge);
  }

  const tile = scene.add.container(center.x, center.y, children);
  if (iconObj) tile.setData('icon', iconObj);
  tile.setDepth(10); // поверх слотов-фонов (depth=1)
  return tile;
}

/**
 * Нужно ли рисовать «NEW!»-ярлык для тира? Правило:
 *   1) tier ≥ NEW_BADGE_MIN_TIER (для младших тиров никогда);
 *   2) тира НЕТ в battledTiers (игрок не ходил с ним в бой).
 */
export function shouldShowNewBadge(tier: WeaponTier, battledTiers: WeaponTier[]): boolean {
  if (tier < NEW_BADGE_MIN_TIER) return false;
  return !battledTiers.includes(tier);
}

/**
 * Плитка-лутбокс. Рисуется как PNG-иконка `ui.lootbox_<kind>` (cheap/medium/elite),
 * с fallback на цветной квадратик если текстура не загружена. Тапом превращается
 * в оружие (см. onOpenLootbox в `BoardCallbacks`).
 *
 * Хранит `tile.setData('lootbox', kind)` — `MergeBoard.hideWeaponTiles` использует
 * это, чтобы НЕ скрывать лутбоксы при старте боя.
 */
export function makeLootboxTile(
  scene: Phaser.Scene,
  center: { x: number; y: number },
  kind: LootboxKind,
  cellSize: number,
): Phaser.GameObjects.Container {
  const size = cellSize * 0.92;
  const texKey = `ui.lootbox_${kind}`;
  const children: Phaser.GameObjects.GameObject[] = [];

  if (scene.textures.exists(texKey)) {
    // Иконка с aspect ratio 1:1 (PNG-ассеты квадратные). Доп. усадка LOOTBOX_ICON_SCALE.
    const target = size * LOOTBOX_ICON_SCALE;
    const img = scene.add.image(0, 0, texKey).setOrigin(0.5);
    img.setDisplaySize(target, target);
    children.push(img);
  } else {
    // Fallback: цветной квадратик + emoji + подпись.
    const color = kind === 'elite' ? 0x9b59b6 : kind === 'medium' ? 0xd4a017 : 0x8a6a3a;
    const label = kind === 'elite' ? 'КРУТ' : kind === 'medium' ? 'СР.' : 'ДЕШ.';
    const bg = scene.add.rectangle(0, 0, size, size, color).setOrigin(0.5);
    bg.setStrokeStyle(3, 0xffffff, 0.6);
    const icon = scene.add
      .text(0, -size * 0.14, '📦', {
        fontFamily: 'monospace',
        fontSize: `${Math.round(size * 0.36)}px`,
      })
      .setOrigin(0.5);
    const lbl = scene.add
      .text(0, size * 0.28, label, {
        fontFamily: 'monospace',
        fontSize: `${Math.round(size * 0.16)}px`,
        color: '#ffffff',
      })
      .setOrigin(0.5);
    lbl.setStroke('#000000', 3);
    children.push(bg, icon, lbl);
  }

  const tile = scene.add.container(center.x, center.y, children);
  tile.setData('lootbox', kind);
  tile.setDepth(10); // поверх слотов-фонов (depth=1)
  return tile;
}

/**
 * Cell-фон (квадратная подложка под плиткой). Image (SVG `ui.merge_slot`) если
 * есть текстура, иначе цветной Rectangle с обводкой. depth=1 — над фоном поля
 * (`drawMergeGround` в WorldScene), под плитками (depth=10).
 */
export function makeSlotBg(
  scene: Phaser.Scene,
  center: { x: number; y: number },
  cellSize: number,
): Phaser.GameObjects.GameObject {
  if (scene.textures.exists('ui.merge_slot')) {
    // figma slot 136×136 с rx=17. setDisplaySize масштабирует под текущий cellSize.
    return scene.add
      .image(center.x, center.y, 'ui.merge_slot')
      .setOrigin(0.5)
      .setDisplaySize(cellSize, cellSize)
      .setDepth(1);
  }
  const r = scene.add
    .rectangle(center.x, center.y, cellSize, cellSize, UI.slot)
    .setOrigin(0.5);
  r.setStrokeStyle(2, UI.slotStroke);
  return r;
}
