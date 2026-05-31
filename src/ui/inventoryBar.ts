import Phaser from 'phaser';
import { getState } from '../core/storage';
import { isLootboxCode, lootboxKindOfCode } from '../core/lootbox';
import { WEAPON_FRAME_PX } from '../config/constants';

/**
 * Инвентарь = бесконечный стек. Одна квадратная ячейка размером ~70% ячейки мердж-поля,
 * показывает только верх стека (последний добытый). Tap → pop с конца, положить в случайную
 * свободную клетку поля (`core/merge.ts → pullFromInventory`).
 *
 * Если у верха стека есть текстура `weapon.t<N>` — рисуем её. Иначе fallback: текст `T<N>`.
 * Для лутбоксов рисуем эмодзи 📦.
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
  private slotIcon: Phaser.GameObjects.Image | null = null;

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
    this.slotIcon?.destroy();
    this.slotIcon = null;
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
    // Сброс предыдущей иконки.
    if (this.slotIcon) {
      this.slotIcon.destroy();
      this.slotIcon = null;
    }
    if (inv.length === 0) {
      this.slotLabel.setText('');
      this.slot.disableInteractive();
      return;
    }
    const top = inv[inv.length - 1] as number;
    const isLb = isLootboxCode(top);
    if (isLb) {
      // Лутбокс: PNG-иконка ui.lootbox_<kind> с fallback на 📦-emoji если ассета нет.
      const lbKind = lootboxKindOfCode(top);
      const texKey = lbKind ? `ui.lootbox_${lbKind}` : '';
      if (lbKind && this.scene.textures.exists(texKey)) {
        this.slotLabel.setText('');
        const target = this.size * 0.85;
        const icon = this.scene.add
          .image(0, 0, texKey)
          .setOrigin(0.5)
          .setDisplaySize(target, target);
        this.container.add(icon);
        this.slotIcon = icon;
      } else {
        this.slotLabel.setText('📦');
        this.slotLabel.setColor(
          lbKind === 'elite' ? '#ffd27f' : lbKind === 'medium' ? '#d8a8ff' : '#c8b08a',
        );
      }
    } else {
      // Оружие: пробуем иконку weapon.t<N>, fallback на текст «T<N>».
      // Масштаб — по эталонному WEAPON_FRAME_PX (фрейм Figma 136px = 272 PNG @ scale 2).
      // НЕ по max(iw,ih) — это убило бы относительные размеры оружий (см. constants.ts).
      const iconKey = `weapon.t${top}`;
      if (this.scene.textures.exists(iconKey)) {
        this.slotLabel.setText('');
        const tex = this.scene.textures.get(iconKey).getSourceImage();
        const iw = (tex as { width: number }).width ?? 1;
        const ih = (tex as { height: number }).height ?? 1;
        const target = this.size * 0.85;
        const s = target / WEAPON_FRAME_PX;
        const icon = this.scene.add
          .image(0, 0, iconKey)
          .setOrigin(0.5)
          .setDisplaySize(iw * s, ih * s);
        this.container.add(icon);
        this.slotIcon = icon;
      } else {
        this.slotLabel.setText(`T${top}`);
        this.slotLabel.setColor('#ffffff');
      }
    }
    this.slot.setInteractive({ useHandCursor: true });
  }
}
