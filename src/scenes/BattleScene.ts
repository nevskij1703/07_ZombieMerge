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

// === Lunge-плейбэк ===========================================================
// Один удар оружием = один «рывок» бойца вперёд. Если удар убивает цель и есть
// избыток (пробивающий урон) — рывок ПРОДОЛЖАЕТСЯ через следующие препятствия,
// которые этот же удар добивает в полёте. Рывок завершается, когда:
//   • первая выжившая цель (ранение карри ИЛИ просто не добили текущим ударом) → отскок;
//   • цепочка добила всех до сундука/конца линии → боец остаётся на месте,
//     следующий event (сундук/новый рывок) продолжает с этой точки.

interface StopTarget {
  kind: 'target';
  step: LaneStep;
  hpBefore: number;
  hpAfter: number;
  killed: boolean;
}

interface StopScrap {
  kind: 'scrap';
  step: LaneStep;
}

type LungeStop = StopTarget | StopScrap;

interface LungeEvent {
  kind: 'lunge';
  stops: LungeStop[]; // в порядке прохождения линии, последний — конечная цель рывка
  retreat: boolean; // отскок назад к yBottom после рывка
  /** Эти поля задаются ТОЛЬКО для «итогового» рывка шага (добивающего/застрял-после),
   *  чтобы UI ресурса не дёргался посередине серии ран-рывков. */
  weaponTierAfter?: number;
  weaponHitsAfter?: number;
}

interface ChestEvent {
  kind: 'chest';
  step: LaneStep;
  scrapEnRoute: StopScrap[];
  weaponTierAfter?: number;
  weaponHitsAfter?: number;
}

interface StuckEvent {
  kind: 'stuck';
  step: LaneStep;
  scrapEnRoute: StopScrap[];
  weaponTierAfter?: number;
  weaponHitsAfter?: number;
}

type LaneEvent = LungeEvent | ChestEvent | StuckEvent;

// Проигрыш боя по линиям: бойцы бегут вверх, дерутся/отступают, открывают сундуки.
// Симуляция уже детерминирована (core/battleSim) — сцена только анимирует timeline.
export class BattleScene extends Phaser.Scene {
  private level!: Level;
  private result!: BattleResult;

  private yChest = 190;
  private yBottom = 1060;
  private laneWidth = 0;
  // Базовый темп боя (timeScale=1). Раньше был в 2× быстрее — то что игроки увидят на ×4.
  private readonly MOVE = 440; // длительность отскока «назад к воротам» (~постоянная).
  private readonly CHEST = 840; // пауза на анимации открытия сундука.

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

  // Время рывка/отскока — пропорционально дистанции, чтобы скорость бойца была постоянной.
  private readonly PIXEL_TIME = 2.4; // мс на пиксель вертикального хода
  private readonly MIN_WALK = 220;

  private playLane(li: number): void {
    const events = this.buildLaneEvents(this.result.lanes[li].steps);
    this.runEvents(li, events, 0);
  }

  /** Собираем timeline в события «рывков»: один удар = один рывок; добивающий удар
   *  тащит с собой все шаги, что были добиты пробивающим уроном (carryIn>0 и убиты),
   *  и заканчивается на первой выжившей цели (carry-ранение). */
  private buildLaneEvents(steps: LaneStep[]): LaneEvent[] {
    const events: LaneEvent[] = [];
    const pendingScrap: StopScrap[] = [];

    let i = 0;
    while (i < steps.length) {
      const step = steps[i];

      if (step.kind === 'scrap') {
        pendingScrap.push({ kind: 'scrap', step });
        i++;
        continue;
      }

      if (step.kind === 'chest') {
        events.push({
          kind: 'chest',
          step,
          scrapEnRoute: pendingScrap.splice(0),
          weaponTierAfter: step.weaponTierAfter,
          weaponHitsAfter: step.weaponHitsAfter,
        });
        i++;
        continue;
      }

      // Боевой шаг (zombie/crate)
      const carryIn = step.carryIn ?? 0;
      const hits = step.hitsSpent;
      const hpStart = step.hpStart ?? 0;
      const hpAfter = step.hpAfter ?? 0;
      const killed = hpAfter <= 0;

      if (hits === 0) {
        if (carryIn > 0) {
          // Этот шаг УЖЕ был визуализирован в цепочке предыдущего рывка — пропускаем.
          i++;
          continue;
        }
        // Боец пришёл к препятствию без оружия — попытка → отскок, линия завершается.
        events.push({
          kind: 'stuck',
          step,
          scrapEnRoute: pendingScrap.splice(0),
          weaponTierAfter: step.weaponTierAfter,
          weaponHitsAfter: step.weaponHitsAfter,
        });
        i++;
        break;
      }

      // hits > 0: hits ранящих рывков + (если убит) 1 добивающий рывок с возможной цепочкой.
      const hpAfterCarry = hpStart - carryIn;
      const minHp = killed ? 0 : hpAfter;
      const totalHitsDmg = killed ? hpAfterCarry : hpAfterCarry - hpAfter;
      const dmgPerLunge = totalHitsDmg / hits;
      const woundCount = killed ? hits - 1 : hits;

      let currentHp = hpAfterCarry;
      for (let w = 0; w < woundCount; w++) {
        const newHp = Math.max(minHp, Math.round(currentHp - dmgPerLunge));
        const stops: LungeStop[] = [];
        if (pendingScrap.length > 0) stops.push(...pendingScrap.splice(0));
        stops.push({
          kind: 'target',
          step,
          hpBefore: Math.round(currentHp),
          hpAfter: newHp,
          killed: false,
        });
        // Промежуточный ран-рывок — НЕ обновляем UI ресурса (он обновится одним
        // снепом в финальном рывке шага).
        events.push({ kind: 'lunge', stops, retreat: true });
        currentHp = newHp;
      }

      if (!killed) {
        // Серия ран-рывков закончилась тем, что оружие иссякло. Финал — stuck.
        events.push({
          kind: 'stuck',
          step,
          scrapEnRoute: pendingScrap.splice(0),
          weaponTierAfter: step.weaponTierAfter,
          weaponHitsAfter: step.weaponHitsAfter,
        });
        i++;
        break;
      }

      // Добивающий рывок: убиваем step, прокидываемся вперёд через carry-цепочку.
      const stops: LungeStop[] = [];
      if (pendingScrap.length > 0) stops.push(...pendingScrap.splice(0));
      stops.push({
        kind: 'target',
        step,
        hpBefore: Math.round(currentHp),
        hpAfter: 0,
        killed: true,
      });

      let j = i + 1;
      let chainRetreat = false;
      while (j < steps.length) {
        const nxt = steps[j];
        if (nxt.kind === 'scrap') {
          stops.push({ kind: 'scrap', step: nxt });
          j++;
          continue;
        }
        if (nxt.kind === 'chest') break;
        // combat
        const carryInNxt = nxt.carryIn ?? 0;
        if (carryInNxt === 0) break; // карри иссяк — рывок завершается

        const hitsNxt = nxt.hitsSpent;
        const hpStartNxt = nxt.hpStart ?? 0;
        const hpAfterNxt = nxt.hpAfter ?? 0;
        const killedByCarry = hitsNxt === 0 && hpAfterNxt === 0;

        if (killedByCarry) {
          stops.push({
            kind: 'target',
            step: nxt,
            hpBefore: hpStartNxt,
            hpAfter: 0,
            killed: true,
          });
          j++;
          continue;
        }

        // Карри РАНИЛ, но не убил. Это последняя цель рывка → отскок.
        stops.push({
          kind: 'target',
          step: nxt,
          hpBefore: hpStartNxt,
          hpAfter: hpStartNxt - carryInNxt,
          killed: false,
        });
        chainRetreat = true;
        if (hitsNxt > 0) {
          // У шага есть собственные рывки — отдадим его основному циклу (НЕ j++).
          break;
        }
        // hitsNxt=0 + carryIn>0 + жив = «застрял после ранения карри» → поглощаем.
        j++;
        break;
      }

      events.push({
        kind: 'lunge',
        stops,
        retreat: chainRetreat,
        weaponTierAfter: step.weaponTierAfter,
        weaponHitsAfter: step.weaponHitsAfter,
      });

      i = j;
    }

    return events;
  }

  private runEvents(li: number, events: LaneEvent[], idx: number): void {
    if (this.resultShown) return;
    if (idx >= events.length) {
      this.finishLane();
      return;
    }
    const ev = events[idx];
    const next = (): void => this.runEvents(li, events, idx + 1);
    switch (ev.kind) {
      case 'lunge':
        this.playLunge(li, ev, next);
        break;
      case 'chest':
        this.playChest(li, ev, next);
        break;
      case 'stuck':
        this.playStuck(li, ev, next);
        break;
    }
  }

  private finishLane(): void {
    this.lanesDone += 1;
    if (this.lanesDone >= this.level.cols) this.showResult();
  }

  private walkTime(distance: number): number {
    return Math.max(this.MIN_WALK, distance * this.PIXEL_TIME);
  }

  /** «Полшажка назад» после рывка с раненой/уцелевшей целью — короткий визуальный
   *  откат прямо у препятствия (НЕ полный возврат к воротам).
   *  Полный отскок к базе остаётся только для stuck (оружие кончилось → разворот домой)
   *  и для chest (взял сундук → пошёл домой). */
  private backstepDistance(li: number): number {
    const count = this.level.lanes[li].obstacles.length;
    const spacing = (this.yBottom - this.yChest) / (count + 1);
    return Math.min(spacing * 0.5, 60); // полспейсинга, но не больше 60px
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

  /** Анимируем РЫВОК: один tween бойца вперёд до последней цели, по пути — мгновенные
   *  снепы HP в каждой точке (без плавных полосок). После рывка — отскок, если ev.retreat. */
  private playLunge(li: number, ev: LungeEvent, onDone: () => void): void {
    if (this.resultShown) {
      onDone();
      return;
    }
    const fighter = this.fighters[li];
    const stops = ev.stops;
    if (stops.length === 0) {
      onDone();
      return;
    }
    const startY = fighter.y;
    const endY = this.obstacleY(li, stops[stops.length - 1].step.index);
    const distance = Math.abs(startY - endY);
    const walk = this.walkTime(distance);
    const span = Math.max(1, distance);

    // Короткое потряхивание бойца — один «свинг» на рывок.
    this.tweens.add({ targets: fighter, scaleX: 1.12, yoyo: true, duration: 80 });

    // Tween бойца вперёд до последней точки рывка.
    this.tweens.add({
      targets: fighter,
      y: endY,
      duration: walk,
      onComplete: () => {
        if (this.resultShown) return;
        if (ev.weaponTierAfter !== undefined) {
          this.updateFighterWeapon(li, ev.weaponTierAfter, ev.weaponHitsAfter);
        }
        if (ev.retreat) {
          // Короткий откат «полшажка назад» — только обозначить, что упёрся.
          // Полное возвращение домой делает только stuck/chest (см. returnFighter).
          const back = this.backstepDistance(li);
          const backY = Math.min(this.yBottom, fighter.y + back);
          const dist = Math.abs(backY - fighter.y);
          this.tweens.add({
            targets: fighter,
            y: backY,
            duration: Math.max(130, dist * this.PIXEL_TIME),
            onComplete: onDone,
          });
        } else {
          onDone();
        }
      },
    });

    // Запланируем мгновенные эффекты по пути.
    for (const stop of stops) {
      const stopY = this.obstacleY(li, stop.step.index);
      const t = (Math.abs(stopY - startY) / span) * walk;
      this.time.delayedCall(t, () => {
        if (this.resultShown) return;
        if (stop.kind === 'target') {
          this.applyHpSnap(li, stop);
        } else {
          this.popText(fighter.x, stopY, `+${stop.step.scrap}`, '#9fe870');
        }
      });
    }
  }

  /** Мгновенный snap HP-бара/числа + (опц.) фейд токена для убитого. */
  private applyHpSnap(li: number, t: StopTarget): void {
    const idx = t.step.index;
    const token = this.obTokens[li]?.[idx];
    const bar = this.obBars[li]?.[idx];
    const barBg = this.obBarBgs[li]?.[idx];
    const hpText = this.obHpTexts[li]?.[idx];
    const maxHp = (bar?.getData('maxHp') as number) ?? 1;
    const hpAfter = Math.max(0, t.hpAfter);

    if (bar) {
      bar.setScale(hpAfter / maxHp, 1);
      hpText?.setText(String(hpAfter));
    }
    if (token) {
      // Короткий «контакт»-флеш на токене (отражает попадание).
      this.tweens.add({ targets: token, alpha: 0.55, yoyo: true, duration: 90 });
    }

    if (t.killed && token) {
      this.tweens.add({
        targets: token,
        alpha: 0,
        scale: 0.2,
        duration: 160,
        delay: 60,
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

  private playChest(li: number, ev: ChestEvent, onDone: () => void): void {
    if (this.resultShown) {
      onDone();
      return;
    }
    const fighter = this.fighters[li];
    const chestY = this.yChest + 46;
    const startY = fighter.y;
    const distance = Math.abs(startY - chestY);
    const walk = this.walkTime(distance);
    const span = Math.max(1, distance);

    this.tweens.add({
      targets: fighter,
      y: chestY,
      duration: walk,
      onComplete: () => {
        if (this.resultShown) return;
        this.openChest(li);
        this.popText(fighter.x, this.yChest, 'СУНДУК', '#ffd700');
        if (ev.weaponTierAfter !== undefined) {
          this.updateFighterWeapon(li, ev.weaponTierAfter, ev.weaponHitsAfter);
        }
        this.time.delayedCall(this.CHEST, () => {
          if (this.resultShown) return;
          this.returnFighter(li, onDone);
        });
      },
    });

    for (const s of ev.scrapEnRoute) {
      const sY = this.obstacleY(li, s.step.index);
      const t = (Math.abs(sY - startY) / span) * walk;
      this.time.delayedCall(t, () => {
        if (this.resultShown) return;
        this.popText(fighter.x, sY, `+${s.step.scrap}`, '#9fe870');
      });
    }
  }

  private playStuck(li: number, ev: StuckEvent, onDone: () => void): void {
    if (this.resultShown) {
      onDone();
      return;
    }
    const fighter = this.fighters[li];
    const stuckY = this.obstacleY(li, ev.step.index);
    const startY = fighter.y;
    const distance = Math.abs(startY - stuckY);
    const walk = this.walkTime(distance);
    const span = Math.max(1, distance);

    this.tweens.add({
      targets: fighter,
      y: stuckY,
      duration: walk,
      onComplete: () => {
        if (this.resultShown) return;
        this.popText(fighter.x, stuckY, 'отступ', '#ff8a8a');
        if (ev.weaponTierAfter !== undefined) {
          this.updateFighterWeapon(li, ev.weaponTierAfter, ev.weaponHitsAfter);
        }
        this.returnFighter(li, onDone);
      },
    });

    for (const s of ev.scrapEnRoute) {
      const sY = this.obstacleY(li, s.step.index);
      const t = (Math.abs(sY - startY) / span) * walk;
      this.time.delayedCall(t, () => {
        if (this.resultShown) return;
        this.popText(fighter.x, sY, `+${s.step.scrap}`, '#9fe870');
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
    const lbMid = r.totalLootboxes.filter((k) => k === 'medium').length;
    const lbElite = r.totalLootboxes.filter((k) => k === 'elite').length;
    const lbLine = lbMid + lbElite > 0 ? `Лутбоксы: ${lbMid} ср. / ${lbElite} кр.` : 'Лутбоксы: —';
    const lines = [
      `Дошло бойцов: ${reached} / ${r.lanes.length}`,
      `Металлолом: +${r.totalScrap}`,
      `Оружие: +${r.totalWeapons.length}`,
      lbLine,
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
