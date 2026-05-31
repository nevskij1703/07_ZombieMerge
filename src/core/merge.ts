// Логика мердж-поля: индексация, спавн, мердж, перенос/swap, переполнение в инвентарь,
// вынос из инвентаря, изменение размера поля. Все функции оперируют переданным FieldState
// (мутируют его) — вызывающий сам персистит сейв.

import type { FieldState, WeaponTier } from '../types';
import { canMergeTier, nextTier } from './weapons';
import { isWeaponCellValue } from './lootbox';

export function firstFreeIndex(f: FieldState): number {
  for (let i = 0; i < f.cells.length; i++) if (f.cells[i] == null) return i;
  return -1;
}

export function isFull(f: FieldState): boolean {
  return firstFreeIndex(f) === -1;
}

export function freeCount(f: FieldState): number {
  let n = 0;
  for (const c of f.cells) if (c == null) n++;
  return n;
}

/** Положить в первую свободную клетку. Возвращает индекс или -1 если поле полно. */
export function placeFirstFree(f: FieldState, tier: WeaponTier): number {
  const i = firstFreeIndex(f);
  if (i === -1) return -1;
  f.cells[i] = tier;
  return i;
}

export function canMergeIndices(f: FieldState, a: number, b: number): boolean {
  if (a === b) return false;
  const ta = f.cells[a];
  const tb = f.cells[b];
  // Лутбоксы не мерджатся (хранятся в клетках как спец-коды).
  if (!isWeaponCellValue(ta) || !isWeaponCellValue(tb)) return false;
  return ta === tb && canMergeTier(ta);
}

/** Слить from -> to. Результат кладётся в to, from очищается. Возвращает новый тир либо null. */
export function mergeInto(f: FieldState, from: number, to: number): WeaponTier | null {
  if (!canMergeIndices(f, from, to)) return null;
  const result = nextTier(f.cells[to] as WeaponTier);
  f.cells[to] = result;
  f.cells[from] = null;
  return result;
}

/** Перетаскивание: to пусто — перенос; иначе swap. (Мердж проверяй до вызова через canMergeIndices.) */
export function moveOrSwap(f: FieldState, from: number, to: number): void {
  if (from === to) return;
  const a = f.cells[from];
  f.cells[from] = f.cells[to];
  f.cells[to] = a;
}

/** Положить лут: в свободную клетку, иначе в инвентарь. */
export function addLoot(
  f: FieldState,
  inventory: WeaponTier[],
  tier: WeaponTier,
): 'field' | 'inventory' {
  if (placeFirstFree(f, tier) !== -1) return 'field';
  inventory.push(tier);
  return 'inventory';
}

/** Достать ВЕРХ стека инвентаря (последний добытый) и положить в случайную свободную
 *  клетку поля. Инвентарь визуально однослотовый бесконечный стек — поэтому индекс не
 *  принимается, всегда pop с конца. Возвращает false, если стек пуст или поле full. */
export function pullFromInventory(
  f: FieldState,
  inventory: WeaponTier[],
  rng: () => number = Math.random,
): boolean {
  if (inventory.length === 0) return false;
  // Собираем индексы всех свободных клеток.
  const free: number[] = [];
  for (let i = 0; i < f.cells.length; i++) if (f.cells[i] == null) free.push(i);
  if (free.length === 0) return false;
  const item = inventory.pop();
  if (item == null) return false;
  const cellIdx = free[Math.floor(rng() * free.length)]!;
  f.cells[cellIdx] = item;
  return true;
}

/**
 * Изменить размер поля, сохранив предметы (компактно, слева-направо/сверху-вниз).
 * Возвращает предметы, не поместившиеся в новый размер (для отправки в инвентарь).
 * В игре поле только растёт, поэтому overflow обычно пустой.
 */
export function resizeField(f: FieldState, cols: number, rows: number): WeaponTier[] {
  const need = cols * rows;
  const items = f.cells.filter((c): c is WeaponTier => c != null);
  const cells: (WeaponTier | null)[] = new Array(need).fill(null);
  const fit = Math.min(items.length, need);
  for (let i = 0; i < fit; i++) cells[i] = items[i];
  f.cols = cols;
  f.rows = rows;
  f.cells = cells;
  return items.slice(fit);
}
