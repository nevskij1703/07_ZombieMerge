// Прогрессия: сбор арсеналов по столбцам, применение результатов боя, рост поля.

import type { SaveState, BattleResult, FieldState, WeaponTier } from '../types';
import { maxTier } from './weapons';
import { resizeField, placeFirstFree } from './merge';
import { getFieldSize } from './levelGen';
import { getBalance } from './balanceRuntime';
import { isWeaponCellValue, lootboxCode } from './lootbox';

/** Арсенал каждой линии = оружие соответствующего столбца поля (сверху вниз).
 *  Лутбоксы в клетках ИГНОРИРУЮТСЯ — у них нет тира, в бой не идут. */
export function laneArsenals(field: FieldState): WeaponTier[][] {
  const out: WeaponTier[][] = [];
  for (let c = 0; c < field.cols; c++) {
    const arr: WeaponTier[] = [];
    for (let r = 0; r < field.rows; r++) {
      const v = field.cells[r * field.cols + c];
      if (isWeaponCellValue(v)) arr.push(v);
    }
    out.push(arr);
  }
  return out;
}

/**
 * Применить результат боя к сейву.
 *  • Оружие столбцов остаётся на поле (возвращается на места).
 *  • Собранный ЛУТ-ОРУЖИЕ всегда идёт в инвентарь (игрок сам решает, когда выносить).
 *  • Собранные ЛУТБОКСЫ кладутся в свободные клетки поля; если места нет — в инвентарь.
 *  • Пройденный уровень → +1 и рост поля + детерминированный апгрейд Цеха.
 */
export function applyBattleResult(state: SaveState, result: BattleResult): void {
  state.scrap += result.totalScrap;
  for (const tier of result.totalWeapons) state.inventory.push(tier);
  for (const kind of result.totalLootboxes) {
    const code = lootboxCode(kind);
    // Лутбокс — единственное, что по правилу «появляется на поле, иначе в инвентарь»
    // (в отличие от оружия, которое целенаправленно идёт в инвентарь).
    if (placeFirstFree(state.field, code) === -1) {
      state.inventory.push(code);
    }
  }
  state.stats.battlesRun += 1;

  if (result.passed) {
    state.stats.battlesWon += 1;
    const passedLevel = state.level;
    state.level += 1;
    state.maxLevelReached = Math.max(state.maxLevelReached, state.level);

    // Детерминированный апгрейд Цеха после ключевых уровней.
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

/** Лучший тир оружия у игрока (для контекста генерации уровня). Лутбоксы не считаются. */
export function bestWeaponTier(state: SaveState): number {
  let best = state.workshopTier; // как минимум — то, что производит цех
  for (const c of state.field.cells) if (isWeaponCellValue(c) && c > best) best = c;
  for (const v of state.inventory) if (isWeaponCellValue(v) && v > best) best = v;
  return best;
}
