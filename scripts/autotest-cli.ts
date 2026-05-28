// Headless-прогон autotest из CLI: npx tsx scripts/autotest-cli.ts
// Заглушает window/localStorage (autotest и DEFAULT_STATE не зависят от LS, но balanceRuntime
// может попытаться прочитать override — там есть safe guards).
//
// Назначение: быстрая проверка баланса после правок (без открытия dev-панели).

if (typeof globalThis.localStorage === 'undefined') {
  // Минимальный shim — нам ничего из LS не нужно, balanceRuntime просто видит «override = нет».
  const store: Record<string, string> = {};
  // @ts-expect-error глобальный shim для node
  globalThis.localStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length(): number {
      return Object.keys(store).length;
    },
  };
}

import { runAutotest } from '../src/core/autotest';

const rep = runAutotest(50);

const lanePassRates = rep.samples.map((s) => s.lanesReached / Math.max(1, s.lanesTotal));
const avg = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const range = (label: string, from: number, to: number): void => {
  const slice = rep.samples.filter((s) => s.level >= from && s.level <= to);
  if (slice.length === 0) return;
  const rates = slice.map((s) => s.lanesReached / Math.max(1, s.lanesTotal));
  const att = slice.map((s) => s.attempts);
  const prod = slice.map((s) => s.weaponsProduced);
  console.log(
    `  L${from}-${to}: ${(avg(rates) * 100).toFixed(0)}% линий → сундук, ${avg(att).toFixed(1)} попыток/ур, ${avg(prod).toFixed(1)} оружий произведено/ур`,
  );
};

console.log('=== AUTOTEST REPORT ===');
console.log(`Дошёл до уровня: ${rep.reachedLevel}/${rep.totalLevels} (${rep.finished ? 'FINISHED' : 'STUCK at L' + rep.stuckAt})`);
console.log(`Всего произведено оружий: ${rep.totalProduced}`);
console.log(`Чертежей: ${rep.totalBlueprints}`);
console.log('');
console.log('Средняя доля линий, дошедших до сундука (по диапазонам):');
range('early', 1, 10);
range('mid-low', 11, 20);
range('mid', 21, 30);
range('mid-high', 31, 40);
range('end', 41, 50);
console.log('');
console.log(`Средний lane-pass-rate по всей кампании: ${(avg(lanePassRates) * 100).toFixed(1)}%`);
const totalLanes = rep.samples.reduce((a, s) => a + s.lanesTotal, 0);
const totalReached = rep.samples.reduce((a, s) => a + s.lanesReached, 0);
console.log(`Всего линий: ${totalLanes}, дошло: ${totalReached} (${((totalReached / totalLanes) * 100).toFixed(1)}%)`);

// Уровни, где упал ниже половины линий — кандидаты на «сложно»
const tough = rep.samples.filter((s) => s.lanesReached < s.lanesTotal / 2);
console.log(`Уровней где <50% линий дошли: ${tough.length} (${tough.slice(0, 8).map((s) => `L${s.level}=${s.lanesReached}/${s.lanesTotal}`).join(', ')}${tough.length > 8 ? '...' : ''})`);

const allClear = rep.samples.filter((s) => s.lanesReached === s.lanesTotal);
console.log(`Уровней где ВСЕ линии дошли: ${allClear.length}/${rep.samples.length} (${((allClear.length / rep.samples.length) * 100).toFixed(0)}%)`);
