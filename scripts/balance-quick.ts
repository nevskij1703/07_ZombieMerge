// QUICK балансовая проверка: только 3 контрольных точки (L5, L25, L50).
// Цель — быстро убедиться, что прогрессия не сломана. ~5 строк вывода.
// Глубокий прогон 50 уровней — `scripts/balance-deep.ts`.
//
// Запуск: `npx tsx scripts/balance-quick.ts`

import './_shim';
import { runAutotest } from '../src/core/autotest';

const rep = runAutotest(50);

const checkpoints = [5, 25, 50];
console.log('=== Balance QUICK check (L5 / L25 / L50) ===');
console.log(rep.finished ? `OK: пройдено ${rep.reachedLevel}/50` : `STUCK at L${rep.stuckAt} (дошёл ${rep.reachedLevel}/50)`);

for (const L of checkpoints) {
  const s = rep.samples[L - 1];
  if (!s) {
    console.log(`L${L}: НЕ ДОСТИГНУТ`);
    continue;
  }
  const pct = ((s.lanesReached / Math.max(1, s.lanesTotal)) * 100).toFixed(0);
  console.log(
    `L${L}: ${pct}% линий, ${s.attempts}× попыток, поле T${s.fieldMaxTier}, цех T${s.workshopTier}, инв ${s.inventorySize}`,
  );
}
