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
import { MergeBoard, type BoardRect } from '../ui/mergeBoard';
import { InventoryBar } from '../ui/inventoryBar';
import { Button } from '../ui/button';
import { MainScreenUI } from '../ui/mainScreen';
import { parseLocation, buildLocation, findTileset, type BuiltLocation, type LocationManifest } from '../art/locationLoader';
import { loadOverrides } from '../editor/layoutOverrides';
import { LayoutEditor } from '../editor/layoutEditor';

// ============================ Layout constants =================================

const GATE_Y = 440;          // ворота — общая граница базы и города
// Дистанция от ворот до ПЕРВОГО зомби в линии. Должна быть достаточно большой, чтобы
// первый зомби находился ЗА ПРЕДЕЛАМИ видимой зоны базы (Y < 0 при scrollY=0).
// При GATE_Y=440 и FIRST_ZOMBIE_OFFSET=500 → первый зомби на Y = -60 (вне экрана).
// Эффект: «зомби были там всегда» — они появляются в кадре только когда камера едет
// вверх во время боя, а на базе их не видно.
const FIRST_ZOMBIE_OFFSET = 500;
const ZOMBIE_SPACING = 64;   // КОНСТАНТНЫЙ шаг между препятствиями (≈ размер токена)
const CHEST_GAP = 64;        // зазор между самым дальним препятствием и сундуком

// =========================== [EXP: zombie-movement] ============================
// Экспериментальная фича: зомби идут к бойцу. Главный switch — если ставить
// `ZOMBIE_MOVEMENT_ENABLED = false`, поведение полностью возвращается к статичным
// зомби (все ссылки на флаг защищены `if`). Маркер `EXP: zombie-movement` в
// комментариях помогает найти все связанные места grep'ом для отката.
//
// Правила движения:
//   • Зомби активируется когда попадает в видимую зону камеры (scrollY..+H).
//   • Стоит на месте если на его линии нет бойца.
//   • По своей линии (X не меняется).
//   • Не проходит сквозь других зомби/коробки (collision по center distance ≥ size).
//     Лом (scrap) проходимый — не блокирует.
//   • Скорость = ZOMBIE_SPEED_RATIO × скорости бойца.
//   • После каждого удара по зомби — stun на ZOMBIE_STUN_MS (= ~backstep duration).
//   • Никогда не идёт ниже ворот (hard limit = GATE_Y − tokenSize/2).
const ZOMBIE_MOVEMENT_ENABLED = true;
const ZOMBIE_SPEED_RATIO = 0.25;
const ZOMBIE_STUN_MS = 180;
const ZOMBIE_STOP_MARGIN = 6; // зазор перед бойцом/другим зомби, чтобы не «врастали»

// Камера. scrollY относительно мира (top-left viewport). 0 = база, отрицательные — дорога.
const WORLD_TOP_BOUND = -3500;
const WORLD_BOTTOM_BOUND = DESIGN_HEIGHT + 600;
// Лидер у сундука должен стоять на верхней 1/3 экрана (= «линия 2/3 экрана» сверху).
// Это «как высоко в кадре стоит лидер» — большее значение = ниже на экране.
const FIGHTER_VIEW_OFFSET = DESIGN_HEIGHT / 3;
// Запас «неба» над сундуком, чтобы камера могла уехать достаточно высоко и держать
// лидера на FIGHTER_VIEW_OFFSET (а не упереться в верхнюю границу). Формула:
// worldTopY = chestRowY - CAMERA_TOP_BUFFER должна быть ≤ требуемого scrollY у сундука
// (chestRowY + 46 − FIGHTER_VIEW_OFFSET), т.е. CAMERA_TOP_BUFFER ≥ FIGHTER_VIEW_OFFSET − 46.
const CAMERA_TOP_BUFFER = FIGHTER_VIEW_OFFSET - 46 + 60; // +60 «свободного неба» сверху
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
  private battleBgGround: Phaser.GameObjects.Image | null = null;
  /** Graphics для merge-ground (фон мердж-поля). Перерисовывается при relayout — bg
   *  адаптируется под форму field (для не-квадратных 2×3 / 3×4 / 4×5). */
  private mergeGroundGfx: Phaser.GameObjects.Graphics | null = null;
  private gradientTop: Phaser.GameObjects.Image | null = null;
  private gradientBot: Phaser.GameObjects.Image | null = null;
  private baseLocation: BuiltLocation | null = null;
  private baseManifest: LocationManifest | null = null;
  /** Верхняя Y-граница «постоянной» дороги (в координатах baseRoadContainer'а).
   *  Battle road extension продолжает её ВЫШЕ до worldTopY (+ запас). */
  private baseRoadTopY = 0;
  /** Контейнер всех road tiles (base + battle extension). Зарегистрирован в LayoutEditor,
   *  чтобы пользователь мог двигать дорогу как одно целое (стартовая позиция). */
  private baseRoadContainer: Phaser.GameObjects.Container | null = null;
  layoutEditor: LayoutEditor | null = null;
  private lootRng: () => number = () => Math.random();

  // === Battle state ===
  private mode: SceneMode = 'base';
  private level: Level | null = null;
  private result: BattleResult | null = null;
  private fighters: Phaser.GameObjects.Container[] = [];
  private fighterTierTexts: Phaser.GameObjects.Text[] = [];
  private fighterHitsTexts: Phaser.GameObjects.Text[] = [];
  /** Кэш текущего показанного тира/ресурса для каждого бойца — для пошагового decrement
   *  на каждом target stop (один kill = один hit, обновляется СИНХРОННО с applyHpSnap).
   *  В конце lunge'а sync'имся с авторитетным `ev.weaponTierAfter` (переключение оружия). */
  private fighterTierShown: number[] = [];
  private fighterHitsRemaining: number[] = [];
  private fighterRings: Phaser.GameObjects.Arc[] = [];
  private chestTokens: Phaser.GameObjects.Container[] = [];
  private obTokens: (Phaser.GameObjects.GameObject | null)[][] = [];
  private obBars: (Phaser.GameObjects.Rectangle | null)[][] = [];
  private obBarBgs: (Phaser.GameObjects.Rectangle | null)[][] = [];
  private obHpTexts: (Phaser.GameObjects.Text | null)[][] = [];
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
  /** [EXP: zombie-movement] Размер токена препятствия (диаметр zombie/сторона crate),
   *  кэшируется в buildRoad для использования в `tickZombieMovement` (collision). */
  private obstacleTokenSize = 0;

  // === Tween/timing ===
  private readonly MOVE = 440;
  private readonly CHEST_PAUSE = 840;
  private readonly PIXEL_TIME = 2.4;
  private readonly MIN_WALK = 220;

  constructor() {
    super(SceneKey.World);
  }

  // ============================== Lifecycle ====================================

  create(): void {
    this.mode = 'base';
    this.lootRng = makeRng(Date.now() & 0x7fffffff);

    // === Финальный арт локации Base (если загрузился в Boot) ===
    // Дровные заглушки (city/fence/base prim, лейбл «ГОРОД», коричневые гейты) удалены —
    // теперь рисуется только финальный арт. Если арт не загрузился — экран будет пустым.
    this.buildBaseArt();
    // Постоянная дорога над воротами — видна в base-режиме (Y=0..GATE_Y).
    // Battle road extension позже продолжит её вверх до chestRowY.
    this.buildBaseRoad();
    // Градиенты top/bottom — фигма linear-gradient(0deg, black @ 50%, transparent @ 100%) × 0.5.
    this.buildGradients();
    // === Visual editor (включается из dev-panel'и; в release tree-shake'нется) ===
    // Фаза 1: создаём редактор и регистрируем figma-арт.
    if (import.meta.env.DEV) {
      this.layoutEditor = new LayoutEditor(this);
      if (this.baseLocation) {
        for (const [id, img] of this.baseLocation.byId) {
          this.layoutEditor.register(id, img, id.replace(/^base\./, ''));
        }
      }
      // Дорога — отдельный Container; редактируется как целое (стартовая позиция).
      if (this.baseRoadContainer) {
        this.layoutEditor.register(
          'base.road',
          this.baseRoadContainer as unknown as Phaser.GameObjects.Container,
          'Base / Дорога',
        );
      }
    }

    // === HUD/база ===
    this.hud = new Hud(this);
    this.buildBaseUI();

    // Visual editor — фаза 2: регистрируем UI как отдельные элементы.
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

    // === Camera ===
    // setBounds разрешает скроллить от WORLD_TOP_BOUND до WORLD_BOTTOM_BOUND-DESIGN_HEIGHT.
    this.cameras.main.setBounds(0, WORLD_TOP_BOUND, DESIGN_WIDTH, -WORLD_TOP_BOUND + WORLD_BOTTOM_BOUND);
    this.cameras.main.setScroll(0, 0);

    this.refreshButtons();
  }

  update(_time: number, delta: number): void {
    // Если редактор подвинул trash — обновить hit-area drop-зоны.
    this.syncTrashRect();
    if (this.mode !== 'battle' && this.mode !== 'transition' && this.mode !== 'returning') return;
    this.updateCameraFollow();
    // [EXP: zombie-movement] зомби двигаются только когда бой идёт. В transition их
    // не двигаем (бойцы ещё на базе, fighter[li] на Y=540 — зомби бы пошли в base).
    if (ZOMBIE_MOVEMENT_ENABLED && (this.mode === 'battle' || this.mode === 'returning')) {
      // Защитный try/catch — даже если экспериментальная фича выбросит ошибку,
      // главный update loop не должен ломаться, иначе сцена встанет колом.
      try {
        // Clamp delta: на стыках режимов / при tab-switch delta может быть огромной
        // или NaN. Безопасный диапазон [0, 50] = до 3 кадров при 60fps.
        const safeDelta = Math.min(Math.max(0, delta || 0), 50);
        this.tickZombieMovement(safeDelta);
      } catch (e) {
        console.error('[EXP: zombie-movement] tick failed', e);
      }
    }
  }

  // ============= [EXP: zombie-movement] методы движения зомби ===================

  /** Каждый кадр двигает зомби/коробки вниз (к воротам) с учётом:
   *  видимости в камере, наличия бойца на линии, collision с другими obstacle'ами,
   *  stun после удара. Лом (scrap) не двигается и не блокирует. */
  private tickZombieMovement(dt: number): void {
    if (!this.level) return;
    const cam = this.cameras.main;
    const viewTopY = cam.scrollY;
    const viewBotY = cam.scrollY + DESIGN_HEIGHT;
    const now = this.time.now;
    // Скорость бойца = 1/PIXEL_TIME px/ms. Зомби = доля от неё.
    const speed = (1 / this.PIXEL_TIME) * ZOMBIE_SPEED_RATIO;
    const dy = Math.min(speed * dt, 8); // защитный cap — макс 8px за тик
    const tokenSize = this.obstacleTokenSize || 44;
    // Hard limit: ниже ворот зомби не пойдёт никогда (даже если боец отступил за ворота).
    const gateLimitY = GATE_Y - tokenSize / 2;

    for (let li = 0; li < this.level.lanes.length; li++) {
      const fighter = this.fighters[li];
      if (!fighter) continue; // на этой линии нет бойца — все зомби стоят
      const lineTokens = this.obTokens[li];
      if (!lineTokens) continue;
      const obstacles = this.level.lanes[li].obstacles;

      // upperLimitY — максимально допустимая Y центра следующего (более далёкого) зомби.
      // Стартует от бойца: зомби ближайший к воротам не может пройти бойца, плюс stop margin.
      // Но не ниже ворот.
      let upperLimitY = Math.min(fighter.y - tokenSize - ZOMBIE_STOP_MARGIN, gateLimitY);

      // Идём от idx=0 (ближайший к воротам, наибольший Y) к idx=N-1 (самый дальний, наименьший Y).
      for (let idx = 0; idx < lineTokens.length; idx++) {
        const token = lineTokens[idx];
        if (!token) continue; // убит — slot пустой, не блокирует
        const ob = obstacles[idx];
        if (ob.kind === 'scrap') continue; // лом не двигается, не блокирует
        const tobj = token as Phaser.GameObjects.GameObject & { y: number };
        const currentY = tobj.y;
        // Не в видимой зоне → не двигается, но блокирует следующих (они «толпятся» сверху).
        if (currentY < viewTopY || currentY > viewBotY) {
          upperLimitY = currentY - tokenSize - ZOMBIE_STOP_MARGIN;
          continue;
        }
        // Stunned после удара — стоит, но блокирует следующих.
        const stunUntil = (token.getData('stunnedUntil') as number | undefined) ?? 0;
        if (now < stunUntil) {
          upperLimitY = currentY - tokenSize - ZOMBIE_STOP_MARGIN;
          continue;
        }
        // Двигаемся вниз (Y увеличивается), но не дальше upperLimitY.
        const desiredY = Math.min(currentY + dy, upperLimitY);
        if (desiredY > currentY) {
          this.moveObstacle(li, idx, desiredY - currentY);
          upperLimitY = desiredY - tokenSize - ZOMBIE_STOP_MARGIN;
        } else {
          upperLimitY = currentY - tokenSize - ZOMBIE_STOP_MARGIN;
        }
      }
    }
  }

  /** Сдвинуть все визуальные части препятствия (token + HP bar + bg + text) на dy. */
  private moveObstacle(li: number, idx: number, dy: number): void {
    if (dy === 0) return;
    const token = this.obTokens[li]?.[idx];
    if (token && 'y' in token) {
      (token as Phaser.GameObjects.GameObject & { y: number }).y += dy;
    }
    const bar = this.obBars[li]?.[idx];
    if (bar) bar.y += dy;
    const bg = this.obBarBgs[li]?.[idx];
    if (bg) bg.y += dy;
    const txt = this.obHpTexts[li]?.[idx];
    if (txt) txt.y += dy;
  }

  /** Текущая Y центра препятствия (учитывает движение). Если токена нет — fallback
   *  на статичную позицию `obstacleY(idx)`. */
  private getObstacleCurrentY(li: number, idx: number): number {
    const token = this.obTokens[li]?.[idx];
    if (token && 'y' in token) {
      return (token as Phaser.GameObjects.GameObject & { y: number }).y;
    }
    return this.obstacleY(idx);
  }

  // =================================================================================

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

  /** Тёмные градиенты top/bottom строго по figma `fill_VNRO2G`:
   *   linear-gradient(0deg, rgba(0,0,0,1) 50%, rgba(0,0,0,0) 100%) × opacity 0.5.
   *  0deg в CSS = bottom → top. 0..50% — solid black, 50..100% — fade-out до transparent.
   *  Применено к rect 720×215 (top) и 720×222 (bottom). Реализовано через canvas-textures
   *  Phaser'а: создаём 2 одноразовые текстуры с linear-gradient'ом и кладём как Image. */
  private buildGradients(): void {
    const make = (key: string, w: number, h: number, flipped: boolean): void => {
      if (this.textures.exists(key)) return;
      const tex = this.textures.createCanvas(key, w, h);
      if (!tex) return;
      const ctx = tex.getContext();
      // figma fill_VNRO2G применяется к обоим (top/bot), но визуально direction разная:
      //   • bottom-gradient: тёмное у НИЖНЕГО края экрана, прозрачное к центру (центр игры).
      //   • top-gradient:    тёмное у ВЕРХНЕГО края экрана (под HUD), прозрачное к центру.
      // Для bot: gradient bottom→top, для top: top→bottom (отражено).
      const [y0, y1] = flipped ? [0, h] : [h, 0];
      const grd = ctx.createLinearGradient(0, y0, 0, y1);
      grd.addColorStop(0, 'rgba(0,0,0,0.5)');
      grd.addColorStop(0.5, 'rgba(0,0,0,0.5)');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, w, h);
      tex.refresh();
    };
    make('grad-top', DESIGN_WIDTH, 215, true); // тёмное наверху
    make('grad-bot', DESIGN_WIDTH, 222, false); // тёмное внизу

    // Top: y=0..215. Bottom: y=1058..1280.
    const top = this.add.image(0, 0, 'grad-top').setOrigin(0, 0).setScrollFactor(0).setDepth(250);
    const bot = this.add.image(0, 1058, 'grad-bot').setOrigin(0, 0).setScrollFactor(0).setDepth(99);
    this.gradientTop = top;
    this.gradientBot = bot;
  }

  /** Загружает финальный арт локации Base из cached манифеста + текстур (Boot грузил их).
   *  Origin/scale подобраны так, чтобы Figma-ворота попадали ~на GATE_Y. Финальные значения
   *  подкрутишь в layout-редакторе (dev-panel → Layout). */
  private buildBaseArt(): void {
    const json = this.cache.json.get('base-layout');
    if (!json) return;
    const manifest = parseLocation(json);
    this.baseManifest = manifest;
    if (manifest.layers.length === 0) return;
    // Origin/scale: фрейм Figma 720×3989. Координаты top-left, без масштаба.
    // X: центр кадра базы по X = центр экрана. В Figma layers идут от x≈-104 до x≈725,
    // ширина ≈ 720. Установка originX = 0 → центры layer'ов окажутся в области экрана.
    // Y: ворота figma центр ≈ Y=2964. Хотим Phaser Y ≈ GATE_Y=440. → originY = 440 - 2964 = -2524.
    // Scale = 1 (figma пиксель = phaser пиксель); подкрутится через редактор/overrides.
    this.baseLocation = buildLocation(
      this,
      manifest,
      {
        originX: 0,
        originY: -2524,
        scale: 1,
        baseDepth: -50, // глубоко под всем UI/боем; финальные layers depth -50..-42
        texturePrefix: 'base',
      },
      loadOverrides(),
    );
  }

  /** Собирает вертикальную полосу дороги из тайла `road_l1`. Тайлы укладываются С НАХЛЁСТОМ
   *  в 1px (чтобы не было дробных щелей при масштабировании setDisplaySize). Шаг между
   *  центрами = `tileH − 1`, а сам тайл отрисовывается в полный `tileH` → соседние тайлы
   *  перекрываются на 1px на стыке.
   *  Координаты `bottomY`/`topY` — в WORLD-системе. Tile добавляется в `baseRoadContainer`
   *  (если создан) — там depth = −49.5 (над `base.ground`, под стенами/воротами).
   *  Возвращает WORLD-y верхнего края последнего тайла (для стыковки сегментов). */
  private buildRoadStripe(bottomY: number, topY: number, intoBattle: boolean): number {
    const tilesetKey = 'base.road_l1';
    if (!this.textures.exists(tilesetKey) || bottomY <= topY) return bottomY;
    const tileset = this.baseManifest ? findTileset(this.baseManifest, 'road_l1') : null;
    const sourceW = tileset?.width ?? 463;
    const sourceH = tileset?.height ?? 314;
    const aspect = sourceH / sourceW;
    // 2 тайла (левый+flipX правый) занимают ровно ширину экрана.
    const tileW = DESIGN_WIDTH / 2;
    const tileH = tileW * aspect;
    const stepY = tileH - 1; // нахлёст 1px между соседними тайлами
    const overshoot = stepY * 0.6;
    const totalH = bottomY - topY + overshoot;
    const tileCount = Math.max(1, Math.ceil(totalH / stepY));
    const leftCx = DESIGN_WIDTH / 4;
    const rightCx = (3 * DESIGN_WIDTH) / 4;
    // Если есть container — кладём tile в него (depth наследуется), координаты делаем
    // относительными (мир − container.{x,y}). Иначе fallback — задаём depth каждому tile'у.
    const container = this.baseRoadContainer;
    const dx = container?.x ?? 0;
    const dy = container?.y ?? 0;
    let topReached = bottomY;
    for (let i = 0; i < tileCount; i++) {
      // tile_0 центр на bottomY − tileH/2 (низ тайла строго на bottomY).
      // Шаг между центрами = stepY < tileH → нахлёст.
      const cy = bottomY - tileH / 2 - i * stepY;
      const left = this.add
        .image(leftCx - dx, cy - dy, tilesetKey)
        .setOrigin(0.5)
        .setDisplaySize(tileW, tileH);
      const right = this.add
        .image(rightCx - dx, cy - dy, tilesetKey)
        .setOrigin(0.5)
        .setDisplaySize(tileW, tileH)
        .setFlipX(true);
      if (container) {
        container.add([left, right]);
      } else {
        left.setDepth(-49.5);
        right.setDepth(-49.5);
      }
      if (intoBattle) this.battleNodes.push(left, right);
      topReached = cy - tileH / 2;
    }
    return topReached;
  }

  /** Постоянная «базовая» дорога над воротами — видна в base-режиме в Y=0..GATE_Y.
   *  Не teardown'ится при `returnToBase`. Контейнер регистрируется в LayoutEditor —
   *  пользователь может двигать дорогу как стартовую позицию (battle extension будет
   *  начинаться от текущего верха базовой дороги, учитывая смещение container'а). */
  private buildBaseRoad(): void {
    this.baseRoadContainer = this.add.container(0, 0).setDepth(-49.5);
    this.baseRoadTopY = this.buildRoadStripe(GATE_Y, 0, false);
  }

  /** Battle road extension: дорисовывает дорогу ВЫШЕ верхней границы базовой дороги до
   *  `worldTopY` (а не `chestRowY`) — чтобы за сундуками не оставалось пустоты в кадре.
   *  Учитывает текущий `container.y` (если пользователь двинул дорогу в редакторе).
   *  Уничтожается в `returnToBase` через `battleNodes`. Базовая дорога остаётся. */
  private buildRoadTiles(): void {
    // Эффективная WORLD-y верхней границы базовой дороги (с учётом editor shift).
    const baseTopWorld = this.baseRoadTopY + (this.baseRoadContainer?.y ?? 0);
    // Дотягиваем выше worldTopY с запасом (камера может ехать почти до worldTopY).
    const targetTop = this.worldTopY - 200;
    if (targetTop < baseTopWorld) {
      // +1: нахлёст 1px на стык base→battle (как и между соседними tile'ами внутри stripe).
      this.buildRoadStripe(baseTopWorld + 1, targetTop, true);
    }
  }

  private buildBaseUI(): void {
    const s = getState();

    // Merge board — рамка для рассчёта позиции/размера ячеек. Figma main UI (158:251):
    // x=135, y=555, 449×449. MergeBoard сам вычисляет outerBounds под форму поля
    // (для не-квадратных field — bg сжимается по короткой оси).
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
    this.battleBgGround = null;

    // Inventory place + Trash place: PNG-арт фона.
    // inventory: x=18, y=889, 100×125 (active_zone 82×82 at +9, +0).
    // trash:     x=601, y=901, 98×113 (active_zone 82×82 at +8, -6).
    if (this.textures.exists('ui.inv_place')) {
      const img = this.add
        .image(18 + 50, 889 + 62, 'ui.inv_place')
        .setOrigin(0.5)
        .setDisplaySize(100, 125)
        .setDepth(0);
      this.invPlaceArt = img;
      // Label «ИНВЕНТАРЬ» — figma style_KHNJWT (Roboto 900, 15px, #331D10), (6, 87, 88×22) внутри
      // inv frame (18, 889, 100×125). Центр текста в абс. координатах: 18+6+44=68, 889+87+11=987.
      this.add
        .text(68, 987, 'ИНВЕНТАРЬ', {
          fontFamily: 'Roboto, Arial Black, sans-serif',
          fontStyle: '900',
          fontSize: '14px',
          color: '#331D10',
        })
        .setOrigin(0.5)
        .setDepth(1);
    }
    if (this.textures.exists('ui.trash_place')) {
      const img = this.add
        .image(601 + 49, 901 + 56, 'ui.trash_place')
        .setOrigin(0.5)
        .setDisplaySize(98, 113)
        .setDepth(0);
      this.trashPlaceArt = img;
      // Label «МУСОР» — figma style_KHNJWT, color #D9D9D9, (5, 76, 88×22) внутри trash frame
      // (601, 901, 98×113). Центр в абс: 601+5+44=650, 901+76+11=988.
      this.add
        .text(650, 988, 'МУСОР', {
          fontFamily: 'Roboto, Arial Black, sans-serif',
          fontStyle: '900',
          fontSize: '14px',
          color: '#D9D9D9',
        })
        .setOrigin(0.5)
        .setDepth(1);
    }
    // Active zones: tap по инвентарю, drop на трэше. Координаты из figma active_zone.
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

    // Главный UI экрана: top-bar (Hud) и нижний бар (MainScreenUI).
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

  /** Рисует фон мердж-поля (3D-стиль кнопок: shadow + outer plate + inner plate + outline).
   *  Вызывается из `MergeBoard.onLayoutChanged` — bg перестраивается при изменении формы
   *  field (2×3, 3×4, 4×5 → bg сжимается по короткой оси).
   *
   *  Цвета figma 158:251:
   *    • shadow: смещение +4px вниз, чёрный 0.25 (effect_IGCP45 boxShadow 0 4 0 rgba(0,0,0,.25))
   *    • outer plate (нижняя «толщина»): #927761, +10px высоты
   *    • inner plate (верхняя поверхность): #DFBB97
   *    • общий outline: #482C1C, 3px вокруг outer.
   */
  private drawMergeGround(outer: BoardRect): void {
    if (!this.mergeGroundGfx) {
      this.mergeGroundGfx = this.add.graphics().setDepth(0);
    }
    const g = this.mergeGroundGfx;
    g.clear();
    const { x, y, w, h } = outer;
    const r = 22;
    const thickness = 10; // выступ outer plate снизу (3D-эффект)
    // 1) Тень.
    g.fillStyle(0x000000, 0.25);
    g.fillRoundedRect(x, y + 4, w, h + thickness, r);
    // 2) Outer plate (выступает на 10px вниз — «толщина»).
    g.fillStyle(0x927761, 1);
    g.fillRoundedRect(x, y, w, h + thickness, r);
    // 3) Inner plate (поверхность, где лежат слоты).
    g.fillStyle(0xdfbb97, 1);
    g.fillRoundedRect(x, y, w, h, r);
    // 4) Общая обводка.
    g.lineStyle(3, 0x482c1c, 1);
    g.strokeRoundedRect(x, y, w, h + thickness, r);
  }

  /** Создать визуал мусорки (квадратный «предмет на локации» — не ячейка поля).
   *  Hit-area для drop живёт в `this.trashRect` и синхронизируется с container в update(). */
  private buildTrashItem(cx: number, cy: number, size: number): void {
    // Если уже есть — уничтожаем (пересоздание при relayout).
    if (this.trashContainer) {
      this.trashContainer.destroy();
      this.trashContainer = null;
    }
    // Прозрачный rect — invisible hit-area для drop, без визуала поверх PNG-арта.
    const bg = this.add
      .rectangle(0, 0, size, size, 0x000000, 0)
      .setOrigin(0.5);
    this.trashContainer = this.add.container(cx, cy, [bg]).setSize(size, size);
    this.trashSize = size;
    this.trashRect = { x: cx - size / 2, y: cy - size / 2, w: size, h: size };
    this.board.setTrashZone(this.trashRect);
  }

  /** Синхронизация trashRect с позицией trashContainer (если её менял layout-editor). */
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
    this.fighterTierShown = [];
    this.fighterHitsRemaining = [];
    this.chestTokens = [];
    this.obTokens = [];
    this.obBars = [];
    this.obBarBgs = [];
    this.obHpTexts = [];
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
    // Скрываем нижний бар базы — это чистый UI, в бою не нужен.
    this.mainUI.setBottomVisible(false);
    this.gradientTop?.setVisible(false);
    this.gradientBot?.setVisible(false);
    // Place-арт инвентаря/мусорки + текст-лейблы тоже не нужны во время боя.
    this.invPlaceArt?.setVisible(false);
    this.trashPlaceArt?.setVisible(false);

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

    // === Динамическая дорога из тайла road_l1 (левая половина + flipX = правая) ===
    // Длина дороги = от GATE_Y вверх до chestRowY. Тайлы укладываются вертикально вплотную;
    // их количество вычисляется так, чтобы покрыть всю дорогу + небольшой запас сверху.
    this.buildRoadTiles();

    for (let li = 0; li < cols; li++) {
      const x = this.colCenterX(li);

      // Сундук на топе. Контейнер с телом + крышкой, чтобы крышка могла «отлететь».
      const chestBody = this.add
        .rectangle(0, 10, 54, 22, 0xd4af37)
        .setOrigin(0.5)
        .setStrokeStyle(2, 0x000000, 0.4);
      const chestLid = this.add
        .rectangle(0, -8, 58, 14, 0xb8941f)
        .setOrigin(0.5)
        .setStrokeStyle(2, 0x000000, 0.4);
      const chest = this.add.container(x, this.chestRowY, [chestBody, chestLid]);
      chest.setData('body', chestBody);
      chest.setData('lid', chestLid);
      this.chestTokens[li] = chest;
      this.battleNodes.push(chest);

      // Препятствия — снизу вверх (idx=0 ближе к воротам).
      const obstacles = this.level!.lanes[li].obstacles;
      const tokens: (Phaser.GameObjects.GameObject | null)[] = new Array(obstacles.length).fill(null);
      const bars: (Phaser.GameObjects.Rectangle | null)[] = new Array(obstacles.length).fill(null);
      const barBgs: (Phaser.GameObjects.Rectangle | null)[] = new Array(obstacles.length).fill(null);
      const hpTexts: (Phaser.GameObjects.Text | null)[] = new Array(obstacles.length).fill(null);

      const tokenSize = Math.min(this.laneWidth * 0.42, 44);
      this.obstacleTokenSize = tokenSize; // [EXP: zombie-movement] cache для tickZombieMovement
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

    // Гейтовые примитивы больше не нужны — анимируем сами figma-ворота
    // (`base.gate_l`/`base.gate_r`) в `playOpeningSequence` / `returnToBase`.
  }

  /** Y координата препятствия с индексом idx (0 — ближайшее к воротам, но всё равно ВНЕ
   *  видимой зоны базы при scrollY=0 — см. `FIRST_ZOMBIE_OFFSET`). */
  private obstacleY(idx: number): number {
    return GATE_Y - FIRST_ZOMBIE_OFFSET - idx * ZOMBIE_SPACING;
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
    this.skipBtn.setScrollFactor(0);
    this.skipBtn.setDepth(100);

    const speeds: Array<{ factor: number; label: string }> = [
      { factor: 0.25, label: '×0.25' }, { factor: 1, label: '×1' }, { factor: 4, label: '×4' },
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

  // ============================== Opening sequence =============================

  private playOpeningSequence(arsenals: number[][]): void {
    // 1) Ворота + их тени разъезжаются (тень — visual продолжение створки). Группируем по
    //    сторонам и тwen'им через относительное смещение, чтобы каждый объект ехал от своего
    //    defaultX. Сохраняем defaultX в data для returnToBase.
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
      const off = 220;
      if (leftTargets.length > 0) {
        this.tweens.add({
          targets: leftTargets,
          x: `-=${off}`,
          duration: 600,
          ease: 'Sine.Out',
        });
      }
      if (rightTargets.length > 0) {
        this.tweens.add({
          targets: rightTargets,
          x: `+=${off}`,
          duration: 600,
          ease: 'Sine.Out',
          onComplete: proceed,
        });
      } else {
        // Только левые створки/тени — fallback на time delay.
        this.time.delayedCall(600, proceed);
      }
    } else {
      // Fallback — без арта ворот сразу едем дальше.
      proceed();
    }
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
      this.fighterTierShown[li] = bestTier;
      this.fighterHitsRemaining[li] = startHits;
      this.battleNodes.push(fighter);
    }

    // Визуально «забираем» оружие — оружейные плитки исчезают с поля (лутбоксы остаются).
    this.board.hideWeaponTiles();

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
      // «Последний consumed step» (для event-level weaponTierAfter). Carry-wound
      // в chain НЕ включается — он будет обработан outer loop'ом как обычный step,
      // у него своя цепочка wound-events с актуальным sync в onComplete.
      let lastStepInChain: LaneStep = step;
      while (j < steps.length) {
        const nxt = steps[j];
        if (nxt.kind === 'scrap') {
          stops.push({ kind: 'scrap', step: nxt });
          lastStepInChain = nxt;
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
          lastStepInChain = nxt;
          j++; continue;
        }
        // Carry-wound — НЕ включаем в chain stops. Просто break, чтобы outer
        // while-loop в следующей итерации обработал nxt step нормально (как
        // обычный target с carryIn → его wound + fatal/stuck events). Так
        // simulator (carry contact = 1 hit, follow-up = N hits) и UI (только
        // wound + fatal stops = N + 1) считают одинаково (carry contact уже
        // отражён в первом wound через hpAfterCarry).
        break;
      }

      events.push({
        kind: 'lunge', stops,
        // Если в цепи был carry-wound — boец «упёрся» (retreat). Если только kills —
        // боец продолжает в следующее событие без backstep'a.
        retreat: false,
        weaponTierAfter: lastStepInChain.weaponTierAfter,
        weaponHitsAfter: lastStepInChain.weaponHitsAfter,
      });
      // `i = j;` — это while-loop, ручной advance к first unconsumed step.
      // (ИСТОРИЧЕСКИЙ БАГ: `i = j - 1;` создавал infinite loop при carry-wound,
      // потому что j не двигалось при carry-wound break → i стояло на месте.)
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
    if (this.lanesDone >= this.level!.cols) {
      // Пауза 2с — дать игроку посмотреть на открытые сундуки и их содержимое
      // до появления модалки результата. На skip эта задержка пропускается.
      this.time.delayedCall(2000, () => {
        if (this.resultShown) return;
        this.showResult();
      });
    }
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
    // [EXP: zombie-movement] цель — ТЕКУЩАЯ Y последнего стопа (зомби мог сдвинуться).
    const endY = this.getObstacleCurrentY(li, stops[stops.length - 1].step.index);
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
        // Финальный sync: оружие могло переключиться (текущее исчерпано → активировано
        // следующее). `ev.weaponTierAfter` — снимок после ВСЕХ шагов этого lunge.
        // Для chain carry-kill это берётся от последнего consumed step (см. buildLaneEvents).
        // Для wound-lunge (не убил) — undefined, sync пропускаем.
        if (ev.weaponTierAfter !== undefined) {
          this.syncFighterWeapon(li, ev.weaponTierAfter, ev.weaponHitsAfter);
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

    // Мгновенные эффекты по пути. На каждом TARGET stop'е decrement hits на 1 —
    // синхронно с applyHpSnap, чтобы цифра под бойцом обновлялась прямо в момент удара
    // (а не только в конце всего lunge'а). [EXP: zombie-movement] — stopY текущая.
    for (const stop of stops) {
      const stopY = this.getObstacleCurrentY(li, stop.step.index);
      const t = (Math.abs(stopY - startY) / span) * walk;
      this.time.delayedCall(t, () => {
        if (this.resultShown) return;
        if (stop.kind === 'target') {
          this.applyHpSnap(li, stop);
          this.decrementFighterHit(li);
        } else {
          this.popText(fighter.x, stopY, `+${stop.step.scrap}`, '#9fe870');
        }
      });
    }
  }

  /** Decrement локального счётчика hits (один stop = один удар = один hit). Не уходим
   *  ниже 0; финальный sync на новое оружие делает `syncFighterWeapon` из onComplete. */
  private decrementFighterHit(li: number): void {
    this.fighterHitsRemaining[li] = Math.max(0, (this.fighterHitsRemaining[li] ?? 0) - 1);
    this.updateFighterWeapon(li, this.fighterTierShown[li] || undefined, this.fighterHitsRemaining[li]);
  }

  /** Авторитетный sync с снимком симулятора — ПЕРЕКЛЮЧАЕТ tier (и ресурс) ТОЛЬКО при
   *  смене тира (оружие исчерпано → активировано следующее). Если тир тот же — ресурс
   *  не переписываем: per-stop `decrementFighterHit` уже отвечает за актуальное значение
   *  (и оно совпадает с симулятором благодаря 1:1 балансу stops↔hits). Иначе sync
   *  затирает local decrement и UI «прыгает» вверх между двумя событиями. */
  private syncFighterWeapon(li: number, tier: number, hits?: number): void {
    const currentTier = this.fighterTierShown[li];
    if (tier !== currentTier) {
      this.fighterTierShown[li] = tier;
      this.fighterHitsRemaining[li] = hits ?? 0;
    }
    this.updateFighterWeapon(li, this.fighterTierShown[li], this.fighterHitsRemaining[li]);
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
      // [EXP: zombie-movement] stun до конца backstep'a бойца — зомби не наступает,
      // пока боец откатывается, потом снова начинает идти. Защита: setData может
      // отсутствовать у нестандартных объектов (хотя у Circle/Rectangle есть всегда).
      if (typeof (token as { setData?: unknown }).setData === 'function') {
        (token as Phaser.GameObjects.GameObject).setData('stunnedUntil', this.time.now + ZOMBIE_STUN_MS);
      }
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
        if (ev.weaponTierAfter !== undefined) {
          this.syncFighterWeapon(li, ev.weaponTierAfter, ev.weaponHitsAfter);
        }
        this.time.delayedCall(this.CHEST_PAUSE, () => {
          if (this.resultShown) return;
          // Боец остаётся возле сундука — ждёт, пока все остальные линии завершатся.
          // Лёгкий idle-bounce, чтобы было видно, что он «живой» и ждёт.
          this.tweens.add({
            targets: fighter, scaleY: 0.92, yoyo: true, duration: 420, repeat: -1,
          });
          onDone();
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
    // [EXP: zombie-movement] — догоняем текущую Y, зомби мог приблизиться.
    const stuckY = this.getObstacleCurrentY(li, ev.step.index);
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
          this.syncFighterWeapon(li, ev.weaponTierAfter, ev.weaponHitsAfter);
        } else {
          // Совсем кончилось оружие (depleted): tier=0, hits=0 → updateFighterWeapon
          // покажет '—' и серый ring.
          this.syncFighterWeapon(li, 0, 0);
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
    const chest = this.chestTokens[li];
    if (!chest) return;
    const lid = chest.getData('lid') as Phaser.GameObjects.Rectangle | undefined;
    const body = chest.getData('body') as Phaser.GameObjects.Rectangle | undefined;
    body?.setFillStyle(0xf2c63a);
    if (lid) {
      // Крышка отлетает вверх и наклоняется.
      this.tweens.add({
        targets: lid,
        y: lid.y - 26,
        angle: -28,
        duration: 260,
        ease: 'Back.Out',
      });
    }
    // Лёгкий «pop» всего сундука.
    this.tweens.add({ targets: chest, scale: 1.12, yoyo: true, duration: 160 });
    this.renderChestContent(li);
  }

  /** Показывает содержимое сундука над ним (висит до конца уровня).
   *  Рендерит САМ предмет: плитку оружия / лутбокс / стопку лома — а не текстовую плашку. */
  private renderChestContent(li: number): void {
    const lane = this.level!.lanes[li];
    const chestDef = lane.chest;
    const x = this.colCenterX(li);
    const size = 54;
    const y = this.chestRowY - size / 2 - 18; // над сундуком, отступ ~18px

    const container = this.add.container(x, y).setDepth(15);
    let fillColor = 0x888888;
    let labelTxt = '';
    let labelColor = '#ffffff';
    let strokeColor = 0x000000;
    let strokeAlpha = 0.4;
    let labelFontFactor = 0.5;

    if (chestDef.reward === 'scrap') {
      // Стопка лома: серая плитка + «+N» зелёным.
      fillColor = 0x6b7785;
      labelTxt = `+${chestDef.scrap ?? 0}`;
      labelColor = '#9fe870';
      labelFontFactor = 0.4;
    } else if (chestDef.reward === 'weapon') {
      // Плитка оружия в стиле мердж-поля: цвет по тиру + цифра тира.
      const t = chestDef.weaponTier ?? 1;
      fillColor = TIER_COLORS[t] ?? 0x888888;
      labelTxt = String(t);
    } else if (chestDef.reward === 'lootbox') {
      // Лутбокс: фиолетовый/жёлтый квадрат с эмодзи 📦.
      const isElite = chestDef.lootboxKind === 'elite';
      fillColor = isElite ? 0x9b59b6 : 0xd4a017;
      labelTxt = '📦';
      strokeColor = 0xffffff;
      strokeAlpha = 0.7;
      labelFontFactor = 0.6;
    }

    const bg = this.add
      .rectangle(0, 0, size, size, fillColor)
      .setOrigin(0.5)
      .setStrokeStyle(3, strokeColor, strokeAlpha);
    const label = this.add
      .text(0, 0, labelTxt, {
        fontFamily: 'monospace',
        fontSize: `${Math.round(size * labelFontFactor)}px`,
        color: labelColor,
      })
      .setOrigin(0.5);
    label.setStroke('#000000', 3);
    container.add([bg, label]);

    container.setScale(0);
    this.tweens.add({ targets: container, scale: 1, duration: 240, ease: 'Back.Out' });
    this.battleNodes.push(container);
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
    back.setScrollFactor(0);
    back.setDepth(152);

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
    this.fighterTierShown = [];
    this.fighterHitsRemaining = [];
    this.chestTokens = [];
    this.obTokens = [];
    this.obBars = [];
    this.obBarBgs = [];
    this.obHpTexts = [];

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

    // 4b) Закрыть ворота (figma-арт) + тени — вернуть створки и их тени в исходные позиции.
    for (const id of ['base.gate_l', 'base.gate_l_shd', 'base.gate_r', 'base.gate_r_shd']) {
      const obj = this.baseLocation?.byId.get(id);
      if (!obj) continue;
      const def = obj.getData('defaultX');
      if (typeof def === 'number') {
        this.tweens.add({ targets: obj, x: def, duration: 600, ease: 'Sine.InOut' });
      }
    }

    // 5) Восстановить мердж-плитки (state мог измениться — лутбоксы + восстановленное оружие).
    //    relayout пересоздаёт ВСЕ плитки visible — отдельный show не нужен.
    this.board.relayout(getState().field);
    // Поле может вырасти, но позиции inv/trash фиксированы из figma — не пересчитываем.
    this.inv.rebuild();
    this.hud.refresh();

    // 6) Mode = base. Возвращаем UI базы.
    this.mode = 'base';
    this.resultShown = false;
    this.lanesDone = 0;
    this.level = null;
    this.result = null;
    this.mainUI.setBottomVisible(true);
    this.gradientTop?.setVisible(true);
    this.gradientBot?.setVisible(true);
    this.invPlaceArt?.setVisible(true);
    this.trashPlaceArt?.setVisible(true);
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
