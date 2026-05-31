// UI главного экрана: нижний ряд + кнопка «В БОЙ!». Координаты из figma (158:63).
//
// Layout: Frame 4 (0, 1120, 720×~123) с alignItems=flex-end. Produce (252×123) самая
// высокая, остальные 4 кнопки (94×98) выравнены ПО НИЖНЕМУ КРАЮ frame'а ⇒ их top на
// 1120 + (123-98) = 1145, центр = 1194.
//
// Стили текста (из figma):
//   • Маленькие лейблы (style_KHNJWT): Roboto 900, 15px, #773F17.
//   • ПРОИЗВЕСТИ + В БОЙ! (style_ZJGFXS): Roboto 900, 32px. Produce — white +
//     stroke #000 1px. Fight — #5C2F0D + stroke #FFD17C 1px.
//   • «999» (style_EBLEKK): Roboto 900, 32px, white + stroke #000 1px.

import Phaser from 'phaser';
import { TIER_COLORS, WEAPON_FRAME_PX } from '../config/constants';
import { getState } from '../core/storage';
import { produceCost } from '../core/economy';
import { isFull } from '../core/merge';

export interface MainScreenCallbacks {
  onProduce: () => void;
  onBattle: () => void;
  onSettings: () => void;
  onProfile: () => void;
  onUpgrade: () => void;
  onCards: () => void;
  onShop: () => void;
}

interface UiButton {
  container: Phaser.GameObjects.Container;
  bg: Phaser.GameObjects.Image;
  setEnabled: (enabled: boolean) => void;
  enabled: boolean;
}

const BUTTON_DEPTH = 100;
const FONT = 'Roboto, Arial Black, sans-serif';

/** Стандартный press-эффект: при удержании — squash + затемнение, при отпускании — bounce.
 *  Применяется к bg-слою (Image), визуально дёргает весь контейнер через tween scale. */
function attachPressEffect(
  scene: Phaser.Scene,
  bg: Phaser.GameObjects.Image,
  container: Phaser.GameObjects.Container,
  getEnabled: () => boolean,
  enabledTint: number = 0xffffff,
): void {
  const PRESS_SCALE = 0.94;
  const RELEASE_BOUNCE = 1.04;
  let pressed = false;
  const release = (): void => {
    if (!pressed) return;
    pressed = false;
    bg.setTint(getEnabled() ? enabledTint : 0x707070);
    scene.tweens.killTweensOf(container);
    scene.tweens.add({
      targets: container,
      scaleX: RELEASE_BOUNCE, scaleY: RELEASE_BOUNCE,
      duration: 70, yoyo: true, ease: 'Sine.Out',
      onComplete: () => container.setScale(1),
    });
  };
  bg.on('pointerdown', () => {
    if (!getEnabled()) return;
    pressed = true;
    bg.setTint(0x9a9a9a); // лёгкое затемнение
    scene.tweens.killTweensOf(container);
    scene.tweens.add({
      targets: container,
      scaleX: PRESS_SCALE, scaleY: PRESS_SCALE,
      duration: 70, ease: 'Sine.Out',
    });
  });
  bg.on('pointerup', release);
  bg.on('pointerout', release);
  bg.on('pointerupoutside', release);
}

export class MainScreenUI {
  readonly btnProfile: UiButton;
  readonly btnUpgrade: UiButton;
  readonly btnProduce: UiButton;
  readonly btnCards: UiButton;
  readonly btnShop: UiButton;
  readonly btnFight: UiButton;
  private produceWeaponIcon: Phaser.GameObjects.Image;
  private produceWeaponTier: Phaser.GameObjects.Text;
  /** Текущий тир, для которого создана produceWeaponIcon. Меняется только если тир сменился. */
  private produceIconTier = 0;
  private produceContainer!: Phaser.GameObjects.Container;
  private produceLabel: Phaser.GameObjects.Text;
  private produceCostText: Phaser.GameObjects.Text;

  private scene: Phaser.Scene;
  private cb: MainScreenCallbacks;

  constructor(scene: Phaser.Scene, cb: MainScreenCallbacks) {
    this.scene = scene;
    this.cb = cb;

    // (тёмные градиенты top/bottom рисует WorldScene.buildGradients — canvas-textures.)

    // ============== Нижний ряд: 5 кнопок, выравнены по НИЖНЕМУ краю Frame 4 ==============
    // Frame 4: top=1120, height=123 (hug по самому высокому ребёнку — produce).
    // Маленькие 94×98: top = 1120 + (123-98) = 1145, centerY = 1145 + 49 = 1194.
    const SMALL_CY = 1194;
    this.btnProfile = this.makeIconButton(
      20 + 47, SMALL_CY, 94, 98,
      'ui.btn_brown', 'ui.profile', 'ПРОФИЛЬ',
      { iconW: 44, iconH: 53, iconOffsetY: 8 - 49 + 53 / 2 },
      () => cb.onProfile(),
    );
    this.btnUpgrade = this.makeIconButton(
      127 + 47, SMALL_CY, 94, 98,
      'ui.btn_brown', 'ui.upgrade', 'АПГРЕЙД',
      { iconW: 55, iconH: 47, iconOffsetY: 9 - 49 + 47 / 2 },
      () => cb.onUpgrade(),
    );
    this.btnCards = this.makeIconButton(
      499 + 47, SMALL_CY, 94, 98,
      'ui.btn_brown', 'ui.cards', 'КАРТЫ',
      { iconW: 64, iconH: 54, iconOffsetY: 9 - 49 + 54 / 2 },
      () => cb.onCards(),
    );
    this.btnShop = this.makeIconButton(
      606 + 47, SMALL_CY, 94, 98,
      'ui.btn_brown', 'ui.shop', 'МАГАЗИН',
      { iconW: 63, iconH: 51, iconOffsetY: 10 - 49 + 51 / 2 },
      () => cb.onShop(),
    );

    // ============== ПРОИЗВЕСТИ — большая зелёная (figma 234, 1120, 252×123) ==============
    const produceCx = 234 + 126;
    const produceCy = 1120 + 62;
    const produceContainer = scene.add.container(produceCx, produceCy);
    const produceBg = scene.add.image(0, 0, 'ui.btn_green').setOrigin(0.5).setDisplaySize(252, 123);

    // Figma 158:206 (Frame 10, produce, 252×123). Все координаты — в координатах
    // ОТНОСИТЕЛЬНО центра кнопки (= local figma + button_center{126,61.5}, минус center).
    //
    // «ПРОИЗВЕСТИ» — style_0T45C1 Roboto Black 900 32px, white + stroke #000 1px.
    //   figma local (17, 9, 217×47) → центр (125.5, 32.5) → button-center (-0.5, -29).
    this.produceLabel = scene.add
      .text(0, -29, 'ПРОИЗВЕСТИ', {
        fontFamily: FONT,
        fontStyle: '900',
        fontSize: '32px',
        color: '#FFFFFF',
      })
      .setOrigin(0.5);
    this.produceLabel.setStroke('#000000', 1);

    // ⇄ arrows-icon (figma 158:54) — figma local (112, 62, 28×35) → центр (126, 79.5) →
    // button-center (0, 18). По центру кнопки горизонтально, чуть ниже центра вертикально.
    const arrowsIcon = scene.add.image(0, 18, 'ui.arrows').setOrigin(0.5).setDisplaySize(28, 35);

    // Group 2 (right): coin + «999». figma group at (152, 59, 87×38) → центр (195.5, 78) →
    // button-center (69.5, 16.5). Внутри группы:
    //   • text «999»: layout_IK5T4U at (0, 0, 56×38), LEFT-CENTER origin, style_YVVPXH
    //     Roboto Black 900 32px, white + stroke #000 1px.
    //     button-center: (152+0-126, 59+19-61.5) = (26, 16.5), origin (0, 0.5).
    //   • coin: layout_L1CYB8 at (61, 6, 26×26), CENTER origin.
    //     button-center: (152+74-126, 59+19-61.5) = (100, 16.5).
    this.produceCostText = scene.add
      .text(26, 16, '0', {
        fontFamily: FONT,
        fontStyle: '900',
        fontSize: '32px',
        color: '#FFFFFF',
      })
      .setOrigin(0, 0.5);
    this.produceCostText.setStroke('#000000', 1);
    const produceCoin = scene.add
      .image(100, 16, 'ui.coin')
      .setOrigin(0.5)
      .setDisplaySize(26, 26);

    // Иконка оружия = PNG-текстура `weapon.t<N>` (заглушка-плейсхолдер на T1 — позже
    // refresh() заменит на актуальный тир из workshopTier через setTexture).
    // Маленькая цифра тира — в правом нижнем углу иконки, стиль ровно как на
    // merge-плитке (Inter Black 900, #B7916B, без stroke/shadow). Раньше тут было
    // большое «T1» с обводкой — оставшийся артефакт черновой вёрстки.
    this.produceWeaponIcon = scene.add.image(-100, 16, 'weapon.t1').setOrigin(0.5);
    this.produceWeaponTier = scene.add
      .text(-100 + 20, 16 + 20, '?', {
        fontFamily: 'Inter, Roboto, Arial Black, sans-serif',
        fontStyle: '900',
        fontSize: '18px',
        color: '#B7916B',
      })
      .setOrigin(0.5);

    produceContainer.add([
      produceBg, this.produceLabel,
      this.produceWeaponIcon, this.produceWeaponTier,
      arrowsIcon,
      produceCoin, this.produceCostText,
    ]);
    this.produceContainer = produceContainer;
    produceContainer.setSize(252, 123).setScrollFactor(0).setDepth(BUTTON_DEPTH);
    produceBg.setInteractive({ useHandCursor: true });
    produceBg.on('pointerup', () => {
      if (!this.btnProduce.enabled) return;
      cb.onProduce();
    });
    this.btnProduce = {
      container: produceContainer,
      bg: produceBg,
      enabled: true,
      setEnabled: (e: boolean) => {
        this.btnProduce.enabled = e;
        produceBg.setTint(e ? 0xffffff : 0x707070);
      },
    };
    attachPressEffect(this.scene, produceBg, produceContainer, () => this.btnProduce.enabled);

    // ============== В БОЙ! — жёлтая (figma 519, 1049, 180×70) ==============
    this.btnFight = this.makeFightButton(519 + 90, 1049 + 35, 180, 70, () => cb.onBattle());

    this.refresh();
  }

  /** Мелкая кнопка нижнего ряда: SVG-bg + иконка + label по figma. */
  private makeIconButton(
    cx: number, cy: number, w: number, h: number,
    bgKey: string, iconKey: string, label: string,
    iconOpts: { iconW: number; iconH: number; iconOffsetY: number },
    onClick: () => void,
  ): UiButton {
    const container = this.scene.add.container(cx, cy);
    const bg = this.scene.add.image(0, 0, bgKey).setOrigin(0.5).setDisplaySize(w, h);
    const icon = this.scene.add
      .image(0, iconOpts.iconOffsetY, iconKey)
      .setOrigin(0.5)
      .setDisplaySize(iconOpts.iconW, iconOpts.iconH);
    // Label: figma style_KHNJWT — 15px Roboto 900, #773F17, position (0, 65, 94×22) внутри
    // кнопки 94×98 → центр (47, 76), от центра btn = (0, 27).
    const lbl = this.scene.add
      .text(0, 27, label, {
        fontFamily: FONT,
        fontStyle: '900',
        fontSize: '15px',
        color: '#773F17',
      })
      .setOrigin(0.5);
    container.add([bg, icon, lbl]);
    container.setSize(w, h).setScrollFactor(0).setDepth(BUTTON_DEPTH);
    bg.setInteractive({ useHandCursor: true });
    bg.on('pointerup', () => {
      if (!btn.enabled) return;
      onClick();
    });
    const btn: UiButton = {
      container, bg,
      enabled: true,
      setEnabled: (e: boolean) => {
        btn.enabled = e;
        bg.setTint(e ? 0xffffff : 0x707070);
        lbl.setAlpha(e ? 1 : 0.5);
        icon.setAlpha(e ? 1 : 0.5);
      },
    };
    attachPressEffect(this.scene, bg, container, () => btn.enabled);
    return btn;
  }

  /** В БОЙ! — btn_yellow + fight-icon + текст. Figma row, justifyContent center, gap 8.
   *  Внутренняя row 180×48 на y=9 → centerY локально = 33, abs = 1049+33 = 1082. */
  private makeFightButton(cx: number, cy: number, w: number, h: number, onClick: () => void): UiButton {
    const container = this.scene.add.container(cx, cy);
    const bg = this.scene.add.image(0, 0, 'ui.btn_yellow').setOrigin(0.5).setDisplaySize(w, h);
    // Row внутри: icon 39×38 + text. row высота 48, top 9 → центр относительно bg (35-35=0 по cy, -2 по cy).
    const icon = this.scene.add.image(-45, -2, 'ui.fight').setOrigin(0.5).setDisplaySize(39, 38);
    const lbl = this.scene.add
      .text(20, -2, 'В БОЙ!', {
        fontFamily: FONT,
        fontStyle: '900',
        fontSize: '28px',
        color: '#5C2F0D',
      })
      .setOrigin(0.5);
    lbl.setStroke('#FFD17C', 1);
    container.add([bg, icon, lbl]);
    container.setSize(w, h).setScrollFactor(0).setDepth(BUTTON_DEPTH);
    bg.setInteractive({ useHandCursor: true });
    bg.on('pointerup', () => {
      if (!btn.enabled) return;
      onClick();
    });
    const btn: UiButton = {
      container, bg,
      enabled: true,
      setEnabled: (e: boolean) => {
        btn.enabled = e;
        bg.setTint(e ? 0xffffff : 0x707070);
        lbl.setAlpha(e ? 1 : 0.5);
        icon.setAlpha(e ? 1 : 0.5);
      },
    };
    attachPressEffect(this.scene, bg, container, () => btn.enabled);
    return btn;
  }

  refresh(): void {
    const s = getState();
    const cost = produceCost(s.workshopTier);
    // Меняем иконку только если тир сменился — экономим setTexture + setDisplaySize вызовы.
    if (this.produceIconTier !== s.workshopTier) {
      this.produceIconTier = s.workshopTier;
      const iconKey = `weapon.t${s.workshopTier}`;
      if (this.scene.textures.exists(iconKey)) {
        this.produceWeaponIcon.setTexture(iconKey);
        const tex = this.scene.textures.get(iconKey).getSourceImage();
        const iw = (tex as { width: number }).width ?? 1;
        const ih = (tex as { height: number }).height ?? 1;
        // Целевой размер фрейма Figma в кнопке Produce — ~52px. Масштаб — по эталонному
        // WEAPON_FRAME_PX, чтобы относительные размеры оружий из Figma сохранялись.
        const scale = 52 / WEAPON_FRAME_PX;
        this.produceWeaponIcon.setDisplaySize(iw * scale, ih * scale);
        this.produceWeaponIcon.clearTint(); // снять fallback-tint если был раньше
      } else {
        // Fallback — раскрашиваем placeholder-иконку цветом тира.
        this.produceWeaponIcon.setTint(TIER_COLORS[s.workshopTier] ?? 0xcccccc);
      }
    }
    this.produceWeaponTier.setText(String(s.workshopTier));
    this.produceCostText.setText(String(cost));
    const canProduce = s.scrap >= cost && !isFull(s.field);
    this.btnProduce.setEnabled(canProduce);
  }

  setProduceEnabled(enabled: boolean): void {
    this.btnProduce.setEnabled(enabled);
  }

  setFightEnabled(enabled: boolean): void {
    this.btnFight.setEnabled(enabled);
  }

  setBottomVisible(visible: boolean): void {
    this.btnProfile.container.setVisible(visible);
    this.btnUpgrade.container.setVisible(visible);
    this.btnProduce.container.setVisible(visible);
    this.btnCards.container.setVisible(visible);
    this.btnShop.container.setVisible(visible);
    this.btnFight.container.setVisible(visible);
  }
}

/** Удалён: bottomGradient был тут программно. Теперь общий gradient рисуется в WorldScene
 *  (метод `buildGradients`), скрывается через `setVisible` поверх top/bottom вместе. */

