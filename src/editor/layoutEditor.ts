// Визуальный редактор расположения и масштаба элементов локации/UI.
// Включается из dev-panel'и (только в dev — `import.meta.env.DEV`).
//
// Возможности:
//  • Поддержка любых GameObject с x/y/scaleX/scaleY/depth (Image, Container, Rectangle, Text).
//  • drag мышью на сцене (мгновенно меняет позицию).
//  • клик по элементу — выделение, открывает inputs в правой панели.
//  • numeric inputs: X, Y, ScaleX, ScaleY, Uniform Scale, Depth.
//  • Кнопки: Reset / Hide-Show / Duplicate / Delete / Export JSON / Reset ALL.
//  • Drag-reorder списка слоёв мышью — порядок == z-order (верх списка = front).
//    Переупорядочивание пересчитывает `depth` всех зарегистрированных элементов и
//    сохраняет `order` каждого в overrides.
//
// Изменения сохраняются в LocalStorage (`zm_layout_overrides`). При следующей загрузке
// сцены overrides применяются автоматически (`applyOverride` + reorder по `order`).

import Phaser from 'phaser';
import {
  loadOverrides,
  saveOverrides,
  applyOverride,
  exportOverridesJSON,
  clearOverrides,
  type LayoutOverride,
} from './layoutOverrides';

/** Любой Phaser-объект, у которого можно прочитать/задать x/y/scaleX/scaleY/depth/visible. */
type Editable = Phaser.GameObjects.GameObject & {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  depth: number;
  visible: boolean;
  setDepth: (v: number) => unknown;
  setVisible: (v: boolean) => unknown;
  getBounds?: () => Phaser.Geom.Rectangle;
};

interface RegisteredObj {
  id: string;
  obj: Editable;
  defaults: { x: number; y: number; scaleX: number; scaleY: number; depth: number };
  /** Удобный label для списка (если не задан — используется id). */
  label?: string;
}

const css = (el: HTMLElement, style: string): void => {
  el.style.cssText = style;
};

export class LayoutEditor {
  private readonly scene: Phaser.Scene;
  private readonly items = new Map<string, RegisteredObj>();
  private overrides: Record<string, LayoutOverride>;
  private enabled = false;
  private selected: string | null = null;
  private dragId: string | null = null;
  private outlineGfx: Phaser.GameObjects.Rectangle | null = null;

  // HTML
  private panel: HTMLDivElement | null = null;
  private listEl: HTMLDivElement | null = null;
  private headerEl: HTMLDivElement | null = null;
  private exportTextarea: HTMLTextAreaElement | null = null;
  private inputX!: HTMLInputElement;
  private inputY!: HTMLInputElement;
  private inputSX!: HTMLInputElement;
  private inputSY!: HTMLInputElement;
  private inputU!: HTMLInputElement;
  private inputD!: HTMLInputElement;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.overrides = loadOverrides();
  }

  /** Зарегистрировать объект как редактируемый. Применяет override, если он есть.
   *  `label` — опциональная подпись в списке (по умолчанию — `id`). depth объекта НЕ
   *  трогается автоматически (его задаёт код сцены или override) — список слоёв
   *  пересортируется по фактическому `obj.depth`. */
  register(id: string, obj: Editable, label?: string): void {
    if (this.items.has(id)) return;
    const defaults = {
      x: obj.x, y: obj.y, scaleX: obj.scaleX, scaleY: obj.scaleY, depth: obj.depth,
    };
    this.items.set(id, { id, obj, defaults, label });
    const ovr = this.overrides[id];
    if (ovr) applyOverride(obj, ovr);
    if (ovr?.deleted) obj.setVisible(false);

    if (this.enabled) {
      this.makeInteractive(id);
      this.rebuildList();
    }
  }

  unregister(id: string): void {
    const it = this.items.get(id);
    if (!it) return;
    if (typeof (it.obj as unknown as { disableInteractive?: () => void }).disableInteractive === 'function') {
      (it.obj as unknown as { disableInteractive: () => void }).disableInteractive();
    }
    this.items.delete(id);
    if (this.selected === id) this.selectNone();
  }

  toggle(): void {
    if (this.enabled) this.disable();
    else this.enable();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    for (const id of this.items.keys()) this.makeInteractive(id);
    this.scene.input.on(Phaser.Input.Events.DRAG, this.onDrag, this);
    this.scene.input.on(Phaser.Input.Events.DRAG_END, this.onDragEnd, this);
    this.buildPanel();
    this.rebuildList();
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    for (const it of this.items.values()) {
      const obj = it.obj as unknown as { disableInteractive?: () => void };
      obj.disableInteractive?.();
    }
    this.scene.input.off(Phaser.Input.Events.DRAG, this.onDrag, this);
    this.scene.input.off(Phaser.Input.Events.DRAG_END, this.onDragEnd, this);
    this.selectNone();
    this.panel?.remove();
    this.panel = null;
  }

  private makeInteractive(id: string): void {
    const it = this.items.get(id);
    if (!it) return;
    const obj = it.obj;
    // Container'ы НЕ имеют hit-area по умолчанию — задаём через getBounds.
    if (obj instanceof Phaser.GameObjects.Container) {
      const b = obj.getBounds();
      const w = Math.max(20, b.width);
      const h = Math.max(20, b.height);
      // bounds возвращает абсолютные координаты; hit area задаётся в локальных
      // координатах объекта (origin = center для Container? зависит). Используем
      // широкий прямоугольник вокруг центра.
      (obj as Phaser.GameObjects.Container).setSize(w, h);
      (obj as unknown as { setInteractive: (opts: { useHandCursor?: boolean; draggable?: boolean }) => void })
        .setInteractive({ useHandCursor: true, draggable: true });
    } else {
      (obj as unknown as { setInteractive: (opts: { useHandCursor?: boolean; draggable?: boolean }) => void })
        .setInteractive({ useHandCursor: true, draggable: true });
    }
    (obj as unknown as { off: (ev: string) => void }).off?.('pointerdown');
    (obj as unknown as { on: (ev: string, cb: () => void) => void }).on('pointerdown', () => this.select(id));
  }

  private onDrag = (
    _p: Phaser.Input.Pointer,
    obj: Phaser.GameObjects.GameObject,
    dragX: number,
    dragY: number,
  ): void => {
    const e = obj as unknown as Editable;
    e.x = Math.round(dragX);
    e.y = Math.round(dragY);
    for (const [id, it] of this.items) {
      if (it.obj === (obj as unknown as Editable)) {
        this.dragId = id;
        this.updateOverride(id, { x: e.x, y: e.y });
        if (this.selected === id) this.updateInputsFromObj();
        if (this.outlineGfx) this.placeOutline(it.obj);
        break;
      }
    }
  };

  private onDragEnd = (): void => {
    if (this.dragId) {
      saveOverrides(this.overrides);
      this.dragId = null;
    }
  };

  private select(id: string): void {
    this.selected = id;
    this.removeOutline();
    const it = this.items.get(id);
    if (it) this.placeOutline(it.obj);
    this.updateInputsFromObj();
    this.highlightInList();
  }

  private selectNone(): void {
    this.selected = null;
    this.removeOutline();
    if (this.headerEl) this.headerEl.textContent = '— ничего не выбрано —';
    this.highlightInList();
  }

  private placeOutline(obj: Editable): void {
    const b = obj.getBounds?.();
    if (!b) return;
    if (!this.outlineGfx) {
      this.outlineGfx = this.scene.add.rectangle(b.centerX, b.centerY, b.width, b.height, 0x00ff00, 0);
      this.outlineGfx.setStrokeStyle(2, 0x00ff00, 1).setDepth(99999);
    }
    this.outlineGfx.setPosition(b.centerX, b.centerY);
    this.outlineGfx.setSize(b.width, b.height);
  }

  private removeOutline(): void {
    this.outlineGfx?.destroy();
    this.outlineGfx = null;
  }

  private updateOverride(id: string, patch: Partial<LayoutOverride>): void {
    const existing = this.overrides[id] ?? {};
    this.overrides[id] = { ...existing, ...patch };
  }

  private updateInputsFromObj(): void {
    if (!this.selected) return;
    const it = this.items.get(this.selected);
    if (!it) return;
    if (this.headerEl) this.headerEl.textContent = it.label ?? it.id;
    this.inputX.value = String(Math.round(it.obj.x));
    this.inputY.value = String(Math.round(it.obj.y));
    this.inputSX.value = it.obj.scaleX.toFixed(3);
    this.inputSY.value = it.obj.scaleY.toFixed(3);
    this.inputU.value = ((it.obj.scaleX + it.obj.scaleY) / 2).toFixed(3);
    this.inputD.value = String(it.obj.depth);
  }

  /** Текущий порядок слоёв = сортировка items по `obj.depth` desc.
   *  Верх списка = max depth (передний). Низ = min depth (задний). */
  private computeOrder(): string[] {
    return [...this.items.keys()].sort((a, b) => {
      const da = this.items.get(a)!.obj.depth;
      const db = this.items.get(b)!.obj.depth;
      return db - da;
    });
  }

  // ============================ HTML PANEL ============================

  private buildPanel(): void {
    if (this.panel) return;
    const p = document.createElement('div');
    css(
      p,
      'position:fixed;top:50px;right:8px;width:300px;max-height:90vh;overflow:auto;background:#0c0e13ee;color:#dde;border:1px solid #3a414d;border-radius:8px;padding:10px;font:12px monospace;z-index:10001;',
    );

    const title = document.createElement('div');
    title.textContent = '🛠 Layout Editor';
    css(title, 'font-size:14px;font-weight:bold;margin-bottom:6px;color:#9fe870;');
    p.appendChild(title);

    const sel = document.createElement('div');
    sel.textContent = '— ничего не выбрано —';
    css(sel, 'margin:4px 0 8px;padding:6px;background:#1a1f28;border-radius:4px;color:#cfe9ff;');
    this.headerEl = sel;
    p.appendChild(sel);

    // Inputs grid.
    const grid = document.createElement('div');
    css(grid, 'display:grid;grid-template-columns:auto 1fr auto 1fr;gap:4px;align-items:center;margin-bottom:8px;');
    const mkInput = (lab: string): HTMLInputElement => {
      const l = document.createElement('label');
      l.textContent = lab;
      css(l, 'font-size:11px;color:#aab;');
      const i = document.createElement('input');
      i.type = 'number';
      i.step = 'any';
      css(i, 'width:100%;background:#15171c;color:#fff;border:1px solid #3a414d;border-radius:3px;padding:3px;font:11px monospace;');
      grid.append(l, i);
      return i;
    };
    this.inputX = mkInput('X');
    this.inputY = mkInput('Y');
    this.inputSX = mkInput('ScaleX');
    this.inputSY = mkInput('ScaleY');
    this.inputU = mkInput('Uniform');
    this.inputD = mkInput('Depth');
    p.appendChild(grid);

    const wireInput = (
      i: HTMLInputElement,
      apply: (v: number, it: RegisteredObj) => void,
      ovrPatch: (v: number) => Partial<LayoutOverride>,
    ): void => {
      i.oninput = () => {
        if (!this.selected) return;
        const it = this.items.get(this.selected);
        if (!it) return;
        const v = parseFloat(i.value);
        if (!Number.isFinite(v)) return;
        apply(v, it);
        this.updateOverride(it.id, ovrPatch(v));
        saveOverrides(this.overrides);
        if (this.outlineGfx) this.placeOutline(it.obj);
      };
    };
    wireInput(this.inputX, (v, it) => (it.obj.x = v), (v) => ({ x: v }));
    wireInput(this.inputY, (v, it) => (it.obj.y = v), (v) => ({ y: v }));
    wireInput(this.inputSX, (v, it) => (it.obj.scaleX = v), (v) => ({ scaleX: v }));
    wireInput(this.inputSY, (v, it) => (it.obj.scaleY = v), (v) => ({ scaleY: v }));
    wireInput(
      this.inputU,
      (v, it) => { it.obj.scaleX = v; it.obj.scaleY = v;
        this.inputSX.value = v.toFixed(3); this.inputSY.value = v.toFixed(3);
      },
      (v) => ({ scaleX: v, scaleY: v }),
    );
    wireInput(this.inputD, (v, it) => it.obj.setDepth(v), (v) => ({ depth: v }));

    // Action buttons.
    const btnsRow = document.createElement('div');
    css(btnsRow, 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;');
    const mkBtn = (label: string, bg: string, onClick: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.textContent = label;
      css(b, `background:${bg};color:#fff;border:0;border-radius:4px;padding:4px 8px;font:11px monospace;cursor:pointer;`);
      b.onclick = onClick;
      btnsRow.appendChild(b);
      return b;
    };
    mkBtn('Reset item', '#5a5f6a', () => this.resetSelected());
    mkBtn('Hide/Show', '#3a414d', () => this.toggleVisibilitySelected());
    mkBtn('Duplicate', '#2e5b7d', () => this.duplicateSelected());
    mkBtn('Delete', '#b23b3b', () => this.deleteSelected());
    p.appendChild(btnsRow);

    const btnsRow2 = document.createElement('div');
    css(btnsRow2, 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;');
    const mkBtn2 = (label: string, bg: string, onClick: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.textContent = label;
      css(b, `background:${bg};color:#fff;border:0;border-radius:4px;padding:4px 8px;font:11px monospace;cursor:pointer;flex:1;`);
      b.onclick = onClick;
      btnsRow2.appendChild(b);
      return b;
    };
    mkBtn2('Export JSON ▼', '#2e7d32', () => this.showExportTextarea());
    mkBtn2('Reset ALL', '#7d2e2e', () => {
      if (!confirm('Сбросить ВСЕ overrides?')) return;
      clearOverrides();
      this.overrides = {};
      for (const it of this.items.values()) {
        it.obj.x = it.defaults.x;
        it.obj.y = it.defaults.y;
        it.obj.scaleX = it.defaults.scaleX;
        it.obj.scaleY = it.defaults.scaleY;
        it.obj.setDepth(it.defaults.depth);
        it.obj.setVisible(true);
      }
      this.updateInputsFromObj();
      this.rebuildList();
    });
    p.appendChild(btnsRow2);

    // Export textarea (скрыта по умолчанию; раскрывается по клику Export JSON ▼).
    const exportTa = document.createElement('textarea');
    exportTa.readOnly = true;
    exportTa.style.display = 'none';
    css(
      exportTa,
      'width:100%;height:140px;background:#0a0c10;color:#cfe;border:1px solid #3a414d;border-radius:4px;padding:6px;font:10px monospace;white-space:pre;margin-bottom:6px;resize:vertical;',
    );
    this.exportTextarea = exportTa;
    p.appendChild(exportTa);

    // List of items (drag-reorder).
    const listTitle = document.createElement('div');
    listTitle.textContent = 'Слои (drag по строке = переместить, click = выбрать):';
    css(listTitle, 'margin-top:6px;color:#aab;font-size:11px;');
    p.appendChild(listTitle);

    const list = document.createElement('div');
    css(list, 'max-height:300px;overflow:auto;background:#0a0c10;border-radius:4px;padding:4px;');
    this.listEl = list;
    p.appendChild(list);

    document.body.appendChild(p);
    this.panel = p;
  }

  private rebuildList(): void {
    if (!this.listEl) return;
    this.listEl.innerHTML = '';
    const ordered = this.computeOrder();
    for (const id of ordered) {
      const it = this.items.get(id);
      if (!it) continue;
      const ovr = this.overrides[id];
      const isDeleted = ovr?.deleted === true;
      const isHidden = ovr?.visible === false;
      const tag = isDeleted ? ' [del]' : isHidden ? ' [hid]' : '';
      const label = it.label ?? id;
      const depthHint = ` (d=${it.obj.depth.toFixed(1)})`;

      const row = document.createElement('div');
      row.draggable = true;
      row.dataset.id = id;
      row.textContent = `≡  ${label}${tag}${depthHint}`;
      css(
        row,
        `padding:4px 6px;margin:1px 0;cursor:grab;border-radius:3px;font-size:11px;` +
          `color:${isDeleted ? '#888' : '#dde'};` +
          `background:${this.selected === id ? '#2e5b7d' : '#15171c'};`,
      );
      row.onclick = (e) => {
        if (!(e.target as HTMLElement).dataset.dragging) this.select(id);
      };
      row.ondragstart = (e) => {
        e.dataTransfer?.setData('text/plain', id);
        row.dataset.dragging = '1';
        row.style.opacity = '0.5';
      };
      row.ondragend = () => {
        delete row.dataset.dragging;
        row.style.opacity = '1';
      };
      row.ondragover = (e) => {
        e.preventDefault();
        row.style.borderTop = '2px solid #9fe870';
      };
      row.ondragleave = () => {
        row.style.borderTop = '';
      };
      row.ondrop = (e) => {
        e.preventDefault();
        row.style.borderTop = '';
        const fromId = e.dataTransfer?.getData('text/plain');
        if (!fromId || fromId === id) return;
        this.reorder(fromId, id);
      };
      this.listEl.appendChild(row);
    }
    this.highlightInList();
  }

  /** Переставить `fromId` так, чтобы он оказался ПРЯМО НАД `toId` в списке (= depth выше). */
  private reorder(fromId: string, toId: string): void {
    const fromItem = this.items.get(fromId);
    const toItem = this.items.get(toId);
    if (!fromItem || !toItem) return;
    // Цель: fromId выше toId. Находим item ВЫШЕ toId (если есть) — между ними вставим.
    const order = this.computeOrder();
    const toIdx = order.indexOf(toId);
    const aboveDepth = toIdx > 0 ? this.items.get(order[toIdx - 1])!.obj.depth : toItem.obj.depth + 2;
    const targetDepth = (toItem.obj.depth + aboveDepth) / 2;
    fromItem.obj.setDepth(targetDepth);
    this.updateOverride(fromId, { depth: targetDepth });
    saveOverrides(this.overrides);
    this.rebuildList();
    this.updateInputsFromObj();
  }

  private highlightInList(): void {
    if (!this.listEl) return;
    for (const row of Array.from(this.listEl.children) as HTMLElement[]) {
      const id = row.dataset.id;
      const ovr = id ? this.overrides[id] : null;
      const isDeleted = ovr?.deleted === true;
      row.style.background = id === this.selected ? '#2e5b7d' : '#15171c';
      row.style.color = isDeleted ? '#888' : '#dde';
    }
  }

  private resetSelected(): void {
    if (!this.selected) return;
    const it = this.items.get(this.selected);
    if (!it) return;
    it.obj.x = it.defaults.x;
    it.obj.y = it.defaults.y;
    it.obj.scaleX = it.defaults.scaleX;
    it.obj.scaleY = it.defaults.scaleY;
    it.obj.setDepth(it.defaults.depth);
    it.obj.setVisible(true);
    delete this.overrides[it.id];
    saveOverrides(this.overrides);
    this.updateInputsFromObj();
    if (this.outlineGfx) this.placeOutline(it.obj);
    this.rebuildList();
  }

  private toggleVisibilitySelected(): void {
    if (!this.selected) return;
    const it = this.items.get(this.selected);
    if (!it) return;
    const newVis = !it.obj.visible;
    it.obj.setVisible(newVis);
    this.updateOverride(it.id, { visible: newVis });
    saveOverrides(this.overrides);
    this.rebuildList();
  }

  private deleteSelected(): void {
    if (!this.selected) return;
    const it = this.items.get(this.selected);
    if (!it) return;
    it.obj.setVisible(false);
    this.updateOverride(it.id, { deleted: true, visible: false });
    saveOverrides(this.overrides);
    this.rebuildList();
  }

  private duplicateSelected(): void {
    if (!this.selected) return;
    const it = this.items.get(this.selected);
    if (!it) return;
    // Дубликат имеет смысл только для Image (есть texture key).
    if (!(it.obj instanceof Phaser.GameObjects.Image)) {
      if (this.headerEl) this.headerEl.textContent = 'Duplicate работает только для Image';
      setTimeout(() => this.updateInputsFromObj(), 1200);
      return;
    }
    const newId = `${it.id}#${Date.now() % 100000}`;
    const tex = (it.obj as Phaser.GameObjects.Image).texture.key;
    const newImg = this.scene.add.image(it.obj.x + 30, it.obj.y + 30, tex);
    newImg.setOrigin((it.obj as Phaser.GameObjects.Image).originX, (it.obj as Phaser.GameObjects.Image).originY);
    newImg.setScale(it.obj.scaleX, it.obj.scaleY);
    newImg.setDepth(it.obj.depth);
    this.register(newId, newImg as Editable, `${it.label ?? it.id} (copy)`);
    this.updateOverride(newId, {
      x: newImg.x, y: newImg.y, scaleX: newImg.scaleX, scaleY: newImg.scaleY, depth: newImg.depth,
      cloneOf: it.id, texture: tex,
    });
    saveOverrides(this.overrides);
    this.select(newId);
  }

  /** Показывает JSON-overrides в textarea внутри панели редактора. Auto-select содержимого
   *  — пользователь сразу жмёт Ctrl+C (избегаем clipboard API, который часто блокируется). */
  private showExportTextarea(): void {
    const json = exportOverridesJSON();
    const ta = this.exportTextarea;
    if (!ta) return;
    ta.value = json;
    ta.style.display = 'block';
    // Сразу выделить + сфокусировать.
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, json.length);
    if (this.headerEl) {
      const prev = this.headerEl.textContent;
      this.headerEl.textContent = 'JSON выделён — Ctrl+C для копирования';
      setTimeout(() => { if (this.headerEl) this.headerEl.textContent = prev; }, 2500);
    }
  }
}
