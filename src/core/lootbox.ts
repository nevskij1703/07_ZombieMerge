// Лутбоксы хранятся в клетках поля и инвентаре как СПЕЦИАЛЬНЫЕ числовые коды (не тиры
// оружия). Тип FieldState.cells остаётся (number | null) — миграция сейва не требуется.
// При рендере/мердже плитки различаются: оружие = tier 1..maxTier, лутбокс = код 1001/1002.
//
// Тир оружия ВНУТРИ лутбокса определяется НЕ при выпадении, а в момент ОТКРЫТИЯ — это
// делает elite-лутбоксы тем выгоднее, чем сильнее у игрока поле.

import type { LootboxKind, WeaponTier } from '../types';
import { getBalance } from './balanceRuntime';
import { maxTier } from './weapons';
import { rint } from './rng';

export const LOOTBOX_CHEAP_CODE = 1003;
export const LOOTBOX_MEDIUM_CODE = 1001;
export const LOOTBOX_ELITE_CODE = 1002;

export function lootboxCode(kind: LootboxKind): number {
  if (kind === 'cheap') return LOOTBOX_CHEAP_CODE;
  if (kind === 'medium') return LOOTBOX_MEDIUM_CODE;
  return LOOTBOX_ELITE_CODE;
}

export function lootboxKindOfCode(code: number | null | undefined): LootboxKind | null {
  if (code === LOOTBOX_CHEAP_CODE) return 'cheap';
  if (code === LOOTBOX_MEDIUM_CODE) return 'medium';
  if (code === LOOTBOX_ELITE_CODE) return 'elite';
  return null;
}

export function isLootboxCode(code: number | null | undefined): boolean {
  return (
    code === LOOTBOX_CHEAP_CODE ||
    code === LOOTBOX_MEDIUM_CODE ||
    code === LOOTBOX_ELITE_CODE
  );
}

/** Является ли число валидным тиром оружия (а не кодом лутбокса/null). */
export function isWeaponCellValue(c: number | null | undefined): c is WeaponTier {
  if (typeof c !== 'number') return false;
  return c >= 1 && c <= maxTier();
}

function clampTier(t: number): WeaponTier {
  return Math.max(1, Math.min(maxTier(), Math.round(t)));
}

/**
 * Тир оружия, который выпадает при открытии лутбокса. Использует переданный RNG для
 * детерминированности. Логика по типам:
 *
 *   • cheap   — оружие ХУЖЕ или равное workshop: workshopTier + uniform[-3..0].
 *   • medium  — среднее между workshop и best: ⌊(workshop+best)/2⌋ + uniform[mid offset].
 *   • elite   — оружие ниже самого крутого на поле: bestTier + uniform[-2..0].
 *
 * bestTier учитывается для medium (как верхняя анкор-точка) и elite.
 */
export function rollLootboxTier(
  kind: LootboxKind,
  workshopTier: number,
  bestTier: number,
  rng: () => number,
): WeaponTier {
  const lb = getBalance().lootbox;
  if (kind === 'cheap') {
    const off = rint(rng, lb.cheapOffsetMin, lb.cheapOffsetMax);
    return clampTier(workshopTier + off);
  }
  if (kind === 'medium') {
    const center = Math.round((workshopTier + bestTier) / 2);
    const off = rint(rng, lb.mediumOffsetMin, lb.mediumOffsetMax);
    return clampTier(center + off);
  }
  // elite
  const off = rint(rng, lb.eliteOffsetMin, lb.eliteOffsetMax);
  return clampTier(bestTier + off);
}
