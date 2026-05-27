// Dev-only смоук ядра: оружие/мердж/экономика/инвентарь. Бросает при провале.
// Вызывается из BootScene под import.meta.env.DEV. Не попадает в release (tree-shaking).

import type { FieldState } from '../types';
import { getWeapon, maxTier, nextTier, canMergeTier } from './weapons';
import { produceCost } from './economy';
import {
  placeFirstFree,
  mergeInto,
  canMergeIndices,
  addLoot,
  isFull,
  firstFreeIndex,
} from './merge';

export function coreSelfTest(): void {
  const assert = (cond: boolean, msg: string): void => {
    if (!cond) throw new Error('[core] self-test: ' + msg);
  };

  assert(maxTier() >= 2, 'maxTier >= 2');
  assert(getWeapon(1).name.length > 0, 'tier1 has name');
  assert(produceCost(1) > 0, 'produceCost(1) > 0');
  assert(canMergeTier(1), 'tier1 mergeable');
  assert(!canMergeTier(maxTier()), 'maxTier not mergeable');
  assert(nextTier(1) === 2, 'nextTier(1) === 2');

  // мердж двух одинаковых на скретч-поле
  const f: FieldState = { cols: 2, rows: 2, cells: [null, null, null, null] };
  placeFirstFree(f, 1);
  placeFirstFree(f, 1);
  assert(canMergeIndices(f, 0, 1), 'two tier1 mergeable');
  assert(mergeInto(f, 0, 1) === 2, 'merge -> tier2');
  assert(f.cells[0] === null && f.cells[1] === 2, 'merge layout');

  // переполнение -> инвентарь
  const full: FieldState = { cols: 2, rows: 1, cells: [5, 5] };
  const inv: number[] = [];
  assert(isFull(full) && firstFreeIndex(full) === -1, 'full field detected');
  assert(addLoot(full, inv, 7) === 'inventory' && inv[0] === 7, 'overflow -> inventory');
}
