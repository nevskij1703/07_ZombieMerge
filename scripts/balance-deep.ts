// DEEP балансовая проверка — полный прогон 50 уровней с разбивкой по диапазонам.
// По умолчанию НЕ запускать (см. правила в CLAUDE.md). Использовать только когда нужен
// полный аудит или явный запрос пользователя «прогон полностью».
// Для быстрой проверки — `scripts/balance-quick.ts` (L5/L25/L50, ~5 строк).
//
// Запуск: `npx tsx scripts/balance-deep.ts`

import './_shim';
import { runAutotest } from '../src/core/autotest';
import { generateLevel } from '../src/core/levelGen';

// Дамп первых 5 уровней — какие зомби генерятся (диагностика баланса тиров).
// Полезно при тюнинге распределения; в продакшне не выполняется.
console.log('=== УРОВНИ 1-5: состав зомби (тиры) ===');
for (let L = 1; L <= 5; L++) {
  const lvl = generateLevel(L, { workshopTier: 1, bestTier: 1 });
  const laneSummaries = lvl.lanes.map((ln, i) => {
    const zombies = ln.obstacles.filter((o) => o.kind === 'zombie');
    const tiers = zombies.map((z) => z.zombieTier ?? 0);
    const totalHp = zombies.reduce((a, z) => a + z.hp, 0);
    return `L${i + 1}: [${tiers.join(',')}] HP=${totalHp}`;
  });
  console.log(`Lvl ${L}: ${laneSummaries.join('  ')}`);
}
console.log('');

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
console.log(`Лутбоксов выпало: ${rep.totalLootboxes}`);
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
