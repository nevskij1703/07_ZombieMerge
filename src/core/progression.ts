// Прогрессия: сбор арсеналов по столбцам, применение результатов боя, рост поля.

import type { SaveState, BattleResult, FieldState, WeaponTier } from '../types';
import { maxTier } from './weapons';
import { resizeField } from './merge';
import { getFieldSize } from './levelGen';
import { getBalance } from './balanceRuntime';

/** Арсенал каждой линии = оружие соответствующего столбца поля (сверху вниз). */
export function laneArsenals(field: FieldState): WeaponTier[][] {
  const out: WeaponTier[][] = [];
  for (let c = 0; c < field.cols; c++) {
    const arr: WeaponTier[] = [];
    for (let r = 0; r < field.rows; r++) {
      const t = field.cells[r * field.cols + c];
      if (t != null) arr.push(t);
    }
    out.push(arr);
  }
  return out;
}

/**
 * Применить результат боя к сейву. Оружие столбцов остаётся на поле (возвращается на места);
 * собранный лут отправляется ТОЛЬКО в инвентарь (игрок сам решит, когда выносить — это
 * сохраняет тактику расстановки и не мешает текущей раскладке поля).
 * Чертёж повышает тир Мастерской. Пройденный уровень -> +1 и рост поля.
 */
export function applyBattleResult(state: SaveState, result: BattleResult): void {
  state.scrap += result.totalScrap;
  for (const tier of result.totalWeapons) state.inventory.push(tier);
  if (result.blueprints > 0) {
    state.workshopTier = Math.min(maxTier(), state.workshopTier + result.blueprints);
  }
  state.stats.battlesRun += 1;

  if (result.passed) {
    state.stats.battlesWon += 1;
    const passedLevel = state.level;
    state.level += 1;
    state.maxLevelReached = Math.max(state.maxLevelReached, state.level);

    // Детерминированный апгрейд Цеха после ключевых уровней. Независим от RNG/сундуков.
    const upgrades = getBalance().workshop.upgradeAtLevels;
    if (Array.isArray(upgrades) && upgrades.includes(passedLevel)) {
      state.workshopTier = Math.min(maxTier(), state.workshopTier + 1);
    }

    const size = getFieldSize(state.level);
    if (size.cols !== state.field.cols || size.rows !== state.field.rows) {
      const overflow = resizeField(state.field, size.cols, size.rows);
      for (const t of overflow) state.inventory.push(t);
    }
  }
}
