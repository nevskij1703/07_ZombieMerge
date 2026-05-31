// «Мировая» сцена: одна на всё (база + бой). Боевая логика — REALTIME per-lane tick
// в `BattleTickEngine` (`world/battleTick.ts`); WorldScene — только ОРКЕСТРАТОР
// (lifecycle + base UI + переходы base↔battle + модалка результата).
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
//   • 'battle'         — реалтайм симуляция: BattleTickEngine.tick каждый кадр.
//   • 'showing_result' — модалка результата.
//
// Структура файла:
//   • Lifecycle (create / update / updateCameraFollow)
//   • Battle orchestration (goBattle / playOpeningSequence / spawnAndDispatchFighters
//     / startBattle / buildSpeedHud / setSpeed / skipBattle)
//   • Result modal (showResult / returnToBase)
//   • Base UI (buildBaseUI / drawMergeGround / buildTrashItem)
//   • Base actions (produce / pullItem / openLootbox / trashWeapon / refreshButtons)
//   • Misc (syncTrashRect / toast)

import Phaser from 'phaser';
import { SceneKey } from './sceneKeys';
import { DESIGN_WIDTH, DESIGN_HEIGHT, NEW_BADGE_MIN_TIER } from '../config/constants';
import type { LootboxKind } from '../types';
import { getState, save, update } from '../core/storage';
import { applyBattleResult, laneArsenals, bestWeaponTier, levelPassBonus } from '../core/progression';
import { generateLevel } from '../core/levelGen';
import { produceCost, canAfford } from '../core/economy';
import { weaponName } from '../core/weapons';
import { placeFirstFree, isFull, pullFromInventory } from '../core/merge';
import { isWeaponCellValue, rollLootboxTier } from '../core/lootbox';
import { getBalance } from '../core/balanceRuntime';
import { makeRng } from '../core/rng';
import { Hud } from '../ui/hud';
import { MergeBoard, type BoardRect } from '../ui/mergeBoard';
import { InventoryBar } from '../ui/inventoryBar';
import { Button } from '../ui/button';
import { MainScreenUI } from '../ui/mainScreen';
import { LayoutEditor } from '../editor/layoutEditor';
import type { SceneMode } from './world/types';
import {
  GATE_Y, FIGHTER_PICKUP_Y, CHEST_GAP, CAMERA_TOP_BUFFER, FIGHTER_VIEW_OFFSET,
  WORLD_TOP_BOUND, WORLD_BOTTOM_BOUND, obstacleY,
} from './world/constants';
import { BaseArtController } from './world/baseArt';
import { FightersController } from './world/fighters';
import { BattleTickEngine } from './world/battleTick';

// ============================ Scene =============================================

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
  layoutEditor: LayoutEditor | null = null;
  private lootRng: () => number = () => Math.random();

  // === Extracted controllers (see src/scenes/world/) ===
  private baseArt!: BaseArtController;
  private fightersCtl!: FightersController;
  private battle!: BattleTickEngine;

  // === Scene-level battle state (not in BattleTickEngine because UI/HUD) ===
  private mode: SceneMode = 'base';
  private resultNodes: Phaser.GameObjects.GameObject[] = [];
  private speedButtons: Array<{ btn: Button; factor: number }> = [];
  private skipBtn: Button | null = null;
  private speedFactor = 1;

  constructor() {
    super(SceneKey.World);
  }

  // ============================== Lifecycle ====================================

  create(): void {
    this.mode = 'base';
    this.lootRng = makeRng(Date.now() & 0x7fffffff);

    // 1) Base art (gradients + tiles + road + lamps).
    this.baseArt = new BaseArtController(this);
    this.baseArt.build();

    // 2) Layout editor (DEV only).
    if (import.meta.env.DEV) {
      this.layoutEditor = new LayoutEditor(this);
      for (const [id, img] of this.baseArt.entries()) {
        this.layoutEditor.register(id, img, id.replace(/^base\./, ''));
      }
      if (this.baseArt.baseRoadContainer) {
        this.layoutEditor.register(
          'base.road',
          this.baseArt.baseRoadContainer as unknown as Phaser.GameObjects.Container,
          'Base / Дорога',
        );
      }
    }

    // 3) HUD + base UI.
    this.hud = new Hud(this);
    this.buildBaseUI();

    // 4) Fighters controller (persistent across battles).
    this.fightersCtl = new FightersController(this);
    this.fightersCtl.ensureExists();

    // 5) Battle tick engine (per-battle reset via resetForBattle).
    this.battle = new BattleTickEngine({
      scene: this,
      fighters: this.fightersCtl,
      hud: this.hud,
      onResultReady: () => this.showResult(),
    });

    // 6) DEV layout editor: register UI elements (after HUD + mainUI built).
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
        const scaledDelta = safeDelta * this.speedFactor;
        const SUB_STEP_MS = 16;
        const steps = Math.max(1, Math.ceil(scaledDelta / SUB_STEP_MS));
        const subDt = scaledDelta / steps;
        for (let i = 0; i < steps; i++) {
          this.battle.tick(subDt, this.time.now);
        }
      } catch (e) {
        console.error('[battle] tick failed', e);
      }
    }
  }

  /** Камера тянется к самой высокой точке лидера и НЕ возвращается вниз во время боя. */
  private updateCameraFollow(): void {
    const fighters = this.fightersCtl.fighters;
    if (fighters.length === 0) return;
    let leadY = Infinity;
    for (const f of fighters) {
      if (!f) continue;
      if (f.y < leadY) leadY = f.y;
    }
    if (!isFinite(leadY)) return;
    const target = Math.max(this.battle.worldTopY, leadY - FIGHTER_VIEW_OFFSET);
    const cam = this.cameras.main;
    if (target < cam.scrollY) {
      cam.scrollY = Phaser.Math.Linear(cam.scrollY, target, 0.12);
    }
  }

  // ============================== Battle orchestration =========================

  private goBattle(): void {
    const s = getState();
    const hasWeapon = s.field.cells.some((c) => isWeaponCellValue(c));
    if (!hasWeapon) {
      this.toast('Сначала собери оружие');
      return;
    }

    this.mode = 'transition';
    this.speedFactor = 1;
    this.tweens.timeScale = 1;
    this.time.timeScale = 1;

    this.fightersCtl.ensureExists();

    // Пометить все weapon-тиры с поля (≥ NEW_BADGE_MIN_TIER) как «битые». После
    // возврата на базу `MergeBoard` пере-проверит battledTiers и снимет
    // «NEW!»-ярлыки с этих тиров. См. core/storage.ts → battledTiers + mergeBoard.ts.
    update((st) => {
      const seen = new Set<number>(st.battledTiers);
      for (const v of st.field.cells) {
        if (isWeaponCellValue(v) && v >= NEW_BADGE_MIN_TIER) seen.add(v);
      }
      st.battledTiers = Array.from(seen).sort((a, b) => a - b);
    });

    const level = generateLevel(s.level, {
      workshopTier: s.workshopTier,
      bestTier: bestWeaponTier(s),
      rewardMultiplier: s.rewardMultiplier,
      // Если поле было расширено раньше уровня (pendingFieldUpgrade), генерируем
      // нужное число линий — иначе arsenals.length (= field.cols) разойдётся с
      // level.lanes.length и часть бойцов останется без дороги.
      fieldColsOverride: s.field.cols,
    });
    const arsenals = laneArsenals(s.field);
    const maxObsCount = Math.max(...level.lanes.map((l) => l.obstacles.length), 1);
    const laneWidth = DESIGN_WIDTH / level.cols;
    const chestRowY = obstacleY(maxObsCount - 1) - CHEST_GAP;
    const worldTopY = chestRowY - CAMERA_TOP_BUFFER;

    this.battle.resetForBattle(level, maxObsCount, chestRowY, worldTopY, laneWidth);
    this.baseArt.extendRoadForBattle(worldTopY, this.battle.battleNodes);
    for (let li = 0; li < level.cols; li++) {
      this.battle.buildLaneRuntime(li, arsenals[li] ?? []);
    }

    this.buildSpeedHud();
    this.mainUI.setBottomVisible(false);
    this.baseArt.setGradientsVisible(false);
    // invPlaceArt/trashPlaceArt НЕ скрываем — они часть локации, текст-лейблы на них
    // тоже остаются (scrollFactor=1) и уезжают с камерой во время боя естественно.

    this.baseArt.openGates(() => this.spawnAndDispatchFighters());
  }

  private spawnAndDispatchFighters(): void {
    const cols = this.battle.level!.cols;
    const laneStartY = GATE_Y - 10;

    // Обновить visual бойцов под арсенал (берётся из laneRuntimes).
    for (let li = 0; li < cols; li++) {
      const lane = this.battle.laneRuntimes[li];
      if (lane) this.fightersCtl.renderFighterWeapon(lane);
    }

    let arrived = 0;
    const total = cols;
    for (let li = 0; li < total; li++) {
      const fighter = this.fightersCtl.fighters[li];
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
  }

  private startBattle(): void {
    if (this.battle.resultShown) return;
    this.mode = 'battle';
    // С этого момента tickBattle() в update() начнёт двигать бойцов и зомби.
  }

  // ============================== Speed / skip HUD =============================

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

  private skipBattle(): void {
    const result = this.battle.skip();
    if (result) this.showResult(true);
  }

  // ============================== Result modal =================================

  private showResult(_skipped = false): void {
    if (this.mode === 'showing_result') return;
    this.mode = 'showing_result';
    this.tweens.timeScale = 1;
    this.time.timeScale = 1;

    const result = this.battle.assembleResult();
    const state = getState();
    // Бонус прохождения вычисляется ДО applyBattleResult — там тир может
    // апгрейднуться, а игроку нужно показать сумму по тиру, который он видел.
    const passBonus = result.passed ? levelPassBonus(state.workshopTier) : 0;
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
    const lbCheap = result.totalLootboxes.filter((k) => k === 'cheap').length;
    const lbMid = result.totalLootboxes.filter((k) => k === 'medium').length;
    const lbElite = result.totalLootboxes.filter((k) => k === 'elite').length;
    const lbTotal = lbCheap + lbMid + lbElite;
    const lbLine = lbTotal > 0
      ? `Лутбоксы: ${lbCheap} деш. / ${lbMid} ср. / ${lbElite} кр.`
      : 'Лутбоксы: —';
    const lines = [
      `Дошло бойцов: ${reached} / ${result.lanes.length}`,
      `Металлолом: +${result.totalScrap}`,
      `Оружие: +${result.totalWeapons.length}`,
      lbLine,
    ];
    if (passBonus > 0) lines.push(`Бонус прохождения: +${passBonus}`);
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
    this.battle.level = null;
    this.battle.laneRuntimes = [];
    this.mainUI.setBottomVisible(true);
    this.baseArt.setGradientsVisible(true);
    this.refreshButtons();

    // Камера обратно к базе; battleNodes уничтожаем в onComplete (чтобы не было
    // «дыр» в локации пока камера скроллит).
    this.tweens.add({
      targets: this.cameras.main, scrollY: 0, duration: 600, ease: 'Sine.InOut',
      onComplete: () => {
        for (const n of this.battle.battleNodes) n.destroy();
        this.battle.battleNodes = [];
      },
    });

    // Закрыть ворота + погасить лампы.
    this.baseArt.closeGates();

    // Восстановить мердж-плитки.
    this.board.relayout(getState().field);
    this.inv.rebuild();
    this.hud.refresh();

    // Бойцы persistent — tween назад к idle (или пересоздать под новый cols).
    const prevFighterCount = this.fightersCtl.fighters.length;
    const newCols = getState().field.cols;
    if (prevFighterCount !== newCols) {
      this.fightersCtl.ensureExists();
    } else {
      this.fightersCtl.tweenAllToIdle(newCols);
    }
  }

  // ============================== Base UI ======================================

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
      // MVP stubs: UI кнопки есть, фичи отложены до пост-MVP.
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

  // ============================== Base actions =================================

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
    const lbName = kind === 'elite' ? 'крутой' : kind === 'medium' ? 'средний' : 'дешманский';
    this.toast(`Открыт ${lbName} лутбокс: T${tier} ${weaponName(tier)}`);
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

  // ============================== Misc =========================================

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
