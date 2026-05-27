// ЕДИНЫЙ источник правды по балансу. Крутим ЧИСЛА здесь, логику в core/* не трогаем.
// Редактируется на лету из дев-панели (вкладка Баланс) через override. См. docs/BALANCE.md.
// Значения — стартовые/отладочные, доводятся на этапе 10.

import type { ZombieKind } from '../types';

export interface WeaponDef {
  name: string;
  /** Урон за один удар/выстрел (скрыт от игрока). */
  damagePerHit: number;
  /** Сколько ударов до истощения оружия (выносливость/боезапас, скрыт). */
  hits: number;
}

export interface FieldSizeStep {
  fromLevel: number;
  cols: number;
  rows: number;
}

export interface ZombieDef {
  hp: number;
}

export interface ChestReward {
  scrapMin: number;
  scrapMax: number;
  /** Шанс (0..1) что в сундуке будет оружие. */
  weaponChance: number;
  /** Тир оружия из сундука = workshopTier + этот сдвиг. */
  weaponTierOffset: number;
  /** Шанс (0..1) чертежа (апгрейд тира Мастерской). */
  blueprintChance: number;
}

export interface LevelGenConfig {
  /** Длина дороги (условные «слоты») на 1-м уровне. */
  baseRoadLength: number;
  roadLengthPerLevel: number;
  baseZombieCount: number;
  zombieCountPerLevel: number;
  /** С какого уровня в составе появляются средние / сильные зомби. */
  mediumFromLevel: number;
  strongFromLevel: number;
  /** Вероятность (0..1) что слот препятствия — ящик (а не зомби). */
  crateChance: number;
  crateHp: number;
  /** Сколько куч металлолома на дороге и сколько в каждой. */
  scrapPilesMin: number;
  scrapPilesMax: number;
  scrapPerPile: number;
}

export interface Balance {
  maxTier: number;
  weapons: Record<number, WeaponDef>;
  workshop: {
    startTier: number;
    /** Цена спавна оружия тира T в металлоломе. */
    produceCostByTier: Record<number, number>;
  };
  field: {
    steps: FieldSizeStep[];
  };
  zombies: Record<ZombieKind, ZombieDef>;
  levelGen: LevelGenConfig;
  chest: ChestReward;
  economy: {
    startScrap: number;
    startDiamonds: number;
  };
}

export const balance: Balance = {
  maxTier: 12,

  weapons: {
    1: { name: 'Труба', damagePerHit: 2, hits: 6 },
    2: { name: 'Лом', damagePerHit: 3, hits: 8 },
    3: { name: 'Топор', damagePerHit: 5, hits: 10 },
    4: { name: 'Нож', damagePerHit: 7, hits: 12 },
    5: { name: 'Катана', damagePerHit: 10, hits: 16 },
    6: { name: 'Пистолет', damagePerHit: 14, hits: 20 },
    7: { name: 'Узи', damagePerHit: 20, hits: 26 },
    8: { name: 'Автомат', damagePerHit: 28, hits: 34 },
    9: { name: 'Пулемёт', damagePerHit: 40, hits: 44 },
    10: { name: 'Гранатомёт', damagePerHit: 56, hits: 56 },
    11: { name: 'Огнемёт', damagePerHit: 78, hits: 72 },
    12: { name: 'Рейлган', damagePerHit: 110, hits: 92 },
  },

  workshop: {
    startTier: 1,
    produceCostByTier: {
      1: 10,
      2: 14,
      3: 20,
      4: 28,
      5: 40,
      6: 56,
      7: 78,
      8: 108,
      9: 150,
      10: 210,
      11: 290,
      12: 400,
    },
  },

  field: {
    steps: [
      { fromLevel: 1, cols: 2, rows: 2 },
      { fromLevel: 3, cols: 2, rows: 3 },
      { fromLevel: 6, cols: 3, rows: 3 },
      { fromLevel: 10, cols: 3, rows: 4 },
      { fromLevel: 16, cols: 4, rows: 4 },
      { fromLevel: 24, cols: 4, rows: 5 },
      { fromLevel: 34, cols: 5, rows: 5 },
    ],
  },

  zombies: {
    weak: { hp: 6 },
    medium: { hp: 18 },
    strong: { hp: 45 },
  },

  levelGen: {
    baseRoadLength: 8,
    roadLengthPerLevel: 0.6,
    baseZombieCount: 4,
    zombieCountPerLevel: 0.7,
    mediumFromLevel: 6,
    strongFromLevel: 16,
    crateChance: 0.18,
    crateHp: 12,
    scrapPilesMin: 1,
    scrapPilesMax: 3,
    scrapPerPile: 8,
  },

  chest: {
    scrapMin: 20,
    scrapMax: 60,
    weaponChance: 0.6,
    weaponTierOffset: 0,
    blueprintChance: 0.25,
  },

  economy: {
    startScrap: 50,
    startDiamonds: 0,
  },
};
