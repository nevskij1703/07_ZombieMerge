// «Мировая» сцена: одна на всё (база + бой). Боевая логика — REALTIME per-lane tick.
// Никаких event-timelin'ов: каждый кадр движем бойца и зомби, проверяем коллизии,
// применяем удары. Симулятор больше НЕ вычисляет результат заранее — мы собираем
// рузультат из runtime в конце боя (assembleResult).
//
// Геометрия (мировые Y):
//   • Y=0..1280 — «base view» (scrollY=0): ворота на GATE_Y=440, мердж-поле, HUD.
//   • Дорога — НАД воротами (отрицательные Y). Препятствия с шагом ZOMBIE_SPACING.
//     Сундуки — на едином Y по самой длинной линии уровня.
//   • Камера: scrollY ≤ 0. После боя — snap обратно к Y=0.
//
// Modes:
//   • 'base'           — интерактив базы (мердж/произвести/трэш/инвентарь/в бой).
//   • 'transition'     — ворота открываются, бойцы спускаются к мердж-полю, забирают
//                        оружие, бегут к старту своей линии.
//   • 'battle'         — реалтайм симуляция: бойцы наступают, бьют зомби, отскакивают.
//   • 'showing_result' — модалка результата.
//
// Per-lane state machine (LaneRuntime.state):
//   walking    — бой идёт вперёд к ближайшему живому препятствию (или к сундуку).
//   backstep   — после ранения зомби: бой отскакивает на BACKSTEP_DISTANCE, зомби stun.
//   retreating — арсенал пуст: бой бежит на базу (за нижний край).
//   at_chest   — бой дошёл до сундука; idle-bounce, лайн «завершена».
//   finished   — бой ушёл за низ экрана; лайн «завершена».

import Phaser from 'phaser';
import { SceneKey } from './sceneKeys';
import { DESIGN_WIDTH, DESIGN_HEIGHT, TIER_COLORS } from '../config/constants';
import type { Level, BattleResult, LootboxKind, WeaponTier, Obstacle } from '../types';
import { getState, save, update } from '../core/storage';
import { applyBattleResult, laneArsenals, bestWeaponTier } from '../core/progression';
import { generateLevel } from '../core/levelGen';
import { produceCost, canAfford } from '../core/economy';
import { weaponName, getWeapon } from '../core/weapons';
import { placeFirstFree, isFull, pullFromInventory } from '../core/merge';
import { isWeaponCellValue, rollLootboxTier } from '../core/lootbox';
import { getBalance } from '../core/balanceRuntime';
import { makeRng } from '../core/rng';
import { Hud } from '../ui/hud';
import { MergeBoard, type BoardRect } from '../ui/mergeBoard';
import { InventoryBar } from '../ui/inventoryBar';
import { Button } from '../ui/button';
import { MainScreenUI } from '../ui/mainScreen';
import { parseLocation, buildLocation, findTileset, type BuiltLocation, type LocationManifest } from '../art/locationLoader';
import { loadOverrides } from '../editor/layoutOverrides';
import { LayoutEditor } from '../editor/layoutEditor';

// ============================ Layout constants =================================

const GATE_Y = 440;          // ворота — общая граница базы и города
// Дистанция от ворот до ПЕРВОГО зомби — первый зомби за пределами видимой зоны базы.
const FIRST_ZOMBIE_OFFSET = 500;
const ZOMBIE_SPACING = 64;   // КОНСТАНТНЫЙ шаг между препятствиями
const CHEST_GAP = 64;        // зазор между самым дальним препятствием и сундуком
// Idle позиция бойца на базе: между воротами (440) и мердж-полем (555).
const FIGHTER_IDLE_Y = 500;
// Y «у мердж-поля» — пickup в начале боя.
const FIGHTER_PICKUP_Y = 580;

// ============================ Battle tuning =====================================

const FIGHTER_WALK_SPEED = 0.3;        // px/ms forward
const FIGHTER_BACKSTEP_SPEED = 0.275;  // быстрее, чем walk
const FIGHTER_RETREAT_SPEED = 0.30;    // самая высокая (бежит на базу)
const ATTACK_RANGE = 14;               // дистанция attack contact (px между center'ами)
const BACKSTEP_DISTANCE = 36;          // насколько отлетает после ранения
const ZOMBIE_SPEED_RATIO = 0.25;       // от скорости бойца (зомби автоматически замедляются вместе с бойцами)
const ZOMBIE_STUN_MS = 200;            // не двигается после удара (= ~backstep duration)
const ZOMBIE_STOP_MARGIN = 6;          // зазор перед бойцом/др зомби
const CHEST_APPROACH_DIST = 50;        // когда бой подошёл к сундук area
const RESULT_DELAY_MS = 1000;          // пауза после последней решённой лайн до модалки

// Камера
const WORLD_TOP_BOUND = -3500;
const WORLD_BOTTOM_BOUND = DESIGN_HEIGHT + 600;
const FIGHTER_VIEW_OFFSET = DESIGN_HEIGHT / 3;
const CAMERA_TOP_BUFFER = FIGHTER_VIEW_OFFSET - 46 + 60;
const OFF_SCREEN_BELOW_Y = DESIGN_HEIGHT + 200;

// ============================ Color palette =====================================

const ZOMBIE_TIER_COLORS: number[] = [
  0x333333, 0x6b8e23, 0x7d931e, 0x90981e, 0xa68f1e, 0xb6851e,
  0xc77b1e, 0xbe6a1e, 0xb55a1e, 0xab4a1e, 0xa53a22, 0xa02e22, 0x9b2222,
];
function zombieColor(tier: number): number {
  return ZOMBIE_TIER_COLORS[Math.max(1, Math.min(12, tier))] ?? ZOMBIE_TIER_COLORS[1];
}

// ============================ Runtime types =====================================

type SceneMode = 'base' | 'transition' | 'battle' | 'showing_result';

type LaneState = 'walking' | 'backstep' | 'retreating' | 'at_chest' | 'finished';

interface ArsenalWeapon {
  tier: number;
  hits: number;
  maxHits: number;
}

interface ObRuntime {
  kind: 'zombie' | 'crate' | 'scrap';
  token: Phaser.GameObjects.GameObject;
  bar: Phaser.GameObjects.Rectangle | null;
  barBg: Phaser.GameObjects.Rectangle | null;
  hpText: Phaser.GameObjects.Text | null;
  hp: number;
  maxHp: number;
  scrap: number;
  givesWeapon: boolean;
  zombieTier: number;
  stunnedUntil: number;
  dead: boolean;
}

interface LaneRuntime {
  li: number;
  state: LaneState;
  fighter: Phaser.GameObjects.Container;
  /** Текущее активное оружие (`null` = арсенал пуст). */
  active: ArsenalWeapon | null;
  /** Остальные оружия (отсортированы DESC по тиру — strongest first). */
  arsenal: ArsenalWeapon[];
  obs: ObRuntime[];
  chest: Phaser.GameObjects.Container;
  chestY: number;
  chestOpened: boolean;
  reachedChest: boolean;
  scrapCollected: number;
  weaponsCollected: number[];
  lootboxesCollected: LootboxKind[];
  /** Y до которого боец должен отскочить во время backstep. */
  backstepTargetY: number;
}

// ================================ Scene =========================================

export class WorldScene extends Phaser.Scene {
  // === Base UI references ===
  private hud!: Hud;
  private board!: MergeBoard;
  private inv!: InventoryBar;
  private mainUI!: MainScreenUI;
  private trashRect: { x: number; y: number; w: number; h: number } | null = null;
  private trashContainer: Phaser.GameObjects.Container | null = null;
  private trashSize = 0;
  private trashPlaceArt: Phaser.GameObjects.Image | null = null;
  private invPlaceArt: Phaser.GameObjects.Image | null = null;
  private mergeGroundGfx: Phaser.GameObjects.Graphics | null = null;
  private gradientTop: Phaser.GameObjects.Image | null = null;
  private gradientBot: Phaser.GameObjects.Image | null = null;
  private baseLocation: BuiltLocation | null = null;
  private baseManifest: LocationManifest | null = null;
  private baseRoadTopY = 0;
  private baseRoadContainer: Phaser.GameObjects.Container | null = null;
  /** Активные tweens мигания ламп (yoyo alpha 50%↔100% когда ворота открыты). */
  private lampTweens: Phaser.Tweens.Tween[] = [];
  layoutEditor: LayoutEditor | null = null;
  private lootRng: () => number = () => Math.random();

  // === Fighters (persistent — created once in `create()`, anim'd between idle/battle) ===
  private fighters: Phaser.GameObjects.Container[] = [];
  private fighterTierTexts: Phaser.GameObjects.Text[] = [];
  private fighterWeaponIcons: Phaser.GameObjects.Image[] = [];
  private fighterHitsTexts: Phaser.GameObjects.Text[] = [];
  private fighterRings: Phaser.GameObjects.Arc[] = [];

  // === Battle state ===
  private mode: SceneMode = 'base';
  private level: Level | null = null;
  private laneRuntimes: LaneRuntime[] = [];
  private battleNodes: Phaser.GameObjects.GameObject[] = []; // teardown list
  private resultShown = false;
  /** Время (`this.time.now`), когда все лайны завершились — после этого `RESULT_DELAY_MS`
   *  до модалки. 0 = ещё не все завершились. */
  private allLanesFinishedAt = 0;
  private resultNodes: Phaser.GameObjects.GameObject[] = [];
  private speedButtons: Array<{ btn: Button; factor: number }> = [];
  private skipBtn: Button | null = null;
  private speedFactor = 1;

  // === World layout (per battle) ===
  private chestRowY = 0;
  private worldTopY = -200;
  private laneWidth = 0;
  private maxObsCount = 0;
  private obstacleTokenSize = 0;

  constructor() {
    super(SceneKey.World);
  }

  // ============================== Lifecycle ====================================

  create(): void {
    this.mode = 'base';
    this.lootRng = makeRng(Date.now() & 0x7fffffff);

    this.buildBaseArt();
    this.buildBaseRoad();
    this.buildGradients();

    if (import.meta.env.DEV) {
      this.layoutEditor = new LayoutEditor(this);
      if (this.baseLocation) {
        for (const [id, img] of this.baseLocation.byId) {
          this.layoutEditor.register(id, img, id.replace(/^base\./, ''));
        }
      }
      if (this.baseRoadContainer) {
        this.layoutEditor.register(
          'base.road',
          this.baseRoadContainer as unknown as Phaser.GameObjects.Container,
          'Base / Дорога',
        );
      }
    }

    this.hud = new Hud(this);
    this.buildBaseUI();
    this.ensureFightersExist();

    if (import.meta.env.DEV && this.layoutEditor) {
      this.layoutEditor.register('ui.hud', this.hud.container as unknown as Phaser.GameObjects.Container, 'UI / HUD');
      this.layoutEditor.register('ui.inventory', this.inv.container, 'UI / Inventory');
      if (this.trashContainer) {
        this.layoutEditor.register('ui.trash', this.trashContainer, 'UI / Trash');
      }
      this.layoutEditor.register('ui.btn.profile', this.mainUI.btnProfile.container, 'UI / Профиль');
      this.layoutEditor.register('ui.btn.upgrade', this.mainUI.btnUpgrade.container, 'UI / Апгрейд');
      this.layoutEditor.register('ui.btn.produce', this.mainUI.btnProduce.container, 'UI / Произвести');
      this.layoutEditor.register('ui.btn.cards', this.mainUI.btnCards.container, 'UI / Карты');
      this.layoutEditor.register('ui.btn.shop', this.mainUI.btnShop.container, 'UI / Магазин');
      this.layoutEditor.register('ui.btn.fight', this.mainUI.btnFight.container, 'UI / В БОЙ!');
      this.layoutEditor.register('ui.btn.settings', this.hud.settingsBtn, 'UI / Настройки');
    }

    this.cameras.main.setBounds(0, WORLD_TOP_BOUND, DESIGN_WIDTH, -WORLD_TOP_BOUND + WORLD_BOTTOM_BOUND);
    this.cameras.main.setScroll(0, 0);
    this.refreshButtons();
  }

  update(_time: number, delta: number): void {
    this.syncTrashRect();
    // 'showing_result' тоже тикает — пока попап на экране, бойцы/зомби продолжают
    // движение (retreating анимируется, зомби идут к бойцам у сундука). Тик в этом
    // режиме не триггерит повторный showResult (allDone-блок гейтится !resultShown).
    if (this.mode !== 'battle' && this.mode !== 'transition' && this.mode !== 'showing_result') return;
    this.updateCameraFollow();
    if (this.mode === 'battle' || this.mode === 'showing_result') {
      try {
        const safeDelta = Math.min(Math.max(0, delta || 0), 50);
        // Применяем speedFactor → slow-mo (×0.5) / norm (×1) / fast (×4). `tweens.
        // timeScale` + `time.timeScale` параллельно ускоряют tween-анимации (chest
        // open, wound flash) — синхронно с per-tick движением.
        // В режиме showing_result speedFactor мы сбрасываем в 1 (в showResult), поэтому
        // sub-stepping тут нерелевантен — но цикл всё равно работает корректно.
        const scaledDelta = safeDelta * this.speedFactor;
        const SUB_STEP_MS = 16;
        const steps = Math.max(1, Math.ceil(scaledDelta / SUB_STEP_MS));
        const subDt = scaledDelta / steps;
        for (let i = 0; i < steps; i++) {
          this.tickBattle(subDt);
        }
      } catch (e) {
        console.error('[battle] tick failed', e);
      }
    }
  }

  /** Камера тянется к самой высокой точке лидера и НЕ возвращается вниз во время боя. */
  private updateCameraFollow(): void {
    if (this.fighters.length === 0) return;
    let leadY = Infinity;
    for (const f of this.fighters) {
      if (!f) continue;
      if (f.y < leadY) leadY = f.y;
    }
    if (!isFinite(leadY)) return;
    const target = Math.max(this.worldTopY, leadY - FIGHTER_VIEW_OFFSET);
    const cam = this.cameras.main;
    if (target < cam.scrollY) {
      cam.scrollY = Phaser.Math.Linear(cam.scrollY, target, 0.12);
    }
  }

  // ============================== Battle tick ==================================

  /** Главная функция боя — вызывается каждый кадр пока mode='battle'. */
  private tickBattle(dt: number): void {
    if (!this.level) return;
    const now = this.time.now;

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
        this.showResult();
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
   *  loop'е и `crateAhead` для zombies за ней сбрасывается → они начинают идти.
   *
   *  Несколько коробок на линии: zombies между ними стоят пока хоть одна коробка
   *  ВПЕРЕДИ них жива (то есть ближе к бойцу). Когда боец «прорубается» через
   *  ближайшую коробку — zombies сразу за ней оживают, а zombies между ними и
   *  следующей коробкой — продолжают стоять. */
  private moveLaneZombies(lane: LaneRuntime, dt: number, now: number): void {
    const cam = this.cameras.main;
    const viewTopY = cam.scrollY;
    const viewBotY = cam.scrollY + DESIGN_HEIGHT;
    const tokenSize = this.obstacleTokenSize || 44;
    const speed = FIGHTER_WALK_SPEED * ZOMBIE_SPEED_RATIO;
    const dy = Math.min(speed * dt, 8);
    // Линия первого зомби (obstacleY(0)) — это ГРАНИЦА: дальше зомби идти не могут,
    // даже если боец уже убежал на базу. Раньше границей был сам гейт (zombies могли
    // приближаться вплотную к воротам) — теперь они останавливаются на той же линии,
    // где обычно спавнятся первые зомби.
    const frontLineY = this.obstacleY(0);
    const fighter = lane.fighter;
    if (!fighter) return;

    let upperLimitY = Math.min(fighter.y - tokenSize - ZOMBIE_STOP_MARGIN, frontLineY);
    let crateAhead = false; // живая коробка между бойцом и текущей точкой обхода

    for (let idx = 0; idx < lane.obs.length; idx++) {
      const ob = lane.obs[idx];
      if (!ob || ob.dead) continue;
      if (ob.kind === 'scrap') continue; // не двигается, не блокирует
      const tobj = ob.token as Phaser.GameObjects.GameObject & { y: number };
      const currentY = tobj.y;
      // Коробка не двигается, блокирует, и «закрывает обзор» для всех zombies за ней.
      if (ob.kind === 'crate') {
        upperLimitY = currentY - tokenSize - ZOMBIE_STOP_MARGIN;
        crateAhead = true;
        continue;
      }
      // Zombie за живой коробкой — стоит на месте (бойца не видит), но блокирует.
      if (crateAhead) {
        upperLimitY = currentY - tokenSize - ZOMBIE_STOP_MARGIN;
        continue;
      }
      // Не в видимой зоне — стоит, блокирует.
      if (currentY < viewTopY || currentY > viewBotY) {
        upperLimitY = currentY - tokenSize - ZOMBIE_STOP_MARGIN;
        continue;
      }
      // Stunned после удара.
      if (now < ob.stunnedUntil) {
        upperLimitY = currentY - tokenSize - ZOMBIE_STOP_MARGIN;
        continue;
      }
      // Двигаемся вниз, но не дальше upperLimitY.
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

  /** Tick state machine бойца в одной лайн. */
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
    // Пытаемся убедиться что есть активное оружие. Если активное исчерпано —
    // переключаемся. Если арсенал пуст, остаёмся БЕЗ оружия (`hasWeapon=false`).
    const hasWeapon = (lane.active != null && lane.active.hits > 0)
      || this.switchWeapon(lane);

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
      this.hud.refresh();
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
    this.updateFighterWeaponVisual(lane);

    if (ob.hp <= 0) {
      // Killed — забрать лут, продолжить движение.
      // Coробка даёт ТОЛЬКО refill ресурса самого крутого оружия (если givesWeapon=true).
      // НЕ выдаёт scrap — он приходит только из лома на земле и из сундуков.
      if (ob.kind === 'crate' && ob.givesWeapon) {
        this.refillBestWeapon(lane);
      }
      this.killObstacle(ob);
      // На следующем tick'е перейдём к следующему target.
    } else {
      // Survived — бойцу backstep, зомби stun.
      ob.stunnedUntil = now + ZOMBIE_STUN_MS;
      this.updateObstacleVisual(ob);
      this.tweens.add({ targets: ob.token, alpha: 0.55, yoyo: true, duration: 90 });
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

  /** Активировать следующее оружие из арсенала (strongest first). Возвращает false если
   *  ничего не осталось. */
  private switchWeapon(lane: LaneRuntime): boolean {
    while (lane.arsenal.length > 0) {
      const next = lane.arsenal.shift()!;
      if (next.hits > 0) {
        lane.active = next;
        this.updateFighterWeaponVisual(lane);
        return true;
      }
    }
    lane.active = null;
    this.updateFighterWeaponVisual(lane);
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
      this.updateFighterWeaponVisual(lane);
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
    this.tweens.add({
      targets: ob.token, alpha: 0, scale: 0.2, duration: 160, delay: 60,
      onComplete: () => {
        ob.token.destroy();
        ob.bar?.destroy();
        ob.barBg?.destroy();
        ob.hpText?.destroy();
      },
    });
  }

  private updateObstacleVisual(ob: ObRuntime): void {
    if (ob.bar) ob.bar.setScale(Math.max(0, ob.hp / ob.maxHp), 1);
    if (ob.hpText) ob.hpText.setText(String(Math.max(0, ob.hp)));
  }

  private updateFighterWeaponVisual(lane: LaneRuntime): void {
    const li = lane.li;
    const w = lane.active;
    const tierText = this.fighterTierTexts[li];
    const hitsText = this.fighterHitsTexts[li];
    const ring = this.fighterRings[li];
    const iconImg = this.fighterWeaponIcons[li];
    if (w && w.hits > 0) {
      tierText?.setText(`T${w.tier}`);
      hitsText?.setText(String(w.hits));
      ring?.setStrokeStyle(3, TIER_COLORS[w.tier] ?? 0x66ccff, 1);
      // Иконка оружия над бойцом — приоритет визуала.
      const key = `weapon.t${w.tier}`;
      if (iconImg) {
        if (this.textures.exists(key)) {
          iconImg.setTexture(key);
          const tex = this.textures.get(key).getSourceImage();
          const iw = (tex as { width: number }).width ?? 1;
          const ih = (tex as { height: number }).height ?? 1;
          const target = (this.obstacleTokenSize || 44) * 0.85;
          const s = target / Math.max(iw, ih);
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

  private openChestForLane(lane: LaneRuntime): void {
    if (lane.chestOpened) return;
    lane.chestOpened = true;
    lane.reachedChest = true;
    // Snap бойца у сундука.
    lane.fighter.y = lane.chestY + 46;
    this.openChestVisual(lane);
    this.renderChestContent(lane);
    // Собрать награду из сундука.
    const cd = this.level!.lanes[lane.li].chest;
    if (cd.reward === 'scrap') lane.scrapCollected += cd.scrap ?? 0;
    else if (cd.reward === 'weapon' && cd.weaponTier != null) lane.weaponsCollected.push(cd.weaponTier);
    else if (cd.reward === 'lootbox' && cd.lootboxKind) lane.lootboxesCollected.push(cd.lootboxKind);
    lane.state = 'at_chest';
    // Idle bounce.
    this.tweens.add({ targets: lane.fighter, scaleY: 0.92, yoyo: true, duration: 420, repeat: -1 });
  }

  private openChestVisual(lane: LaneRuntime): void {
    const chest = lane.chest;
    const lid = chest.getData('lid') as Phaser.GameObjects.Rectangle | undefined;
    const body = chest.getData('body') as Phaser.GameObjects.Rectangle | undefined;
    body?.setFillStyle(0xf2c63a);
    if (lid) {
      this.tweens.add({ targets: lid, y: lid.y - 26, angle: -28, duration: 260, ease: 'Back.Out' });
    }
    this.tweens.add({ targets: chest, scale: 1.12, yoyo: true, duration: 160 });
  }

  private renderChestContent(lane: LaneRuntime): void {
    const chestDef = this.level!.lanes[lane.li].chest;
    const x = (lane.li + 0.5) * this.laneWidth;
    const size = 54;
    const y = lane.chestY - size / 2 - 18;
    const container = this.add.container(x, y).setDepth(15);
    let fillColor = 0x888888;
    let labelTxt = '';
    let labelColor = '#ffffff';
    let strokeColor = 0x000000;
    let strokeAlpha = 0.4;
    let labelFontFactor = 0.5;
    if (chestDef.reward === 'scrap') {
      fillColor = 0x6b7785;
      labelTxt = `+${chestDef.scrap ?? 0}`;
      labelColor = '#9fe870';
      labelFontFactor = 0.4;
    } else if (chestDef.reward === 'weapon') {
      const t = chestDef.weaponTier ?? 1;
      fillColor = TIER_COLORS[t] ?? 0x888888;
      labelTxt = String(t);
    } else if (chestDef.reward === 'lootbox') {
      const isElite = chestDef.lootboxKind === 'elite';
      fillColor = isElite ? 0x9b59b6 : 0xd4a017;
      labelTxt = '📦';
      strokeColor = 0xffffff;
      strokeAlpha = 0.7;
      labelFontFactor = 0.6;
    }
    const bg = this.add.rectangle(0, 0, size, size, fillColor).setOrigin(0.5)
      .setStrokeStyle(3, strokeColor, strokeAlpha);
    const label = this.add.text(0, 0, labelTxt, {
      fontFamily: 'monospace', fontSize: `${Math.round(size * labelFontFactor)}px`, color: labelColor,
    }).setOrigin(0.5);
    label.setStroke('#000000', 3);
    container.add([bg, label]);
    container.setScale(0);
    this.tweens.add({ targets: container, scale: 1, duration: 240, ease: 'Back.Out' });
    this.battleNodes.push(container);
  }

  // =========================== Battle building ==================================

  private goBattle(): void {
    const s = getState();
    const hasWeapon = s.field.cells.some((c) => isWeaponCellValue(c));
    if (!hasWeapon) {
      this.toast('Сначала собери оружие');
      return;
    }

    this.mode = 'transition';
    this.resultShown = false;
    this.allLanesFinishedAt = 0;
    this.speedFactor = 1;
    this.tweens.timeScale = 1;
    this.time.timeScale = 1;
    this.laneRuntimes = [];
    this.battleNodes = [];

    this.ensureFightersExist();

    const level = generateLevel(s.level, {
      workshopTier: s.workshopTier,
      bestTier: bestWeaponTier(s),
      rewardMultiplier: s.rewardMultiplier,
    });
    const arsenals = laneArsenals(s.field);
    this.level = level;
    this.maxObsCount = Math.max(...level.lanes.map((l) => l.obstacles.length), 1);

    this.buildBattleVisuals(arsenals);
    this.buildSpeedHud();
    this.mainUI.setBottomVisible(false);
    this.gradientTop?.setVisible(false);
    this.gradientBot?.setVisible(false);
    // invPlaceArt/trashPlaceArt НЕ скрываем — они часть локации, текст-лейблы на них
    // тоже остаются (scrollFactor=1) и уезжают с камерой во время боя естественно.

    this.playOpeningSequence(arsenals);
  }

  private buildBattleVisuals(arsenals: number[][]): void {
    const cols = this.level!.cols;
    this.laneWidth = DESIGN_WIDTH / cols;
    this.chestRowY = this.obstacleY(this.maxObsCount - 1) - CHEST_GAP;
    this.worldTopY = this.chestRowY - CAMERA_TOP_BUFFER;
    this.buildRoadTiles();

    for (let li = 0; li < cols; li++) {
      this.laneRuntimes.push(this.buildLaneRuntime(li, arsenals[li] ?? []));
    }
  }

  private buildLaneRuntime(li: number, tiers: number[]): LaneRuntime {
    const lane = this.level!.lanes[li];
    const x = (li + 0.5) * this.laneWidth;
    const tokenSize = Math.min(this.laneWidth * 0.42, 44);
    this.obstacleTokenSize = tokenSize;

    // Сундук — container с body+lid.
    const chestBody = this.add.rectangle(0, 10, 54, 22, 0xd4af37)
      .setOrigin(0.5).setStrokeStyle(2, 0x000000, 0.4);
    const chestLid = this.add.rectangle(0, -8, 58, 14, 0xb8941f)
      .setOrigin(0.5).setStrokeStyle(2, 0x000000, 0.4);
    const chest = this.add.container(x, this.chestRowY, [chestBody, chestLid]);
    chest.setData('body', chestBody);
    chest.setData('lid', chestLid);
    this.battleNodes.push(chest);

    // Препятствия.
    const obs: ObRuntime[] = [];
    const barW = Math.min(tokenSize * 1.4, 60);
    const barH = 4;
    for (let i = 0; i < lane.obstacles.length; i++) {
      const ob = lane.obstacles[i];
      obs.push(this.makeObRuntime(ob, x, this.obstacleY(i), tokenSize, barW, barH));
    }

    // Арсенал: sorted DESC (strongest first). Active = strongest.
    const sorted = [...tiers].sort((a, b) => b - a);
    const arsenal: ArsenalWeapon[] = sorted.map(t => {
      const def = getWeapon(t);
      return { tier: t, hits: def.hits, maxHits: def.hits };
    });
    const active = arsenal.shift() ?? null;

    return {
      li,
      state: 'walking',
      fighter: this.fighters[li],
      active,
      arsenal,
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
  }

  private makeObRuntime(
    ob: Obstacle,
    x: number,
    y: number,
    tokenSize: number,
    barW: number,
    barH: number,
  ): ObRuntime {
    let token: Phaser.GameObjects.GameObject;
    if (ob.kind === 'zombie') {
      token = this.add.circle(x, y, tokenSize / 2, zombieColor(ob.zombieTier ?? 1))
        .setStrokeStyle(2, 0x000000, 0.4);
    } else if (ob.kind === 'crate') {
      token = this.add.rectangle(x, y, tokenSize, tokenSize, 0x8b5a2b)
        .setStrokeStyle(2, 0x000000, 0.4);
    } else {
      token = this.add.circle(x, y, tokenSize / 4, 0x9aa0a6);
    }
    this.battleNodes.push(token);
    let bar: Phaser.GameObjects.Rectangle | null = null;
    let barBg: Phaser.GameObjects.Rectangle | null = null;
    let hpText: Phaser.GameObjects.Text | null = null;
    if (ob.kind === 'zombie' || ob.kind === 'crate') {
      const barY = y - tokenSize / 2 - 9;
      const barX = x - barW / 2;
      barBg = this.add.rectangle(barX, barY, barW, barH, 0x333333).setOrigin(0, 0.5);
      bar = this.add.rectangle(barX, barY, barW, barH, 0xee3333).setOrigin(0, 0.5);
      hpText = this.add.text(x, barY - 4, String(ob.hp), {
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

  private obstacleY(idx: number): number {
    return GATE_Y - FIRST_ZOMBIE_OFFSET - idx * ZOMBIE_SPACING;
  }

  // ============================= Opening sequence ===============================

  private playOpeningSequence(arsenals: number[][]): void {
    const gateL = this.baseLocation?.byId.get('base.gate_l') ?? null;
    const gateR = this.baseLocation?.byId.get('base.gate_r') ?? null;
    const shdL = this.baseLocation?.byId.get('base.gate_l_shd') ?? null;
    const shdR = this.baseLocation?.byId.get('base.gate_r_shd') ?? null;
    const proceed = (): void => this.spawnAndDispatchFighters(arsenals);
    const leftTargets = [gateL, shdL].filter((x): x is Phaser.GameObjects.Image => x != null);
    const rightTargets = [gateR, shdR].filter((x): x is Phaser.GameObjects.Image => x != null);
    if (leftTargets.length > 0 || rightTargets.length > 0) {
      for (const obj of [...leftTargets, ...rightTargets]) {
        if (obj.getData('defaultX') == null) obj.setData('defaultX', obj.x);
      }
      // Ворота открываются — параллельно зажигаем лампы (fade-in 600ms → blink loop).
      this.startLampBlink();
      const off = 220;
      if (leftTargets.length > 0) {
        this.tweens.add({ targets: leftTargets, x: `-=${off}`, duration: 600, ease: 'Sine.Out' });
      }
      if (rightTargets.length > 0) {
        this.tweens.add({
          targets: rightTargets, x: `+=${off}`, duration: 600, ease: 'Sine.Out',
          onComplete: proceed,
        });
      } else {
        this.time.delayedCall(600, proceed);
      }
    } else {
      proceed();
    }
  }

  private spawnAndDispatchFighters(arsenals: number[][]): void {
    const cols = this.level!.cols;
    const laneStartY = GATE_Y - 10;

    // Обновить visual бойцов под арсенал (берётся из laneRuntimes).
    for (let li = 0; li < cols; li++) {
      const lane = this.laneRuntimes[li];
      if (lane) this.updateFighterWeaponVisual(lane);
    }

    let arrived = 0;
    const total = cols;
    for (let li = 0; li < total; li++) {
      const fighter = this.fighters[li];
      if (!fighter) {
        arrived++;
        if (arrived === total) this.startBattle();
        continue;
      }
      // Спуск к мердж-полю (забирают оружие).
      this.tweens.add({
        targets: fighter, y: FIGHTER_PICKUP_Y, duration: 350, ease: 'Quad.In',
        onComplete: () => {
          if (li === 0) this.board.hideWeaponTiles();
          // Подъём к старту своей линии.
          this.tweens.add({
            targets: fighter, y: laneStartY, duration: 700, ease: 'Quad.Out',
            onComplete: () => {
              arrived++;
              if (arrived === total) this.startBattle();
            },
          });
        },
      });
    }
    // Edge: arsenals для каждой линии есть, но reference неиспользуется
    // (visual уже обновлён через laneRuntime). Параметр оставлен для совместимости.
    void arsenals;
  }

  private startBattle(): void {
    if (this.resultShown) return;
    this.mode = 'battle';
    // С этого момента tickBattle() в update() начнёт двигать бойцов и зомби.
  }

  // ============================== Speed/skip HUD ================================

  private buildSpeedHud(): void {
    this.skipBtn = new Button(this, {
      x: 110, y: 1210, width: 180, height: 70, label: 'СКИП', fontSize: 24, bg: 0x555a66,
      onClick: () => this.skipBattle(),
    });
    this.skipBtn.setScrollFactor(0);
    this.skipBtn.setDepth(100);

    const speeds: Array<{ factor: number; label: string }> = [
      { factor: 0.5, label: '×0.5' }, { factor: 1, label: '×1' }, { factor: 4, label: '×4' },
    ];
    speeds.forEach((s, i) => {
      const btn = new Button(this, {
        x: 290 + i * 130, y: 1210, width: 120, height: 70,
        label: s.label, fontSize: 22, bg: 0x3a414d,
        onClick: () => this.setSpeed(s.factor),
      });
      btn.setScrollFactor(0);
      btn.setDepth(100);
      this.speedButtons.push({ btn, factor: s.factor });
    });
    this.setSpeed(1);
  }

  private setSpeed(factor: number): void {
    this.speedFactor = factor;
    this.tweens.timeScale = factor;
    this.time.timeScale = factor;
    for (const sb of this.speedButtons) {
      sb.btn.setBg(sb.factor === factor ? 0x2e7d32 : 0x3a414d);
    }
  }

  // ============================== Result modal ==================================

  private skipBattle(): void {
    // Skip: проматываем runtime до конца (через ускорение цикла).
    // Простое: tweens.timeScale большой → быстро. Но за это время tickBattle может
    // не успеть обработать всё. Делаем по-другому: продолжаем симулировать в `tickBattle`
    // но с большим dt, до завершения всех лайн.
    if (this.resultShown) return;
    if (!this.level) return;
    // «Виртуальные» большие тики до полного завершения (cap на безопасность).
    const MAX_ITERATIONS = 10000;
    let iter = 0;
    while (iter < MAX_ITERATIONS) {
      iter++;
      const now = this.time.now + iter * 50;
      for (const lane of this.laneRuntimes) {
        this.moveLaneZombies(lane, 50, now);
      }
      for (const lane of this.laneRuntimes) {
        this.tickLane(lane, 50, now);
      }
      const allDone = this.laneRuntimes.every(l => l.state === 'at_chest' || l.state === 'finished');
      if (allDone) break;
    }
    this.showResult(true);
  }

  private assembleResult(): BattleResult {
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

  private showResult(_skipped = false): void {
    if (this.resultShown) return;
    this.resultShown = true;
    this.mode = 'showing_result';
    this.tweens.timeScale = 1;
    this.time.timeScale = 1;

    const result = this.assembleResult();
    const state = getState();
    applyBattleResult(state, result);
    save();

    const cx = DESIGN_WIDTH / 2;
    const cy = DESIGN_HEIGHT / 2;

    const dim = this.add.rectangle(cx, cy, DESIGN_WIDTH, DESIGN_HEIGHT, 0x000000, 0.7)
      .setOrigin(0.5).setScrollFactor(0).setDepth(150);
    const panel = this.add.rectangle(cx, cy, 560, 460, 0x12151b)
      .setOrigin(0.5).setStrokeStyle(2, 0x3a414d).setScrollFactor(0).setDepth(151);

    const title = result.passed ? 'УРОВЕНЬ ПРОЙДЕН' : 'УРОВЕНЬ НЕ ПРОЙДЕН';
    const titleColor = result.passed ? '#9fe870' : '#ff8a8a';
    const titleText = this.add.text(cx, cy - 170, title, {
      fontFamily: 'monospace', fontSize: '32px', color: titleColor,
    }).setOrigin(0.5).setScrollFactor(0).setDepth(152);

    const reached = result.lanes.filter((l) => l.reachedChest).length;
    const lbMid = result.totalLootboxes.filter((k) => k === 'medium').length;
    const lbElite = result.totalLootboxes.filter((k) => k === 'elite').length;
    const lbLine = lbMid + lbElite > 0 ? `Лутбоксы: ${lbMid} ср. / ${lbElite} кр.` : 'Лутбоксы: —';
    const lines = [
      `Дошло бойцов: ${reached} / ${result.lanes.length}`,
      `Металлолом: +${result.totalScrap}`,
      `Оружие: +${result.totalWeapons.length}`,
      lbLine,
    ];
    const linesText = this.add.text(cx, cy - 40, lines.join('\n'), {
      fontFamily: 'monospace', fontSize: '26px', color: '#dddddd', align: 'center', lineSpacing: 12,
    }).setOrigin(0.5).setScrollFactor(0).setDepth(152);

    const back = new Button(this, {
      x: cx, y: cy + 150, width: 360, height: 80, label: 'НА БАЗУ', fontSize: 30,
      onClick: () => this.returnToBase(),
    });
    back.setScrollFactor(0);
    back.setDepth(152);
    this.resultNodes.push(dim, panel, titleText, linesText, back.container);
  }

  private returnToBase(): void {
    for (const n of this.resultNodes) n.destroy();
    this.resultNodes = [];

    if (this.skipBtn) { this.skipBtn.destroy(); this.skipBtn = null; }
    for (const sb of this.speedButtons) sb.btn.destroy();
    this.speedButtons = [];
    this.speedFactor = 1;
    this.tweens.timeScale = 1;
    this.time.timeScale = 1;

    this.mode = 'base';
    this.resultShown = false;
    this.allLanesFinishedAt = 0;
    this.level = null;
    this.laneRuntimes = [];
    this.mainUI.setBottomVisible(true);
    this.gradientTop?.setVisible(true);
    this.gradientBot?.setVisible(true);
    this.refreshButtons();

    // Камера обратно к базе; battleNodes уничтожаем в onComplete (чтобы не было
    // «дыр» в локации пока камера скроллит).
    this.tweens.add({
      targets: this.cameras.main, scrollY: 0, duration: 600, ease: 'Sine.InOut',
      onComplete: () => {
        for (const n of this.battleNodes) n.destroy();
        this.battleNodes = [];
      },
    });

    // Закрыть ворота + тени.
    for (const id of ['base.gate_l', 'base.gate_l_shd', 'base.gate_r', 'base.gate_r_shd']) {
      const obj = this.baseLocation?.byId.get(id);
      if (!obj) continue;
      const def = obj.getData('defaultX');
      if (typeof def === 'number') {
        this.tweens.add({ targets: obj, x: def, duration: 600, ease: 'Sine.InOut' });
      }
    }
    // Параллельно гасим лампы (fade-out 600ms — синхронно с закрытием ворот).
    this.fadeLampsOff();

    // Восстановить мердж-плитки.
    this.board.relayout(getState().field);
    this.inv.rebuild();
    this.hud.refresh();

    // Бойцы persistent — tween назад к idle (или пересоздать под новый cols).
    const prevFighterCount = this.fighters.length;
    const newCols = getState().field.cols;
    if (prevFighterCount !== newCols) {
      this.ensureFightersExist();
    } else {
      for (let li = 0; li < this.fighters.length; li++) {
        const f = this.fighters[li];
        if (!f) continue;
        this.tweens.killTweensOf(f);
        f.setScale(1);
        const targetX = (li + 0.5) * (DESIGN_WIDTH / newCols);
        this.tweens.add({
          targets: f, x: targetX, y: FIGHTER_IDLE_Y, duration: 600, ease: 'Sine.InOut',
        });
        this.resetFighterVisualToIdle(li);
      }
    }
  }

  // ============================== Base art / Road / Gradients ===================

  private buildGradients(): void {
    const make = (key: string, w: number, h: number, flipped: boolean): void => {
      if (this.textures.exists(key)) return;
      const tex = this.textures.createCanvas(key, w, h);
      if (!tex) return;
      const ctx = tex.getContext();
      const [y0, y1] = flipped ? [0, h] : [h, 0];
      const grd = ctx.createLinearGradient(0, y0, 0, y1);
      grd.addColorStop(0, 'rgba(0,0,0,0.5)');
      grd.addColorStop(0.5, 'rgba(0,0,0,0.5)');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, w, h);
      tex.refresh();
    };
    make('grad-top', DESIGN_WIDTH, 215, true);
    make('grad-bot', DESIGN_WIDTH, 222, false);
    const top = this.add.image(0, 0, 'grad-top').setOrigin(0, 0).setScrollFactor(0).setDepth(250);
    const bot = this.add.image(0, 1058, 'grad-bot').setOrigin(0, 0).setScrollFactor(0).setDepth(99);
    this.gradientTop = top;
    this.gradientBot = bot;
  }

  private buildBaseArt(): void {
    const json = this.cache.json.get('base-layout');
    if (!json) return;
    const manifest = parseLocation(json);
    this.baseManifest = manifest;
    if (manifest.layers.length === 0) return;
    this.baseLocation = buildLocation(
      this,
      manifest,
      { originX: 0, originY: -2524, scale: 1, baseDepth: -50, texturePrefix: 'base' },
      loadOverrides(),
    );
    // Изначально ворота закрыты → лампы выключены (alpha 0). При открытии ворот в
    // playOpeningSequence запускаем мигание; при закрытии в returnToBase — гасим.
    for (const lamp of this.getLamps()) lamp.setAlpha(0);
  }

  // ============================== Lamp blink ====================================

  /** Спрайты светящихся ламп из base-локации (l + r, в любом порядке). */
  private getLamps(): Phaser.GameObjects.Image[] {
    const out: Phaser.GameObjects.Image[] = [];
    const l = this.baseLocation?.byId.get('base.lamp_l');
    const r = this.baseLocation?.byId.get('base.lamp_r');
    if (l) out.push(l);
    if (r) out.push(r);
    return out;
  }

  /** Запустить мигание ламп: fade-in alpha→1 за время открытия ворот, затем yoyo 1↔0.5. */
  private startLampBlink(): void {
    this.stopLampTweens();
    const lamps = this.getLamps();
    if (lamps.length === 0) return;
    const fadeIn = this.tweens.add({
      targets: lamps,
      alpha: 1,
      duration: 600,
      ease: 'Sine.Out',
      onComplete: () => {
        const blink = this.tweens.add({
          targets: lamps,
          alpha: 0.5,
          duration: 700,
          ease: 'Sine.InOut',
          yoyo: true,
          repeat: -1,
        });
        this.lampTweens.push(blink);
      },
    });
    this.lampTweens.push(fadeIn);
  }

  /** Погасить лампы (ворота закрылись): fade-out alpha→0 синхронно со схлопыванием ворот. */
  private fadeLampsOff(): void {
    this.stopLampTweens();
    const lamps = this.getLamps();
    if (lamps.length === 0) return;
    this.tweens.add({
      targets: lamps,
      alpha: 0,
      duration: 600,
      ease: 'Sine.InOut',
    });
  }

  /** Остановить все активные tweens на лампах (не трогает alpha — это делают вызывающие). */
  private stopLampTweens(): void {
    for (const t of this.lampTweens) t.stop();
    this.lampTweens = [];
    for (const lamp of this.getLamps()) this.tweens.killTweensOf(lamp);
  }

  private buildRoadStripe(bottomY: number, topY: number, intoBattle: boolean): number {
    const tilesetKey = 'base.road_l1';
    if (!this.textures.exists(tilesetKey) || bottomY <= topY) return bottomY;
    const tileset = this.baseManifest ? findTileset(this.baseManifest, 'road_l1') : null;
    const sourceW = tileset?.width ?? 463;
    const sourceH = tileset?.height ?? 314;
    const aspect = sourceH / sourceW;
    const tileW = DESIGN_WIDTH / 2;
    const tileH = tileW * aspect;
    const stepY = tileH - 1;
    const overshoot = stepY * 0.6;
    const totalH = bottomY - topY + overshoot;
    const tileCount = Math.max(1, Math.ceil(totalH / stepY));
    const leftCx = DESIGN_WIDTH / 4;
    const rightCx = (3 * DESIGN_WIDTH) / 4;
    const container = this.baseRoadContainer;
    const dx = container?.x ?? 0;
    const dy = container?.y ?? 0;
    let topReached = bottomY;
    for (let i = 0; i < tileCount; i++) {
      const cy = bottomY - tileH / 2 - i * stepY;
      const left = this.add.image(leftCx - dx, cy - dy, tilesetKey).setOrigin(0.5).setDisplaySize(tileW, tileH);
      const right = this.add.image(rightCx - dx, cy - dy, tilesetKey).setOrigin(0.5).setDisplaySize(tileW, tileH).setFlipX(true);
      if (container) container.add([left, right]);
      else { left.setDepth(-49.5); right.setDepth(-49.5); }
      if (intoBattle) this.battleNodes.push(left, right);
      topReached = cy - tileH / 2;
    }
    return topReached;
  }

  private buildBaseRoad(): void {
    this.baseRoadContainer = this.add.container(0, 0).setDepth(-49.5);
    this.baseRoadTopY = this.buildRoadStripe(GATE_Y, 0, false);
  }

  private buildRoadTiles(): void {
    const baseTopWorld = this.baseRoadTopY + (this.baseRoadContainer?.y ?? 0);
    const targetTop = this.worldTopY - 200;
    if (targetTop < baseTopWorld) {
      this.buildRoadStripe(baseTopWorld + 1, targetTop, true);
    }
  }

  // ============================== Base UI =======================================

  private buildBaseUI(): void {
    const s = getState();

    this.board = new MergeBoard(
      this,
      s.field,
      { x: 135, y: 555, w: 449, h: 449 },
      {
        onChange: () => {
          if (this.mode !== 'base') return;
          save();
          this.hud.refresh();
          this.mainUI?.refresh();
          this.inv?.rebuild();
        },
        onMerge: () => {
          if (this.mode !== 'base') return;
          update((st) => st.stats.merges++);
        },
        onOpenLootbox: (cellIndex, kind) => {
          if (this.mode !== 'base') return false;
          return this.openLootbox(cellIndex, kind);
        },
        onTrash: (cellIndex) => {
          if (this.mode !== 'base') return false;
          return this.trashWeapon(cellIndex);
        },
        onLayoutChanged: (outer) => this.drawMergeGround(outer),
      },
    );

    if (this.textures.exists('ui.inv_place')) {
      const img = this.add.image(18 + 50, 889 + 62, 'ui.inv_place').setOrigin(0.5).setDisplaySize(100, 125).setDepth(0);
      this.invPlaceArt = img;
      this.add.text(68, 987, 'ИНВЕНТАРЬ', {
        fontFamily: 'Roboto, Arial Black, sans-serif', fontStyle: '900', fontSize: '14px', color: '#331D10',
      }).setOrigin(0.5).setDepth(1);
    }
    if (this.textures.exists('ui.trash_place')) {
      const img = this.add.image(601 + 49, 901 + 56, 'ui.trash_place').setOrigin(0.5).setDisplaySize(98, 113).setDepth(0);
      this.trashPlaceArt = img;
      this.add.text(650, 988, 'МУСОР', {
        fontFamily: 'Roboto, Arial Black, sans-serif', fontStyle: '900', fontSize: '14px', color: '#D9D9D9',
      }).setOrigin(0.5).setDepth(1);
    }
    const invCx = 18 + 9 + 41;
    const invCy = 889 + 0 + 41;
    const invSize = 82;
    this.inv = new InventoryBar(this, invCx, invCy, invSize, () => {
      if (this.mode !== 'base') return;
      this.pullItem();
    });
    const trashCx = 601 + 8 + 41;
    const trashCy = 901 - 6 + 41;
    const trashSize = 82;
    this.buildTrashItem(trashCx, trashCy, trashSize);

    this.mainUI = new MainScreenUI(this, {
      onProduce: () => { if (this.mode === 'base') this.produce(); },
      onBattle: () => { if (this.mode === 'base') this.goBattle(); },
      onSettings: () => this.toast('Настройки — пока не реализовано'),
      onProfile: () => this.toast('Профиль — пока не реализовано'),
      onUpgrade: () => this.toast('Апгрейд — пока не реализовано'),
      onCards: () => this.toast('Карты — пока не реализовано'),
      onShop: () => this.toast('Магазин — пока не реализовано'),
    });
    this.hud.setOnSettings(() => this.toast('Настройки — пока не реализовано'));
  }

  private drawMergeGround(outer: BoardRect): void {
    if (!this.mergeGroundGfx) {
      this.mergeGroundGfx = this.add.graphics().setDepth(0);
    }
    const g = this.mergeGroundGfx;
    g.clear();
    const { x, y, w, h } = outer;
    const r = 22;
    const thickness = 10;
    g.fillStyle(0x000000, 0.25);
    g.fillRoundedRect(x, y + 4, w, h + thickness, r);
    g.fillStyle(0x927761, 1);
    g.fillRoundedRect(x, y, w, h + thickness, r);
    g.fillStyle(0xdfbb97, 1);
    g.fillRoundedRect(x, y, w, h, r);
    g.lineStyle(3, 0x482c1c, 1);
    g.strokeRoundedRect(x, y, w, h + thickness, r);
  }

  private buildTrashItem(cx: number, cy: number, size: number): void {
    if (this.trashContainer) {
      this.trashContainer.destroy();
      this.trashContainer = null;
    }
    const bg = this.add.rectangle(0, 0, size, size, 0x000000, 0).setOrigin(0.5);
    this.trashContainer = this.add.container(cx, cy, [bg]).setSize(size, size);
    this.trashSize = size;
    this.trashRect = { x: cx - size / 2, y: cy - size / 2, w: size, h: size };
    this.board.setTrashZone(this.trashRect);
  }

  // ============================== Idle fighters =================================

  private ensureFightersExist(): void {
    const cols = getState().field.cols;
    const laneWidth = DESIGN_WIDTH / cols;
    const tokenSize = Math.min(laneWidth * 0.42, 44);
    if (this.fighters.length !== cols) {
      for (const f of this.fighters) f?.destroy();
      this.fighters = [];
      this.fighterTierTexts = [];
      this.fighterHitsTexts = [];
      this.fighterRings = [];
      this.fighterWeaponIcons = [];
      for (let li = 0; li < cols; li++) {
        this.createIdleFighter(li, laneWidth, tokenSize);
      }
      return;
    }
    for (let li = 0; li < cols; li++) {
      const f = this.fighters[li];
      if (!f) continue;
      f.x = (li + 0.5) * laneWidth;
      f.y = FIGHTER_IDLE_Y;
      f.setScale(1);
      this.resetFighterVisualToIdle(li);
    }
  }

  private createIdleFighter(li: number, laneWidth: number, tokenSize: number): void {
    const x = (li + 0.5) * laneWidth;
    const ringColor = 0x55606e;
    const circle = this.add.circle(0, 0, tokenSize * 0.6, 0x66ccff).setStrokeStyle(3, ringColor, 1);
    const tierLabel = this.add.text(-tokenSize * 0.5, tokenSize * 0.5, '', {
      fontFamily: 'Roboto, Arial Black, sans-serif', fontStyle: '900', fontSize: '13px', color: '#ffffff',
    }).setOrigin(0.5);
    tierLabel.setStroke('#000000', 3);
    // Иконка оружия — сверху над бойцом. Использует 'weapon.t1' как placeholder (точно
    // загружен Boot'ом). Texture/visible меняется в updateFighterWeaponVisual.
    const initialKey = this.textures.exists('weapon.t1') ? 'weapon.t1' : '__DEFAULT';
    const weaponIcon = this.add.image(0, -tokenSize * 0.95, initialKey)
      .setOrigin(0.5).setVisible(false);
    const hitsLabel = this.add.text(0, tokenSize * 0.7 + 4, '', {
      fontFamily: 'monospace', fontSize: '12px', color: '#ffffff',
    }).setOrigin(0.5);
    hitsLabel.setStroke('#000000', 3);
    const fighter = this.add
      .container(x, FIGHTER_IDLE_Y, [circle, weaponIcon, tierLabel, hitsLabel])
      .setDepth(5);
    this.fighters[li] = fighter;
    this.fighterTierTexts[li] = tierLabel;
    this.fighterHitsTexts[li] = hitsLabel;
    this.fighterRings[li] = circle;
    this.fighterWeaponIcons[li] = weaponIcon;
  }

  private resetFighterVisualToIdle(li: number): void {
    this.fighterTierTexts[li]?.setText('');
    this.fighterHitsTexts[li]?.setText('');
    this.fighterRings[li]?.setStrokeStyle(3, 0x55606e, 1);
    this.fighterWeaponIcons[li]?.setVisible(false);
  }

  private syncTrashRect(): void {
    const c = this.trashContainer;
    const r = this.trashRect;
    if (!c || !r) return;
    const w = this.trashSize;
    if (r.x !== c.x - w / 2 || r.y !== c.y - w / 2) {
      r.x = c.x - w / 2;
      r.y = c.y - w / 2;
      r.w = w;
      r.h = w;
    }
  }

  // ============================== Base actions ==================================

  private produce(): void {
    const s = getState();
    const cost = produceCost(s.workshopTier);
    if (!canAfford(s.scrap, cost)) {
      this.toast('Не хватает лома');
      return;
    }
    if (isFull(s.field)) {
      this.toast('Поле заполнено');
      return;
    }
    update((st) => {
      st.scrap -= cost;
      placeFirstFree(st.field, st.workshopTier);
    });
    this.board.rebuildTiles();
    this.hud.refresh();
    this.refreshButtons();
  }

  private pullItem(): void {
    const s = getState();
    if (s.inventory.length === 0) return;
    if (pullFromInventory(s.field, s.inventory)) {
      save();
      this.board.rebuildTiles();
      this.inv.rebuild();
      this.refreshButtons();
    } else {
      this.toast('Поле заполнено');
    }
  }

  private openLootbox(cellIndex: number, kind: LootboxKind): boolean {
    const s = getState();
    const tier = rollLootboxTier(kind, s.workshopTier, bestWeaponTier(s), this.lootRng);
    update((st) => {
      st.field.cells[cellIndex] = tier;
    });
    this.toast(`Открыт ${kind === 'elite' ? 'крутой' : 'средний'} лутбокс: T${tier} ${weaponName(tier)}`);
    return true;
  }

  private trashWeapon(cellIndex: number): boolean {
    const s = getState();
    const v = s.field.cells[cellIndex];
    if (!isWeaponCellValue(v)) return false;
    const refund = Math.round(produceCost(v) * getBalance().trash.refundRatio);
    update((st) => {
      st.field.cells[cellIndex] = null;
      st.scrap += refund;
    });
    this.toast(`Удалено T${v}: +${refund} лома`);
    this.hud.refresh();
    return true;
  }

  private refreshButtons(): void {
    if (!this.mainUI) return;
    this.mainUI.refresh();
    this.mainUI.setFightEnabled(this.mode === 'base');
  }

  // ============================== Misc ==========================================

  private popText(x: number, y: number, msg: string, color: string): void {
    const t = this.add.text(x, y, msg, { fontFamily: 'monospace', fontSize: '20px', color })
      .setOrigin(0.5).setDepth(50);
    this.tweens.add({ targets: t, y: y - 40, alpha: 0, duration: 700, onComplete: () => t.destroy() });
  }

  private toast(msg: string): void {
    const t = this.add.text(DESIGN_WIDTH / 2, 1230, msg, {
      fontFamily: 'monospace', fontSize: '20px', color: '#ffd27f',
      backgroundColor: '#000000aa', padding: { x: 12, y: 7 },
    }).setOrigin(0.5).setScrollFactor(0).setDepth(1000);
    this.tweens.add({
      targets: t, alpha: 0, y: 1195, duration: 1500, delay: 800, onComplete: () => t.destroy(),
    });
  }
}
