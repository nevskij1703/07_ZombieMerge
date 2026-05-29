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
import { generateLevel, getFieldSize } from './levelGen';
import { simulateBattle } from './battleSim';

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

export function battleSelfTest(): void {
  const assert = (cond: boolean, msg: string): void => {
    if (!cond) throw new Error('[battle] self-test: ' + msg);
  };

  // Детерминизм генерации уровня.
  assert(JSON.stringify(generateLevel(5)) === JSON.stringify(generateLevel(5)), 'level gen deterministic');

  const lvl = generateLevel(1);
  assert(lvl.cols === getFieldSize(1).cols, 'level cols == field size');
  assert(lvl.lanes.length === lvl.cols, 'lanes per column');

  // Сильный арсенал на всех линиях — уровень проходится, лут собран.
  const strong = lvl.lanes.map(() => [12, 12]);
  const win = simulateBattle(lvl, strong, { workshopTier: 1 });
  assert(win.passed, 'strong arsenal passes lvl1');
  assert(win.totalScrap > 0, 'scrap collected on win');
  assert(win.lanes.every((l) => l.steps.length > 0), 'timeline produced');

  // Пустые арсеналы при наличии зомби — не проходит, но не падает и собирает лом по пути.
  const lose = simulateBattle(lvl, lvl.lanes.map(() => []), { workshopTier: 1 });
  assert(!lose.passed, 'empty arsenal fails when zombies present');
}

/** Целостность генерации 50 уровней MVP: поле не убывает, состав корректен. */
export function levelSanityTest(): void {
  const assert = (cond: boolean, msg: string): void => {
    if (!cond) throw new Error('[levels] self-test: ' + msg);
  };

  let prevSize = 0;
  for (let L = 1; L <= 50; L++) {
    const lvl = generateLevel(L);
    assert(lvl.lanes.length === lvl.cols, `lvl${L}: lanes == cols`);
    assert(lvl.cols >= 2 && lvl.rows >= 2, `lvl${L}: field >= 2x2`);
    const size = lvl.cols * lvl.rows;
    assert(size >= prevSize, `lvl${L}: field non-decreasing`);
    prevSize = size;
  }

  // На 1-м уровне максимальный тир зомби — zombieMinTypesL1 (по умолч. 3 типа: T1-T3).
  const onlyEarlyTiers = generateLevel(1).lanes.every((ln) =>
    ln.obstacles.every((o) => o.kind !== 'zombie' || (o.zombieTier ?? 1) <= 3),
  );
  assert(onlyEarlyTiers, 'lvl1: zombies only T1-T3');
}
