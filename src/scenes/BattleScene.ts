import Phaser from 'phaser';
import { SceneKey } from './sceneKeys';
import { DESIGN_WIDTH, DESIGN_HEIGHT, COLORS, TIER_COLORS } from '../config/constants';
import type { Level, BattleResult, LaneStep } from '../types';
import { getState, save } from '../core/storage';
import { simulateBattle } from '../core/battleSim';
import { applyBattleResult } from '../core/progression';
import { getWeapon } from '../core/weapons';
import { Button } from '../ui/button';

interface BattleData {
  level: Level;
  arsenals: number[][];
  workshopTier: number;
}

const ZKIND_COLOR: Record<string, number> = {
  weak: 0x6b8e23,
  medium: 0xc77b1e,
  strong: 0x9b2222,
};

// Проигрыш боя по линиям: бойцы бегут вверх, дерутся/отступают, открывают сундуки.
// Симуляция уже детерминирована (core/battleSim) — сцена только анимирует timeline.
export class BattleScene extends Phaser.Scene {
  private level!: Level;
  private result!: BattleResult;

  private yChest = 190;
  private yBottom = 1060;
  private laneWidth = 0;
  // Базовый темп боя (timeScale=1). Раньше был в 2× быстрее — то что игроки увидят на ×4.
  private readonly MOVE = 440;
  private readonly SCRAP = 280;
  private readonly CHEST = 840;

  private fighters: Phaser.GameObjects.Container[] = [];
  private fighterTierTexts: Phaser.GameObjects.Text[] = [];
  private fighterHitsTexts: Phaser.GameObjects.Text[] = [];
  private fighterRings: Phaser.GameObjects.Arc[] = [];
  private chestTokens: Phaser.GameObjects.Rectangle[] = [];
  private obTokens: (Phaser.GameObjects.GameObject | null)[][] = [];
  private obBars: (Phaser.GameObjects.Rectangle | null)[][] = [];
  private obBarBgs: (Phaser.GameObjects.Rectangle | null)[][] = [];
  private obHpTexts: (Phaser.GameObjects.Text | null)[][] = [];
  private lanesDone = 0;
  private resultShown = false;
  private speedButtons: Array<{ btn: Button; factor: number }> = [];

  constructor() {
    super(SceneKey.Battle);
  }

  create(data: BattleData): void {
    this.level = data.level;
    this.result = simulateBattle(data.level, data.arsenals, { workshopTier: data.workshopTier });
    this.lanesDone = 0;
    this.resultShown = false;
    this.speedButtons = [];
    this.fighters = [];
    this.fighterTierTexts = [];
    this.fighterHitsTexts = [];
    this.fighterRings = [];
    this.chestTokens = [];
    this.obTokens = [];
    this.obBars = [];
    this.obBarBgs = [];
    this.obHpTexts = [];

    const cols = this.level.cols;
    this.laneWidth = DESIGN_WIDTH / cols;

    this.add.rectangle(DESIGN_WIDTH / 2, DESIGN_HEIGHT / 2, DESIGN_WIDTH, DESIGN_HEIGHT, COLORS.city).setOrigin(0.5);
    this.add
      .text(DESIGN_WIDTH / 2, 70, `БОЙ · Уровень ${this.level.number}`, {
        fontFamily: 'monospace',
        fontSize: '34px',
        color: '#9fe870',
      })
      .setOrigin(0.5);

    // База/ворота снизу.
    this.add.rectangle(DESIGN_WIDTH / 2, this.yBottom + 70, DESIGN_WIDTH, 140, COLORS.base).setOrigin(0.5);

    for (let li = 0; li < cols; li++) this.buildLane(li, data.arsenals[li] ?? []);

    // Управление: СКИП + переключатель скорости (×0.25 / ×1 / ×4).
    new Button(this, {
      x: 110,
      y: 1210,
      width: 180,
      height: 70,
      label: 'СКИП',
      fontSize: 24,
      bg: 0x555a66,
      onClick: () => this.showResult(),
    });
    const speeds: Array<{ factor: number; label: string }> = [
      { factor: 0.25, label: '×0.25' },
      { factor: 1, label: '×1' },
      { factor: 4, label: '×4' },
    ];
    speeds.forEach((s, i) => {
      const btn = new Button(this, {
        x: 290 + i * 130,
        y: 1210,
        width: 120,
        height: 70,
        label: s.label,
        fontSize: 22,
        bg: 0x3a414d,
        onClick: () => this.setSpeed(s.factor),
      });
      this.speedButtons.push({ btn, factor: s.factor });
    });
    this.setSpeed(1);

    for (let li = 0; li < cols; li++) this.playLane(li);
  }

  private buildLane(li: number, arsenal: number[]): void {
    const x = (li + 0.5) * this.laneWidth;
    // вертикальная дорожка
    this.add.rectangle(x, (this.yChest + this.yBottom) / 2, 6, this.yBottom - this.yChest, 0x2a3a2a).setOrigin(0.5);

    // сундук сверху
    const chest = this.add.rectangle(x, this.yChest, 54, 40, 0xd4af37).setOrigin(0.5);
    chest.setStrokeStyle(3, 0x000000, 0.4);
    this.chestTokens[li] = chest;

    // препятствия
    const obstacles = this.level.lanes[li].obstacles;
    const tokens: (Phaser.GameObjects.GameObject | null)[] = new Array(obstacles.length).fill(null);
    const bars: (Phaser.GameObjects.Rectangle | null)[] = new Array(obstacles.length).fill(null);
    const barBgs: (Phaser.GameObjects.Rectangle | null)[] = new Array(obstacles.length).fill(null);
    const hpTexts: (Phaser.GameObjects.Text | null)[] = new Array(obstacles.length).fill(null);
    const tokenSize = Math.min(this.laneWidth * 0.42, 42);
    const barW = Math.min(tokenSize * 1.4, 56);
    const barH = 4;
    for (let i = 0; i < obstacles.length; i++) {
      const ob = obstacles[i];
      const y = this.obstacleY(li, i);
      if (ob.kind === 'zombie') {
        tokens[i] = this.add.circle(x, y, tokenSize / 2, ZKIND_COLOR[ob.zombieKind ?? 'weak']).setStrokeStyle(2, 0x000000, 0.4);
      } else if (ob.kind === 'crate') {
        tokens[i] = this.add.rectangle(x, y, tokenSize, tokenSize, 0x8b5a2b).setStrokeStyle(2, 0x000000, 0.4);
      } else {
        tokens[i] = this.add.circle(x, y, tokenSize / 4, 0x9aa0a6);
      }
      // HP-bar только для боевых препятствий.
      if (ob.kind === 'zombie' || ob.kind === 'crate') {
        const barY = y - tokenSize / 2 - 9;
        const barX = x - barW / 2;
        barBgs[i] = this.add.rectangle(barX, barY, barW, barH, 0x333333).setOrigin(0, 0.5);
        const bar = this.add.rectangle(barX, barY, barW, barH, 0xee3333).setOrigin(0, 0.5);
        bar.setData('maxHp', ob.hp);
        bars[i] = bar;
        hpTexts[i] = this.add
          .text(x, barY - 4, String(ob.hp), { fontFamily: 'monospace', fontSize: '10px', color: '#ffcccc' })
          .setOrigin(0.5, 1);
      }
    }
    this.obTokens[li] = tokens;
    this.obBars[li] = bars;
    this.obBarBgs[li] = barBgs;
    this.obHpTexts[li] = hpTexts;

    // боец снизу
    const bestTier = arsenal.length ? Math.max(...arsenal) : 0;
    const startHits = bestTier ? getWeapon(bestTier).hits : 0;
    const ringColor = bestTier ? TIER_COLORS[bestTier] ?? 0x66ccff : 0x55606e;
    const circle = this.add.circle(0, 0, tokenSize * 0.6, 0x66ccff).setStrokeStyle(3, ringColor, 1);
    const tierLabel = this.add
      .text(0, -2, bestTier ? String(bestTier) : '—', { fontFamily: 'monospace', fontSize: '20px', color: '#06121f' })
      .setOrigin(0.5);
    const hitsLabel = this.add
      .text(0, tokenSize * 0.7 + 4, bestTier ? String(startHits) : '', {
        fontFamily: 'monospace',
        fontSize: '12px',
        color: '#ffffff',
      })
      .setOrigin(0.5);
    hitsLabel.setStroke('#000000', 3);
    const fighter = this.add.container(x, this.yBottom, [circle, tierLabel, hitsLabel]);
    this.fighters[li] = fighter;
    this.fighterTierTexts[li] = tierLabel;
    this.fighterHitsTexts[li] = hitsLabel;
    this.fighterRings[li] = circle;
  }

  private obstacleY(li: number, idx: number): number {
    const count = this.level.lanes[li].obstacles.length;
    const spacing = (this.yBottom - this.yChest) / (count + 1);
    return this.yBottom - (idx + 1) * spacing;
  }

  private fightTime(hits: number): number {
    return Phaser.Math.Clamp(hits * 110, 240, 2800);
  }

  private playLane(li: number): void {
    const steps = this.result.lanes[li].steps;
    const fighter = this.fighters[li];
    let si = 0;

    const finishLane = (): void => {
      this.lanesDone += 1;
      if (this.lanesDone >= this.level.cols) this.showResult();
    };

    const doStep = (): void => {
      if (this.resultShown) return;
      if (si >= steps.length) {
        finishLane();
        return;
      }
      const step: LaneStep = steps[si++];
      const ty = step.index === -1 ? this.yChest + 46 : this.obstacleY(li, step.index);
      this.tweens.add({
        targets: fighter,
        y: ty,
        duration: this.MOVE,
        onComplete: () => {
          if (this.resultShown) return;
          if (step.kind === 'scrap') {
            this.popText(fighter.x, ty, `+${step.scrap}`, '#9fe870');
            this.time.delayedCall(this.SCRAP, () => {
              this.updateFighterWeapon(li, step.weaponTierAfter, step.weaponHitsAfter);
              doStep();
            });
          } else if (step.outcome === 'opened') {
            this.openChest(li);
            this.popText(fighter.x, this.yChest, 'СУНДУК', '#ffd700');
            this.time.delayedCall(this.CHEST, () => {
              this.updateFighterWeapon(li, step.weaponTierAfter, step.weaponHitsAfter);
              this.returnFighter(li, finishLane);
            });
          } else if (step.outcome === 'cleared') {
            const ft = this.fightTime(step.hitsSpent);
            this.fightObstacle(li, step, fighter, ft);
            this.time.delayedCall(ft, () => {
              this.updateFighterWeapon(li, step.weaponTierAfter, step.weaponHitsAfter);
              doStep();
            });
          } else {
            // stuck — препятствие остаётся живым, боец отступает
            const ft = this.fightTime(step.hitsSpent);
            this.fightObstacle(li, step, fighter, ft);
            this.popText(fighter.x, ty, 'отступ', '#ff8a8a');
            this.time.delayedCall(ft, () => {
              this.updateFighterWeapon(li, step.weaponTierAfter, step.weaponHitsAfter);
              this.returnFighter(li, finishLane);
            });
          }
        },
      });
    };

    doStep();
  }

  private returnFighter(li: number, cb: () => void): void {
    if (this.resultShown) {
      cb();
      return;
    }
    this.tweens.add({
      targets: this.fighters[li],
      y: this.yBottom,
      duration: this.MOVE * 1.6,
      onComplete: cb,
    });
  }

  /**
   * Анимируем бой по препятствию. HP-бар обновляется ДИСКРЕТНО на каждый удар (мгновенный
   * снеп — без плавного твина). Если препятствие убито (hpAfter=0) — фейд токена;
   * если боец застрял (hpAfter>0) — токен остаётся с уменьшенным HP.
   */
  private fightObstacle(
    li: number,
    step: LaneStep,
    fighter: Phaser.GameObjects.Container,
    ft: number,
  ): void {
    const idx = step.index;
    const token = this.obTokens[li]?.[idx];
    const bar = this.obBars[li]?.[idx];
    const barBg = this.obBarBgs[li]?.[idx];
    const hpText = this.obHpTexts[li]?.[idx];
    const maxHp = (bar?.getData('maxHp') as number) ?? 1;
    const startHp = step.hpStart ?? maxHp;
    const endHp = step.hpAfter ?? 0;
    const kills = endHp <= 0;
    const hits = step.hitsSpent;

    if (bar) {
      if (hits > 0 && ft > 0) {
        // Дискретные снепы: каждый удар мгновенно обновляет HP-бар и число.
        const interval = ft / hits;
        const drop = (startHp - endHp) / hits;
        for (let h = 1; h <= hits; h++) {
          const newHp = Math.max(endHp, Math.round(startHp - drop * h));
          this.time.delayedCall(interval * h, () => {
            if (this.resultShown) return;
            bar.setScale(newHp / maxHp, 1);
            hpText?.setText(String(newHp));
            this.tweens.add({ targets: fighter, scaleX: 1.1, yoyo: true, duration: 60 });
          });
        }
      } else {
        // Пробивающий урон / мгновенное уничтожение — снеп сразу.
        bar.setScale(endHp / maxHp, 1);
        hpText?.setText(String(endHp));
      }
    }

    // Токен исчезает только если враг убит.
    if (kills && token) {
      this.tweens.add({
        targets: token,
        alpha: 0,
        scale: 0.2,
        duration: 180,
        delay: Math.max(0, ft - 100),
        onComplete: () => {
          token.destroy();
          bar?.destroy();
          barBg?.destroy();
          hpText?.destroy();
          if (this.obTokens[li]) this.obTokens[li][idx] = null;
          if (this.obBars[li]) this.obBars[li][idx] = null;
          if (this.obBarBgs[li]) this.obBarBgs[li][idx] = null;
          if (this.obHpTexts[li]) this.obHpTexts[li][idx] = null;
        },
      });
    }
  }

  /** Обновить тир и оставшийся ресурс активного оружия бойца. */
  private updateFighterWeapon(li: number, tier?: number, hits?: number): void {
    const tierText = this.fighterTierTexts[li];
    const hitsText = this.fighterHitsTexts[li];
    const ring = this.fighterRings[li];
    if (!tierText || !hitsText) return;
    if (tier == null || hits == null || hits <= 0) {
      tierText.setText('—');
      hitsText.setText('');
      ring?.setStrokeStyle(3, 0x55606e, 1);
      return;
    }
    tierText.setText(String(tier));
    hitsText.setText(String(hits));
    ring?.setStrokeStyle(3, TIER_COLORS[tier] ?? 0x66ccff, 1);
  }

  private openChest(li: number): void {
    this.chestTokens[li]?.setFillStyle(0x7be37b);
  }

  private popText(x: number, y: number, msg: string, color: string): void {
    const t = this.add
      .text(x, y, msg, { fontFamily: 'monospace', fontSize: '20px', color })
      .setOrigin(0.5)
      .setDepth(50);
    this.tweens.add({ targets: t, y: y - 40, alpha: 0, duration: 700, onComplete: () => t.destroy() });
  }

  /** Установить скорость анимации боя; подсветить активную кнопку. */
  private setSpeed(factor: number): void {
    this.tweens.timeScale = factor;
    this.time.timeScale = factor;
    for (const sb of this.speedButtons) {
      sb.btn.setBg(sb.factor === factor ? 0x2e7d32 : 0x3a414d);
    }
  }

  private showResult(): void {
    if (this.resultShown) return;
    this.resultShown = true;
    this.tweens.timeScale = 1;
    this.time.timeScale = 1;
    this.tweens.killAll();
    this.time.removeAllEvents();

    // Применяем результат к сейву (один раз).
    const state = getState();
    applyBattleResult(state, this.result);
    save();

    const cx = DESIGN_WIDTH / 2;
    this.add.rectangle(cx, DESIGN_HEIGHT / 2, DESIGN_WIDTH, DESIGN_HEIGHT, 0x000000, 0.7).setOrigin(0.5).setDepth(100);
    const panel = this.add.rectangle(cx, DESIGN_HEIGHT / 2, 560, 460, 0x12151b).setOrigin(0.5).setDepth(101);
    panel.setStrokeStyle(2, 0x3a414d);

    const r = this.result;
    const title = r.passed ? 'УРОВЕНЬ ПРОЙДЕН' : 'УРОВЕНЬ НЕ ПРОЙДЕН';
    const titleColor = r.passed ? '#9fe870' : '#ff8a8a';
    this.add.text(cx, DESIGN_HEIGHT / 2 - 170, title, { fontFamily: 'monospace', fontSize: '32px', color: titleColor }).setOrigin(0.5).setDepth(102);

    const reached = r.lanes.filter((l) => l.reachedChest).length;
    const lines = [
      `Дошло бойцов: ${reached} / ${r.lanes.length}`,
      `Металлолом: +${r.totalScrap}`,
      `Оружие: +${r.totalWeapons.length}`,
      `Чертежи: +${r.blueprints}`,
    ];
    this.add
      .text(cx, DESIGN_HEIGHT / 2 - 40, lines.join('\n'), { fontFamily: 'monospace', fontSize: '26px', color: '#dddddd', align: 'center', lineSpacing: 12 })
      .setOrigin(0.5)
      .setDepth(102);

    const back = new Button(this, {
      x: cx,
      y: DESIGN_HEIGHT / 2 + 150,
      width: 360,
      height: 80,
      label: 'НА БАЗУ',
      fontSize: 30,
      onClick: () => this.scene.start(SceneKey.Base),
    });
    back.container.setDepth(102);
  }
}
