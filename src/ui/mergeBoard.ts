import Phaser from 'phaser';
import type { FieldState, WeaponTier } from '../types';
import { TIER_COLORS, UI, COLORS } from '../config/constants';
import { weaponName } from '../core/weapons';
import { canMergeIndices, mergeInto, moveOrSwap } from '../core/merge';

export interface BoardCallbacks {
  /** Вызывается после любого изменения поля (персист + обновить HUD/кнопки). */
  onChange: () => void;
  /** Вызывается при успешном мердже (передаётся новый тир). */
  onMerge?: (tier: WeaponTier) => void;
}

export interface BoardRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Тащить мелко = тап (не драг). В игровых единицах поля.
const DRAG_THRESHOLD = 12;

/**
 * Рендер мердж-поля на примитивах. Два способа взаимодействия (мобильно-дружелюбно):
 *  - ТАП по плитке -> выбрать; тап по другой -> мердж (если можно) или перевыбор;
 *    тап по пустой клетке с выбранной плиткой -> перенос.
 *  - DRAG плитки на другую -> мердж / перенос / swap.
 * Хитзоны — на всю клетку (pitch), чтобы попадать легко.
 */
export class MergeBoard {
  private readonly scene: Phaser.Scene;
  private field: FieldState;
  private rect: BoardRect;
  private readonly cb: BoardCallbacks;

  private pitch = 0;
  private cellSize = 0;
  private gridLeft = 0;
  private gridTop = 0;

  private cellRects: Phaser.GameObjects.Rectangle[] = [];
  private tiles: Phaser.GameObjects.Container[] = [];
  private tileByIndex = new Map<number, Phaser.GameObjects.Container>();
  private selectedIndex: number | null = null;

  constructor(scene: Phaser.Scene, field: FieldState, rect: BoardRect, cb: BoardCallbacks) {
    this.scene = scene;
    this.field = field;
    this.rect = rect;
    this.cb = cb;
    // Мелкое смещение трактуем как тап, а не как начало перетаскивания.
    scene.input.dragDistanceThreshold = DRAG_THRESHOLD;
    this.computeGeometry();
    this.buildCells();
    this.rebuildTiles();
  }

  /** Перепривязать к (возможно новому) полю и перерисовать — например после роста поля. */
  relayout(field: FieldState): void {
    this.field = field;
    this.clearSelection();
    this.computeGeometry();
    this.cellRects.forEach((r) => r.destroy());
    this.cellRects = [];
    this.buildCells();
    this.rebuildTiles();
  }

  private computeGeometry(): void {
    const { cols, rows } = this.field;
    this.pitch = Math.min(this.rect.w / cols, this.rect.h / rows);
    this.cellSize = this.pitch * 0.9;
    this.gridLeft = this.rect.x + (this.rect.w - this.pitch * cols) / 2;
    this.gridTop = this.rect.y + (this.rect.h - this.pitch * rows) / 2;
  }

  private centerOf(index: number): { x: number; y: number } {
    const col = index % this.field.cols;
    const row = Math.floor(index / this.field.cols);
    return {
      x: this.gridLeft + col * this.pitch + this.pitch / 2,
      y: this.gridTop + row * this.pitch + this.pitch / 2,
    };
  }

  private buildCells(): void {
    const total = this.field.cols * this.field.rows;
    for (let i = 0; i < total; i++) {
      const c = this.centerOf(i);
      // Хитзона клетки — на весь pitch (включая зазоры): по пустой клетке легко попасть.
      const r = this.scene.add
        .rectangle(c.x, c.y, this.pitch, this.pitch, UI.slot)
        .setOrigin(0.5);
      r.setStrokeStyle(2, UI.slotStroke);
      r.setInteractive({ useHandCursor: true });
      r.on('pointerup', () => this.onCellTap(i));
      this.cellRects.push(r);
    }
  }

  rebuildTiles(): void {
    this.clearSelection();
    this.tiles.forEach((t) => t.destroy());
    this.tiles = [];
    this.tileByIndex.clear();
    for (let i = 0; i < this.field.cells.length; i++) {
      const tier = this.field.cells[i];
      if (tier == null) continue;
      const tile = this.makeTile(i, tier);
      this.tiles.push(tile);
      this.tileByIndex.set(i, tile);
    }
  }

  private makeTile(index: number, tier: WeaponTier): Phaser.GameObjects.Container {
    const c = this.centerOf(index);
    const size = this.cellSize * 0.92;
    const color = TIER_COLORS[tier] ?? 0x888888;

    const bg = this.scene.add.rectangle(0, 0, size, size, color).setOrigin(0.5);
    bg.setStrokeStyle(3, 0x000000, 0.3);
    const tierTxt = this.scene.add
      .text(0, -size * 0.12, String(tier), {
        fontFamily: 'monospace',
        fontSize: `${Math.round(size * 0.34)}px`,
        color: '#ffffff',
      })
      .setOrigin(0.5);
    tierTxt.setStroke('#000000', 4);
    const nameTxt = this.scene.add
      .text(0, size * 0.27, weaponName(tier), {
        fontFamily: 'monospace',
        fontSize: `${Math.round(size * 0.12)}px`,
        color: '#ffffff',
      })
      .setOrigin(0.5);
    nameTxt.setStroke('#000000', 3);

    const tile = this.scene.add.container(c.x, c.y, [bg, tierTxt, nameTxt]);
    // Хитзона на весь pitch (а не только на видимую плитку) — попадать легче, нет «мёртвых» зазоров.
    tile.setSize(this.pitch, this.pitch);
    tile.setData('index', index);
    tile.setData('bg', bg);
    tile.setData('dragged', false);
    tile.setInteractive(
      new Phaser.Geom.Rectangle(-this.pitch / 2, -this.pitch / 2, this.pitch, this.pitch),
      Phaser.Geom.Rectangle.Contains,
    );
    this.scene.input.setDraggable(tile);

    tile.on('pointerdown', () => tile.setData('dragged', false));
    tile.on('dragstart', () => {
      tile.setData('dragged', true);
      this.scene.children.bringToTop(tile);
      tile.setScale(1.06);
    });
    tile.on('drag', (_p: Phaser.Input.Pointer, dragX: number, dragY: number) => {
      tile.setPosition(dragX, dragY);
    });
    tile.on('dragend', () => {
      tile.setScale(1);
      this.handleDrop(index, tile.x, tile.y);
    });
    // Тап (без перетаскивания) — выбор/мердж.
    tile.on('pointerup', () => {
      if (!tile.getData('dragged')) this.onTileTap(index);
    });

    return tile;
  }

  // --- Тап-логика ---

  private onTileTap(index: number): void {
    if (this.selectedIndex === null) {
      this.select(index);
      return;
    }
    if (this.selectedIndex === index) {
      this.clearSelection();
      return;
    }
    const from = this.selectedIndex;
    if (canMergeIndices(this.field, from, index)) {
      this.clearSelection();
      const result = mergeInto(this.field, from, index);
      this.rebuildTiles();
      this.cb.onChange();
      if (result != null) this.cb.onMerge?.(result);
    } else {
      // Не мерджится — просто переносим выбор на новую плитку.
      this.clearSelection();
      this.select(index);
    }
  }

  private onCellTap(index: number): void {
    // По пустой клетке (плитки на ней нет, иначе событие забрала бы плитка): перенос выбранной.
    if (this.selectedIndex === null) return;
    if (this.field.cells[index] != null) return;
    const from = this.selectedIndex;
    this.clearSelection();
    moveOrSwap(this.field, from, index); // to пусто => перенос
    this.rebuildTiles();
    this.cb.onChange();
  }

  private select(index: number): void {
    this.selectedIndex = index;
    const tile = this.tileByIndex.get(index);
    if (!tile) return;
    tile.setScale(1.08);
    const bg = tile.getData('bg') as Phaser.GameObjects.Rectangle | undefined;
    bg?.setStrokeStyle(5, COLORS.accent, 1);
  }

  private clearSelection(): void {
    if (this.selectedIndex === null) return;
    const tile = this.tileByIndex.get(this.selectedIndex);
    if (tile) {
      tile.setScale(1);
      const bg = tile.getData('bg') as Phaser.GameObjects.Rectangle | undefined;
      bg?.setStrokeStyle(3, 0x000000, 0.3);
    }
    this.selectedIndex = null;
  }

  // --- Drag-логика ---

  private hitIndex(x: number, y: number): number {
    const { cols, rows } = this.field;
    const col = Math.floor((x - this.gridLeft) / this.pitch);
    const row = Math.floor((y - this.gridTop) / this.pitch);
    if (col < 0 || col >= cols || row < 0 || row >= rows) return -1;
    return row * cols + col;
  }

  private handleDrop(from: number, x: number, y: number): void {
    this.clearSelection();
    const to = this.hitIndex(x, y);
    if (to === -1 || to === from) {
      this.rebuildTiles(); // вернуть на место
      return;
    }
    if (canMergeIndices(this.field, from, to)) {
      const result = mergeInto(this.field, from, to);
      this.rebuildTiles();
      this.cb.onChange();
      if (result != null) this.cb.onMerge?.(result);
    } else {
      moveOrSwap(this.field, from, to);
      this.rebuildTiles();
      this.cb.onChange();
    }
  }
}
