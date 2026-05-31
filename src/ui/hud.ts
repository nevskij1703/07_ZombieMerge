import Phaser from 'phaser';
import { DESIGN_WIDTH } from '../config/constants';
import { getState } from '../core/storage';

/** Top-bar главного экрана. Стили строго из figma 158:63:
 *   • Settings (PNG 56×67) at (33, 39).
 *   • «УРОВЕНЬ N-M» — text style_TO8NZY: Roboto Black 900, 48px, #FFFFFF,
 *     textShadow «0px 4px 4px rgba(0,0,0,.25), 0px 2px 0px rgba(159,159,159,1)».
 *     Bounding box (215, 50, 289×89), align center.
 *   • Resource: bg rect 143×44 (полупрозрачный чёрный 34%), coin 37×37, text «12 345»
 *     style_HG07GI Roboto Black 900 28px #FFF stroke #000 1px.
 *   • Тёмный градиент top (figma fill_VNRO2G + opacity 0.5) — нарисован canvas-texture'ой
 *     (метод bottom-half black → top-fade-out) в WorldScene, тут только UI элементы. */
const HUD_DEPTH = 300;

export class Hud {
  readonly container: Phaser.GameObjects.Container;
  readonly settingsBtn: Phaser.GameObjects.Container;
  private readonly levelText: Phaser.GameObjects.Text;
  private readonly coinText: Phaser.GameObjects.Text;
  private onSettings: (() => void) | null = null;

  constructor(scene: Phaser.Scene) {
    // Settings — иконка-шестерёнка с press-эффектом.
    const settingsImg = scene.add
      .image(0, 0, 'ui.settings')
      .setOrigin(0.5)
      .setDisplaySize(56, 67);
    this.settingsBtn = scene.add
      .container(33 + 28, 39 + 33, [settingsImg])
      .setSize(56, 67);
    settingsImg.setInteractive({ useHandCursor: true });
    settingsImg.on('pointerup', () => this.onSettings?.());
    const releaseSettings = (): void => {
      settingsImg.setTint(0xffffff);
      scene.tweens.killTweensOf(this.settingsBtn);
      scene.tweens.add({
        targets: this.settingsBtn,
        scaleX: 1.04, scaleY: 1.04, duration: 70, yoyo: true, ease: 'Sine.Out',
        onComplete: () => this.settingsBtn.setScale(1),
      });
    };
    settingsImg.on('pointerdown', () => {
      settingsImg.setTint(0x9a9a9a);
      scene.tweens.killTweensOf(this.settingsBtn);
      scene.tweens.add({
        targets: this.settingsBtn,
        scaleX: 0.94, scaleY: 0.94, duration: 70, ease: 'Sine.Out',
      });
    });
    settingsImg.on('pointerup', releaseSettings);
    settingsImg.on('pointerout', releaseSettings);
    settingsImg.on('pointerupoutside', releaseSettings);

    // «УРОВЕНЬ N-M» по центру.
    this.levelText = scene.add
      .text(DESIGN_WIDTH / 2, 50 + 89 / 2, '', {
        fontFamily: 'Roboto, Arial Black, sans-serif',
        fontStyle: '900',
        fontSize: '40px',
        color: '#FFFFFF',
        align: 'center',
      })
      .setOrigin(0.5);
    // Figma textShadow: 0,2,0 rgba(159,159,159) — твёрдая «нижняя подложка».
    this.levelText.setShadow(0, 2, 'rgba(159, 159, 159, 1)', 0, false, true);

    // Счётчик монет — resource frame. Figma 158:232 «resource»:
    //   • Group at (558, 50), 143×44.
    //   • bg rect 143×44, fill #000 @ alpha 0.34, borderRadius 22 10 10 22
    //     (TL=22, TR=10, BR=10, BL=22 — слева полу-кругло, справа slabo).
    //   • coin instance at (3, 4), 37×37.
    //   • text «12 345» at (45, 9), 91×28 — style_SVPOWL = Roboto Black 900, 28px,
    //     white, stroke black 1px (LEFT-aligned, vertical CENTER).
    const coinBg = scene.add.graphics();
    coinBg.fillStyle(0x000000, 0.34);
    coinBg.fillRoundedRect(0, 0, 143, 44, { tl: 22, tr: 10, br: 10, bl: 22 });
    const coinIcon = scene.add
      .image(3, 4, 'ui.coin')
      .setOrigin(0, 0)
      .setDisplaySize(37, 37);
    this.coinText = scene.add
      .text(45, 9 + 14, '', {
        fontFamily: 'Roboto, Arial Black, sans-serif',
        fontStyle: '900',
        fontSize: '28px',
        color: '#FFFFFF',
      })
      .setOrigin(0, 0.5);
    this.coinText.setStroke('#000000', 1);
    const coinFrame = scene.add.container(558, 50, [coinBg, coinIcon, this.coinText]);

    this.container = scene.add
      .container(0, 0, [this.settingsBtn, this.levelText, coinFrame])
      .setScrollFactor(0)
      .setDepth(HUD_DEPTH)
      .setSize(DESIGN_WIDTH, 165);
    this.refresh();
  }

  setOnSettings(cb: () => void): void {
    this.onSettings = cb;
  }

  refresh(): void {
    const s = getState();
    this.levelText.setText(`УРОВЕНЬ\n${s.level}-${Math.max(s.level, s.maxLevelReached)}`);
    this.coinText.setText(String(s.scrap));
  }
}
