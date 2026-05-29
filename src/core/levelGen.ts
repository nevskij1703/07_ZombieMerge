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
    const ratio = Math.min(b.levelGen.mediumCap, b.levelGen.mediumGrowthPerLevel * (level - b.levelGen.mediumFromLevel + 1));
    medium = Math.round(zombieCount * ratio);
  }
  if (level >= b.levelGen.strongFromLevel) {
    const ratio = Math.min(b.levelGen.strongCap, b.levelGen.strongGrowthPerLevel * (level - b.levelGen.strongFromLevel + 1));
    strong = Math.round(zombieCount * ratio);
  }
  const weak = Math.max(0, zombieCount - medium - strong);

  // Sort-with-jitter: размытое распределение. Без jitter — weak строго в начале, strong в
  // конце; с jitter>0 границы между типами «дышат» (по тз — блендинг, не жёсткие стены).
  const jitter = b.levelGen.zombieOrderJitter ?? 0;
  const lineup: ZombieKind[] = [];
  for (let i = 0; i < weak; i++) lineup.push('weak');
  for (let i = 0; i < medium; i++) lineup.push('medium');
  for (let i = 0; i < strong; i++) lineup.push('strong');
  const positioned = lineup.map((k, i) => ({ kind: k, pos: i + (jitter > 0 ? (rng() - 0.5) * 2 * jitter : 0) }));
  positioned.sort((a, b) => a.pos - b.pos);

  const obstacles: Obstacle[] = [];
  for (const item of positioned) {
    obstacles.push({ kind: 'zombie', zombieKind: item.kind, hp: b.zombies[item.kind].hp, scrap: 0 });
  }

  // Per-lane: с шансом crateLaneChance — ровно ОДНА коробка, иначе никакой.
  if (rng() < b.levelGen.crateLaneChance) {
    const pos = rint(rng, 0, obstacles.length);
    const givesWeapon = rng() < b.levelGen.crateWeaponChance;
    // По тз: коробка имеет HP в ~2× HP сильнейшего зомби на уровне (динамически).
    const strongestHp = Math.max(
      b.zombies.weak.hp,
      medium > 0 ? b.zombies.medium.hp : 0,
      strong > 0 ? b.zombies.strong.hp : 0,
    );
    const crateHp = Math.max(1, Math.round(strongestHp * (b.levelGen.crateHpMultiplier ?? 2)));
    obstacles.splice(pos, 0, {
      kind: 'crate',
      hp: crateHp,
      scrap: b.levelGen.scrapPerPile,
      givesWeapon,
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
