// Доступ к таблице оружия и правила мерджа. Числа — из рантайм-баланса.

import { getBalance } from './balanceRuntime';
import type { WeaponDef } from '../config/balance';

export function maxTier(): number {
  return getBalance().maxTier;
}

export function getWeapon(tier: number): WeaponDef {
  const w = getBalance().weapons[tier];
  return w ?? { name: `T${tier}`, damagePerHit: 0, hits: 0 };
}

export function weaponName(tier: number): string {
  return getWeapon(tier).name;
}

/** Можно ли мерджить оружие этого тира (есть следующий тир). */
export function canMergeTier(tier: number): boolean {
  return tier >= 1 && tier < maxTier();
}

/** Тир после мерджа (не выше maxTier). */
export function nextTier(tier: number): number {
  return Math.min(tier + 1, maxTier());
}
