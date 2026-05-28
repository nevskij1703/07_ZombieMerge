import Phaser from 'phaser';
import type { FieldState, LootboxKind, WeaponTier } from '../types';
import { TIER_COLORS, UI, COLORS } from '../config/constants';
import { weaponName } from '../core/weapons';
import { canMergeIndices, mergeInto, moveOrSwap } from '../core/merge';
import { isLootboxCode, isWeaponCellValue, lootboxKindOfCode } from '../core/lootbox';

export interface BoardCallbacks {
  /** Вызывается после любого изменения поля (персист + обновить HUD/кнопки). */
  onChange: () => void;
  /** Вызывается при успешном мердже (передаётся новый тир). */
  onMerge?: (tier: WeaponTier) => void;
  /** Тап по клетке с лутбоксом. Получатель должен обновить state.field (открыть лутбокс)
   *  и вернуть true, чтобы доска перерисовала плитки. */
  onOpenLootbox?: (cellIndex: number, kind: LootboxKind) => boolean;
  /** Drop оружия в зону мусорки. Получатель удаляет из state.field и возвращает true,
   *  если удаление состоялось (для перерисовки + анимации). */
  onTrash?: (cellIndex: number) => boolean;
}

export interface BoardRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Смещение указателя (в игровых px) выше которого жест считается перетаскиванием, а не тапом.
const DRAG_THRESHOLD = 14;

/**
 * Мердж-поле. Ввод обрабатывается НА УРОВНЕ СЦЕНЫ (scene.input) и попадание в клетку
 * считается чистой сеточной математикой из pointer.worldX/worldY. Плитки и клетки —
 * НЕ интерактивные объекты (нет per-object hitArea, нет topOnly, масштаб выделения
 * не влияет на попадание). Это убирает «через раз»/смещение прошлой реализации.
 *
 * Управление:
 *  - Тап по плитке -> выбрать; тап по другой -> мердж / своп-выбор; тап по пустой -> перенос.
 *  - Перетаскивание плитки -> мердж / перенос / swap по месту отпускания.
 */
export class MergeBoard {
  private readonly scene: Phaser.Scene;
  private field: FieldState;
  private rect: BoardRect;
  private readonly cb: BoardCallbacks;
  private trashZone: BoardRect | null = null;

  private pitch = 0;
  private cellSize = 0;
  private gridLeft = 0;
  private gridTop = 0;

  private cellRects: Phaser.GameObjects.Rectangle[] = [];
  private tileByIndex = new Map<number, Phaser.GameObjects.Container>();
  private selectedIndex: number | null = null;

  // Состояние текущего жеста.
  private downIndex: number | null = null;
  private downX = 0;
  private downY = 0;
  private dragging = false;
  private dragTile: Phaser.GameObjects.Container | null = null;

  constructor(scene: Phaser.Scene, field: FieldState, rect: BoardRect, cb: BoardCallbacks) {
    this.scene = scene;
    this.field = field;
    this.rect = rect;
    this.cb = cb;
    this.computeGeometry();
    this.buildCells();
    this.rebuildTiles();
    this.attachInput();
  }

  /** Установить прямоугольник трэш-зоны. Drop оружия в эту область → cb.onTrash. */
  setTrashZone(rect: BoardRect | null): void {
    this.trashZone = rect;
  }

  /** Перепривязать к (возможно новому) полю и перерисовать — например после роста поля. */
  relayout(field: FieldState): void {
    this.field = field;
    this.clearSelection();
    this.resetGesture();
    this.computeGeometry();
    this.cellRects.forEach((r) => r.destroy());
    this.cellRects = [];
    this.buildCells();
    this.rebuildTiles();
  }

  // --- Ввод на уровне сцены ---

  private attachInput(): void {
    this.scene.input.on(Phaser.Input.Events.POINTER_DOWN, this.onPointerDown, this);
    this.scene.input.on(Phaser.Input.Events.POINTER_MOVE, this.onPointerMove, this);
    this.scene.input.on(Phaser.Input.Events.POINTER_UP, this.onPointerUp, this);
    this.scene.input.on(Phaser.Input.Events.POINTER_UP_OUTSIDE, this.onPointerUp, this);
    this.scene.events.once(Phaser.Scenes.Events.SHUTDOWN, this.detachInput, this);
    this.scene.events.once(Phaser.Scenes.Events.DESTROY, this.detachInput, this);
  }

  private detachInput(): void {
    this.scene.input.off(Phaser.Input.Events.POINTER_DOWN, this.onPointerDown, this);
    this.scene.input.off(Phaser.Input.Events.POINTER_MOVE, this.onPointerMove, this);
    this.scene.input.off(Phaser.Input.Events.POINTER_UP, this.onPointerUp, this);
    this.scene.input.off(Phaser.Input.Events.POINTER_UP_OUTSIDE, this.onPointerUp, this);
  }

  private resetGesture(): void {
    this.downIndex = null;
    this.dragging = false;
    this.dragTile = null;
  }

  /** Индекс клетки под указателем по сеточной математике, либо -1 если вне поля. */
  private pointerCell(pointer: Phaser.Input.Pointer): number {
    const col = Math.floor((pointer.worldX - this.gridLeft) / this.pitch);
    const row = Math.floor((pointer.worldY - this.gridTop) / this.pitch);
    if (col < 0 || col >= this.field.cols || row < 0 || row >= this.field.rows) return -1;
    return row * this.field.cols + col;
  }

  private onPointerDown(pointer: Phaser.Input.Pointer): void {
    const idx = this.pointerCell(pointer);
    if (idx === -1) return; // клик вне поля — это не наш жест (кнопки/HUD/инвентарь)
    this.downIndex = idx;
    this.downX = pointer.worldX;
    this.downY = pointer.worldY;
    this.dragging = false;
    this.dragTile = null;
  }

  private onPointerMove(pointer: Phaser.Input.Pointer): void {
    if (this.downIndex === null) return;
    if (!this.dragging) {
      const dist = Phaser.Math.Distance.Between(this.downX, this.downY, pointer.worldX, pointer.worldY);
      if (dist < DRAG_THRESHOLD) return;
      const tile = this.tileByIndex.get(this.downIndex);
      if (!tile) {
        // тащить из пустой клетки нечего
        this.downIndex = null;
        return;
      }
      this.dragging = true;
      this.dragTile = tile;
      this.clearSelection();
      this.scene.children.bringToTop(tile);
      tile.setScale(1.06);
    }
    if (this.dragTile) this.dragTile.setPosition(pointer.worldX, pointer.worldY);
  }

  private onPointerUp(pointer: Phaser.Input.Pointer): void {
    if (this.downIndex === null) return;
    const from = this.downIndex;
    const wasDragging = this.dragging;
    const dragTile = this.dragTile;
    this.resetGesture();

    if (wasDragging && dragTile) {
      dragTile.setScale(1);
      this.resolveDrop(from, this.pointerCell(pointer), pointer.worldX, pointer.worldY);
    } else {
      this.handleTap(from);
    }
  }

  private isInTrashZone(x: number, y: number): boolean {
    const z = this.trashZone;
    if (!z) return false;
    return x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h;
  }

  // --- Логика слотов ---

  private handleTap(index: number): void {
    const value = this.field.cells[index];

    // Тап по лутбоксу — открыть его (без выделения/мерджа).
    if (isLootboxCode(value)) {
      this.clearSelection();
      const kind = lootboxKindOfCode(value);
      if (kind && this.cb.onOpenLootbox?.(index, kind)) {
        this.rebuildTiles();
        this.cb.onChange();
      }
      return;
    }

    if (this.selectedIndex === null) {
      if (value != null) this.select(index);
      return;
    }
    if (this.selectedIndex === index) {
      this.clearSelection();
      return;
    }

    const from = this.selectedIndex;
    if (value == null) {
      this.clearSelection();
      this.applyMove(from, index);
    } else if (canMergeIndices(this.field, from, index)) {
      this.clearSelection();
      this.applyMerge(from, index);
    } else {
      // занято и не мерджится (или лутбокс) — перевыбираем (если оружие).
      this.clearSelection();
      if (isWeaponCellValue(value)) this.select(index);
    }
  }

  private resolveDrop(from: number, to: number, worldX: number, worldY: number): void {
    // Drop в зону мусорки — удалить (если разрешено).
    if (to === -1 && this.isInTrashZone(worldX, worldY)) {
      const v = this.field.cells[from];
      if (isWeaponCellValue(v) && this.cb.onTrash?.(from)) {
        this.rebuildTiles();
        this.cb.onChange();
        return;
      }
    }
    if (to === -1 || to === from) {
      this.rebuildTiles(); // вернуть плитку на место
      return;
    }
    if (this.field.cells[to] == null) {
      this.applyMove(from, to);
    } else if (canMergeIndices(this.field, from, to)) {
      this.applyMerge(from, to);
    } else {
      this.applyMove(from, to); // обе заняты, не мерджатся => swap
    }
  }

  private applyMerge(from: number, to: number): void {
    const result = mergeInto(this.field, from, to);
    this.rebuildTiles();
    this.cb.onChange();
    if (result != null) this.cb.onMerge?.(result);
  }

  private applyMove(from: number, to: number): void {
    moveOrSwap(this.field, from, to);
    this.rebuildTiles();
    this.cb.onChange();
  }

  // --- Выделение (чисто косметика, на попадание не влияет) ---

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

  // --- Геометрия и рендер ---

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
      const r = this.scene.add
        .rectangle(c.x, c.y, this.cellSize, this.cellSize, UI.slot)
        .setOrigin(0.5);
      r.setStrokeStyle(2, UI.slotStroke);
      this.cellRects.push(r);
    }
  }

  rebuildTiles(): void {
    this.clearSelection();
    this.tileByIndex.forEach((t) => t.destroy());
    this.tileByIndex.clear();
    for (let i = 0; i < this.field.cells.length; i++) {
      const v = this.field.cells[i];
      if (v == null) continue;
      if (isLootboxCode(v)) {
        const kind = lootboxKindOfCode(v);
        if (kind) this.tileByIndex.set(i, this.makeLootboxTile(i, kind));
      } else if (isWeaponCellValue(v)) {
        this.tileByIndex.set(i, this.makeTile(i, v));
      }
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
    tile.setData('bg', bg);
    return tile;
  }

  /** Плитка-лутбокс. Отличается цветом и подписью; тапом превращается в оружие. */
  private makeLootboxTile(index: number, kind: LootboxKind): Phaser.GameObjects.Container {
    const c = this.centerOf(index);
    const size = this.cellSize * 0.92;
    const color = kind === 'elite' ? 0x9b59b6 : 0xd4a017; // фиолетовый / золото
    const label = kind === 'elite' ? 'КРУТ' : 'СР.';

    const bg = this.scene.add.rectangle(0, 0, size, size, color).setOrigin(0.5);
    bg.setStrokeStyle(3, 0xffffff, 0.6);
    const icon = this.scene.add
      .text(0, -size * 0.14, '📦', { fontFamily: 'monospace', fontSize: `${Math.round(size * 0.36)}px` })
      .setOrigin(0.5);
    const lbl = this.scene.add
      .text(0, size * 0.28, label, {
        fontFamily: 'monospace',
        fontSize: `${Math.round(size * 0.16)}px`,
        color: '#ffffff',
      })
      .setOrigin(0.5);
    lbl.setStroke('#000000', 3);

    const tile = this.scene.add.container(c.x, c.y, [bg, icon, lbl]);
    tile.setData('bg', bg);
    tile.setData('lootbox', kind);
    return tile;
  }
}
