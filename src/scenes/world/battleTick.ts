// Реалтайм-двигатель боя. Per-frame `tick(dt, now)` двигает зомби, прогоняет
// FSM-у каждого бойца (walking/backstep/retreating/at_chest/finished), проверяет
// завершение уровня. Не привязан к WorldScene напрямую — общается через `deps`
// (scene, fighters controller, hud, callbacks).
//
// State, который держим тут (per battle, mutable):
//   • laneRuntimes — массив per-lane runtime'а (см. types.ts)
//   • battleNodes — Phaser-объекты, созданные для боя (cleanup после)
//   • chestRowY, worldTopY, laneWidth, maxObsCount, obstacleTokenSize — геометрия
//   • resultShown, allLanesFinishedAt — для RESULT_DELAY_MS pause перед модалкой
//
// Lifecycle:
//   1. `resetForBattle(level, ...)` — обнулить state, выставить новые derived'ы.
//   2. `buildLaneRuntime(li, tiers)` × cols — построить лайн (сундук + obstacles + arsenal).
//   3. tick(dt, now) каждый кадр пока mode='battle' (вызывается из WorldScene.update).
//   4. На `onResultReady` callback'е caller показывает модалку результата.
//   5. `assembleResult()` собирает BattleResult из laneRuntimes для applyBattleResult.
//   6. `skipBattle()` — fast-forward через большие тики до полного завершения.

import Phaser from 'phaser';
import type { BattleResult, Level, Obstacle, WeaponTier } from '../../types';
import { DESIGN_HEIGHT } from '../../config/constants';
import { getWeapon } from '../../core/weapons';
import { update, save } from '../../core/storage';
import type { Hud } from '../../ui/hud';
import { type FightersController, buildArsenal } from './fighters';
import { CHEST_DISPLAY_W, CHEST_DISPLAY_H, openChestVisual, renderChestContent } from './chestReward';
import type { ArsenalWeapon, LaneRuntime, LaneState, ObRuntime } from './types';
import {
  ATTACK_RANGE,
  BACKSTEP_DISTANCE,
  CHEST_APPROACH_DIST,
  FIGHTER_BACKSTEP_SPEED,
  FIGHTER_RETREAT_SPEED,
  FIGHTER_WALK_SPEED,
  OFF_SCREEN_BELOW_Y,
  RESULT_DELAY_MS,
  ZOMBIE_SPEED_RATIO,
  ZOMBIE_STOP_MARGIN,
  ZOMBIE_STUN_MS,
  obstacleY,
  zombieColor,
} from './constants';

export interface BattleTickDeps {
  scene: Phaser.Scene;
  fighters: FightersController;
  hud: Hud;
  /** Когда все лайны решены + RESULT_DELAY_MS истекла — caller показывает модалку. */
  onResultReady: () => void;
}

export class BattleTickEngine {
  level: Level | null = null;
  laneRuntimes: LaneRuntime[] = [];
  /** Все Phaser-объекты, созданные для текущего боя. cleanup в returnToBase. */
  battleNodes: Phaser.GameObjects.GameObject[] = [];
  chestRowY = 0;
  worldTopY = -200;
  laneWidth = 0;
  maxObsCount = 0;
  obstacleTokenSize = 0;
  resultShown = false;
  /** Время (`scene.time.now`), когда все лайны завершились — после этого
   *  `RESULT_DELAY_MS` до модалки. 0 = ещё не все завершились. */
  private allLanesFinishedAt = 0;

  private get scene(): Phaser.Scene { return this.deps.scene; }

  constructor(private deps: BattleTickDeps) {}

  // ============================== Build ========================================

  /** Сбросить state перед новым боем + выставить геометрию. Вызывается из
   *  `goBattle` после generateLevel, но ДО buildLaneRuntime. */
  resetForBattle(level: Level, maxObsCount: number, chestRowY: number, worldTopY: number, laneWidth: number): void {
    this.level = level;
    this.maxObsCount = maxObsCount;
    this.chestRowY = chestRowY;
    this.worldTopY = worldTopY;
    this.laneWidth = laneWidth;
    this.laneRuntimes = [];
    this.battleNodes = [];
    this.resultShown = false;
    this.allLanesFinishedAt = 0;
  }

  /** Построить одну линию боя. tiers — арсенал из laneArsenals(field). */
  buildLaneRuntime(li: number, tiers: number[]): LaneRuntime {
    const scene = this.scene;
    const lane = this.level!.lanes[li];
    const x = (li + 0.5) * this.laneWidth;
    const tokenSize = Math.min(this.laneWidth * 0.42, 44);
    this.obstacleTokenSize = tokenSize;
    this.deps.fighters.setTokenSize(tokenSize);

    // Сундук — PNG-Image (ui.chest_close → ui.chest_opened по openChestVisual).
    // Fallback на цветной квадрат если текстура не загружена (dev без preload'а).
    // origin (0.5, 1) — якорь по нижнему краю: база сундука сидит ровно на
    // chestRowY (= позиция самого дальнего препятствия линии + CHEST_GAP), а
    // высокая открытая крышка/тело расширяется ВВЕРХ, не наезжая на бойца внизу.
    const chest = scene.textures.exists('ui.chest_close')
      ? scene.add.image(x, this.chestRowY, 'ui.chest_close')
          .setOrigin(0.5, 1)
          .setDisplaySize(CHEST_DISPLAY_W, CHEST_DISPLAY_H)
      : scene.add.image(x, this.chestRowY, '__DEFAULT')
          .setOrigin(0.5, 1)
          .setDisplaySize(CHEST_DISPLAY_W, CHEST_DISPLAY_H)
          .setTint(0xd4af37);
    this.battleNodes.push(chest);

    // Препятствия.
    const obs: ObRuntime[] = [];
    const barW = Math.min(tokenSize * 1.4, 60);
    const barH = 4;
    for (let i = 0; i < lane.obstacles.length; i++) {
      obs.push(this.makeObRuntime(lane.obstacles[i], x, obstacleY(i), tokenSize, barW, barH));
    }

    const { active, rest } = buildArsenal(tiers);

    const runtime: LaneRuntime = {
      li,
      state: 'walking' as LaneState,
      fighter: this.deps.fighters.fighters[li],
      active,
      arsenal: rest,
      obs,
      chest,
      chestY: this.chestRowY,
      chestOpened: false,
      reachedChest: false,
      scrapCollected: 0,
      weaponsCollected: [],
      lootboxesCollected: [],
      backstepTargetY: 0,
    };
    this.laneRuntimes.push(runtime);
    return runtime;
  }

  private makeObRuntime(
    ob: Obstacle,
    x: number,
    y: number,
    tokenSize: number,
    barW: number,
    barH: number,
  ): ObRuntime {
    const scene = this.scene;
    let token: Phaser.GameObjects.GameObject;
    if (ob.kind === 'zombie') {
      token = scene.add.circle(x, y, tokenSize / 2, zombieColor(ob.zombieTier ?? 1))
        .setStrokeStyle(2, 0x000000, 0.4);
    } else if (ob.kind === 'crate') {
      token = scene.add.rectangle(x, y, tokenSize, tokenSize, 0x8b5a2b)
        .setStrokeStyle(2, 0x000000, 0.4);
    } else {
      token = scene.add.circle(x, y, tokenSize / 4, 0x9aa0a6);
    }
    this.battleNodes.push(token);
    let bar: Phaser.GameObjects.Rectangle | null = null;
    let barBg: Phaser.GameObjects.Rectangle | null = null;
    let hpText: Phaser.GameObjects.Text | null = null;
    if (ob.kind === 'zombie' || ob.kind === 'crate') {
      const barY = y - tokenSize / 2 - 9;
      const barX = x - barW / 2;
      barBg = scene.add.rectangle(barX, barY, barW, barH, 0x333333).setOrigin(0, 0.5);
      bar = scene.add.rectangle(barX, barY, barW, barH, 0xee3333).setOrigin(0, 0.5);
      hpText = scene.add.text(x, barY - 4, String(ob.hp), {
        fontFamily: 'monospace', fontSize: '10px', color: '#ffcccc',
      }).setOrigin(0.5, 1);
      this.battleNodes.push(barBg, bar, hpText);
    }
    return {
      kind: ob.kind,
      token, bar, barBg, hpText,
      hp: ob.hp,
      maxHp: ob.hp,
      scrap: ob.scrap ?? 0,
      givesWeapon: ob.kind === 'crate' ? (ob.givesWeapon ?? false) : false,
      zombieTier: ob.kind === 'zombie' ? (ob.zombieTier ?? 0) : 0,
      stunnedUntil: 0,
      dead: false,
    };
  }

  // ============================== Tick =========================================

  /** Главный тик боя — вызывается каждый кадр из WorldScene.update пока mode='battle'. */
  tick(dt: number, now: number): void {
    if (!this.level) return;

    // 1) Движение зомби (per lane).
    for (const lane of this.laneRuntimes) {
      this.moveLaneZombies(lane, dt, now);
    }

    // 2) Движение/действия бойца (per lane).
    for (const lane of this.laneRuntimes) {
      this.tickLane(lane, dt, now);
    }

    // 3) Проверка завершения уровня — все лайны в {at_chest, retreating, finished}.
    //    КЛЮЧЕВОЕ: 'retreating' тоже считается «done» — как только последний боец НАЧАЛ
    //    убегать на базу, запускаем таймер RESULT_DELAY_MS. Без этого ждали бы пока он
    //    физически добежит за нижний край экрана (~4-5 секунд), что слишком долго.
    const allDone = this.laneRuntimes.every(l =>
      l.state === 'at_chest' || l.state === 'retreating' || l.state === 'finished',
    );
    if (allDone && !this.resultShown) {
      if (this.allLanesFinishedAt === 0) {
        this.allLanesFinishedAt = now;
      } else if (now >= this.allLanesFinishedAt + RESULT_DELAY_MS) {
        this.resultShown = true;
        this.deps.onResultReady();
      }
    }
  }

  /** Движение зомби в линии: к бойцу (вниз), с учётом видимости/stun/collision/crate.
   *
   *  Правило коробок: zombie «видит бойца» только если между ним и бойцом нет НИ ОДНОЙ
   *  живой коробки. Идём по линии от бойца к концу (idx=0 → N-1), флагом `crateAhead`
   *  помечаем, что между текущим zombie и бойцом стоит хотя бы одна коробка. Такой
   *  zombie стоит на месте (но всё равно блокирует zombies за собой).
   *
   *  Когда боец разбивает коробку → `ob.dead = true` → коробка пропускается в этом
   *  loop'е и `crateAhead` для zombies за ней сбрасывается → они начинают идти. */
  private moveLaneZombies(lane: LaneRuntime, dt: number, now: number): void {
    const cam = this.scene.cameras.main;
    const viewTopY = cam.scrollY;
    const viewBotY = cam.scrollY + DESIGN_HEIGHT;
    const tokenSize = this.obstacleTokenSize || 44;
    const speed = FIGHTER_WALK_SPEED * ZOMBIE_SPEED_RATIO;
    const dy = Math.min(speed * dt, 8);
    // Линия первого зомби (obstacleY(0)) — это ГРАНИЦА: дальше зомби идти не могут.
    const frontLineY = obstacleY(0);
    const fighter = lane.fighter;
    if (!fighter) return;

    let upperLimitY = Math.min(fighter.y - tokenSize - ZOMBIE_STOP_MARGIN, frontLineY);
    let crateAhead = false;

    for (let idx = 0; idx < lane.obs.length; idx++) {
      const ob = lane.obs[idx];
      if (!ob || ob.dead) continue;
      if (ob.kind === 'scrap') continue;
      const tobj = ob.token as Phaser.GameObjects.GameObject & { y: number };
      const currentY = tobj.y;
      if (ob.kind === 'crate') {
        upperLimitY = currentY - tokenSize - ZOMBIE_STOP_MARGIN;
        crateAhead = true;
        continue;
      }
      if (crateAhead) {
        upperLimitY = currentY - tokenSize - ZOMBIE_STOP_MARGIN;
        continue;
      }
      if (currentY < viewTopY || currentY > viewBotY) {
        upperLimitY = currentY - tokenSize - ZOMBIE_STOP_MARGIN;
        continue;
      }
      if (now < ob.stunnedUntil) {
        upperLimitY = currentY - tokenSize - ZOMBIE_STOP_MARGIN;
        continue;
      }
      const desiredY = Math.min(currentY + dy, upperLimitY);
      if (desiredY > currentY) {
        this.moveObstacleVisuals(ob, desiredY - currentY);
        upperLimitY = desiredY - tokenSize - ZOMBIE_STOP_MARGIN;
      } else {
        upperLimitY = currentY - tokenSize - ZOMBIE_STOP_MARGIN;
      }
    }
  }

  /** Сдвинуть все визуальные части препятствия (token + bar + bg + text) на dy. */
  private moveObstacleVisuals(ob: ObRuntime, dy: number): void {
    if (dy === 0) return;
    (ob.token as Phaser.GameObjects.GameObject & { y: number }).y += dy;
    if (ob.bar) ob.bar.y += dy;
    if (ob.barBg) ob.barBg.y += dy;
    if (ob.hpText) ob.hpText.y += dy;
  }

  // ============================== Fighter state machines =======================

  /** Tick state machine бойца в одной лайне (диспатчит на tickFighterXxx). */
  private tickLane(lane: LaneRuntime, dt: number, now: number): void {
    switch (lane.state) {
      case 'walking': this.tickFighterWalking(lane, dt, now); break;
      case 'backstep': this.tickFighterBackstep(lane, dt); break;
      case 'retreating': this.tickFighterRetreating(lane, dt); break;
      case 'at_chest':
      case 'finished':
        return;
    }
  }

  private tickFighterWalking(lane: LaneRuntime, dt: number, now: number): void {
    const hasWeapon = (lane.active != null && lane.active.hits > 0) || this.switchWeapon(lane);
    const targetIdx = this.findNextLiveObstacle(lane);

    // === БЕЗ оружия ============================================================
    // Лом — собираем (instant credit). Сундук — открываем. Zombie/crate — идём к нему
    // до столкновения, потом retreat (бить нечем).
    if (!hasWeapon) {
      if (targetIdx === null) {
        this.walkOrOpenChest(lane, dt);
        return;
      }
      const ob = lane.obs[targetIdx];
      const obY = (ob.token as Phaser.GameObjects.GameObject & { y: number }).y;
      const dist = lane.fighter.y - obY;
      if (ob.kind === 'scrap') {
        this.tryPickupScrap(lane, ob, obY, dist, dt);
        return;
      }
      // zombie/crate ahead — collision → retreat.
      if (dist <= ATTACK_RANGE) {
        lane.state = 'retreating';
        return;
      }
      lane.fighter.y -= FIGHTER_WALK_SPEED * dt;
      return;
    }

    // === С оружием =============================================================
    if (targetIdx === null) {
      this.walkOrOpenChest(lane, dt);
      return;
    }
    const ob = lane.obs[targetIdx];
    const obY = (ob.token as Phaser.GameObjects.GameObject & { y: number }).y;
    const dist = lane.fighter.y - obY;

    if (ob.kind === 'scrap') {
      this.tryPickupScrap(lane, ob, obY, dist, dt);
      return;
    }
    // zombie/crate — подойти и ударить.
    if (dist > ATTACK_RANGE) {
      lane.fighter.y -= FIGHTER_WALK_SPEED * dt;
      return;
    }
    this.attackObstacle(lane, targetIdx, now);
  }

  /** Подобрать лом при контакте: instant credit в state.scrap, не в попап. */
  private tryPickupScrap(
    lane: LaneRuntime, ob: ObRuntime, obY: number, dist: number, dt: number,
  ): void {
    if (dist <= ATTACK_RANGE + 4) {
      const amount = ob.scrap;
      update((st) => { st.scrap += amount; });
      save();
      this.deps.hud.refresh();
      this.popText(lane.fighter.x, obY, `+${amount}`, '#9fe870');
      ob.token.destroy();
      ob.dead = true;
    } else {
      lane.fighter.y -= FIGHTER_WALK_SPEED * dt;
    }
  }

  /** Идти к сундуку и открыть при достижении (когда впереди живых препятствий нет). */
  private walkOrOpenChest(lane: LaneRuntime, dt: number): void {
    const dist = lane.fighter.y - lane.chestY;
    if (dist <= CHEST_APPROACH_DIST) {
      this.openChestForLane(lane);
      return;
    }
    lane.fighter.y -= FIGHTER_WALK_SPEED * dt;
  }

  /** Один удар активным оружием: -1 hit, -dmg HP. Если убил — продолжаем, если ранил —
   *  backstep + stun зомби. */
  private attackObstacle(lane: LaneRuntime, idx: number, now: number): void {
    const ob = lane.obs[idx];
    const w = lane.active;
    if (!w || w.hits <= 0) return;
    const dmg = getWeapon(w.tier).damagePerHit;
    ob.hp -= dmg;
    w.hits -= 1;
    this.deps.fighters.renderFighterWeapon(lane);

    if (ob.hp <= 0) {
      // Killed — забрать лут, продолжить движение.
      // Coробка даёт ТОЛЬКО refill ресурса самого крутого оружия (если givesWeapon=true).
      // НЕ выдаёт scrap — он приходит только из лома на земле и из сундуков.
      if (ob.kind === 'crate' && ob.givesWeapon) {
        this.refillBestWeapon(lane);
      }
      this.killObstacle(ob);
    } else {
      // Survived — бойцу backstep, зомби stun.
      ob.stunnedUntil = now + ZOMBIE_STUN_MS;
      this.renderObstacleHp(ob);
      this.scene.tweens.add({ targets: ob.token, alpha: 0.55, yoyo: true, duration: 90 });
      lane.backstepTargetY = lane.fighter.y + BACKSTEP_DISTANCE;
      lane.state = 'backstep';
    }
  }

  private tickFighterBackstep(lane: LaneRuntime, dt: number): void {
    const target = lane.backstepTargetY;
    if (lane.fighter.y >= target) {
      // Backstep завершён — если оружие исчерпано, retreat. Иначе walking.
      if (!lane.active || lane.active.hits <= 0) {
        if (!this.switchWeapon(lane)) {
          lane.state = 'retreating';
          return;
        }
      }
      lane.state = 'walking';
      return;
    }
    lane.fighter.y = Math.min(target, lane.fighter.y + FIGHTER_BACKSTEP_SPEED * dt);
  }

  private tickFighterRetreating(lane: LaneRuntime, dt: number): void {
    const target = OFF_SCREEN_BELOW_Y;
    if (lane.fighter.y >= target) {
      lane.state = 'finished';
      return;
    }
    lane.fighter.y = Math.min(target, lane.fighter.y + FIGHTER_RETREAT_SPEED * dt);
  }

  // ============================== Arsenal / obstacle helpers ===================

  /** Активировать следующее оружие из арсенала (strongest first). Возвращает false если
   *  ничего не осталось. */
  private switchWeapon(lane: LaneRuntime): boolean {
    while (lane.arsenal.length > 0) {
      const next = lane.arsenal.shift() as ArsenalWeapon;
      if (next.hits > 0) {
        lane.active = next;
        this.deps.fighters.renderFighterWeapon(lane);
        return true;
      }
    }
    lane.active = null;
    this.deps.fighters.renderFighterWeapon(lane);
    return false;
  }

  /** Сундук-коробка с givesWeapon=true: обновляем ресурс САМОГО КРУТОГО оружия в арсенале
   *  бойца до его maxHits. */
  private refillBestWeapon(lane: LaneRuntime): void {
    const all: ArsenalWeapon[] = [];
    if (lane.active) all.push(lane.active);
    all.push(...lane.arsenal);
    if (all.length === 0) return;
    let best: ArsenalWeapon | null = null;
    for (const w of all) {
      if (!best || w.tier > best.tier) best = w;
    }
    if (best) {
      best.hits = best.maxHits;
      this.deps.fighters.renderFighterWeapon(lane);
    }
  }

  private findNextLiveObstacle(lane: LaneRuntime): number | null {
    for (let i = 0; i < lane.obs.length; i++) {
      const ob = lane.obs[i];
      if (ob && !ob.dead) return i;
    }
    return null;
  }

  private killObstacle(ob: ObRuntime): void {
    ob.dead = true;
    this.scene.tweens.add({
      targets: ob.token, alpha: 0, scale: 0.2, duration: 160, delay: 60,
      onComplete: () => {
        ob.token.destroy();
        ob.bar?.destroy();
        ob.barBg?.destroy();
        ob.hpText?.destroy();
      },
    });
  }

  /** Обновить HP-bar и hp-text препятствия после ранения. */
  private renderObstacleHp(ob: ObRuntime): void {
    if (ob.bar) ob.bar.setScale(Math.max(0, ob.hp / ob.maxHp), 1);
    if (ob.hpText) ob.hpText.setText(String(Math.max(0, ob.hp)));
  }

  // ============================== Chest open ===================================

  private openChestForLane(lane: LaneRuntime): void {
    if (lane.chestOpened) return;
    lane.chestOpened = true;
    lane.reachedChest = true;
    // Snap бойца у сундука.
    lane.fighter.y = lane.chestY + 46;
    openChestVisual(this.scene, lane.chest);
    // Render reward visual (returns container — push в battleNodes для cleanup'а).
    const chestDef = this.level!.lanes[lane.li].chest;
    const cx = (lane.li + 0.5) * this.laneWidth;
    this.battleNodes.push(renderChestContent(this.scene, chestDef, cx, lane.chestY));
    // Собрать награду из сундука.
    if (chestDef.reward === 'scrap') lane.scrapCollected += chestDef.scrap ?? 0;
    else if (chestDef.reward === 'weapon' && chestDef.weaponTier != null)
      lane.weaponsCollected.push(chestDef.weaponTier);
    else if (chestDef.reward === 'lootbox' && chestDef.lootboxKind)
      lane.lootboxesCollected.push(chestDef.lootboxKind);
    lane.state = 'at_chest';
    // Idle bounce.
    this.scene.tweens.add({ targets: lane.fighter, scaleY: 0.92, yoyo: true, duration: 420, repeat: -1 });
  }

  // ============================== Skip / result ================================

  /** Fast-forward: проматываем runtime до полного завершения. Cap MAX_ITERATIONS для
   *  безопасности (теоретически бесконечный loop при баге). */
  skip(): BattleResult | null {
    if (this.resultShown) return null;
    if (!this.level) return null;
    const MAX_ITERATIONS = 10000;
    let iter = 0;
    while (iter < MAX_ITERATIONS) {
      iter++;
      const now = this.scene.time.now + iter * 50;
      for (const lane of this.laneRuntimes) {
        this.moveLaneZombies(lane, 50, now);
      }
      for (const lane of this.laneRuntimes) {
        this.tickLane(lane, 50, now);
      }
      const allDone = this.laneRuntimes.every(l => l.state === 'at_chest' || l.state === 'finished');
      if (allDone) break;
    }
    this.resultShown = true;
    return this.assembleResult();
  }

  /** Собрать BattleResult из laneRuntimes (после боя, перед applyBattleResult). */
  assembleResult(): BattleResult {
    const lanes = this.laneRuntimes.map(r => ({
      reachedChest: r.reachedChest,
      collectedScrap: r.scrapCollected,
      collectedWeapons: r.weaponsCollected as WeaponTier[],
      collectedLootboxes: r.lootboxesCollected,
      steps: [],
    }));
    return {
      level: this.level?.number ?? 0,
      passed: lanes.some(l => l.reachedChest),
      lanes,
      totalScrap: lanes.reduce((a, l) => a + l.collectedScrap, 0),
      totalWeapons: lanes.flatMap(l => l.collectedWeapons),
      totalLootboxes: lanes.flatMap(l => l.collectedLootboxes),
    };
  }

  // ============================== Misc =========================================

  private popText(x: number, y: number, msg: string, color: string): void {
    const t = this.scene.add
      .text(x, y, msg, { fontFamily: 'monospace', fontSize: '20px', color })
      .setOrigin(0.5)
      .setDepth(50);
    this.scene.tweens.add({
      targets: t,
      y: y - 40,
      alpha: 0,
      duration: 700,
      onComplete: () => t.destroy(),
    });
  }
}
