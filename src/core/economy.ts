// Экономика металлолома и стоимость производства Мастерской.

import { getBalance } from './balanceRuntime';

/** Цена спавна оружия тира T в металлоломе (0 — тир не производится). */
export function produceCost(tier: number): number {
  const c = getBalance().workshop.produceCostByTier[tier];
  return typeof c === 'number' ? c : 0;
}

export function canAfford(scrap: number, cost: number): boolean {
  return cost > 0 && scrap >= cost;
}
