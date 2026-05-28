// Детерминированная генерация уровня из баланса + номера уровня + контекста игрока.
// Один и тот же (level, workshopTier, bestTier) всегда даёт одинаковую раскладку.

import type { Level, Lane, Obstacle, WeaponTier, ZombieKind, ChestDef, LootboxKind, ChestRewardKind } from '../types';
import type { Balance } from '../config/balance';
import { getBalance } from './balanceRuntime';
import { makeRng, rint } from './rng';
import { maxTier } from './weapons';

/** Контекст игрока для генерации тиров наград (коробки, сундуки). */
export interface LevelGenContext {
  workshopTier: number;
  /** Лучший тир оружия у игрока в данный момент (поле + инвентарь, исключая лутбоксы). */
  bestTier: number;
}

function clampTier(t: number): WeaponTier {
  return Math.max(1, Math.min(maxTier(), Math.round(t)));
}

/** Случайный выбор по нормализованным весам. */
function weightedPick<T extends string>(rng: () => number, weights: Record<T, number>): T {
  const keys = Object.keys(weights) as T[];
  let total = 0;
  for (const k of keys) total += Math.max(0, weights[k]);
  if (total <= 0) return keys[0]!;
  let r = rng() * total;
  for (const k of keys) {
    r -= Math.max(0, weights[k]);
    if (r <= 0) return k;
  }
  return keys[keys.length - 1]!;
}

/** Размер поля (и число линий = cols) для уровня. */
export function getFieldSize(level: number): { cols: number; rows: number } {
  const steps = getBalance().field.steps;
  let chosen = steps[0];
  for (const s of steps) if (level >= s.fromLevel) chosen = s;
  return { cols: chosen.cols, rows: chosen.rows };
}

export function generateLevel(level: number, ctx?: LevelGenContext): Level {
  const b = getBalance();
  const rng = makeRng(Math.imul(level, 2654435761) ^ 0x9e3779b9);
  const { cols, rows } = getFieldSize(level);
  const roadLength = Math.round(
    b.levelGen.baseRoadLength + b.levelGen.roadLengthPerLevel * (level - 1),
  );
  const baseZombieCount = Math.max(
    1,
    Math.round(b.levelGen.baseZombieCount + b.levelGen.zombieCountPerLevel * (level - 1)),
  );
  const spread = b.levelGen.laneDifficultySpread ?? 0;
  // Если контекста нет (например, autotest без передачи) — используем разумные дефолты:
  // workshop=1, best=1. Это упрощает миграцию вызовов.
  const playerCtx: LevelGenContext = {
    workshopTier: ctx?.workshopTier ?? 1,
    bestTier: Math.max(1, ctx?.bestTier ?? 1),
  };

  const lanes: Lane[] = [];
  for (let c = 0; c < cols; c++) {
    // Множитель сложности этой линии — детерминированно из seed-rng, разный для каждой линии и
    // уровня. Так игрок не угадает «крайняя левая всегда лёгкая» и не разложит оружие шаблонно.
    const factor = spread > 0 ? 1 + (rng() * 2 - 1) * spread : 1;
    const laneZombies = Math.max(1, Math.round(baseZombieCount * factor));
    lanes.push(genLane(b, rng, level, laneZombies, playerCtx));
  }
  return { number: level, cols, rows, roadLength, lanes };
}

function genLane(
  b: Balance,
  rng: () => number,
  level: number,
  zombieCount: number,
  playerCtx: LevelGenContext,
): Lane {
  let medium = 0;
  let strong = 0;
  if (level >= b.levelGen.mediumFromLevel) {
    medium = Math.round(zombieCount * Math.min(0.5, 0.12 * (level - b.levelGen.mediumFromLevel + 1)));
  }
  if (level >= b.levelGen.strongFromLevel) {
    strong = Math.round(zombieCount * Math.min(0.4, 0.08 * (level - b.levelGen.strongFromLevel + 1)));
  }
  const weak = Math.max(0, zombieCount - medium - strong);

  const obstacles: Obstacle[] = [];
  const pushZombies = (kind: ZombieKind, n: number): void => {
    for (let i = 0; i < n; i++) {
      obstacles.push({ kind: 'zombie', zombieKind: kind, hp: b.zombies[kind].hp, scrap: 0 });
    }
  };
  // усложнение к концу линии: слабые -> средние -> сильные
  pushZombies('weak', weak);
  pushZombies('medium', medium);
  pushZombies('strong', strong);

  // Per-lane: с шансом crateLaneChance — ровно ОДНА коробка, иначе никакой.
  if (rng() < b.levelGen.crateLaneChance) {
    const pos = rint(rng, 0, obstacles.length);
    const hasWeapon = rng() < b.levelGen.crateWeaponChance;
    // Тир оружия в коробке = best + offset (по тз — НИЖЕ лучшего на 1-2 разряда).
    let crateWeaponTier: WeaponTier | undefined;
    if (hasWeapon) {
      const off = rint(rng, b.levelGen.crateWeaponOffsetMin, b.levelGen.crateWeaponOffsetMax);
      crateWeaponTier = clampTier(playerCtx.bestTier + off);
    }
    obstacles.splice(pos, 0, {
      kind: 'crate',
      hp: b.levelGen.crateHp,
      scrap: b.levelGen.scrapPerPile,
      weaponTier: crateWeaponTier,
    });
  }

  const piles = rint(rng, b.levelGen.scrapPilesMin, b.levelGen.scrapPilesMax);
  for (let i = 0; i < piles; i++) {
    const pos = rint(rng, 0, obstacles.length);
    obstacles.splice(pos, 0, { kind: 'scrap', hp: 0, scrap: b.levelGen.scrapPerPile });
  }

  // Сундук: ровно ОДНА награда (взвешенно).
  const chest: ChestDef = makeChest(b, rng, playerCtx);
  return { obstacles, chest };
}

function makeChest(b: Balance, rng: () => number, playerCtx: LevelGenContext): ChestDef {
  const reward = weightedPick<ChestRewardKind>(rng, {
    scrap: b.chest.rewardWeights.scrap,
    weapon: b.chest.rewardWeights.weapon,
    lootbox: b.chest.rewardWeights.lootbox,
  });
  if (reward === 'scrap') {
    return { reward, scrap: rint(rng, b.chest.scrapMin, b.chest.scrapMax) };
  }
  if (reward === 'weapon') {
    const off = rint(rng, b.chest.chestWeaponOffsetMin, b.chest.chestWeaponOffsetMax);
    return { reward, weaponTier: clampTier(playerCtx.workshopTier + off) };
  }
  // lootbox: medium vs elite по доле mediumShare (4:1 → 0.8)
  const lootboxKind: LootboxKind = rng() < b.lootbox.mediumShare ? 'medium' : 'elite';
  return { reward, lootboxKind };
}
