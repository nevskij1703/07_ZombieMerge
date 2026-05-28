import Phaser from 'phaser';
import { TIER_COLORS, UI } from '../config/constants';
import { getState } from '../core/storage';
import { isLootboxCode, lootboxKindOfCode } from '../core/lootbox';

export interface InventoryRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MAX_VISIBLE = 9;

// Буфер переполнения (не-мердж). Тап по предмету -> вынести на свободную клетку поля.
export class InventoryBar {
  private readonly scene: Phaser.Scene;
  private readonly rect: InventoryRect;
  private readonly onPull: (index: number) => void;
  private readonly label: Phaser.GameObjects.Text;
  private items: Phaser.GameObjects.GameObject[] = [];

  constructor(scene: Phaser.Scene, rect: InventoryRect, onPull: (index: number) => void) {
    this.scene = scene;
    this.rect = rect;
    this.onPull = onPull;
    scene.add.rectangle(rect.x + rect.w / 2, rect.y + rect.h / 2, rect.w, rect.h, UI.hudBg).setOrigin(0.5);
    this.label = scene.add.text(rect.x + 10, rect.y + 6, '', {
      fontFamily: 'monospace',
      fontSize: '18px',
      color: '#9aa0a6',
    });
    this.rebuild();
  }

  rebuild(): void {
    this.items.forEach((o) => o.destroy());
    this.items = [];

    const inv = getState().inventory;
    this.label.setText(`Инвентарь (${inv.length})`);

    const size = this.rect.h * 0.6;
    const gap = 8;
    const startX = this.rect.x + 12;
    const y = this.rect.y + this.rect.h - size / 2 - 8;
    const count = Math.min(inv.length, MAX_VISIBLE);

    for (let i = 0; i < count; i++) {
      const v = inv[i];
      const x = startX + i * (size + gap) + size / 2;
      const lbKind = lootboxKindOfCode(v);
      const isLb = isLootboxCode(v);
      const color = isLb ? (lbKind === 'elite' ? 0x9b59b6 : 0xd4a017) : TIER_COLORS[v] ?? 0x888888;
      const bg = this.scene.add.rectangle(x, y, size, size, color).setOrigin(0.5);
      bg.setStrokeStyle(2, isLb ? 0xffffff : 0x000000, isLb ? 0.6 : 0.3);
      const label = isLb ? '📦' : String(v);
      const txt = this.scene.add
        .text(x, y, label, { fontFamily: 'monospace', fontSize: `${Math.round(size * (isLb ? 0.5 : 0.4))}px`, color: '#ffffff' })
        .setOrigin(0.5);
      txt.setStroke('#000000', 3);
      bg.setInteractive({ useHandCursor: true });
      bg.on('pointerup', () => this.onPull(i));
      this.items.push(bg, txt);
    }

    if (inv.length > MAX_VISIBLE) {
      const x = startX + MAX_VISIBLE * (size + gap) + size / 2;
      const more = this.scene.add
        .text(x, y, `+${inv.length - MAX_VISIBLE}`, { fontFamily: 'monospace', fontSize: '18px', color: '#cccccc' })
        .setOrigin(0.5);
      this.items.push(more);
    }
  }
}
