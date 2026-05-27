// Детерминированная генерация уровня из баланса + номера уровня.
// Один и тот же level всегда даёт одинаковую раскладку (seed = номер уровня).

import type { Level, Lane, Obstacle, ZombieKind } from '../types';
import type { Balance } from '../config/balance';
import { getBalance } from './balanceRuntime';
import { makeRng, rint } from './rng';

/** Размер поля (и число линий = cols) для уровня. */
export function getFieldSize(level: number): { cols: number; rows: number } {
  const steps = getBalance().field.steps;
  let chosen = steps[0];
  for (const s of steps) if (level >= s.fromLevel) chosen = s;
  return { cols: chosen.cols, rows: chosen.rows };
}

export function generateLevel(level: number): Level {
  const b = getBalance();
  const rng = makeRng(Math.imul(level, 2654435761) ^ 0x9e3779b9);
  const { cols, rows } = getFieldSize(level);
  const roadLength = Math.round(
    b.levelGen.baseRoadLength + b.levelGen.roadLengthPerLevel * (level - 1),
  );
  const zombieCount = Math.max(
    1,
    Math.round(b.levelGen.baseZombieCount + b.levelGen.zombieCountPerLevel * (level - 1)),
  );
  const lanes: Lane[] = [];
  for (let c = 0; c < cols; c++) lanes.push(genLane(b, rng, level, zombieCount));
  return { number: level, cols, rows, roadLength, lanes };
}

function genLane(b: Balance, rng: () => number, level: number, zombieCount: number): Lane {
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
      obstacles.push({ kind: 'zombie', zombieKind: kind, hp: b.zombies[kind].hp, scrap: 0, weapon: false });
    }
  };
  // усложнение к концу линии: слабые -> средние -> сильные
  pushZombies('weak', weak);
  pushZombies('medium', medium);
  pushZombies('strong', strong);

  const crateCount = Math.round(zombieCount * b.levelGen.crateChance);
  for (let i = 0; i < crateCount; i++) {
    const pos = rint(rng, 0, obstacles.length);
    obstacles.splice(pos, 0, {
      kind: 'crate',
      hp: b.levelGen.crateHp,
      scrap: b.levelGen.scrapPerPile,
      weapon: rng() < b.levelGen.crateWeaponChance,
    });
  }

  const piles = rint(rng, b.levelGen.scrapPilesMin, b.levelGen.scrapPilesMax);
  for (let i = 0; i < piles; i++) {
    const pos = rint(rng, 0, obstacles.length);
    obstacles.splice(pos, 0, { kind: 'scrap', hp: 0, scrap: b.levelGen.scrapPerPile, weapon: false });
  }

  return {
    obstacles,
    chest: {
      scrap: rint(rng, b.chest.scrapMin, b.chest.scrapMax),
      weapon: rng() < b.chest.weaponChance,
      blueprint: rng() < b.chest.blueprintChance,
    },
  };
}
