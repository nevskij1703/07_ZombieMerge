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
import { laneArsenals, applyBattleResult } from './progression';

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
  blueprints: number;
}

export interface AutotestReport {
  finished: boolean;
  reachedLevel: number;
  totalLevels: number;
  totalProduced: number;
  totalBlueprints: number;
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
      if (t != null && t > max) max = t;
    }
    out[c] = max;
  }
  return out;
}

function maxTierOnField(field: FieldState): number {
  let m = 0;
  for (const t of field.cells) if (t != null && t > m) m = t;
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

/** Smart-merge с такой же плиткой на полном поле (когда нет свободных клеток). */
function smartMergeIntoSameTier(field: FieldState, tier: WeaponTier): boolean {
  if (!canMergeTier(tier)) return false;
  for (let i = 0; i < field.cells.length; i++) {
    if (field.cells[i] === tier) {
      field.cells[i] = nextTier(tier);
      return true;
    }
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

/** Достать из инвентаря всё что влезет: на свободные клетки или slr-merge с совпадающим тиром. */
function drainInventoryToField(state: SaveState): boolean {
  let changed = false;
  while (state.inventory.length > 0) {
    const tier = state.inventory[0];
    const placed = placeIntoWeakestColumn(state.field, tier) || smartMergeIntoSameTier(state.field, tier);
    if (!placed) break;
    state.inventory.shift();
    changed = true;
  }
  return changed;
}

/** Прогон фазы мерджа до тупика. Возвращает кол-во произведённых оружий. */
function runMergePhase(state: SaveState): number {
  let produced = 0;
  for (let safety = 0; safety < MERGE_SAFETY; safety++) {
    if (drainInventoryToField(state)) continue;
    if (mergeAnyPair(state.field)) continue;

    const cost = produceCost(state.workshopTier);
    if (canAfford(state.scrap, cost)) {
      const placed =
        placeIntoWeakestColumn(state.field, state.workshopTier) ||
        smartMergeIntoSameTier(state.field, state.workshopTier);
      if (placed) {
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
  let totalBlueprints = 0;

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
          totalBlueprints,
          samples,
          stuckAt: L,
        };
      }

      producedThisLevel += runMergePhase(state);
      const lvl = generateLevel(state.level);
      const arsenals = laneArsenals(state.field);
      const result = simulateBattle(lvl, arsenals, { workshopTier: state.workshopTier });
      lastResult = result;
      if (result.passed) break;
      // Не прошли: применим частичные награды (металлолом по дороге) и снова мерджим.
      applyBattleResult(state, result);
    }

    const result = lastResult!;
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
      blueprints: result.blueprints,
    };
    samples.push(sample);
    totalProduced += producedThisLevel;
    totalBlueprints += result.blueprints;

    applyBattleResult(state, result); // level++, рост поля, лут на поле/инвентарь
  }

  return {
    finished: true,
    reachedLevel: maxLevel,
    totalLevels: maxLevel,
    totalProduced,
    totalBlueprints,
    samples,
    stuckAt: null,
  };
}
