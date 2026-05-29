// «Мировая» сцена: одна на всё (база + бой). Battle — это режим внутри неё, а не отдельная
// Phaser-сцена. Камера скроллится между базой (внизу) и дорогой к сундукам (вверху).
//
// Геометрия (мировые Y):
//   • Y=0..1280 — «base view», то что видно по умолчанию (scrollY=0): город-баннер,
//     ворота на Y=GATE_Y, забор, мердж-поле, инвентарь, кнопки, HUD.
//   • Ворота на Y=GATE_Y=440 (бывшая линия забора). Делятся пополам и разъезжаются в
//     стороны при старте боя.
//   • Дорога — НАД воротами, в отрицательных Y. Препятствия расставлены с КОНСТАНТНЫМ
//     шагом ZOMBIE_SPACING. Сундуки — на едином Y по самой длинной линии уровня.
//   • Камера: scrollY ≤ 0 (вверх в негативный Y). Никогда не скроллится ниже базы во
//     время боя. После боя — snap обратно к Y=0.
//
// Modes:
//   • 'base'        — интерактив базы (мердж/произвести/трэш/инвентарь/в бой).
//   • 'transition'  — ворота открываются, бойцы спавнятся над мердж-полем, берут оружие,
//                     бегут вверх к стартам линий.
//   • 'battle'      — lunge-плейбэк по линиям. Камера следит за лидером.
//   • 'returning'   — отступившие бойцы уходят вниз за экран, лидер у сундука или умер.
//   • 'showing_result' — модалка результата. На «НА БАЗУ» — teardown, mode='base'.

import Phaser from 'phaser';
import { SceneKey } from './sceneKeys';
import { DESIGN_WIDTH, DESIGN_HEIGHT, COLORS, TIER_COLORS } from '../config/constants';
import type { Level, BattleResult, LaneStep, LootboxKind, WeaponTier } from '../types';
import { getState, save, update } from '../core/storage';
import { simulateBattle } from '../core/battleSim';
import { applyBattleResult, laneArsenals, bestWeaponTier } from '../core/progression';
import { generateLevel } from '../core/levelGen';
import { produceCost, canAfford } from '../core/economy';
import { weaponName, getWeapon } from '../core/weapons';
import { placeFirstFree, isFull, pullFromInventory } from '../core/merge';
import { isWeaponCellValue, rollLootboxTier } from '../core/lootbox';
import { getBalance } from '../core/balanceRuntime';
import { makeRng } from '../core/rng';
import { Hud } from '../ui/hud';
import { MergeBoard } from '../ui/mergeBoard';
import { InventoryBar } from '../ui/inventoryBar';
import { Button } from '../ui/button';

// ============================ Layout constants =================================

const GATE_Y = 440;          // ворота — общая граница базы и города
const GATE_BUFFER = 50;      // зазор между воротами и первым препятствием
const ZOMBIE_SPACING = 64;   // КОНСТАНТНЫЙ шаг между препятствиями (≈ размер токена)
const CHEST_GAP = 64;        // зазор между самым дальним препятствием и сундуком
const CAMERA_TOP_BUFFER = 140; // запас над сундуком — чтоб камера показала чуть выше

// Камера. scrollY относительно мира (top-left viewport). 0 = база, отрицательные — дорога.
const WORLD_TOP_BOUND = -3500;
const WORLD_BOTTOM_BOUND = DESIGN_HEIGHT + 600;
const FIGHTER_VIEW_OFFSET = DESIGN_HEIGHT * 0.45; // как высоко в кадре стоит лидер
const OFF_SCREEN_BELOW_Y = DESIGN_HEIGHT + 200;  // куда уходят отступающие бойцы

// ============================ Color palette ====================================

const ZOMBIE_TIER_COLORS: number[] = [
  0x333333, 0x6b8e23, 0x7d931e, 0x90981e, 0xa68f1e, 0xb6851e,
  0xc77b1e, 0xbe6a1e, 0xb55a1e, 0xab4a1e, 0xa53a22, 0xa02e22, 0x9b2222,
];
function zombieColor(tier: number): number {
  return ZOMBIE_TIER_COLORS[Math.max(1, Math.min(12, tier))] ?? ZOMBIE_TIER_COLORS[1];
}

// ============================ Lunge model types ================================

interface StopTarget {
  kind: 'target';
  step: LaneStep;
  hpBefore: number;
  hpAfter: number;
  killed: boolean;
}
interface StopScrap { kind: 'scrap'; step: LaneStep; }
type LungeStop = StopTarget | StopScrap;

interface LungeEvent {
  kind: 'lunge';
  stops: LungeStop[];
  retreat: boolean;
  fullRetreat?: boolean;
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

// ============================ Scene ============================================

type SceneMode = 'base' | 'transition' | 'battle' | 'returning' | 'showing_result';

export class BaseScene extends Phaser.Scene {
  // === Base UI references ===
  private hud!: Hud;
  private board!: MergeBoard;
  private inv!: InventoryBar;
  private produceBtn!: Button;
  private battleBtn!: Button;
  private trashRect: { x: number; y: number; w: number; h: number } | null = null;
  private lootRng: () => number = () => Math.random();

  // === Battle state ===
  private mode: SceneMode = 'base';
  private level: Level | null = null;
  private result: BattleResult | null = null;
  private fighters: Phaser.GameObjects.Container[] = [];
  private fighterTierTexts: Phaser.GameObjects.Text[] = [];
  private fighterHitsTexts: Phaser.GameObjects.Text[] = [];
  private fighterRings: Phaser.GameObjects.Arc[] = [];
  private chestTokens: Phaser.GameObjects.Rectangle[] = [];
  private obTokens: (Phaser.GameObjects.GameObject | null)[][] = [];
  private obBars: (Phaser.GameObjects.Rectangle | null)[][] = [];
  private obBarBgs: (Phaser.GameObjects.Rectangle | null)[][] = [];
  private obHpTexts: (Phaser.GameObjects.Text | null)[][] = [];
  private gateHalves: Phaser.GameObjects.Rectangle[] = [];
  private battleNodes: Phaser.GameObjects.GameObject[] = []; // teardown list
  private lanesDone = 0;
  private resultShown = false;
  private resultNodes: Phaser.GameObjects.GameObject[] = [];
  private speedButtons: Array<{ btn: Button; factor: number }> = [];
  private skipBtn: Button | null = null;
  private speedFactor = 1;

  // === World layout (per battle) ===
  private chestRowY = 0;
  private worldTopY = -200;
  private laneWidth = 0;
  private maxObsCount = 0;

  // === Tween/timing ===
  private readonly MOVE = 440;
  private readonly CHEST_PAUSE = 840;
  private readonly PIXEL_TIME = 2.4;
  private readonly MIN_WALK = 220;

  constructor() {
    super(SceneKey.Base);
  }

  // ============================== Lifecycle ====================================

  create(): void {
    this.mode = 'base';
    this.lootRng = makeRng(Date.now() & 0x7fffffff);

    const cx = DESIGN_WIDTH / 2;

    // === Фон (бесконечно вверх для города/дороги) ===
    // Большой прямоугольник города уходит далеко в негативный Y.
    this.add.rectangle(cx, -1500, DESIGN_WIDTH, 4000, COLORS.city).setOrigin(0.5).setDepth(-10);
    // Забор у ворот.
    this.add.rectangle(cx, GATE_Y, DESIGN_WIDTH, 16, COLORS.fence).setOrigin(0.5).setDepth(-9);
    // База ниже ворот.
    this.add.rectangle(cx, 855, DESIGN_WIDTH, 850, COLORS.base).setOrigin(0.5).setDepth(-9);
    this.add
      .text(cx, 250, 'ГОРОД', { fontFamily: 'monospace', fontSize: '22px', color: '#5c7a5c' })
      .setOrigin(0.5)
      .setDepth(-8);

    // === HUD/база ===
    this.hud = new Hud(this);
    this.buildBaseUI();

    // === Camera ===
    // setBounds разрешает скроллить от WORLD_TOP_BOUND до WORLD_BOTTOM_BOUND-DESIGN_HEIGHT.
    this.cameras.main.setBounds(0, WORLD_TOP_BOUND, DESIGN_WIDTH, -WORLD_TOP_BOUND + WORLD_BOTTOM_BOUND);
    this.cameras.main.setScroll(0, 0);

    this.refreshButtons();
  }

  update(): void {
    if (this.mode !== 'battle' && this.mode !== 'transition' && this.mode !== 'returning') return;
    this.updateCameraFollow();
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
    // Скроллим ВВЕРХ (target < scrollY); если target ВЫШЕ текущей позиции — не двигаемся
    // (фиксируемся на самом высоком достигнутом).
    if (target < cam.scrollY) {
      cam.scrollY = Phaser.Math.Linear(cam.scrollY, target, 0.12);
    }
  }

  // ============================== Base UI ======================================

  private buildBaseUI(): void {
    const cx = DESIGN_WIDTH / 2;
    const s = getState();

    // Trash drop-zone.
    const trashW = 110, trashH = 74;
    const trashX = DESIGN_WIDTH - 20 - trashW;
    const trashY = 885;
    this.trashRect = { x: trashX, y: trashY, w: trashW, h: trashH };
    this.add
      .rectangle(trashX + trashW / 2, trashY + trashH / 2, trashW, trashH, 0x4a2020)
      .setOrigin(0.5)
      .setStrokeStyle(2, 0xb23b3b, 0.8);
    this.add
      .text(trashX + trashW / 2, trashY + trashH / 2 - 10, '🗑 ТРЭШ', {
        fontFamily: 'monospace', fontSize: '18px', color: '#ffb0b0',
      })
      .setOrigin(0.5);
    this.add
      .text(trashX + trashW / 2, trashY + trashH / 2 + 18, '50% лома', {
        fontFamily: 'monospace', fontSize: '11px', color: '#ffd0d0',
      })
      .setOrigin(0.5);

    // Merge board.
    this.board = new MergeBoard(
      this,
      s.field,
      { x: 40, y: 465, w: DESIGN_WIDTH - 80, h: 410 },
      {
        onChange: () => {
          if (this.mode !== 'base') return;
          save();
          this.hud.refresh();
          this.refreshButtons();
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
      },
    );
    this.board.setTrashZone(this.trashRect);

    // Inventory bar.
    this.inv = new InventoryBar(
      this,
      { x: 20, y: 885, w: trashX - 20 - 10, h: 74 },
      (i) => {
        if (this.mode !== 'base') return;
        this.pullItem(i);
      },
    );

    // Produce button.
    this.produceBtn = new Button(this, {
      x: cx, y: 1010, width: 470, height: 78, label: '', fontSize: 26,
      onClick: () => {
        if (this.mode !== 'base') return;
        this.produce();
      },
    });

    // Battle button.
    this.battleBtn = new Button(this, {
      x: cx, y: 1112, width: 470, height: 78, label: 'В БОЙ', fontSize: 30, bg: 0xb23b3b,
      onClick: () => {
        if (this.mode !== 'base') return;
        this.goBattle();
      },
    });
  }

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

  private pullItem(index: number): void {
    const s = getState();
    if (pullFromInventory(s.field, s.inventory, index)) {
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
    const s = getState();
    const cost = produceCost(s.workshopTier);
    this.produceBtn.setLabel(`Произвести: ${weaponName(s.workshopTier)} (${cost})`);
    this.produceBtn.setEnabled(this.mode === 'base' && canAfford(s.scrap, cost) && !isFull(s.field));
    this.battleBtn.setEnabled(this.mode === 'base');
  }

  // ============================== goBattle =====================================

  private goBattle(): void {
    const s = getState();
    const hasWeapon = s.field.cells.some((c) => isWeaponCellValue(c));
    if (!hasWeapon) {
      this.toast('Сначала собери оружие');
      return;
    }

    this.mode = 'transition';
    this.lanesDone = 0;
    this.resultShown = false;
    this.speedFactor = 1;
    this.fighters = [];
    this.fighterTierTexts = [];
    this.fighterHitsTexts = [];
    this.fighterRings = [];
    this.chestTokens = [];
    this.obTokens = [];
    this.obBars = [];
    this.obBarBgs = [];
    this.obHpTexts = [];
    this.gateHalves = [];
    this.battleNodes = [];

    const level = generateLevel(s.level, {
      workshopTier: s.workshopTier,
      bestTier: bestWeaponTier(s),
    });
    const arsenals = laneArsenals(s.field);
    const result = simulateBattle(level, arsenals, { workshopTier: s.workshopTier });
    this.level = level;
    this.result = result;
    this.maxObsCount = Math.max(...level.lanes.map((l) => l.obstacles.length), 1);

    this.buildRoad();
    this.buildSpeedHud();
    this.produceBtn.setEnabled(false);
    this.battleBtn.setEnabled(false);

    // Анимация старта: ворота открываются → бойцы спавнятся над мердж-полем → берут
    // оружие (мердж-поле «гаснет») → бегут вверх через ворота к началу своих линий.
    this.playOpeningSequence(arsenals);
  }

  private buildRoad(): void {
    const cols = this.level!.cols;
    this.laneWidth = DESIGN_WIDTH / cols;

    // Y сундука — на топ самой длинной линии. Все сундуки в уровне на одной высоте.
    this.chestRowY = this.obstacleY(this.maxObsCount - 1) - CHEST_GAP;
    this.worldTopY = this.chestRowY - CAMERA_TOP_BUFFER;

    for (let li = 0; li < cols; li++) {
      const x = this.colCenterX(li);

      // Вертикальная дорожка.
      const lineTopY = this.chestRowY;
      const lineBotY = GATE_Y;
      const line = this.add
        .rectangle(x, (lineTopY + lineBotY) / 2, 6, lineBotY - lineTopY, 0x2a3a2a)
        .setOrigin(0.5)
        .setDepth(-5);
      this.battleNodes.push(line);

      // Сундук на топе.
      const chest = this.add
        .rectangle(x, this.chestRowY, 54, 40, 0xd4af37)
        .setOrigin(0.5)
        .setStrokeStyle(3, 0x000000, 0.4);
      this.chestTokens[li] = chest;
      this.battleNodes.push(chest);

      // Препятствия — снизу вверх (idx=0 ближе к воротам).
      const obstacles = this.level!.lanes[li].obstacles;
      const tokens: (Phaser.GameObjects.GameObject | null)[] = new Array(obstacles.length).fill(null);
      const bars: (Phaser.GameObjects.Rectangle | null)[] = new Array(obstacles.length).fill(null);
      const barBgs: (Phaser.GameObjects.Rectangle | null)[] = new Array(obstacles.length).fill(null);
      const hpTexts: (Phaser.GameObjects.Text | null)[] = new Array(obstacles.length).fill(null);

      const tokenSize = Math.min(this.laneWidth * 0.42, 44);
      const barW = Math.min(tokenSize * 1.4, 60);
      const barH = 4;

      for (let i = 0; i < obstacles.length; i++) {
        const ob = obstacles[i];
        const y = this.obstacleY(i);
        let token: Phaser.GameObjects.GameObject;
        if (ob.kind === 'zombie') {
          token = this.add
            .circle(x, y, tokenSize / 2, zombieColor(ob.zombieTier ?? 1))
            .setStrokeStyle(2, 0x000000, 0.4);
        } else if (ob.kind === 'crate') {
          token = this.add
            .rectangle(x, y, tokenSize, tokenSize, 0x8b5a2b)
            .setStrokeStyle(2, 0x000000, 0.4);
        } else {
          token = this.add.circle(x, y, tokenSize / 4, 0x9aa0a6);
        }
        tokens[i] = token;
        this.battleNodes.push(token);
        if (ob.kind === 'zombie' || ob.kind === 'crate') {
          const barY = y - tokenSize / 2 - 9;
          const barX = x - barW / 2;
          const bg = this.add.rectangle(barX, barY, barW, barH, 0x333333).setOrigin(0, 0.5);
          const bar = this.add.rectangle(barX, barY, barW, barH, 0xee3333).setOrigin(0, 0.5);
          bar.setData('maxHp', ob.hp);
          const txt = this.add
            .text(x, barY - 4, String(ob.hp), { fontFamily: 'monospace', fontSize: '10px', color: '#ffcccc' })
            .setOrigin(0.5, 1);
          barBgs[i] = bg;
          bars[i] = bar;
          hpTexts[i] = txt;
          this.battleNodes.push(bg, bar, txt);
        }
      }
      this.obTokens[li] = tokens;
      this.obBars[li] = bars;
      this.obBarBgs[li] = barBgs;
      this.obHpTexts[li] = hpTexts;
    }

    // Ворота — две половинки, закрыты на старте, разъезжаются по бокам.
    const halfW = DESIGN_WIDTH / 2;
    const leftHalf = this.add
      .rectangle(halfW / 2, GATE_Y, halfW - 4, 30, 0x6b4a2a)
      .setOrigin(0.5)
      .setStrokeStyle(3, 0x000000, 0.7);
    const rightHalf = this.add
      .rectangle(DESIGN_WIDTH - halfW / 2, GATE_Y, halfW - 4, 30, 0x6b4a2a)
      .setOrigin(0.5)
      .setStrokeStyle(3, 0x000000, 0.7);
    this.gateHalves = [leftHalf, rightHalf];
    this.battleNodes.push(leftHalf, rightHalf);
  }

  /** Y координата препятствия с индексом idx (0 — ближайшее к воротам). */
  private obstacleY(idx: number): number {
    return GATE_Y - GATE_BUFFER - (idx + 0.5) * ZOMBIE_SPACING;
  }

  private colCenterX(li: number): number {
    return (li + 0.5) * this.laneWidth;
  }

  // === Speed/skip HUD (screen-space, scrollFactor=0) ===

  private buildSpeedHud(): void {
    // СКИП — нижний-левый угол.
    this.skipBtn = new Button(this, {
      x: 110, y: 1210, width: 180, height: 70, label: 'СКИП', fontSize: 24, bg: 0x555a66,
      onClick: () => this.skipBattle(),
    });
    this.skipBtn.container.setScrollFactor(0).setDepth(100);

    const speeds: Array<{ factor: number; label: string }> = [
      { factor: 0.25, label: '×0.25' }, { factor: 1, label: '×1' }, { factor: 4, label: '×4' },
    ];
    speeds.forEach((s, i) => {
      const btn = new Button(this, {
        x: 290 + i * 130, y: 1210, width: 120, height: 70,
        label: s.label, fontSize: 22, bg: 0x3a414d,
        onClick: () => this.setSpeed(s.factor),
      });
      btn.container.setScrollFactor(0).setDepth(100);
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

  // ============================== Opening sequence =============================

  private playOpeningSequence(arsenals: number[][]): void {
    const halfW = DESIGN_WIDTH / 2;
    // 1) Ворота разъезжаются.
    this.tweens.add({
      targets: this.gateHalves[0],
      x: -halfW / 2 + 10,
      duration: 600,
      ease: 'Sine.Out',
    });
    this.tweens.add({
      targets: this.gateHalves[1],
      x: DESIGN_WIDTH + halfW / 2 - 10,
      duration: 600,
      ease: 'Sine.Out',
      onComplete: () => {
        // 2) Спавн бойцов над мердж-полем + бег к старту линии (через ворота).
        this.spawnAndDispatchFighters(arsenals);
      },
    });
  }

  private spawnAndDispatchFighters(arsenals: number[][]): void {
    const cols = this.level!.cols;
    const tokenSize = Math.min(this.laneWidth * 0.42, 44);
    // Стартовая позиция бойцов — НАД мердж-полем (мердж-поле y=465..875, бойцы выше).
    const spawnY = 540;

    for (let li = 0; li < cols; li++) {
      const x = this.colCenterX(li);
      const arsenal = arsenals[li] ?? [];
      const bestTier = arsenal.length ? Math.max(...arsenal) : 0;
      const startHits = bestTier ? getWeapon(bestTier).hits : 0;
      const ringColor = bestTier ? TIER_COLORS[bestTier] ?? 0x66ccff : 0x55606e;

      const circle = this.add
        .circle(0, 0, tokenSize * 0.6, 0x66ccff)
        .setStrokeStyle(3, ringColor, 1);
      const tierLabel = this.add
        .text(0, -2, bestTier ? String(bestTier) : '—', {
          fontFamily: 'monospace', fontSize: '20px', color: '#06121f',
        })
        .setOrigin(0.5);
      const hitsLabel = this.add
        .text(0, tokenSize * 0.7 + 4, bestTier ? String(startHits) : '', {
          fontFamily: 'monospace', fontSize: '12px', color: '#ffffff',
        })
        .setOrigin(0.5);
      hitsLabel.setStroke('#000000', 3);

      // Спавн чуть выше мердж-поля колонки.
      const fighter = this.add.container(x, spawnY, [circle, tierLabel, hitsLabel]).setDepth(5);
      // Появление: масштаб 0 → 1.
      fighter.setScale(0);
      this.tweens.add({ targets: fighter, scale: 1, duration: 250, ease: 'Back.Out' });

      this.fighters[li] = fighter;
      this.fighterTierTexts[li] = tierLabel;
      this.fighterHitsTexts[li] = hitsLabel;
      this.fighterRings[li] = circle;
      this.battleNodes.push(fighter);
    }

    // Визуально «забираем» оружие — мердж-плитки тускнеют.
    this.dimMergeBoard(true);

    // Бойцы бегут вверх через ворота к началу своей линии (чуть выше ворот).
    this.time.delayedCall(450, () => {
      let arrived = 0;
      const total = cols;
      const laneStartY = GATE_Y - 10; // прямо у ворот, сразу за их линией
      for (let li = 0; li < total; li++) {
        const fighter = this.fighters[li];
        this.tweens.add({
          targets: fighter,
          y: laneStartY,
          duration: 700,
          ease: 'Quad.Out',
          onComplete: () => {
            arrived++;
            if (arrived === total) {
              this.mode = 'battle';
              for (let li = 0; li < total; li++) this.playLane(li);
            }
          },
        });
      }
    });
  }

  // Полупрозрачный оверлей над мердж-полем — визуальное «оружие забрано» на время боя.
  private mergeOverlay: Phaser.GameObjects.Rectangle | null = null;

  private dimMergeBoard(dim: boolean): void {
    if (dim) {
      if (this.mergeOverlay) return;
      this.mergeOverlay = this.add
        .rectangle(DESIGN_WIDTH / 2, 670, DESIGN_WIDTH - 80, 410, 0x000000, 0.55)
        .setOrigin(0.5)
        .setDepth(20)
        .setScrollFactor(1); // в мировом пространстве (двигается с камерой)
      const lbl = this.add
        .text(DESIGN_WIDTH / 2, 670, '⚔  В БОЮ  ⚔', {
          fontFamily: 'monospace', fontSize: '24px', color: '#ffd27f',
        })
        .setOrigin(0.5)
        .setDepth(21);
      this.mergeOverlay.setData('label', lbl);
    } else {
      if (this.mergeOverlay) {
        const lbl = this.mergeOverlay.getData('label') as Phaser.GameObjects.Text | undefined;
        lbl?.destroy();
        this.mergeOverlay.destroy();
        this.mergeOverlay = null;
      }
    }
  }

  // ============================== Battle playback ==============================

  private playLane(li: number): void {
    const events = this.buildLaneEvents(this.result!.lanes[li].steps);
    this.runEvents(li, events, 0);
  }

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
          kind: 'chest', step,
          scrapEnRoute: pendingScrap.splice(0),
          weaponTierAfter: step.weaponTierAfter,
          weaponHitsAfter: step.weaponHitsAfter,
        });
        i++;
        continue;
      }

      const carryIn = step.carryIn ?? 0;
      const hits = step.hitsSpent;
      const hpStart = step.hpStart ?? 0;
      const hpAfter = step.hpAfter ?? 0;
      const killed = hpAfter <= 0;

      if (hits === 0) {
        if (carryIn > 0) {
          i++;
          continue;
        }
        events.push({
          kind: 'stuck', step,
          scrapEnRoute: pendingScrap.splice(0),
          weaponTierAfter: step.weaponTierAfter,
          weaponHitsAfter: step.weaponHitsAfter,
        });
        i++;
        break;
      }

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
          kind: 'target', step,
          hpBefore: Math.round(currentHp), hpAfter: newHp, killed: false,
        });
        events.push({ kind: 'lunge', stops, retreat: true });
        currentHp = newHp;
      }

      if (!killed) {
        events.push({
          kind: 'stuck', step,
          scrapEnRoute: pendingScrap.splice(0),
          weaponTierAfter: step.weaponTierAfter,
          weaponHitsAfter: step.weaponHitsAfter,
        });
        i++;
        break;
      }

      const stops: LungeStop[] = [];
      if (pendingScrap.length > 0) stops.push(...pendingScrap.splice(0));
      stops.push({
        kind: 'target', step,
        hpBefore: Math.round(currentHp), hpAfter: 0, killed: true,
      });

      let j = i + 1;
      let chainRetreat = false;
      while (j < steps.length) {
        const nxt = steps[j];
        if (nxt.kind === 'scrap') {
          stops.push({ kind: 'scrap', step: nxt });
          j++; continue;
        }
        if (nxt.kind === 'chest') break;
        const carryInNxt = nxt.carryIn ?? 0;
        if (carryInNxt === 0) break;
        const hitsNxt = nxt.hitsSpent;
        const hpStartNxt = nxt.hpStart ?? 0;
        const hpAfterNxt = nxt.hpAfter ?? 0;
        const killedByCarry = hitsNxt === 0 && hpAfterNxt === 0;
        if (killedByCarry) {
          stops.push({ kind: 'target', step: nxt, hpBefore: hpStartNxt, hpAfter: 0, killed: true });
          j++; continue;
        }
        stops.push({
          kind: 'target', step: nxt, hpBefore: hpStartNxt,
          hpAfter: hpStartNxt - carryInNxt, killed: false,
        });
        chainRetreat = true;
        if (hitsNxt > 0) break;
        j++; break;
      }

      events.push({
        kind: 'lunge', stops, retreat: chainRetreat,
        weaponTierAfter: step.weaponTierAfter,
        weaponHitsAfter: step.weaponHitsAfter,
      });
      i = j;
    }

    // Если линия закончилась рывком с retreat=true и больше событий нет — полный возврат.
    const last = events[events.length - 1];
    if (last && last.kind === 'lunge' && last.retreat) last.fullRetreat = true;

    return events;
  }

  private runEvents(li: number, events: LaneEvent[], idx: number): void {
    if (this.resultShown) return;
    if (idx >= events.length) {
      this.finishLane(li);
      return;
    }
    const ev = events[idx];
    const next = (): void => this.runEvents(li, events, idx + 1);
    switch (ev.kind) {
      case 'lunge': this.playLunge(li, ev, next); break;
      case 'chest': this.playChest(li, ev, next); break;
      case 'stuck': this.playStuck(li, ev, next); break;
    }
  }

  private finishLane(_li: number): void {
    this.lanesDone += 1;
    if (this.lanesDone >= this.level!.cols) this.showResult();
  }

  private walkTime(distance: number): number {
    return Math.max(this.MIN_WALK, distance * this.PIXEL_TIME);
  }

  // === Lunge: один рывок ===

  private playLunge(li: number, ev: LungeEvent, onDone: () => void): void {
    if (this.resultShown) { onDone(); return; }
    const fighter = this.fighters[li];
    const stops = ev.stops;
    if (stops.length === 0) { onDone(); return; }

    const startY = fighter.y;
    const endY = this.obstacleY(stops[stops.length - 1].step.index);
    const distance = Math.abs(startY - endY);
    const walk = this.walkTime(distance);
    const span = Math.max(1, distance);

    this.tweens.add({ targets: fighter, scaleX: 1.12, yoyo: true, duration: 80 });

    this.tweens.add({
      targets: fighter,
      y: endY,
      duration: walk,
      onComplete: () => {
        if (this.resultShown) return;
        if (ev.weaponTierAfter !== undefined) {
          this.updateFighterWeapon(li, ev.weaponTierAfter, ev.weaponHitsAfter);
        }
        if (ev.fullRetreat) {
          this.returnFighterOffscreen(li, onDone);
        } else if (ev.retreat) {
          // Короткий откат «полшажка назад» (визуально упёрся).
          const back = this.backstepDistance();
          const backY = fighter.y + back;
          const dist = Math.abs(backY - fighter.y);
          this.tweens.add({
            targets: fighter, y: backY,
            duration: Math.max(130, dist * this.PIXEL_TIME),
            onComplete: onDone,
          });
        } else {
          onDone();
        }
      },
    });

    // Мгновенные эффекты по пути.
    for (const stop of stops) {
      const stopY = this.obstacleY(stop.step.index);
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
      this.tweens.add({ targets: token, alpha: 0.55, yoyo: true, duration: 90 });
    }

    if (t.killed && token) {
      this.tweens.add({
        targets: token,
        alpha: 0, scale: 0.2, duration: 160, delay: 60,
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
    if (this.resultShown) { onDone(); return; }
    const fighter = this.fighters[li];
    const chestY = this.chestRowY + 46; // упереться чуть выше сундука
    const startY = fighter.y;
    const distance = Math.abs(startY - chestY);
    const walk = this.walkTime(distance);
    const span = Math.max(1, distance);

    this.tweens.add({
      targets: fighter, y: chestY, duration: walk,
      onComplete: () => {
        if (this.resultShown) return;
        this.openChest(li);
        this.popText(fighter.x, this.chestRowY, 'СУНДУК', '#ffd700');
        if (ev.weaponTierAfter !== undefined) {
          this.updateFighterWeapon(li, ev.weaponTierAfter, ev.weaponHitsAfter);
        }
        this.time.delayedCall(this.CHEST_PAUSE, () => {
          if (this.resultShown) return;
          this.returnFighterOffscreen(li, onDone);
        });
      },
    });
    for (const s of ev.scrapEnRoute) {
      const sY = this.obstacleY(s.step.index);
      const t = (Math.abs(sY - startY) / span) * walk;
      this.time.delayedCall(t, () => {
        if (this.resultShown) return;
        this.popText(fighter.x, sY, `+${s.step.scrap}`, '#9fe870');
      });
    }
  }

  private playStuck(li: number, ev: StuckEvent, onDone: () => void): void {
    if (this.resultShown) { onDone(); return; }
    const fighter = this.fighters[li];
    const stuckY = this.obstacleY(ev.step.index);
    const startY = fighter.y;
    const distance = Math.abs(startY - stuckY);
    const walk = this.walkTime(distance);
    const span = Math.max(1, distance);

    this.tweens.add({
      targets: fighter, y: stuckY, duration: walk,
      onComplete: () => {
        if (this.resultShown) return;
        this.popText(fighter.x, stuckY, 'отступ', '#ff8a8a');
        if (ev.weaponTierAfter !== undefined) {
          this.updateFighterWeapon(li, ev.weaponTierAfter, ev.weaponHitsAfter);
        }
        this.returnFighterOffscreen(li, onDone);
      },
    });
    for (const s of ev.scrapEnRoute) {
      const sY = this.obstacleY(s.step.index);
      const t = (Math.abs(sY - startY) / span) * walk;
      this.time.delayedCall(t, () => {
        if (this.resultShown) return;
        this.popText(fighter.x, sY, `+${s.step.scrap}`, '#9fe870');
      });
    }
  }

  /** Возвращающийся боец уходит ВНИЗ ЗА ЭКРАН (за нижний край viewport) → onDone. */
  private returnFighterOffscreen(li: number, cb: () => void): void {
    if (this.resultShown) { cb(); return; }
    if (this.mode === 'battle') this.mode = 'returning';
    const fighter = this.fighters[li];
    // OFF_SCREEN_BELOW_Y — за границей нижнего края камеры. Камера у сундука, бойцу далеко идти.
    const targetY = Math.max(OFF_SCREEN_BELOW_Y, fighter.y + 400);
    const dist = Math.abs(targetY - fighter.y);
    this.tweens.add({
      targets: fighter, y: targetY,
      duration: Math.max(this.MOVE, dist * 1.0),
      onComplete: cb,
    });
  }

  private backstepDistance(): number {
    return Math.min(36, ZOMBIE_SPACING * 0.5);
  }

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

  // ============================== Result modal =================================

  private skipBattle(): void {
    this.showResult(true);
  }

  private showResult(skipped = false): void {
    if (this.resultShown) return;
    this.resultShown = true;
    this.mode = 'showing_result';

    this.tweens.timeScale = 1;
    this.time.timeScale = 1;
    if (skipped) {
      // Skip: глушим всё, мгновенно показываем модалку.
      this.tweens.killAll();
      this.time.removeAllEvents();
      // Снепим бойцов в безопасное место (за низ экрана), чтобы не висели в воздухе.
      for (const f of this.fighters) if (f) f.y = OFF_SCREEN_BELOW_Y;
    }

    // Применяем результат к сейву (один раз).
    const state = getState();
    applyBattleResult(state, this.result!);
    save();

    // Камера фиксируется в текущем положении (где была).
    const cx = DESIGN_WIDTH / 2;
    const cy = DESIGN_HEIGHT / 2;

    const dim = this.add
      .rectangle(cx, cy, DESIGN_WIDTH, DESIGN_HEIGHT, 0x000000, 0.7)
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(150);
    const panel = this.add
      .rectangle(cx, cy, 560, 460, 0x12151b)
      .setOrigin(0.5)
      .setStrokeStyle(2, 0x3a414d)
      .setScrollFactor(0)
      .setDepth(151);

    const r = this.result!;
    const title = r.passed ? 'УРОВЕНЬ ПРОЙДЕН' : 'УРОВЕНЬ НЕ ПРОЙДЕН';
    const titleColor = r.passed ? '#9fe870' : '#ff8a8a';
    const titleText = this.add
      .text(cx, cy - 170, title, { fontFamily: 'monospace', fontSize: '32px', color: titleColor })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(152);

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
    const linesText = this.add
      .text(cx, cy - 40, lines.join('\n'), {
        fontFamily: 'monospace', fontSize: '26px', color: '#dddddd', align: 'center', lineSpacing: 12,
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(152);

    const back = new Button(this, {
      x: cx, y: cy + 150, width: 360, height: 80, label: 'НА БАЗУ', fontSize: 30,
      onClick: () => this.returnToBase(),
    });
    back.container.setScrollFactor(0).setDepth(152);

    this.resultNodes.push(dim, panel, titleText, linesText, back.container);
  }

  private returnToBase(): void {
    // 1) Скрыть модалку.
    for (const n of this.resultNodes) n.destroy();
    this.resultNodes = [];

    // 2) Tear down road (все battleNodes).
    for (const n of this.battleNodes) n.destroy();
    this.battleNodes = [];
    this.fighters = [];
    this.fighterTierTexts = [];
    this.fighterHitsTexts = [];
    this.fighterRings = [];
    this.chestTokens = [];
    this.obTokens = [];
    this.obBars = [];
    this.obBarBgs = [];
    this.obHpTexts = [];
    this.gateHalves = [];

    // 3) Убрать speed/skip HUD.
    if (this.skipBtn) { this.skipBtn.destroy(); this.skipBtn = null; }
    for (const sb of this.speedButtons) sb.btn.destroy();
    this.speedButtons = [];
    this.speedFactor = 1;
    this.tweens.timeScale = 1;
    this.time.timeScale = 1;

    // 4) Камера обратно к базе.
    this.tweens.add({
      targets: this.cameras.main,
      scrollY: 0,
      duration: 600,
      ease: 'Sine.InOut',
      onUpdate: () => { /* ensure cam refresh */ },
    });

    // 5) Восстановить мердж-плитки (state мог измениться — лутбоксы).
    this.board.relayout(getState().field);
    this.inv.rebuild();
    this.hud.refresh();
    this.dimMergeBoard(false);

    // 6) Mode = base.
    this.mode = 'base';
    this.resultShown = false;
    this.lanesDone = 0;
    this.level = null;
    this.result = null;
    this.refreshButtons();
  }

  // ============================== Misc =========================================

  private toast(msg: string): void {
    const t = this.add
      .text(DESIGN_WIDTH / 2, 1230, msg, {
        fontFamily: 'monospace', fontSize: '20px', color: '#ffd27f',
        backgroundColor: '#000000aa', padding: { x: 12, y: 7 },
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(1000);
    this.tweens.add({
      targets: t, alpha: 0, y: 1195,
      duration: 1500, delay: 800,
      onComplete: () => t.destroy(),
    });
  }
}
