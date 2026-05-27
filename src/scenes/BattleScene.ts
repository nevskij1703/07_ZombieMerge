import Phaser from 'phaser';
import { SceneKey } from './sceneKeys';
import { DESIGN_WIDTH, DESIGN_HEIGHT, COLORS, TIER_COLORS } from '../config/constants';
import type { Level, BattleResult, LaneStep } from '../types';
import { getState, save } from '../core/storage';
import { simulateBattle } from '../core/battleSim';
import { applyBattleResult } from '../core/progression';
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
  private readonly MOVE = 220;
  private readonly SCRAP = 140;
  private readonly CHEST = 420;

  private fighters: Phaser.GameObjects.Container[] = [];
  private chestTokens: Phaser.GameObjects.Rectangle[] = [];
  private obTokens: Phaser.GameObjects.GameObject[][] = [];
  private lanesDone = 0;
  private resultShown = false;
  private speed = 1;

  constructor() {
    super(SceneKey.Battle);
  }

  create(data: BattleData): void {
    this.level = data.level;
    this.result = simulateBattle(data.level, data.arsenals, { workshopTier: data.workshopTier });
    this.lanesDone = 0;
    this.resultShown = false;
    this.speed = 1;
    this.fighters = [];
    this.chestTokens = [];
    this.obTokens = [];

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

    // Управление.
    new Button(this, { x: 150, y: 1210, width: 240, height: 70, label: 'СКИП', fontSize: 26, bg: 0x555a66, onClick: () => this.showResult() });
    let speedBtn: Button;
    speedBtn = new Button(this, { x: DESIGN_WIDTH - 150, y: 1210, width: 240, height: 70, label: '2×', fontSize: 26, bg: 0x3a6ea5, onClick: () => this.toggleSpeed(speedBtn) });

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
    const tokens: Phaser.GameObjects.GameObject[] = [];
    const tokenSize = Math.min(this.laneWidth * 0.42, 42);
    for (let i = 0; i < obstacles.length; i++) {
      const ob = obstacles[i];
      const y = this.obstacleY(li, i);
      let t: Phaser.GameObjects.GameObject;
      if (ob.kind === 'zombie') {
        t = this.add.circle(x, y, tokenSize / 2, ZKIND_COLOR[ob.zombieKind ?? 'weak']).setStrokeStyle(2, 0x000000, 0.4);
      } else if (ob.kind === 'crate') {
        t = this.add.rectangle(x, y, tokenSize, tokenSize, 0x8b5a2b).setStrokeStyle(2, 0x000000, 0.4);
      } else {
        t = this.add.circle(x, y, tokenSize / 4, 0x9aa0a6);
      }
      tokens.push(t);
    }
    this.obTokens[li] = tokens;

    // боец снизу
    const bestTier = arsenal.length ? Math.max(...arsenal) : 0;
    const color = bestTier ? TIER_COLORS[bestTier] ?? 0x66ccff : 0x55606e;
    const circle = this.add.circle(0, 0, tokenSize * 0.6, 0x66ccff).setStrokeStyle(3, color, 1);
    const label = this.add
      .text(0, 0, bestTier ? String(bestTier) : '—', { fontFamily: 'monospace', fontSize: '20px', color: '#06121f' })
      .setOrigin(0.5);
    const fighter = this.add.container(x, this.yBottom, [circle, label]);
    this.fighters[li] = fighter;
  }

  private obstacleY(li: number, idx: number): number {
    const count = this.level.lanes[li].obstacles.length;
    const spacing = (this.yBottom - this.yChest) / (count + 1);
    return this.yBottom - (idx + 1) * spacing;
  }

  private fightTime(hits: number): number {
    return Phaser.Math.Clamp(hits * 55, 120, 1400);
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
            this.time.delayedCall(this.SCRAP, doStep);
          } else if (step.outcome === 'opened') {
            this.openChest(li);
            this.popText(fighter.x, this.yChest, 'СУНДУК', '#ffd700');
            this.time.delayedCall(this.CHEST, () => this.returnFighter(li, finishLane));
          } else if (step.outcome === 'cleared') {
            this.clearObstacle(li, step.index, fighter);
            this.time.delayedCall(this.fightTime(step.hitsSpent), doStep);
          } else {
            // stuck — отступление
            this.popText(fighter.x, ty, 'отступ', '#ff8a8a');
            this.time.delayedCall(this.fightTime(step.hitsSpent), () => this.returnFighter(li, finishLane));
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

  private clearObstacle(li: number, idx: number, fighter: Phaser.GameObjects.Container): void {
    const token = this.obTokens[li]?.[idx];
    if (token) {
      this.tweens.add({ targets: token, alpha: 0, scale: 0.2, duration: 180, onComplete: () => token.destroy() });
    }
    this.tweens.add({ targets: fighter, scaleX: 1.15, yoyo: true, duration: 70, repeat: 1 });
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

  private toggleSpeed(btn: Button): void {
    this.speed = this.speed === 1 ? 2 : 1;
    this.tweens.timeScale = this.speed;
    this.time.timeScale = this.speed;
    btn.setLabel(this.speed === 1 ? '2×' : '1×');
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
