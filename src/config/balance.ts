// ЕДИНЫЙ источник правды по балансу. Крутим ЧИСЛА здесь, логику в core/* не трогаем.
// Редактируется на лету из дев-панели (вкладка Баланс) через override. См. docs/BALANCE.md.
//
// ═════════════════════════════════════════════════════════════════════════════
// PRIMARY TUNING KNOBS  ──  МЕНЯЙ ПЕРВЫМ ДЕЛОМ ПРИ ЛЮБОМ «ТЮНЕ БАЛАНСА»
// ═════════════════════════════════════════════════════════════════════════════
// Полный индекс параметров — `docs/PROJECT_MAP.md` §4. Ниже — самые горячие:
//
// DIFFICULTY (как быстро игра становится сложнее)
//   • levelGen.zombieCountPerLevel      = 0.45   зомби/уровень
//   • levelGen.zombieTierGrowthPerLevel = 0.18   центр гауссиана тиров +/lvl
//   • levelGen.zombieTierSpread         = 1.5    ширина распределения
//   • levelGen.zombieTierWildcardShare  = 0.05   доля равномерки (high-tier surprises)
//
// ECONOMY (лом → производство)
//   • economy.startScrap                = 30
//   • levelGen.scrapPerPile             = 9
//   • levelGen.scrapPilesMin/Max        = 2/3
//   • chest.rewardWeights               = {scrap:0.15, weapon:0.20, lootbox:0.65}
//   • chest.scrapMin/Max                = 14/32
//
// PLAYER PROGRESSION (как сильно растёт игрок)
//   • workshop.upgradeAtLevels          = [4, 12, 22]
//   • weapons[N].hits                   = N + 3 (линейный)
//   • chest.chestWeaponOffsetMin/Max    = -2/+2  (тир оружия из сундука vs workshop)
//   • lootbox.eliteOffsetMin/Max        = -2/0   (elite-лутбокс vs player best)
//
// ZOMBIE HP ANCHORS (piecewise linear между анкорами)
//   • zombies[1].hp = 5  (anchor: weak)
//   • zombies[6].hp = 25 (anchor: medium)
//   • zombies[12].hp = 150 (anchor: strong)
//
// Проверка после тюна: `npx tsx scripts/balance-quick.ts` (L5/L25/L50, 5 строк).
// Глубоко: `npx tsx scripts/balance-deep.ts`. НЕ запускай без явной просьбы.
// ═════════════════════════════════════════════════════════════════════════════

export interface WeaponDef {
  name: string;
  /** Урон за один удар/выстрел (скрыт от игрока). */
  damagePerHit: number;
  /** Сколько ударов до истощения оружия (выносливость/боезапас, скрыт). */
  hits: number;
  /** Базовое имя PNG-иконки (без расширения, без пути). Файл лежит в
   *  `public/art/weapons/<icon>.png`. В Boot регистрируется как `weapon.t<tier>` текстура. */
  icon: string;
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
  /** Доли трёх типов лутбоксов среди выпавших (нормализуются перед сэмплингом). */
  shares: { cheap: number; medium: number; elite: number };
  /** Cheap-лутбокс: тир = workshopTier + uniform[cheapOffsetMin..cheapOffsetMax].
   *  По тз: «на 0-3 тира ниже того, что производит игрок» → [-3, 0]. */
  cheapOffsetMin: number;
  cheapOffsetMax: number;
  /** Medium-лутбокс: тир ≈ ⌊(workshop + best) / 2⌋ + uniform[mediumOffsetMin..mediumOffsetMax].
   *  Центр — среднее между производством игрока и его лучшим оружием; офсет даёт лёгкий разброс. */
  mediumOffsetMin: number;
  mediumOffsetMax: number;
  /** Elite-лутбокс: тир = bestTier + uniform[eliteOffsetMin..eliteOffsetMax].
   *  По тз: «на 0-2 тира ниже самого крутого у игрока» → [-2, 0]. */
  eliteOffsetMin: number;
  eliteOffsetMax: number;
}

export interface TrashBalance {
  /** Доля от стоимости производства, которая возвращается за удаление оружия в трэш. */
  refundRatio: number;
}

/** Динамическая подкрутка наград — реагирует на силу игрока. После каждого боя в
 *  `progression.updateRewardTuning` смотрим долю дошедших до сундука бойцов:
 *   • ≥ strongChestRatio  → strongStreak++; если streak ≥ strongStreakTrigger → mult *= nerfStep.
 *   • reached == 0        → weakStreak++; mult *= buffStep (срабатывает с 1-го раза).
 *   • Иначе               → оба streak сбрасываются, mult НЕ меняется (freeze).
 *  Клампим mult в [multMin, multMax]. */
export interface DynamicDifficultyBalance {
  /** Минимальная доля reached/total чтобы уровень считался «сильным». 0.8 = ≥80%. */
  strongChestRatio: number;
  /** Сколько consecutive сильных уровней нужно перед ПЕРВЫМ нерфом. 3 = после 1,2,3 → нерф. */
  strongStreakTrigger: number;
  /** Множитель наград при каждом nerf-шаге. 0.7 = -30%. */
  nerfStep: number;
  /** Множитель наград при каждом buff-шаге. 1.5 = +50%. */
  buffStep: number;
  /** Нижняя/верхняя граница rewardMultiplier (защита от выезжания в крайности). */
  multMin: number;
  multMax: number;
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
  /** Сколько куч металлолома на дороге и сколько в каждой. Число куч сэмплится один
   *  раз на уровень — одинаковое для всех линий, чтобы длина дорог совпадала. */
  scrapPilesMin: number;
  scrapPilesMax: number;
  scrapPerPile: number;
}

// (removed `laneDifficultySpread`: число зомби в линии теперь одинаковое — дороги выровнены.
// Разнообразие линий — через распределение тиров зомби и шанс коробки.)
//
// (removed `zombieOrderJitter`: на смену пришёл anchored shuffle в genLane — слабые зомби
// строго в начале линии, средняя и сильная зоны перемешаны внутри. Распределение тиров
// не меняется, общая сложность сохраняется.)


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
  dynamicDifficulty: DynamicDifficultyBalance;
  economy: {
    startScrap: number;
    startDiamonds: number;
  };
}

export const balance: Balance = {
  maxTier: 19,

  // 19 тиров оружия. Порядок и имена — из figma (164:69). hits линейный N+3.
  // damagePerHit растёт ×1.4 за тир. Иконки в public/art/weapons/, поле `icon`.
  weapons: {
    1:  { name: 'Дубина',      icon: 't01_club',           damagePerHit: 2,    hits: 4  },
    2:  { name: 'Труба',       icon: 't02_pipe',           damagePerHit: 3,    hits: 5  },
    3:  { name: 'Кирка',       icon: 't03_pickaxe',        damagePerHit: 5,    hits: 6  },
    4:  { name: 'Топор',       icon: 't04_fireaxe',        damagePerHit: 7,    hits: 7  },
    5:  { name: 'Нож',         icon: 't05_knife',          damagePerHit: 10,   hits: 8  },
    6:  { name: 'Мачете',      icon: 't06_machete',        damagePerHit: 14,   hits: 9  },
    7:  { name: 'Бензопила',   icon: 't07_chainsaw',       damagePerHit: 20,   hits: 10 },
    8:  { name: 'Огнемёт',     icon: 't08_flamethrower',   damagePerHit: 28,   hits: 11 },
    9:  { name: 'Револьвер',   icon: 't09_revolver',       damagePerHit: 40,   hits: 12 },
    10: { name: 'Пистолет',    icon: 't10_pistol',         damagePerHit: 56,   hits: 13 },
    11: { name: 'Узи',         icon: 't11_uzi',            damagePerHit: 78,   hits: 14 },
    12: { name: 'Дробовик',    icon: 't12_shotgun',        damagePerHit: 110,  hits: 15 },
    13: { name: 'Автомат',     icon: 't13_ak',             damagePerHit: 155,  hits: 16 },
    14: { name: 'Винтовка',    icon: 't14_sniper',         damagePerHit: 215,  hits: 17 },
    15: { name: 'Рейлган',     icon: 't15_railgun',        damagePerHit: 300,  hits: 18 },
    16: { name: 'Гранатомёт',  icon: 't16_grenadelauncher',damagePerHit: 420,  hits: 19 },
    17: { name: 'РПГ',         icon: 't17_rpg',            damagePerHit: 590,  hits: 20 },
    18: { name: 'Тесла-пушка', icon: 't18_tesla',          damagePerHit: 830,  hits: 21 },
    19: { name: 'Лазертаг',    icon: 't19_lazertag',       damagePerHit: 1160, hits: 22 },
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
      13: 560,
      14: 780,
      15: 1100,
      16: 1500,
      17: 2100,
      18: 3000,
      19: 4200,
    },
    // Цех 1→4 к L22; дальше не растёт — гэп с Полем (растёт к T19) расширяется к эндгейму.
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
    // теперь даёт только refill вместо нового оружия). Число куч сэмплится ОДНОКРАТНО
    // per level (одинаково для всех линий) — чтобы длина дорог была равной.
    scrapPilesMin: 2,
    scrapPilesMax: 3,
    scrapPerPile: 9,
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
    // 3 типа: cheap (часто, оружие близкое к workshop), medium (умеренно, центр между
    // workshop и best), elite (редко, около best). Дефолт ~40/40/20 — нормализуется
    // в `scaleBalance` с учётом rewardMultiplier (mult>1 → больше elite, меньше cheap).
    shares: { cheap: 0.4, medium: 0.4, elite: 0.2 },
    // Cheap: на 0-3 тира НИЖЕ workshop — «дешманский», но всегда хоть какое-то оружие.
    cheapOffsetMin: -3,
    cheapOffsetMax: 0,
    // Medium: центр = avg(workshop, best); ±1 разброса для разнообразия.
    mediumOffsetMin: -1,
    mediumOffsetMax: 1,
    // Elite: на 0-2 тира ниже best (самого крутого оружия у игрока на поле/инвентаре/Цехе).
    eliteOffsetMin: -2,
    eliteOffsetMax: 0,
  },

  trash: {
    // Удаление оружия → возврат 50% от стоимости производства того же тира.
    refundRatio: 0.5,
  },

  dynamicDifficulty: {
    // По тз: «хотя бы 1 раз ≥80% сундуков» → сразу -30%. Каждый последующий strong-уровень
    // → ещё -30% (мультипликативно). Симметрично с buff: оба триггера срабатывают с 1-го раза.
    strongChestRatio: 0.8,
    strongStreakTrigger: 1,
    nerfStep: 0.7,   // -30% за каждый strong-уровень (с 1-го раза)
    // По тз: «не открыл ни одного сундука за уровень» → сразу +50%. Каждый последующий
    // weak-уровень → ещё +50% (от нового значения, мультипликативно).
    buffStep: 1.5,   // +50% за каждый weak-уровень (с 1-го раза)
    // Границы — чтобы при экстремальном перекосе значения не уезжали в абсурд.
    multMin: 0.1,
    multMax: 10.0,
  },

  economy: {
    startScrap: 30,
    startDiamonds: 0,
  },
};
