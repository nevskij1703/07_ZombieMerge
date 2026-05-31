import Phaser from 'phaser';
import type { FieldState, LootboxKind, WeaponTier } from '../types';
import { canMergeIndices, mergeInto, moveOrSwap } from '../core/merge';
import { isLootboxCode, isWeaponCellValue, lootboxKindOfCode } from '../core/lootbox';
import { getState } from '../core/storage';
import {
  ensureMergeVfxTextures,
  playLootboxBurst,
  playMergeVfx,
} from './merge/vfx';
import { makeLootboxTile, makeSlotBg, makeWeaponTile } from './merge/tileFactory';

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
 *
 * Структура файла:
 *  - Pointer-обработчики (down/move/up) + tap/drop resolver.
 *  - Selection + glow highlight (preFX.addGlow).
 *  - Геометрия + рендер cells/tiles (фабрики плиток вынесены в `merge/tileFactory.ts`).
 *  - VFX (merge bounce/flash/sparks, lootbox burst) — вынесены в `merge/vfx.ts`.
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
    // VFX-текстуры (spark/flash/shockwave) генерируются один раз для всей сессии
    // через canvas radial gradient. Кешируются в scene.textures, повторные вызовы —
    // no-op. Это позволяет рендерить sparks/flash как Image (batched single draw
    // call) вместо Arc (Graphics, per-object vertex submission).
    ensureMergeVfxTextures(this.scene);
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

  // ============================== Input handling ================================

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
      // alpha < 0.5 = плитка ещё в fade-in после параллельного мерджа. Drag по ней
      // запретим (игрок её толком не видит, схватить пальцем нельзя), но через
      // drop'ом в эту клетку получить мердж — можно, это разрешено в applyMerge.
      if (!tile || tile.alpha < 0.5) {
        this.downIndex = null;
        return;
      }
      this.dragging = true;
      this.dragTile = tile;
      this.clearSelection();
      this.scene.children.bringToTop(tile);
      tile.setScale(1.08);
      // Подсветка drag-плитки (сильный glow) + всех такого же тира (мягкий glow).
      const dragValue = this.field.cells[this.downIndex];
      if (isWeaponCellValue(dragValue)) {
        this.highlightTier(dragValue, this.downIndex);
      }
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
      // Снимаем подсветку до resolveDrop — rebuildTiles внутри его всё пересоздаст, но
      // на случай ранних `return` (drop вне поля без trash) подстрахуемся.
      this.unhighlightAll();
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

  // ============================== Tap & drop resolver ===========================

  private handleTap(index: number): void {
    // Если плитка ещё в fade-in после параллельного мерджа — не реагируем на тап
    // (через мгновение появится — пусть игрок видит, что появилось).
    const existing = this.tileByIndex.get(index);
    if (existing && existing.alpha < 0.5) return;
    const value = this.field.cells[index];

    // Тап по лутбоксу — открыть его (без выделения/мерджа). State мутируется
    // снаружи (cb.onOpenLootbox), а визуал отыгрываем здесь через VFX.
    if (isLootboxCode(value)) {
      this.clearSelection();
      const kind = lootboxKindOfCode(value);
      if (kind && this.cb.onOpenLootbox?.(index, kind)) {
        this.playLootboxOpenVfx(index);
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

  // ============================== Merge & move (state mutation + VFX) ===========

  /**
   * Мердж двух плиток с VFX-анимацией. State мутируется СРАЗУ — игрок может
   * параллельно делать другие действия (мердж в других ячейках, drag другой
   * плитки и т.д.). Анимация старых плиток живёт независимо в Phaser-tween'ах.
   *
   * Цепочка мерджей в одну и ту же ячейку: если to-плитка уже в fade-in после
   * предыдущего мерджа (alpha<1), её сразу делаем видимой (setAlpha(1) +
   * setScale(1)) и помечаем `finalized` — старый VFX докатится до flash, но
   * не дёрнет её повторно scale-bounce.
   */
  private applyMerge(from: number, to: number): void {
    const oldFromTile = this.tileByIndex.get(from);
    const oldToTile = this.tileByIndex.get(to);

    // Если to-плитка ещё в fade-in от предыдущего мерджа — мгновенно показать,
    // чтобы новый VFX стартовал с видимого состояния.
    if (oldToTile && oldToTile.alpha < 1) {
      oldToTile.setAlpha(1).setScale(1);
      oldToTile.setData('finalized', true);
    }

    // State-mutation мгновенно. Дальнейшие операции игры видят актуальное поле.
    const result = mergeInto(this.field, from, to);
    this.cb.onChange();
    if (result != null) this.cb.onMerge?.(result);

    // Старые плитки больше не доступны через map — они доживают свою VFX-жизнь
    // отдельно и destroy себя сами в Phase 5.
    this.tileByIndex.delete(from);
    this.tileByIndex.delete(to);

    // Сразу создаём новую плитку tier+1 в позиции `to`. Она НЕВИДИМА (alpha=0)
    // до завершения VFX, но УЖЕ В map — следующий мердж может её использовать.
    let newTile: Phaser.GameObjects.Container | null = null;
    if (result != null) {
      newTile = this.makeWeaponTileAt(to, result);
      newTile.setAlpha(0).setScale(0.5);
      this.tileByIndex.set(to, newTile);
    }

    // Запуск VFX (без блокировки input).
    if (oldFromTile && oldToTile && result != null && newTile) {
      playMergeVfx(this.scene, this.cellSize, oldFromTile, oldToTile, this.centerOf(to), newTile);
    } else if (newTile) {
      // Без визуала старых плиток анимировать нечего — сразу показать новую.
      newTile.setAlpha(1).setScale(1);
    }
  }

  private applyMove(from: number, to: number): void {
    moveOrSwap(this.field, from, to);
    this.rebuildTiles();
    this.cb.onChange();
  }

  /**
   * VFX открытия лутбокса (~460 ms): старая плитка пухнет → схлопывается, параллельно
   * мини-салют, через 180 ms появляется новая weapon-плитка с fade-in.
   *
   * Анимация старой плитки + салют — в `playLootboxBurst` (merge/vfx.ts). Здесь —
   * только state-доступ: после schlopnut'я создаём new tile из `field.cells[index]`
   * через factory и регистрируем в `tileByIndex`.
   */
  private playLootboxOpenVfx(index: number): void {
    const oldTile = this.tileByIndex.get(index);
    if (!oldTile) {
      // Плитки нет (relayout?) — fallback на мгновенный rebuild.
      this.rebuildTiles();
      return;
    }
    this.tileByIndex.delete(index);
    const center = this.centerOf(index);

    playLootboxBurst(this.scene, this.cellSize, oldTile, center);

    // Phase 3: новая weapon-плитка появляется (через 180ms — когда old схлопнулся).
    this.scene.time.delayedCall(180, () => {
      // Если другой код уже создал плитку на этой клетке (drop/merge во время VFX)
      // — не дублируем.
      if (this.tileByIndex.has(index)) return;
      const v = this.field.cells[index];
      if (!isWeaponCellValue(v)) return;
      const newTile = this.makeWeaponTileAt(index, v);
      newTile.setAlpha(0).setScale(0.3);
      this.tileByIndex.set(index, newTile);
      this.scene.tweens.add({
        targets: newTile,
        alpha: 1,
        scaleX: 1,
        scaleY: 1,
        duration: 280,
        ease: 'Back.Out',
      });
    });
  }

  // ============================== Selection + glow highlight ====================

  private select(index: number): void {
    this.selectedIndex = index;
    const tile = this.tileByIndex.get(index);
    if (!tile) return;
    tile.setScale(1.08);
    const v = this.field.cells[index];
    if (isWeaponCellValue(v)) this.highlightTier(v, index);
  }

  private clearSelection(): void {
    if (this.selectedIndex === null) return;
    const tile = this.tileByIndex.get(this.selectedIndex);
    if (tile) tile.setScale(1);
    this.unhighlightAll();
    this.selectedIndex = null;
  }

  /**
   * Подсветить ВСЕ плитки указанного тира на мердж-поле:
   *   • `primaryIndex` — выделенная/перетаскиваемая плитка → сильный glow (видно, что
   *     именно она «активна»).
   *   • остальные с таким же тиром → слабый glow (подсказка «эту можно слить с этой»).
   *
   * Используется PreFX.addGlow — WebGL шейдер, рисует ауру вокруг непрозрачных пикселей
   * иконки. На canvas-рендере отсутствует (preFX будет undefined) — silently skip.
   */
  private highlightTier(tier: WeaponTier, primaryIndex: number): void {
    for (const [idx, tile] of this.tileByIndex) {
      const v = this.field.cells[idx];
      if (!isWeaponCellValue(v) || v !== tier) continue;
      const icon = tile.getData('icon') as Phaser.GameObjects.Image | undefined;
      if (!icon?.preFX) continue;
      icon.preFX.clear();
      if (idx === primaryIndex) {
        // Сильное белое свечение для активной плитки.
        icon.preFX.addGlow(0xffffff, 8, 2, false, 0.1, 16);
      } else {
        // Подсказка «такого же тира» — мягче.
        icon.preFX.addGlow(0xffffff, 4, 0, false, 0.1, 10);
      }
    }
  }

  /** Снять glow со всех weapon-плиток поля. Безопасно вызывать многократно. */
  private unhighlightAll(): void {
    for (const [, tile] of this.tileByIndex) {
      const icon = tile.getData('icon') as Phaser.GameObjects.Image | undefined;
      icon?.preFX?.clear();
    }
  }

  // ============================== Geometry & cell rendering =====================

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
    for (let i = 0; i < total; i++) {
      this.cellRects.push(makeSlotBg(this.scene, this.centerOf(i), this.cellSize));
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
        if (kind) this.tileByIndex.set(i, makeLootboxTile(this.scene, this.centerOf(i), kind, this.cellSize));
      } else if (isWeaponCellValue(v)) {
        this.tileByIndex.set(i, this.makeWeaponTileAt(i, v));
      }
    }
  }

  /** Обёртка над фабрикой weapon-плитки — добавляет `getState().battledTiers` (для
   *  «NEW!»-ярлыка). Все callsite'ы внутри `MergeBoard` идут через неё, чтобы logic
   *  «откуда читать battledTiers» жил в одном месте. */
  private makeWeaponTileAt(index: number, tier: WeaponTier): Phaser.GameObjects.Container {
    return makeWeaponTile(
      this.scene,
      this.centerOf(index),
      tier,
      this.cellSize,
      getStateBattledTiersSafe(),
    );
  }
}

/** Безопасное чтение `state.battledTiers`: если по какой-то причине state не доступен
 *  (boot-time race?) — возвращаем пустой массив. Лучше не показать «NEW!», чем уронить
 *  весь рендер плитки. */
function getStateBattledTiersSafe(): WeaponTier[] {
  try {
    return getState().battledTiers;
  } catch {
    return [];
  }
}
