// ЕДИНЫЙ источник правды по балансу. Крутим ЧИСЛА здесь, логику в core/* не трогаем.
// Редактируется на лету из дев-панели (вкладка Баланс) через override. См. docs/BALANCE.md.
// Значения — стартовые/отладочные, доводятся на этапе 10.

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
  /** Сколько разных типов зомби минимум доступно на L1 (по тз — 3). */
  zombieMinTypesL1: number;
  /** С какого уровня доступны ВСЕ 12 тиров (по тз — L5). До этого окно растёт. */
  zombieAllTypesFromLevel: number;
  /** Как быстро «центральный» тир сдвигается вверх по уровням (для распределения). */
  zombieTierGrowthPerLevel: number;
  /** Гауссова ширина распределения вокруг центрального тира. */
  zombieTierSpread: number;
  /** Доля «равномерной» примеси к гауссиану — гарантирует, что любой доступный тир
   *  имеет ненулевую вероятность. 0 = строго гауссиан. 1 = чистая равномерка. */
  zombieTierWildcardShare: number;
  /** Вероятность (0..1) что ДАННАЯ линия получит ОДНУ коробку. Применяется per-lane:
   *  rng()<crateLaneChance → линия имеет 1 коробку, иначе — ноль. (Раньше было per-obstacle
   *  и плодило слишком много коробок; коробки теперь редкое сильное событие.) */
  crateLaneChance: number;
  /** Множитель к HP сильнейшего зомби в данной линии — столько HP получит коробка.
   *  По тз: коробки должны быть в ~2 раза крепче сильнейшего зомби на уровне. */
  crateHpMultiplier: number;
  /** Вероятность (0..1) что разбитая коробка содержит «обновление ресурса» лучшего
   *  оружия в линии (иначе — только лом). Тиры коробке больше не нужны: refill идёт
   *  по уже имеющемуся у бойца оружию. */
  crateWeaponChance: number;
  /** Сколько куч металлолома на дороге и сколько в каждой. */
  scrapPilesMin: number;
  scrapPilesMax: number;
  scrapPerPile: number;
  /** Разброс «нагрузки» между линиями одного уровня: множитель кол-ва зомби в линии
   *  выбирается из [1-spread, 1+spread]. 0 — все линии одинаковые. 0.4 — линии могут
   *  быть от 60% до 140% базового зомби-бюджета (player не может стабильно угадать,
   *  куда ставить топовое оружие). */
  laneDifficultySpread: number;
  /** Сила «перемешивания» зомби по тирам в линии (sort with jitter):
   *  0 = чётко отсортировано (от слабых к сильным).
   *  3-4 = заметное размытие границ (тиры мягко чередуются).
   *  Больше = почти случайный порядок. */
  zombieOrderJitter: number;
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
  /** 12 тиров зомби. По тз: T1=5, T6=25, T12=150 — анкоры. Промежуточные piecewise-linear. */
  zombies: Record<number, ZombieDef>;
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

  // 12 тиров зомби (как у оружий). По тз: анкоры T1=5, T6=25, T12=150 — это бывшие
  // weak/medium/strong. Промежуточные — piecewise linear, равномерный рост в каждом сегменте.
  // T1-T6: +4 HP/тир. T6-T12: ~+21 HP/тир (округлено для красивых чисел).
  zombies: {
    1: { hp: 5 },
    2: { hp: 9 },
    3: { hp: 13 },
    4: { hp: 17 },
    5: { hp: 21 },
    6: { hp: 25 },
    7: { hp: 45 },
    8: { hp: 65 },
    9: { hp: 90 },
    10: { hp: 110 },
    11: { hp: 130 },
    12: { hp: 150 },
  },

  levelGen: {
    baseRoadLength: 8,
    roadLengthPerLevel: 0.6,
    // Цель: ~50-60% линий дошли до сундука в среднем (часть валится, но прогрессия до L50
    // проходима). Сложность держит низкий ресурс оружий (T1=4 ... T12=15) и редкие коробки.
    // См. scripts/autotest-cli.ts.
    // С 12-тирной системой основная сложность идёт от роста ТИРОВ (HP). Количество зомби
    // держим скромным — иначе мердж-окно (особенно 2x2 на L1-L3) не успевает за HP-инфляцией.
    // baseZombieCount=2 чтоб L1-L3 (поле 2x2) не уходили в death-spiral.
    baseZombieCount: 2,
    zombieCountPerLevel: 0.45,
    // Распределение 12 тиров зомби по уровням (по тз):
    //   • L1: минимум 3 типа (T1-T3 доступны).
    //   • L5+: все 12 тиров могут спавниться.
    //   • Распределение взвешенное (гауссиан + wildcard-floor).
    zombieMinTypesL1: 3,
    zombieAllTypesFromLevel: 5,
    zombieTierGrowthPerLevel: 0.18, // насколько вырастает «центральный» тир за уровень
    zombieTierSpread: 1.5, // ширина гауссиана вокруг центра (узкая — большинство зомби близ центра)
    zombieTierWildcardShare: 0.05, // лёгкая примесь равномерки — гарантирует «все 12 могут быть» по тз
    // ПЕРЕИМЕНОВАНИЕ И СЕМАНТИКА: per-lane (вместо per-obstacle). Половина линий получит ОДНУ
    // коробку, остальные — ноль. Если в локальном override был старый ключ crateChance, он будет
    // проигнорирован (semantically incompatible).
    crateLaneChance: 0.5,
    // По тз: коробка ~×2 HP сильнейшего зомби на уровне (динамически в genLane).
    crateHpMultiplier: 2.0,
    // По новому тз: коробка возрождает ресурс лучшего оружия линии, не дропает новое.
    // 0.85 — почти всегда даёт refill (иначе ломать тяжёлую коробку только ради лома обидно).
    crateWeaponChance: 0.85,
    // Кучи лома на дороге — основной источник скрапа (сундук редко даёт лом, коробка
    // теперь даёт только refill вместо нового оружия).
    scrapPilesMin: 2,
    scrapPilesMax: 3,
    scrapPerPile: 9,
    // Линии в одном уровне теперь разной нагрузки: множитель в [0.6, 1.4]. Меняется с уровнем (seed).
    laneDifficultySpread: 0.4,
    // Размытие границ между тирами зомби в линии. ±3 позиции — заметный блендинг,
    // тиры мягко чередуются вместо «жёсткой стены».
    zombieOrderJitter: 3,
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
