import Phaser from 'phaser';
import { getState } from '../core/storage';
import { isLootboxCode, lootboxKindOfCode } from '../core/lootbox';

/**
 * Инвентарь = бесконечный стек. Одна квадратная ячейка размером ~70% ячейки мердж-поля,
 * показывает только верх стека (последний добытый). Tap → pop с конца, положить в случайную
 * свободную клетку поля (`core/merge.ts → pullFromInventory`).
 *
 * Все визуалы внутри `container` (origin = центр ячейки). Это позволяет двигать инвентарь
 * как один объект через LayoutEditor.
 */
export class InventoryBar {
  readonly container: Phaser.GameObjects.Container;
  private readonly scene: Phaser.Scene;
  private readonly onPull: () => void;
  private size = 0;
  private slot!: Phaser.GameObjects.Rectangle;
  private slotLabel!: Phaser.GameObjects.Text;

  constructor(scene: Phaser.Scene, cx: number, cy: number, size: number, onPull: () => void) {
    this.scene = scene;
    this.onPull = onPull;
    this.size = size;
    this.container = scene.add.container(cx, cy);
    this.build();
    this.rebuild();
  }

  /** Пересоздать визуал на новом размере/позиции (вызывается при relayout поля). */
  relayout(cx: number, cy: number, size: number): void {
    this.container.setPosition(cx, cy);
    this.size = size;
    this.slot.destroy();
    this.slotLabel.destroy();
    this.build();
    this.rebuild();
  }

  destroy(): void {
    this.container.destroy();
  }

  private build(): void {
    // Прозрачный rect — нужен для interactive hit-area, но не рисует свою рамку
    // поверх инвентарного PNG-арта в WorldScene.
    this.slot = this.scene.add
      .rectangle(0, 0, this.size, this.size, 0x000000, 0)
      .setOrigin(0.5);
    this.slot.setInteractive({ useHandCursor: true });
    this.slot.on('pointerup', () => this.onPull());
    this.slotLabel = this.scene.add
      .text(0, 0, '', {
        fontFamily: 'monospace',
        fontSize: `${Math.round(this.size * 0.5)}px`,
        color: '#ffffff',
      })
      .setOrigin(0.5);
    this.slotLabel.setStroke('#000000', 3);
    this.container.add([this.slot, this.slotLabel]);
    this.container.setSize(this.size, this.size);
  }

  rebuild(): void {
    const inv = getState().inventory;
    if (inv.length === 0) {
      // Пусто — ничего не показываем поверх инвентарного арта.
      this.slotLabel.setText('');
      this.slot.disableInteractive();
      return;
    }
    const top = inv[inv.length - 1] as number;
    const isLb = isLootboxCode(top);
    this.slotLabel.setText(isLb ? '📦' : `T${top}`);
    // Цвет лейбла по тиру (для оружия) или белый (для лутбокса) — узнаваемо поверх арта.
    const lbKind = lootboxKindOfCode(top);
    const color = isLb
      ? lbKind === 'elite' ? '#ffd27f' : '#d8a8ff'
      : '#ffffff';
    this.slotLabel.setColor(color);
    this.slot.setInteractive({ useHandCursor: true });
  }
}
