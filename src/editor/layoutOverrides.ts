// LocalStorage слой для редактора расположения. Хранит per-id override
// (x/y/scaleX/scaleY/depth/visibility/удалён). Применяется поверх дефолтов из Spine JSON.
//
// Ключ LS: `zm_layout_overrides`. Это отдельный от сейва ключ — на сейв-миграции не влияет.

import type Phaser from 'phaser';

export interface LayoutOverride {
  x?: number;
  y?: number;
  scaleX?: number;
  scaleY?: number;
  depth?: number;
  visible?: boolean;
  /** Удалён в редакторе — не отображать (но overrride сохраняется, можно восстановить). */
  deleted?: boolean;
  /** Если этот id — клон существующего слоя, ссылка на исходник (для дублирования). */
  cloneOf?: string;
  /** Имя текстуры (для клонов / добавленных). */
  texture?: string;
  /** Позиция в списке слоёв редактора (0 = верх = front). Управляет z-order. */
  order?: number;
}

const KEY = 'zm_layout_overrides';

export function loadOverrides(): Record<string, LayoutOverride> {
  try {
    const s = localStorage.getItem(KEY);
    return s ? (JSON.parse(s) as Record<string, LayoutOverride>) : {};
  } catch {
    return {};
  }
}

export function saveOverrides(map: Record<string, LayoutOverride>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

export function clearOverrides(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Минимальный набор полей для applyOverride — подходит для Image, Container, Rectangle, Text. */
export interface OverridableObject {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  setDepth(v: number): unknown;
  setVisible(v: boolean): unknown;
}

/** Накатить override на конкретный объект. Поля не указанные в override — не трогаются. */
export function applyOverride(obj: OverridableObject, ovr: LayoutOverride): void {
  if (ovr.x != null) obj.x = ovr.x;
  if (ovr.y != null) obj.y = ovr.y;
  if (ovr.scaleX != null) obj.scaleX = ovr.scaleX;
  if (ovr.scaleY != null) obj.scaleY = ovr.scaleY;
  if (ovr.depth != null) obj.setDepth(ovr.depth);
  if (ovr.visible != null) obj.setVisible(ovr.visible);
}

/** Экспорт JSON (для копирования в код / архив). */
export function exportOverridesJSON(): string {
  return JSON.stringify(loadOverrides(), null, 2);
}
