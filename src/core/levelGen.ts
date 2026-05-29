// Детерминированная генерация уровня из баланса + номера уровня + контекста игрока.
// Один и тот же (level, workshopTier, bestTier) всегда даёт одинаковую раскладку.

import type { Level, Lane, Obstacle, WeaponTier, ChestDef, LootboxKind, ChestRewardKind } from '../types';
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
  // Гарантия из тз: на L1 минимум N типов зомби (по дефолту 3) должны быть видны.
  // Если рандом не дал нужное разнообразие — досвопаем «дубликаты» в недостающие тиры.
  if (level === 1) {
    enforceMinTypes(lanes, b, level);
  }
  return { number: level, cols, rows, roadLength, lanes };
}

/** Гарантируем, что в уровне видны минимум N разных тиров зомби (по тз для L1 = 3).
 *  Если не хватает — заменяем «дубликаты» на недостающие тиры. */
function enforceMinTypes(lanes: Lane[], b: Balance, level: number): void {
  const minTypes = b.levelGen.zombieMinTypesL1 ?? 3;
  const tierMax = maxZombieTierForLevel(b, level);
  const target = Math.min(minTypes, tierMax);

  const present = new Set<number>();
  const collectPresent = (): void => {
    present.clear();
    for (const lane of lanes) {
      for (const ob of lane.obstacles) {
        if (ob.kind === 'zombie' && ob.zombieTier !== undefined) present.add(ob.zombieTier);
      }
    }
  };
  collectPresent();

  for (let t = 1; t <= target; t++) {
    if (present.has(t)) continue;
    // Ищем «дубликат» (тир, представленный более 1 раза) для замены — чтобы не убить другой тип.
    const counts = new Map<number, number>();
    for (const lane of lanes) {
      for (const ob of lane.obstacles) {
        if (ob.kind === 'zombie' && ob.zombieTier !== undefined) {
          counts.set(ob.zombieTier, (counts.get(ob.zombieTier) ?? 0) + 1);
        }
      }
    }
    let swapped = false;
    for (const lane of lanes) {
      for (const ob of lane.obstacles) {
        if (ob.kind !== 'zombie' || ob.zombieTier === undefined) continue;
        if ((counts.get(ob.zombieTier) ?? 0) > 1) {
          ob.zombieTier = t;
          ob.hp = b.zombies[t]?.hp ?? 1;
          swapped = true;
          break;
        }
      }
      if (swapped) break;
    }
    if (swapped) collectPresent();
    // Если зомби недостаточно (нет дубликата) — просто пропускаем недостающий тир.
  }
}

/** Максимальный тир зомби, доступный на этом уровне (по тз: L1=3, L5+=12, плавный рост).
 *  Округляем ВНИЗ — чтобы средние уровни не вылетали слишком жёсткими тирами. */
function maxZombieTierForLevel(b: Balance, level: number): number {
  const minTypes = b.levelGen.zombieMinTypesL1 ?? 3;
  const allFrom = b.levelGen.zombieAllTypesFromLevel ?? 5;
  if (level <= 1) return Math.min(12, minTypes);
  if (level >= allFrom) return 12;
  const span = 12 - minTypes;
  const grown = minTypes + Math.floor(((level - 1) * span) / (allFrom - 1));
  return Math.min(12, Math.max(minTypes, grown));
}

/** Сэмплирует тир одного зомби по уровню. На L1 — равномерное распределение по T1-T3
 *  (гарантирует, что все доступные тиры реально видны игроку). С L2+ — гауссиан вокруг
 *  «центра» (растёт с level) + лёгкий wildcard. */
function sampleZombieTier(b: Balance, rng: () => number, level: number): number {
  const tierMax = maxZombieTierForLevel(b, level);
  if (level <= 1) {
    return 1 + Math.floor(rng() * tierMax);
  }
  const center = Math.min(12, 1 + (level - 1) * (b.levelGen.zombieTierGrowthPerLevel ?? 0.3));
  const spread = Math.max(0.5, b.levelGen.zombieTierSpread ?? 3);
  const wildcard = Math.max(0, Math.min(1, b.levelGen.zombieTierWildcardShare ?? 0.3));

  const weights: number[] = [];
  let total = 0;
  for (let t = 1; t <= tierMax; t++) {
    const gauss = Math.exp(-(((t - center) / spread) ** 2));
    const w = (1 - wildcard) * gauss + wildcard / tierMax;
    weights.push(w);
    total += w;
  }
  let r = rng() * total;
  for (let t = 1; t <= tierMax; t++) {
    r -= weights[t - 1];
    if (r <= 0) return t;
  }
  return tierMax;
}

function genLane(
  b: Balance,
  rng: () => number,
  level: number,
  zombieCount: number,
  playerCtx: LevelGenContext,
): Lane {
  // Сэмплируем тир для каждого зомби в линии.
  const tiers: number[] = [];
  for (let i = 0; i < zombieCount; i++) {
    tiers.push(sampleZombieTier(b, rng, level));
  }

  // Sort-with-jitter: лёгкие в начале, тяжёлые в конце, но границы «дышат».
  tiers.sort((a, c) => a - c);
  const jitter = b.levelGen.zombieOrderJitter ?? 0;
  const positioned = tiers.map((tier, i) => ({
    tier,
    pos: i + (jitter > 0 ? (rng() - 0.5) * 2 * jitter : 0),
  }));
  positioned.sort((a, c) => a.pos - c.pos);

  const obstacles: Obstacle[] = [];
  let maxZombieHpInLane = 0;
  for (const item of positioned) {
    const def = b.zombies[item.tier];
    const hp = def?.hp ?? 1;
    if (hp > maxZombieHpInLane) maxZombieHpInLane = hp;
    obstacles.push({ kind: 'zombie', zombieTier: item.tier, hp, scrap: 0 });
  }

  // Per-lane: с шансом crateLaneChance — ровно ОДНА коробка, иначе никакой.
  if (rng() < b.levelGen.crateLaneChance) {
    const pos = rint(rng, 0, obstacles.length);
    const givesWeapon = rng() < b.levelGen.crateWeaponChance;
    // По тз: коробка имеет HP в ~2× HP сильнейшего зомби В ЭТОЙ ЛИНИИ (динамически).
    const refHp = maxZombieHpInLane > 0 ? maxZombieHpInLane : (b.zombies[1]?.hp ?? 1);
    const crateHp = Math.max(1, Math.round(refHp * (b.levelGen.crateHpMultiplier ?? 2)));
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
