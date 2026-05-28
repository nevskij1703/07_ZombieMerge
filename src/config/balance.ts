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
  /** Если выпала награда `scrap` — этот диапазон случайного количества лома. */
  scrapMin: number;
  scrapMax: number;
  /** Веса наград в сундуке (нормализуются). Ровно одна выпадает. */
  rewardWeights: { scrap: number; weapon: number; lootbox: number };
  /** Тир оружия в сундуке = workshopTier + uniform[chestWeaponOffsetMin..chestWeaponOffsetMax].
   *  Симметричный диапазон ±2 даёт «как у игрока, иногда чуть лучше/хуже». */
  chestWeaponOffsetMin: number;
  chestWeaponOffsetMax: number;
}

export interface LootboxBalance {
  /** Доля medium среди выпавших лутбоксов (4:1 = mediumShare 0.8). */
  mediumShare: number;
  /** Тир оружия в medium-лутбоксе = workshopTier + uniform[mediumOffsetMin..mediumOffsetMax]. */
  mediumOffsetMin: number;
  mediumOffsetMax: number;
  /** Тир оружия в elite-лутбоксе = bestTier + uniform[eliteOffsetMin..eliteOffsetMax].
   *  Отрицательные значения = ниже лучшего тира игрока (всё равно обычно лучше workshop). */
  eliteOffsetMin: number;
  eliteOffsetMax: number;
}

export interface TrashBalance {
  /** Доля от стоимости производства, которая возвращается за удаление оружия в трэш. */
  refundRatio: number;
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
  /** Вероятность (0..1) что ДАННАЯ линия получит ОДНУ коробку. Применяется per-lane:
   *  rng()<crateLaneChance → линия имеет 1 коробку, иначе — ноль. (Раньше было per-obstacle
   *  и плодило слишком много коробок; коробки теперь редкое сильное событие.) */
  crateLaneChance: number;
  crateHp: number;
  /** Вероятность (0..1) что разбитый ящик роняет оружие (иначе только лом). */
  crateWeaponChance: number;
  /** Тир оружия в коробке = bestTier + uniform[crateWeaponOffsetMin..crateWeaponOffsetMax].
   *  Отрицательные значения — оружие НИЖЕ лучшего у игрока (по тз: -1..-2). */
  crateWeaponOffsetMin: number;
  crateWeaponOffsetMax: number;
  /** Сколько куч металлолома на дороге и сколько в каждой. */
  scrapPilesMin: number;
  scrapPilesMax: number;
  scrapPerPile: number;
  /** Разброс «нагрузки» между линиями одного уровня: множитель кол-ва зомби в линии
   *  выбирается из [1-spread, 1+spread]. 0 — все линии одинаковые. 0.4 — линии могут
   *  быть от 60% до 140% базового зомби-бюджета (player не может стабильно угадать,
   *  куда ставить топовое оружие). */
  laneDifficultySpread: number;
}

export interface Balance {
  maxTier: number;
  weapons: Record<number, WeaponDef>;
  workshop: {
    startTier: number;
    /** Цена спавна оружия тира T в металлоломе. */
    produceCostByTier: Record<number, number>;
    /**
     * Уровни, после прохождения которых Цех ГАРАНТИРОВАННО получает +1 тир производства.
     * Применяется в `applyBattleResult` независимо от рандома сундуков — задаёт детерминированную
     * кривую отставания «лучшее оружие на поле vs тир производства».
     */
    upgradeAtLevels: number[];
  };
  field: {
    steps: FieldSizeStep[];
  };
  zombies: Record<ZombieKind, ZombieDef>;
  levelGen: LevelGenConfig;
  chest: ChestReward;
  lootbox: LootboxBalance;
  trash: TrashBalance;
  economy: {
    startScrap: number;
    startDiamonds: number;
  };
}

export const balance: Balance = {
  maxTier: 12,

  // Ресурс — линейный N+3 (T1=4 ... T12=15). Оружия быстрее выходят из строя,
  // нужно чаще производить/мерджить. damagePerHit — без изменений.
  weapons: {
    1: { name: 'Труба', damagePerHit: 2, hits: 4 },
    2: { name: 'Лом', damagePerHit: 3, hits: 5 },
    3: { name: 'Топор', damagePerHit: 5, hits: 6 },
    4: { name: 'Нож', damagePerHit: 7, hits: 7 },
    5: { name: 'Катана', damagePerHit: 10, hits: 8 },
    6: { name: 'Пистолет', damagePerHit: 14, hits: 9 },
    7: { name: 'Узи', damagePerHit: 20, hits: 10 },
    8: { name: 'Автомат', damagePerHit: 28, hits: 11 },
    9: { name: 'Пулемёт', damagePerHit: 40, hits: 12 },
    10: { name: 'Гранатомёт', damagePerHit: 56, hits: 13 },
    11: { name: 'Огнемёт', damagePerHit: 78, hits: 14 },
    12: { name: 'Рейлган', damagePerHit: 110, hits: 15 },
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
    // Цех 1→4 к L22; дальше не растёт — гэп с Полем (растёт к 12) расширяется к эндгейму.
    upgradeAtLevels: [4, 12, 22],
  },

  field: {
    steps: [
      { fromLevel: 1, cols: 2, rows: 2 },
      { fromLevel: 4, cols: 2, rows: 3 },
      { fromLevel: 8, cols: 3, rows: 3 },
      { fromLevel: 14, cols: 3, rows: 4 },
      { fromLevel: 20, cols: 4, rows: 4 },
      { fromLevel: 28, cols: 4, rows: 5 },
      { fromLevel: 40, cols: 5, rows: 5 },
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
    // Цель: ~50-60% линий дошли до сундука в среднем (часть валится, но прогрессия до L50
    // проходима). Сложность держит низкий ресурс оружий (T1=4 ... T12=15) и редкие коробки.
    // См. scripts/autotest-cli.ts.
    baseZombieCount: 3,
    // С лутбоксами игрок получает «бесплатные» оружия из сундуков — сложность зомби
    // должна расти быстрее, иначе late-game становится тривиальным.
    zombieCountPerLevel: 1.5,
    mediumFromLevel: 6,
    strongFromLevel: 16,
    // ПЕРЕИМЕНОВАНИЕ И СЕМАНТИКА: per-lane (вместо per-obstacle). Половина линий получит ОДНУ
    // коробку, остальные — ноль. Если в локальном override был старый ключ crateChance, он будет
    // проигнорирован (semantically incompatible).
    crateLaneChance: 0.5,
    crateHp: 12,
    // Раз коробки редкие — пусть, когда выпадают, дают оружие чаще (было 0.3, стало 0.6).
    crateWeaponChance: 0.6,
    // По тз: «оружие в коробках — на 1-2 разряда меньше чем самое сильное у игрока».
    crateWeaponOffsetMin: -2,
    crateWeaponOffsetMax: -1,
    // Кучи лома на дороге — основной источник скрапа теперь, когда сундук даёт лом только
    // в 15% случаев (остальное — оружие/лутбоксы).
    scrapPilesMin: 2,
    scrapPilesMax: 3,
    scrapPerPile: 7,
    // Линии в одном уровне теперь разной нагрузки: множитель в [0.6, 1.4]. Меняется с уровнем (seed).
    laneDifficultySpread: 0.4,
  },

  chest: {
    // Сундук даёт РОВНО одну награду: scrap | weapon | lootbox. По тз — лутбоксы в 65%
    // случаев, остальное делю: weapon чуть выгоднее scrap для прогрессии оружий.
    scrapMin: 14,
    scrapMax: 32,
    rewardWeights: { scrap: 0.15, weapon: 0.20, lootbox: 0.65 },
    // По тз: «в сундуке оружие ~как производит игрок, ±1-2 разряда равновероятно».
    chestWeaponOffsetMin: -2,
    chestWeaponOffsetMax: 2,
  },

  lootbox: {
    // По тз: средние выпадают в 4 раза чаще крутых → mediumShare = 0.8.
    mediumShare: 0.8,
    // «Средние лутбоксы содержат оружие на 0-1 порядок лучше чем производит игрок».
    mediumOffsetMin: 0,
    mediumOffsetMax: 1,
    // «Крутые — на 0-2 порядка хуже чем самое крутое у игрока». В большинстве кейсов best >
    // workshop, так что elite даёт оружие СИЛЬНЕЕ medium — выгодный, но редкий приз.
    eliteOffsetMin: -2,
    eliteOffsetMax: 0,
  },

  trash: {
    // Удаление оружия → возврат 50% от стоимости производства того же тира.
    refundRatio: 0.5,
  },

  economy: {
    startScrap: 30,
    startDiamonds: 0,
  },
};
