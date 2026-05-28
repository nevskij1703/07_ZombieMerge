// Headless-автотестер баланса. Прогоняет всю кампанию (50 уровней) на ТЕХ ЖЕ модулях,
// что и игра: generateLevel + simulateBattle + applyBattleResult. Без визуала.
//
// Стратегия «жадного идеального игрока»:
//   1. Достать из инвентаря всё, что влезает на поле (бесплатно).
//   2. Слить любую пару одинакового тира (предпочитая высокий) — максимальный апгрейд.
//   3. Если есть лом и место — произвести оружие в «самый слабый» столбец
//      (минимальный max-tier, при равенстве — больше свободных клеток).
//   4. Повторять, пока есть прогресс. Когда тупик — отправлять в бой.

import type { SaveState, FieldState, WeaponTier } from '../types';
import { DEFAULT_STATE } from './storage';
import { produceCost, canAfford } from './economy';
import { canMergeTier, nextTier } from './weapons';
import { isFull } from './merge';
import { generateLevel } from './levelGen';
import { simulateBattle } from './battleSim';
import { laneArsenals, applyBattleResult, bestWeaponTier } from './progression';
import { isLootboxCode, isWeaponCellValue, lootboxKindOfCode, rollLootboxTier } from './lootbox';
import { makeRng } from './rng';

export interface LevelSample {
  level: number;
  cols: number;
  rows: number;
  workshopTier: number;
  scrapBefore: number;
  weaponsProduced: number; // суммарно за все попытки этого уровня
  attempts: number;
  maxTierByColumn: number[]; // длина = cols
  fieldMaxTier: number;
  inventorySize: number;
  scrapGained: number;
  weaponsLooted: number;
  lootboxesLooted: number;
  /** Сколько линий дошли до сундука / общее число линий в этом уровне. */
  lanesReached: number;
  lanesTotal: number;
}

export interface AutotestReport {
  finished: boolean;
  reachedLevel: number;
  totalLevels: number;
  totalProduced: number;
  totalLootboxes: number;
  samples: LevelSample[];
  stuckAt: number | null; // уровень, на котором завис (если finished=false)
}

const MERGE_SAFETY = 10000;

function computeMaxTierByColumn(field: FieldState): number[] {
  const out = new Array<number>(field.cols).fill(0);
  for (let c = 0; c < field.cols; c++) {
    let max = 0;
    for (let r = 0; r < field.rows; r++) {
      const t = field.cells[r * field.cols + c];
      if (isWeaponCellValue(t) && t > max) max = t;
    }
    out[c] = max;
  }
  return out;
}

function maxTierOnField(field: FieldState): number {
  let m = 0;
  for (const t of field.cells) if (isWeaponCellValue(t) && t > m) m = t;
  return m;
}

/** Слить любую пару одинакового тира, предпочитая самый высокий тир. true если что-то слилось. */
function mergeAnyPair(field: FieldState): boolean {
  const byTier = new Map<number, number[]>();
  for (let i = 0; i < field.cells.length; i++) {
    const t = field.cells[i];
    if (t == null) continue;
    if (!canMergeTier(t)) continue;
    let arr = byTier.get(t);
    if (!arr) {
      arr = [];
      byTier.set(t, arr);
    }
    arr.push(i);
  }
  const tiers = Array.from(byTier.keys()).sort((a, b) => b - a);
  for (const t of tiers) {
    const idxs = byTier.get(t);
    if (!idxs || idxs.length < 2) continue;
    const a = idxs[0];
    const b = idxs[1];
    field.cells[b] = nextTier(t);
    field.cells[a] = null;
    return true;
  }
  return false;
}

/** Положить оружие в «самый слабый» столбец (минимальный max-tier, больше свободных клеток). */
function placeIntoWeakestColumn(field: FieldState, tier: WeaponTier): boolean {
  let bestCol = -1;
  let bestMax = Infinity;
  let bestFree = -1;
  for (let c = 0; c < field.cols; c++) {
    let maxT = 0;
    let free = 0;
    for (let r = 0; r < field.rows; r++) {
      const t = field.cells[r * field.cols + c];
      if (t == null) free++;
      else if (t > maxT) maxT = t;
    }
    if (free === 0) continue;
    if (maxT < bestMax || (maxT === bestMax && free > bestFree)) {
      bestMax = maxT;
      bestFree = free;
      bestCol = c;
    }
  }
  if (bestCol === -1) return false;
  for (let r = 0; r < field.rows; r++) {
    const idx = r * field.cols + bestCol;
    if (field.cells[idx] == null) {
      field.cells[idx] = tier;
      return true;
    }
  }
  return false;
}

/** Достать всё что влезет из инвентаря в свободные клетки (бесплатно). */
function drainInventoryToField(state: SaveState): boolean {
  let changed = false;
  while (state.inventory.length > 0 && !isFull(state.field)) {
    const item = state.inventory.shift()!;
    placeIntoWeakestColumn(state.field, item);
    changed = true;
  }
  return changed;
}

/** Открыть все лутбоксы на поле (для greedy-автоигрока). Кладёт оружие на ту же клетку. */
function openAllLootboxes(state: SaveState, rng: () => number): boolean {
  let opened = false;
  const ws = state.workshopTier;
  const best = bestWeaponTier(state);
  for (let i = 0; i < state.field.cells.length; i++) {
    const c = state.field.cells[i];
    if (!isLootboxCode(c)) continue;
    const kind = lootboxKindOfCode(c);
    if (!kind) continue;
    const tier = rollLootboxTier(kind, ws, best, rng);
    state.field.cells[i] = tier;
    opened = true;
  }
  return opened;
}

/** Прогон фазы мерджа до тупика. Возвращает кол-во произведённых оружий. */
function runMergePhase(state: SaveState, openLootboxRng: () => number): number {
  let produced = 0;
  for (let safety = 0; safety < MERGE_SAFETY; safety++) {
    if (drainInventoryToField(state)) continue;
    if (openAllLootboxes(state, openLootboxRng)) continue;
    if (mergeAnyPair(state.field)) continue;

    const cost = produceCost(state.workshopTier);
    if (canAfford(state.scrap, cost) && !isFull(state.field)) {
      if (placeIntoWeakestColumn(state.field, state.workshopTier)) {
        state.scrap -= cost;
        produced += 1;
        continue;
      }
    }
    break; // тупик — больше ничего не сделать без боя
  }
  return produced;
}

export function runAutotest(maxLevel = 50, maxAttemptsPerLevel = 50): AutotestReport {
  const state = DEFAULT_STATE();
  const samples: LevelSample[] = [];
  let totalProduced = 0;
  let totalLootboxes = 0;
  // Отдельный RNG для открытия лутбоксов (детерминированно по seed=кампания).
  const lootRng = makeRng(0x5eedb000);

  for (let L = 1; L <= maxLevel; L++) {
    let attempts = 0;
    let producedThisLevel = 0;
    let lastResult: ReturnType<typeof simulateBattle> | null = null;

    // Снапшот «до боя» возьмём перед УСПЕШНЫМ боем (после неудач игрок ещё мерджит дальше).
    while (true) {
      attempts += 1;
      if (attempts > maxAttemptsPerLevel) {
        return {
          finished: false,
          reachedLevel: L - 1,
          totalLevels: maxLevel,
          totalProduced,
          totalLootboxes,
          samples,
          stuckAt: L,
        };
      }

      producedThisLevel += runMergePhase(state, lootRng);
      const lvl = generateLevel(state.level, {
        workshopTier: state.workshopTier,
        bestTier: bestWeaponTier(state),
      });
      const arsenals = laneArsenals(state.field);
      const result = simulateBattle(lvl, arsenals);
      lastResult = result;
      if (result.passed) break;
      // Не прошли: применим частичные награды и снова мерджим (вкл. открытие лутбоксов).
      applyBattleResult(state, result);
    }

    const result = lastResult!;
    const lanesReached = result.lanes.filter((l) => l.reachedChest).length;
    const sample: LevelSample = {
      level: state.level,
      cols: state.field.cols,
      rows: state.field.rows,
      workshopTier: state.workshopTier,
      scrapBefore: state.scrap,
      weaponsProduced: producedThisLevel,
      attempts,
      maxTierByColumn: computeMaxTierByColumn(state.field),
      fieldMaxTier: maxTierOnField(state.field),
      inventorySize: state.inventory.length,
      scrapGained: result.totalScrap,
      weaponsLooted: result.totalWeapons.length,
      lootboxesLooted: result.totalLootboxes.length,
      lanesReached,
      lanesTotal: result.lanes.length,
    };
    samples.push(sample);
    totalProduced += producedThisLevel;
    totalLootboxes += result.totalLootboxes.length;

    applyBattleResult(state, result); // level++, рост поля, лут на поле/инвентарь
  }

  return {
    finished: true,
    reachedLevel: maxLevel,
    totalLevels: maxLevel,
    totalProduced,
    totalLootboxes,
    samples,
    stuckAt: null,
  };
}
