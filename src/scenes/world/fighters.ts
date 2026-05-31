// Контроллер бойцов: создание, idle-позиции, обновление визуала оружия. Бойцы
// PERSISTENT — создаются один раз в WorldScene.create(), переиспользуются между
// боями. Между уровнями могут пересоздаваться, если изменилось число столбцов
// поля (`ensureFightersExist`).
//
// Структура: каждый боец — Container с children [circle, weaponIcon, tierLabel,
// hitsLabel]. Эти child'ы храним в отдельных массивах (по индексу линии) для
// быстрого update'а без поиска по children.

import Phaser from 'phaser';
import { DESIGN_WIDTH, TIER_COLORS, WEAPON_FRAME_PX } from '../../config/constants';
import { getWeapon } from '../../core/weapons';
import { getState } from '../../core/storage';
import type { ArsenalWeapon, LaneRuntime } from './types';
import { FIGHTER_IDLE_Y } from './constants';

/** Контроллер бойцов на базе/в бою. Persistent через всю сессию. */
export class FightersController {
  private readonly scene: Phaser.Scene;
  fighters: Phaser.GameObjects.Container[] = [];
  /** Визуальные субкомпоненты бойца, parallel-arrays индексируемые `li`. */
  private tierTexts: Phaser.GameObjects.Text[] = [];
  private weaponIcons: Phaser.GameObjects.Image[] = [];
  private hitsTexts: Phaser.GameObjects.Text[] = [];
  private rings: Phaser.GameObjects.Arc[] = [];
  /** Текущий размер токена бойца (= obstacleTokenSize в бою). Обновляется ensureFightersExist
   *  и используется в renderFighterWeapon для масштаба weapon-иконки. */
  private tokenSize = 44;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  /**
   * Убедиться, что число бойцов = `cols` поля. Если меняется — пересоздаём с нуля
   * (destroy старых + новые createIdleFighter). Если совпадает — просто snap'аем
   * каждого в idle-позицию своей линии и сбрасываем visual.
   *
   * Вызывается:
   *   • один раз в WorldScene.create() — стартовая инициализация;
   *   • в returnToBase, когда field.cols мог измениться (рост поля по уровню);
   *   • в начале goBattle для гарантии перед боем (защита от рассинхрона).
   */
  ensureExists(): void {
    const cols = getState().field.cols;
    const laneWidth = DESIGN_WIDTH / cols;
    this.tokenSize = Math.min(laneWidth * 0.42, 44);
    if (this.fighters.length !== cols) {
      for (const f of this.fighters) f?.destroy();
      this.fighters = [];
      this.tierTexts = [];
      this.hitsTexts = [];
      this.rings = [];
      this.weaponIcons = [];
      for (let li = 0; li < cols; li++) {
        this.createIdleFighter(li, laneWidth);
      }
      return;
    }
    for (let li = 0; li < cols; li++) {
      const f = this.fighters[li];
      if (!f) continue;
      f.x = (li + 0.5) * laneWidth;
      f.y = FIGHTER_IDLE_Y;
      f.setScale(1);
      this.resetVisualToIdle(li);
    }
  }

  /** Tween всех бойцов обратно к idle-позициям (на returnToBase, когда cols не менялся). */
  tweenAllToIdle(newCols: number): void {
    for (let li = 0; li < this.fighters.length; li++) {
      const f = this.fighters[li];
      if (!f) continue;
      this.scene.tweens.killTweensOf(f);
      f.setScale(1);
      const targetX = (li + 0.5) * (DESIGN_WIDTH / newCols);
      this.scene.tweens.add({
        targets: f,
        x: targetX,
        y: FIGHTER_IDLE_Y,
        duration: 600,
        ease: 'Sine.InOut',
      });
      this.resetVisualToIdle(li);
    }
  }

  /** Создать визуал одного idle-бойца в линии `li`. Push'ит в parallel-arrays. */
  private createIdleFighter(li: number, laneWidth: number): void {
    const tokenSize = this.tokenSize;
    const x = (li + 0.5) * laneWidth;
    const ringColor = 0x55606e;
    const circle = this.scene.add
      .circle(0, 0, tokenSize * 0.6, 0x66ccff)
      .setStrokeStyle(3, ringColor, 1);
    const tierLabel = this.scene.add
      .text(-tokenSize * 0.5, tokenSize * 0.5, '', {
        fontFamily: 'Roboto, Arial Black, sans-serif',
        fontStyle: '900',
        fontSize: '13px',
        color: '#ffffff',
      })
      .setOrigin(0.5);
    tierLabel.setStroke('#000000', 3);
    // Иконка оружия — сверху над бойцом. Использует 'weapon.t1' как placeholder (точно
    // загружен Boot'ом). Texture/visible меняется в renderFighterWeapon.
    const initialKey = this.scene.textures.exists('weapon.t1') ? 'weapon.t1' : '__DEFAULT';
    const weaponIcon = this.scene.add
      .image(0, -tokenSize * 0.95, initialKey)
      .setOrigin(0.5)
      .setVisible(false);
    const hitsLabel = this.scene.add
      .text(0, tokenSize * 0.7 + 4, '', {
        fontFamily: 'monospace',
        fontSize: '12px',
        color: '#ffffff',
      })
      .setOrigin(0.5);
    hitsLabel.setStroke('#000000', 3);
    const fighter = this.scene.add
      .container(x, FIGHTER_IDLE_Y, [circle, weaponIcon, tierLabel, hitsLabel])
      .setDepth(5);
    this.fighters[li] = fighter;
    this.tierTexts[li] = tierLabel;
    this.hitsTexts[li] = hitsLabel;
    this.rings[li] = circle;
    this.weaponIcons[li] = weaponIcon;
  }

  /** Сбросить визуал бойца `li` в idle (пустой текст, серое кольцо, скрытая иконка). */
  resetVisualToIdle(li: number): void {
    this.tierTexts[li]?.setText('');
    this.hitsTexts[li]?.setText('');
    this.rings[li]?.setStrokeStyle(3, 0x55606e, 1);
    this.weaponIcons[li]?.setVisible(false);
  }

  /** Обновить размер токена (= obstacleTokenSize при старте боя). Влияет на масштаб
   *  иконки оружия в `renderFighterWeapon`. */
  setTokenSize(size: number): void {
    this.tokenSize = size;
  }

  /**
   * Обновить визуал оружия бойца в линии `lane`:
   *   • активное оружие → tier-text «T<N>», hits-counter, цветное кольцо, PNG-иконка
   *     оружия пропорционально WEAPON_FRAME_PX (сохраняем дизайнерскую разницу
   *     длинной винтовки vs короткого ножа);
   *   • арсенал пуст → «—», скрытая иконка, серое кольцо.
   *
   * Вызывается из tickBattle: при switchWeapon, refillBestWeapon, attackObstacle
   * (после каждого удара — обновить hits-counter).
   */
  renderFighterWeapon(lane: LaneRuntime): void {
    const li = lane.li;
    const w = lane.active;
    const tierText = this.tierTexts[li];
    const hitsText = this.hitsTexts[li];
    const ring = this.rings[li];
    const iconImg = this.weaponIcons[li];
    if (w && w.hits > 0) {
      tierText?.setText(`T${w.tier}`);
      hitsText?.setText(String(w.hits));
      ring?.setStrokeStyle(3, TIER_COLORS[w.tier] ?? 0x66ccff, 1);
      const key = `weapon.t${w.tier}`;
      if (iconImg) {
        if (this.scene.textures.exists(key)) {
          iconImg.setTexture(key);
          const tex = this.scene.textures.get(key).getSourceImage();
          const iw = (tex as { width: number }).width ?? 1;
          const ih = (tex as { height: number }).height ?? 1;
          const target = this.tokenSize * 0.85;
          const s = target / WEAPON_FRAME_PX;
          iconImg.setDisplaySize(iw * s, ih * s).setVisible(true);
        } else {
          iconImg.setVisible(false);
        }
      }
    } else {
      tierText?.setText('—');
      hitsText?.setText('');
      ring?.setStrokeStyle(3, 0x55606e, 1);
      iconImg?.setVisible(false);
    }
  }
}

/** Public helper: построить арсенал из набора тиров. Strongest first — порядок,
 *  который ожидает BattleTickEngine для switchWeapon. */
export function buildArsenal(tiers: number[]): { active: ArsenalWeapon | null; rest: ArsenalWeapon[] } {
  const sorted = [...tiers].sort((a, b) => b - a);
  const arsenal: ArsenalWeapon[] = sorted.map((t) => {
    const def = getWeapon(t);
    return { tier: t, hits: def.hits, maxHits: def.hits };
  });
  const active = arsenal.shift() ?? null;
  return { active, rest: arsenal };
}
