import Phaser from 'phaser';
import { UI } from '../config/constants';

export interface ButtonOpts {
  x: number;
  y: number;
  width: number;
  height?: number;
  label: string;
  onClick: () => void;
  fontSize?: number;
  bg?: number;
}

/** Простая кнопка на примитивах: прямоугольник + текст + состояние enabled. */
export class Button {
  readonly container: Phaser.GameObjects.Container;
  private readonly bgRect: Phaser.GameObjects.Rectangle;
  private readonly label: Phaser.GameObjects.Text;
  private readonly baseBg: number;
  private readonly onClick: () => void;
  private enabled = true;

  constructor(scene: Phaser.Scene, opts: ButtonOpts) {
    const h = opts.height ?? 64;
    this.baseBg = opts.bg ?? UI.btn;
    this.onClick = opts.onClick;

    this.bgRect = scene.add.rectangle(0, 0, opts.width, h, this.baseBg).setOrigin(0.5);
    this.bgRect.setStrokeStyle(2, 0x000000, 0.25);
    this.label = scene.add
      .text(0, 0, opts.label, {
        fontFamily: 'monospace',
        fontSize: `${opts.fontSize ?? 24}px`,
        color: UI.btnText,
        align: 'center',
      })
      .setOrigin(0.5);

    this.container = scene.add.container(opts.x, opts.y, [this.bgRect, this.label]);
    this.bgRect.setInteractive({ useHandCursor: true });
    this.bgRect.on('pointerup', () => {
      if (this.enabled) this.onClick();
    });
  }

  setLabel(s: string): void {
    this.label.setText(s);
  }

  setEnabled(b: boolean): void {
    this.enabled = b;
    this.bgRect.setFillStyle(b ? this.baseBg : UI.btnDisabled);
    this.label.setAlpha(b ? 1 : 0.55);
  }

  setPosition(x: number, y: number): void {
    this.container.setPosition(x, y);
  }

  destroy(): void {
    this.container.destroy();
  }
}
