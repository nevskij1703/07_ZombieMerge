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
  /** Вызывается при создании доски и при `relayout` (рост поля). Получает реальный
   *  прямоугольник фона (`outerBounds`) — поле может быть `Не` квадратным (2×3, 3×4,
   *  4×5), bg адаптируется под форму. Сцена должна перерисовать merge-ground. */
  onLayoutChanged?: (outer: BoardRect) => void;
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
  // Реальные размеры фона мердж-поля (адаптируются под форму field — 2×3, 3×4, 4×5).
  // `outerLeft/outerTop` — top-left bg; `outerW/outerH` включают padding вокруг сетки.
  private outerLeft = 0;
  private outerTop = 0;
  private outerW = 0;
  private outerH = 0;

  /** Фон ячеек: Image (ui.merge_slot SVG) если есть текстура, иначе Rectangle-fallback. */
  private cellRects: Phaser.GameObjects.GameObject[] = [];
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
    this.cb.onLayoutChanged?.(this.getOuterBounds());
    this.buildCells();
    this.rebuildTiles();
    this.attachInput();
  }

  /** Установить прямоугольник трэш-зоны. Drop оружия в эту область → cb.onTrash. */
  setTrashZone(rect: BoardRect | null): void {
    this.trashZone = rect;
  }

  /** Текущий визуальный размер ячейки поля в px. Меняется при relayout (рост поля). */
  getCellSize(): number {
    return this.cellSize;
  }

  /** Перепривязать к (возможно новому) полю и перерисовать — например после роста поля. */
  relayout(field: FieldState): void {
    this.field = field;
    this.clearSelection();
    this.resetGesture();
    this.computeGeometry();
    this.cb.onLayoutChanged?.(this.getOuterBounds());
    this.cellRects.forEach((r) => r.destroy());
    this.cellRects = [];
    this.buildCells();
    this.rebuildTiles();
  }

  /** Реальный bg-прямоугольник: учитывает форму поля (для не-квадратных размеров — узкий
   *  или невысокий относительно исходного rect'а). Сцена использует его для отрисовки
   *  merge-ground. */
  getOuterBounds(): BoardRect {
    return { x: this.outerLeft, y: this.outerTop, w: this.outerW, h: this.outerH };
  }

  /** Скрыть визуал ОРУЖЕЙНЫХ плиток (лутбоксы остаются видимыми). Используется на старте
   *  боя — «бойцы забрали оружие». State не трогается; после боя `relayout(field)`
   *  пересоздаст плитки и оружие появится снова. */
  hideWeaponTiles(): void {
    this.clearSelection();
    for (const [, tile] of this.tileByIndex) {
      if (!tile.getData('lootbox')) tile.setVisible(false);
    }
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
    // Cell size = по «бОльшей» оси field (max(cols,rows)) с учётом padding/gap. Это даёт
    // ОДИНАКОВЫЙ cellSize для любого field с тем же max-измерением (например 4×5 и 5×5
    // имеют одинаковые ячейки), а сам bg сужается по короткой оси:
    //   • 2×3 (maxDim=3, как 3×3) → cellSize ≈ 136, bg ≈ 309×449
    //   • 3×4 (maxDim=4, как 4×4) → cellSize ≈ 101, bg ≈ 344×449
    //   • 4×5 (maxDim=5, как 5×5) → cellSize ≈ 80,  bg ≈ 365×449
    const padding = 16;
    const gap = 4;
    const baseMinDim = Math.min(this.rect.w, this.rect.h);
    const maxDim = Math.max(cols, rows);
    this.cellSize = (baseMinDim - 2 * padding - gap * (maxDim - 1)) / maxDim;
    this.pitch = this.cellSize + gap;
    const totalW = cols * this.cellSize + (cols - 1) * gap;
    const totalH = rows * this.cellSize + (rows - 1) * gap;
    // Outer bg = totalW/H + padding вокруг.
    this.outerW = totalW + 2 * padding;
    this.outerH = totalH + 2 * padding;
    // Центрируем bg в исходном rect.
    this.outerLeft = this.rect.x + (this.rect.w - this.outerW) / 2;
    this.outerTop = this.rect.y + (this.rect.h - this.outerH) / 2;
    this.gridLeft = this.outerLeft + padding;
    this.gridTop = this.outerTop + padding;
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
    const hasSlotArt = this.scene.textures.exists('ui.merge_slot');
    for (let i = 0; i < total; i++) {
      const c = this.centerOf(i);
      if (hasSlotArt) {
        // figma slot 136×136 с rx=17. setDisplaySize масштабирует под текущий cellSize.
        const img = this.scene.add
          .image(c.x, c.y, 'ui.merge_slot')
          .setOrigin(0.5)
          .setDisplaySize(this.cellSize, this.cellSize)
          .setDepth(1);
        this.cellRects.push(img);
      } else {
        const r = this.scene.add
          .rectangle(c.x, c.y, this.cellSize, this.cellSize, UI.slot)
          .setOrigin(0.5);
        r.setStrokeStyle(2, UI.slotStroke);
        this.cellRects.push(r);
      }
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
    const iconKey = `weapon.t${tier}`;
    const hasIcon = this.scene.textures.exists(iconKey);

    // Фон-рамка с цветом по тиру (тонкая «карта» под иконкой).
    const bg = this.scene.add.rectangle(0, 0, size, size, color, hasIcon ? 0.2 : 1).setOrigin(0.5);
    bg.setStrokeStyle(3, color, 0.9);

    const children: Phaser.GameObjects.GameObject[] = [bg];

    if (hasIcon) {
      // Иконка: заполняет ~85% ячейки, сохраняя aspect ratio (через setDisplaySize по большей стороне).
      const tex = this.scene.textures.get(iconKey).getSourceImage();
      const iconW = (tex as { width: number }).width ?? 1;
      const iconH = (tex as { height: number }).height ?? 1;
      const maxSide = Math.max(iconW, iconH);
      const targetMax = size * 0.85;
      const scale = targetMax / maxSide;
      const icon = this.scene.add
        .image(0, -size * 0.04, iconKey)
        .setOrigin(0.5)
        .setDisplaySize(iconW * scale, iconH * scale);
      children.push(icon);
      // Маленький tier-индикатор в углу.
      const tierBadge = this.scene.add
        .text(-size * 0.4, size * 0.4, String(tier), {
          fontFamily: 'Roboto, Arial Black, sans-serif',
          fontStyle: '900',
          fontSize: `${Math.round(size * 0.18)}px`,
          color: '#ffffff',
        })
        .setOrigin(0.5);
      tierBadge.setStroke('#000000', 3);
      children.push(tierBadge);
    } else {
      // Fallback на старый стиль (цвет + цифра тира) — если иконка не загружена.
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
      children.push(tierTxt, nameTxt);
    }

    const tile = this.scene.add.container(c.x, c.y, children);
    tile.setData('bg', bg);
    tile.setDepth(10); // поверх слотов-фонов (depth=1)
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
    tile.setDepth(10); // поверх слотов-фонов (depth=1)
    return tile;
  }
}
