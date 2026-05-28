// Логика мердж-поля: индексация, спавн, мердж, перенос/swap, переполнение в инвентарь,
// вынос из инвентаря, изменение размера поля. Все функции оперируют переданным FieldState
// (мутируют его) — вызывающий сам персистит сейв.

import type { FieldState, WeaponTier } from '../types';
import { canMergeTier, nextTier } from './weapons';

export function cellCount(f: FieldState): number {
  return f.cols * f.rows;
}

export function indexOf(f: FieldState, col: number, row: number): number {
  return row * f.cols + col;
}

export function colOf(f: FieldState, index: number): number {
  return index % f.cols;
}

export function rowOf(f: FieldState, index: number): number {
  return Math.floor(index / f.cols);
}

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

export function placeAt(f: FieldState, index: number, tier: WeaponTier): boolean {
  if (index < 0 || index >= f.cells.length) return false;
  if (f.cells[index] != null) return false;
  f.cells[index] = tier;
  return true;
}

/** Положить в первую свободную клетку. Возвращает индекс или -1 если поле полно. */
export function placeFirstFree(f: FieldState, tier: WeaponTier): number {
  const i = firstFreeIndex(f);
  if (i === -1) return -1;
  f.cells[i] = tier;
  return i;
}

/**
 * «Умное» размещение: в свободную клетку, иначе — слить с такой же плиткой на поле
 * (даёт мерджабельную пару с тем что было раньше и спасает от тупиков на малых полях).
 * Возвращает true если поле изменилось.
 */
export function produceInto(f: FieldState, tier: WeaponTier): boolean {
  if (placeFirstFree(f, tier) !== -1) return true;
  if (!canMergeTier(tier)) return false;
  for (let i = 0; i < f.cells.length; i++) {
    if (f.cells[i] === tier) {
      f.cells[i] = nextTier(tier);
      return true;
    }
  }
  return false;
}

export function canMergeIndices(f: FieldState, a: number, b: number): boolean {
  if (a === b) return false;
  const ta = f.cells[a];
  const tb = f.cells[b];
  if (ta == null || tb == null) return false;
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

/** Положить лут: на поле в первую свободную, иначе в инвентарь. */
export function addLoot(
  f: FieldState,
  inventory: WeaponTier[],
  tier: WeaponTier,
): 'field' | 'inventory' {
  if (placeFirstFree(f, tier) !== -1) return 'field';
  inventory.push(tier);
  return 'inventory';
}

/**
 * Вынести предмет из инвентаря на поле: в свободную клетку, иначе — слить с такой же
 * плиткой на поле (если поле полно и есть совпадение по тиру). Спасает от тупиков.
 */
export function pullFromInventory(
  f: FieldState,
  inventory: WeaponTier[],
  invIndex: number,
): boolean {
  if (invIndex < 0 || invIndex >= inventory.length) return false;
  if (!produceInto(f, inventory[invIndex])) return false;
  inventory.splice(invIndex, 1);
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
