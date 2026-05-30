// Загрузчик локационного арта. Унифицированный формат `figma-layout-1`:
//   { format, frame: {width, height}, layers: [{ id, image, x, y, width, height, drawOrder, flipX?, flipY? }] }
// Координаты — top-left, Y вниз (как Figma и Phaser).
//
// Frame.width/height — размеры исходного canvas (для понимания пропорций). Каждый layer
// рендерится как Phaser.Image с origin=0.5: phaserX = origin.x + (x + w/2) * scale,
// phaserY = origin.y + (y + h/2) * scale. Image использует общий texturePrefix:
// финальный ключ = `${texturePrefix}.${image}`. Несколько слоёв могут ссылаться на одну
// текстуру (например road_l1 переиспользуется во всех 8 сегментах дороги через flipX).
//
// Поверх дефолтов накладываются overrides из LocalStorage (см. editor/layoutOverrides).

import Phaser from 'phaser';
import { applyOverride, type LayoutOverride } from '../editor/layoutOverrides';

export interface LocationLayer {
  /** Уникальный id для overrides. Пример: `base.gate_l`. */
  id: string;
  /** Имя текстуры (без префикса и расширения). Пример: `gate_l`. */
  image: string;
  /** Top-left X в системе фрейма. */
  x: number;
  /** Top-left Y в системе фрейма (Y вниз). */
  y: number;
  width: number;
  height: number;
  /** Чем больше, тем ближе к зрителю (внутри baseDepth). */
  drawOrder: number;
  flipX?: boolean;
  flipY?: boolean;
}

/** Описание тайла, который НЕ рендерится статикой, но нужен движку
 *  (используется кодом, например как тайл для динамической дороги). */
export interface TilesetDef {
  image: string;
  width: number;
  height: number;
}

export interface LocationManifest {
  format?: string;
  frame?: { width: number; height: number };
  /** Дополнительные текстуры, которые нужно прелоадить, но не рисовать как layers. */
  tilesets?: TilesetDef[];
  layers: LocationLayer[];
  /** Built-in overrides поверх дефолтов слоёв (зафиксированные «команда»-настройки).
   *  Применяются ДО пользовательских overrides из LocalStorage (LS перезаписывает). */
  overrides?: Record<string, LayoutOverride>;
}

/** Парсит JSON в манифест. Сейчас поддерживается единственный формат `figma-layout-1`. */
export function parseLocation(json: unknown): LocationManifest {
  const j = json as LocationManifest;
  if (!j || !Array.isArray(j.layers)) {
    return { layers: [] };
  }
  return {
    format: j.format ?? 'figma-layout-1',
    frame: j.frame,
    tilesets: j.tilesets,
    layers: j.layers,
    overrides: j.overrides,
  };
}

/** Найти тайлсет по имени (нужно WorldScene при сборке динамической дороги). */
export function findTileset(manifest: LocationManifest, image: string): TilesetDef | null {
  return manifest.tilesets?.find((t) => t.image === image) ?? null;
}

export interface BuildOptions {
  /** Phaser X точки (0, 0) системы фрейма. */
  originX: number;
  /** Phaser Y точки (0, 0) системы фрейма. */
  originY: number;
  /** Общий масштаб локации. 1 = пиксель-в-пиксель. */
  scale: number;
  /** Базовый Phaser depth; финальный = baseDepth + drawOrder. */
  baseDepth: number;
  /** Префикс ключей текстур: `${prefix}.${layer.image}`. */
  texturePrefix: string;
}

export interface BuiltLocation {
  byId: Map<string, Phaser.GameObjects.Image>;
  all: Phaser.GameObjects.Image[];
}

/** Рендерит слои в сцену. Применяет overrides поверх дефолтов. */
export function buildLocation(
  scene: Phaser.Scene,
  manifest: LocationManifest,
  opts: BuildOptions,
  overrides: Record<string, LayoutOverride> = {},
): BuiltLocation {
  const byId = new Map<string, Phaser.GameObjects.Image>();
  const all: Phaser.GameObjects.Image[] = [];
  for (const l of manifest.layers) {
    const key = `${opts.texturePrefix}.${l.image}`;
    if (!scene.textures.exists(key)) {
      // Missing texture — skip (loader log уже сообщил в Boot, если что).
      continue;
    }
    // Center of layer in frame space.
    const cx = l.x + l.width / 2;
    const cy = l.y + l.height / 2;
    const defX = opts.originX + cx * opts.scale;
    const defY = opts.originY + cy * opts.scale;
    const img = scene.add.image(defX, defY, key);
    img.setOrigin(0.5);
    img.setDisplaySize(l.width * opts.scale, l.height * opts.scale);
    img.setDepth(opts.baseDepth + l.drawOrder);
    if (l.flipX) img.setFlipX(true);
    if (l.flipY) img.setFlipY(true);

    // 1) Built-in overrides из манифеста (зафиксированные «команда»-настройки).
    const builtin = manifest.overrides?.[l.id];
    if (builtin) applyOverride(img, builtin);
    // 2) Пользовательские overrides из LS — поверх (могут переопределить built-in).
    const ovr = overrides[l.id];
    if (ovr) applyOverride(img, ovr);
    if (builtin?.deleted || ovr?.deleted) img.setVisible(false);

    byId.set(l.id, img);
    all.push(img);
  }
  return { byId, all };
}

/** Список уникальных имён текстур для preload — `layers` + `tilesets`, без дубликатов. */
export function uniqueImages(manifest: LocationManifest): string[] {
  const set = new Set<string>();
  for (const l of manifest.layers) set.add(l.image);
  for (const t of manifest.tilesets ?? []) set.add(t.image);
  return [...set];
}
