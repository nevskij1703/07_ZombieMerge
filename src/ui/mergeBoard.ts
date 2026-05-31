import Phaser from 'phaser';
import type { FieldState, LootboxKind, WeaponTier } from '../types';
import { UI, WEAPON_FRAME_PX } from '../config/constants';
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
    // VFX-текстуры (spark / flash / shockwave) генерируются один раз для всей
    // сессии через canvas radial gradient. Кешируются в scene.textures, повторные
    // вызовы — no-op. Это позволяет рендерить sparks/flash как Image (batched
    // single draw call) вместо Arc (Graphics, per-object vertex submission).
    this.ensureVfxTextures();
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

  // --- Логика слотов ---

  private handleTap(index: number): void {
    // Если плитка ещё в fade-in после параллельного мерджа — не реагируем на тап
    // (через мгновение появится — пусть игрок видит, что появилось).
    const existing = this.tileByIndex.get(index);
    if (existing && existing.alpha < 0.5) return;
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
      newTile = this.makeTile(to, result);
      newTile.setAlpha(0).setScale(0.5);
      this.tileByIndex.set(to, newTile);
    }

    // Запуск VFX (без блокировки input).
    if (oldFromTile && oldToTile && result != null && newTile) {
      this.playMergeVfx(oldFromTile, oldToTile, this.centerOf(to), newTile);
    } else if (newTile) {
      // Без визуала старых плиток анимировать нечего — сразу показать новую.
      newTile.setAlpha(1).setScale(1);
    }
  }

  /**
   * VFX мерджа двух плиток (~440ms всего). НЕ блокирует input и НЕ блокирует
   * параллельные мерджи — каждый VFX живёт независимо.
   *   Phase 1 (0-60ms):    fromTile долетает до центра to-ячейки (если был drag).
   *   Phase 2 (60-180ms):  расходятся ±25% cellSize по X («накапливают энергию»).
   *   Phase 3 (180-330ms): тряска (yoyo по 25ms, 3 repeat) с мелким смещением по Y.
   *   Phase 4 (330-440ms): резкое схождение в центр, scale → 0.3, alpha → 0.
   *   Phase 5 (440+ms):    вспышка ADD-blend круга, fade-in новой плитки tier+1.
   *   Параллельно (0-580ms): 10 «искр» с радиусов 1.0-1.6 × cellSize летят к центру.
   *
   * `newTile` уже создан в applyMerge и лежит в tileByIndex. Если до завершения
   * фазы 5 он успел стать частью другого мерджа (data 'finalized' === true) или
   * был destroy'ed — пропускаем fade-in, не дёргаем повторно.
   */
  private playMergeVfx(
    fromTile: Phaser.GameObjects.Container,
    toTile: Phaser.GameObjects.Container,
    toCenter: { x: number; y: number },
    newTile: Phaser.GameObjects.Container,
  ): void {
    const scene = this.scene;
    const cs = this.cellSize;
    // Поднимаем участников поверх остальных плиток.
    fromTile.setDepth(50);
    toTile.setDepth(50);

    // Искорки.
    this.spawnMergeSparks(toCenter, 580);

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
        x: toCenter.x - cs * 0.25,
        duration: 120,
        ease: 'Sine.Out',
      });
      scene.tweens.add({
        targets: toTile,
        x: toCenter.x + cs * 0.25,
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
        x: toCenter.x - cs * 0.25 - 3,
        duration: 25,
        yoyo: true,
        repeat: 2,
        ease: 'Sine.InOut',
      });
      scene.tweens.add({
        targets: toTile,
        y: toCenter.y - 4,
        x: toCenter.x + cs * 0.25 + 3,
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
          flash.setDisplaySize(cs * 0.24, cs * 0.24);
          scene.tweens.add({
            targets: flash,
            displayWidth: cs * 1.44,
            displayHeight: cs * 1.44,
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
          wave.setDisplaySize(cs * 0.4, cs * 0.4);
          scene.tweens.add({
            targets: wave,
            displayWidth: cs * 2.5,
            displayHeight: cs * 2.5,
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
  private ensureVfxTextures(): void {
    this.makeRadialTexture(
      'merge.spark',
      32,
      [
        [0.0, 'rgba(255, 244, 179, 1.0)'],
        [0.5, 'rgba(255, 244, 179, 0.55)'],
        [1.0, 'rgba(255, 244, 179, 0.0)'],
      ],
    );
    this.makeRadialTexture(
      'merge.flash',
      128,
      [
        [0.0, 'rgba(255, 255, 255, 1.0)'],
        [0.6, 'rgba(255, 255, 255, 0.9)'],
        [1.0, 'rgba(255, 255, 255, 0.0)'],
      ],
    );
    this.makeRadialTexture(
      'merge.shockwave',
      512,
      [
        [0.0, 'rgba(255, 255, 255, 0.0)'],
        [0.55, 'rgba(255, 255, 255, 0.04)'],
        [0.82, 'rgba(255, 255, 255, 0.35)'],
        [0.94, 'rgba(255, 255, 255, 1.0)'],
        [1.0, 'rgba(255, 255, 255, 0.0)'],
      ],
    );
  }

  /** Один helper для создания radial-gradient PNG-текстуры через canvas. */
  private makeRadialTexture(key: string, size: number, stops: Array<[number, string]>): void {
    if (this.scene.textures.exists(key)) return;
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
    this.scene.textures.addCanvas(key, canvas);
  }

  /**
   * 8 «искр» (Image из `merge.spark`, ADD-blend) летят к target с разных
   * радиусов 1.0-1.6 × cellSize. duration варьируется per-spark (65-100%
   * базового) — частицы не приходят в один кадр.
   */
  private spawnMergeSparks(target: { x: number; y: number }, duration: number): void {
    const COUNT = 8;
    const cs = this.cellSize;
    for (let i = 0; i < COUNT; i++) {
      const angle = (Math.PI * 2 * i) / COUNT + (Math.random() - 0.5) * 0.4;
      const radius = cs * (1.0 + Math.random() * 0.6);
      const sx = target.x + Math.cos(angle) * radius;
      const sy = target.y + Math.sin(angle) * radius;
      const sizePx = 7 + Math.random() * 4; // 7-11 px видимый диаметр
      const spark = this.scene.add
        .image(sx, sy, 'merge.spark')
        .setOrigin(0.5)
        .setDepth(40)
        .setBlendMode(Phaser.BlendModes.ADD);
      spark.setDisplaySize(sizePx, sizePx);
      this.scene.tweens.add({
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
    const iconKey = `weapon.t${tier}`;
    const hasIcon = this.scene.textures.exists(iconKey);

    const children: Phaser.GameObjects.GameObject[] = [];
    let iconObj: Phaser.GameObjects.Image | null = null;

    if (hasIcon) {
      // Иконка оружия по центру слота. Масштаб — по эталонному фрейму Figma 272 px:
      // винтовка визуально длиннее ножа (см. WEAPON_FRAME_PX в constants.ts).
      const tex = this.scene.textures.get(iconKey).getSourceImage();
      const iconW = (tex as { width: number }).width ?? 1;
      const iconH = (tex as { height: number }).height ?? 1;
      const target = this.cellSize * 0.85;
      const scale = target / WEAPON_FRAME_PX;
      iconObj = this.scene.add
        .image(0, 0, iconKey)
        .setOrigin(0.5)
        .setDisplaySize(iconW * scale, iconH * scale);
      children.push(iconObj);
    } else {
      // Fallback (PNG-иконка не загружена): крупная цифра тира + название мелким текстом.
      const tierTxt = this.scene.add
        .text(0, -this.cellSize * 0.10, String(tier), {
          fontFamily: 'Inter, Roboto, Arial Black, sans-serif',
          fontStyle: '900',
          fontSize: `${Math.round(this.cellSize * 0.34)}px`,
          color: '#ffffff',
        })
        .setOrigin(0.5);
      tierTxt.setStroke('#000000', 4);
      const nameTxt = this.scene.add
        .text(0, this.cellSize * 0.27, weaponName(tier), {
          fontFamily: 'Inter, Roboto, Arial Black, sans-serif',
          fontSize: `${Math.round(this.cellSize * 0.12)}px`,
          color: '#ffffff',
        })
        .setOrigin(0.5);
      nameTxt.setStroke('#000000', 3);
      children.push(tierTxt, nameTxt);
    }

    // Цифра тира в правом нижнем углу: чистая надпись без обводки/тени, Inter Black
    // 900. Цвет `rgba(0,0,0,0.65)` — чёрный полупрозрачный, выбран как «универсальный»
    // на любую подложку (тёмный фон → силуэт виден за счёт полупрозрачности, светлый
    // → проступает как тёмная цифра). Размер шрифта АДАПТИВНЫЙ: 32px при cellSize
    // 136 (3×3 / 2×3 поле — эталон), на других полях пропорционально, мин 10px.
    const REFERENCE_CELL_SIZE = 136;
    const REFERENCE_BADGE_FONT = 32;
    const badgeFontPx = Math.max(
      10,
      Math.round((this.cellSize * REFERENCE_BADGE_FONT) / REFERENCE_CELL_SIZE),
    );
    const badgeOffset = this.cellSize * 0.35;
    const tierBadge = this.scene.add
      .text(badgeOffset, badgeOffset, String(tier), {
        fontFamily: 'Inter, Roboto, Arial Black, sans-serif',
        fontStyle: '900',
        fontSize: `${badgeFontPx}px`,
        color: 'rgba(0, 0, 0, 0.30)',
      })
      .setOrigin(0.5);
    children.push(tierBadge);

    const tile = this.scene.add.container(c.x, c.y, children);
    if (iconObj) tile.setData('icon', iconObj);
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
