// Прогрессия: сбор арсеналов по столбцам, применение результатов боя, рост поля.

import type { SaveState, BattleResult, FieldState, WeaponTier } from '../types';
import { maxTier } from './weapons';
import { resizeField, placeFirstFree } from './merge';
import { getFieldSize, nextFieldSize } from './levelGen';
import { getBalance } from './balanceRuntime';
import { isWeaponCellValue, lootboxCode } from './lootbox';

/** Арсенал каждой линии = оружие соответствующего столбца поля (сверху вниз).
 *  Лутбоксы в клетках ИГНОРИРУЮТСЯ — у них нет тира, в бой не идут. */
export function laneArsenals(field: FieldState): WeaponTier[][] {
  const out: WeaponTier[][] = [];
  for (let c = 0; c < field.cols; c++) {
    const arr: WeaponTier[] = [];
    for (let r = 0; r < field.rows; r++) {
      const v = field.cells[r * field.cols + c];
      if (isWeaponCellValue(v)) arr.push(v);
    }
    out.push(arr);
  }
  return out;
}

/** Динамическая подкрутка наград: смотрим долю дошедших до сундука бойцов и
 *  обновляем state.rewardMultiplier + strongStreak/weakStreak. Применяется к
 *  СЛЕДУЮЩЕМУ уровню через levelGen (см. scaleBalance).
 *
 *  Правила (см. balance.dynamicDifficulty):
 *  • ratio ≥ strongChestRatio:
 *      strongStreak++; weakStreak=0.
 *      Если strongStreak ≥ strongStreakTrigger (default 3) → mult *= nerfStep (0.7).
 *  • reached == 0:
 *      weakStreak++; strongStreak=0; mult *= buffStep (1.5).  (срабатывает с 1-го раза)
 *  • иначе:
 *      оба streak'a сбрасываются, mult НЕ меняется (заморозка). */
function updateRewardTuning(state: SaveState, result: BattleResult): void {
  const dd = getBalance().dynamicDifficulty;
  const total = result.lanes.length;
  if (total === 0) return;
  const reached = result.lanes.filter(l => l.reachedChest).length;
  const ratio = reached / total;
  const clamp = (v: number): number => Math.max(dd.multMin, Math.min(dd.multMax, v));

  if (ratio >= dd.strongChestRatio) {
    state.strongStreak += 1;
    state.weakStreak = 0;
    if (state.strongStreak >= dd.strongStreakTrigger) {
      state.rewardMultiplier = clamp(state.rewardMultiplier * dd.nerfStep);
    }
  } else if (reached === 0) {
    state.weakStreak += 1;
    state.strongStreak = 0;
    state.rewardMultiplier = clamp(state.rewardMultiplier * dd.buffStep);
  } else {
    state.strongStreak = 0;
    state.weakStreak = 0;
    // rewardMultiplier остаётся как был — «заморозка».
  }
}

/**
 * Применить результат боя к сейву.
 *  • Оружие столбцов остаётся на поле (возвращается на места).
 *  • Собранный ЛУТ-ОРУЖИЕ всегда идёт в инвентарь (игрок сам решает, когда выносить).
 *  • Собранные ЛУТБОКСЫ кладутся в свободные клетки поля; если места нет — в инвентарь.
 *  • Пройденный уровень → +1 и рост поля + детерминированный апгрейд Цеха.
 *  • Динамическая подкрутка: на основе reached-ratio обновляем rewardMultiplier.
 */
export function applyBattleResult(state: SaveState, result: BattleResult): void {
  state.scrap += result.totalScrap;
  for (const tier of result.totalWeapons) state.inventory.push(tier);
  for (const kind of result.totalLootboxes) {
    const code = lootboxCode(kind);
    // Лутбокс — единственное, что по правилу «появляется на поле, иначе в инвентарь»
    // (в отличие от оружия, которое целенаправленно идёт в инвентарь).
    if (placeFirstFree(state.field, code) === -1) {
      state.inventory.push(code);
    }
  }
  state.stats.battlesRun += 1;

  updateRewardTuning(state, result);

  if (result.passed) {
    state.stats.battlesWon += 1;
    const passedLevel = state.level;
    state.level += 1;
    state.maxLevelReached = Math.max(state.maxLevelReached, state.level);

    // Детерминированный апгрейд Цеха после ключевых уровней.
    const upgrades = getBalance().workshop.upgradeAtLevels;
    if (Array.isArray(upgrades) && upgrades.includes(passedLevel)) {
      state.workshopTier = Math.min(maxTier(), state.workshopTier + 1);
    }

    // === Размер поля: ранний апгрейд (pendingFieldUpgrade) vs level-based threshold. ===
    // Берём ЛИБО стандартный размер по уровню, ЛИБО next-step если поднят флаг — макс из двух.
    // Никогда не shrink'аем (если current уже больше — оставляем как есть).
    const stdSize = getFieldSize(state.level);
    let targetSize: { cols: number; rows: number } = stdSize;
    if (state.pendingFieldUpgrade) {
      const early = nextFieldSize(state.field.cols, state.field.rows);
      if (early && early.cols * early.rows > targetSize.cols * targetSize.rows) {
        targetSize = early;
      }
      state.pendingFieldUpgrade = false;
    }
    if (targetSize.cols * targetSize.rows > state.field.cols * state.field.rows) {
      const overflow = resizeField(state.field, targetSize.cols, targetSize.rows);
      for (const t of overflow) state.inventory.push(t);
    }

    // === Триггер раннего апгрейда: лучшее оружие игрока ≥ cols×rows нового поля. ===
    // Флаг сработает на СЛЕДУЮЩЕМ завершённом уровне. Каскадирование возможно: если после
    // расширения оружие всё ещё ≥ cells (например T12 на 2×2 → 2×3 → 3×3 → ...), флаг
    // выставится снова и продолжит расширять поле по одному шагу за уровень.
    const currentBest = bestWeaponTier(state);
    const cells = state.field.cols * state.field.rows;
    if (currentBest >= cells) {
      state.pendingFieldUpgrade = true;
    }
  }
}

/** Лучший тир оружия у игрока (для контекста генерации уровня). Лутбоксы не считаются. */
export function bestWeaponTier(state: SaveState): number {
  let best = state.workshopTier; // как минимум — то, что производит цех
  for (const c of state.field.cells) if (isWeaponCellValue(c) && c > best) best = c;
  for (const v of state.inventory) if (isWeaponCellValue(v) && v > best) best = v;
  return best;
}
