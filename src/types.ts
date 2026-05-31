// Общие типы домена. Игровая логика (core/*) и сцены (scenes/*) опираются на них.

/** Тир оружия (1..N). В MVP до 12. Просто число — для гибкости при расширении до 50-100. */
export type WeaponTier = number;

/** Тир зомби (1..N). Аналогично оружию: 1 — самый слабый, 12 — самый мощный. По тз:
 *  T1=5HP (как старый weak), T6=25HP (как старый medium), T12=150HP (как старый strong),
 *  промежуточные — равномерно. */
export type ZombieTier = number;

/** Типы лутбоксов из сундуков. medium — около произв. тира, elite — около лучшего у игрока. */
export type LootboxKind = 'medium' | 'elite';

/** Что выпадает из сундука. Ровно ОДНО за сундук. */
export type ChestRewardKind = 'scrap' | 'weapon' | 'lootbox';

/** Состояние мердж-поля. cells — row-major, длина = cols*rows; tier либо null (пусто). */
export interface FieldState {
  cols: number;
  rows: number;
  cells: (WeaponTier | null)[];
}

export interface Settings {
  sound: boolean;
  vibration: boolean;
}

export interface Stats {
  battlesWon: number;
  battlesRun: number;
  merges: number;
}

/** Единый объект сейва (один ключ localStorage `zm_save`). См. docs/SAVES.md. */
export interface SaveState {
  schemaVersion: number;
  scrap: number; // металлолом (софт-валюта)
  diamonds: number; // хард-валюта — зарезервировано, мета отложена
  level: number; // текущий уровень (1-based)
  maxLevelReached: number;
  workshopTier: WeaponTier; // тир, который производит Мастерская
  field: FieldState;
  inventory: WeaponTier[]; // буфер переполнения (не-мердж)
  settings: Settings;
  stats: Stats;
  /** Динамическая подкрутка наград. 1.0 = нейтрально. <1 = nerf (игрок слишком силён),
   *  >1 = buff (игрок слаб). Применяется в levelGen к scrapPerPile, chest.scrap*, и
   *  весам chest.rewardWeights (weapon/lootbox). Обновляется в `updateRewardTuning`. */
  rewardMultiplier: number;
  /** Сколько уровней подряд игрок открыл ≥80% сундуков. На strongStreakTrigger+ → nerf. */
  strongStreak: number;
  /** Сколько уровней подряд игрок открыл 0 сундуков. На каждом таком уровне → buff. */
  weakStreak: number;
  /** Флаг раннего апгрейда мердж-поля. Ставится в applyBattleResult если у игрока есть
   *  оружие с тиром ≥ cols×rows текущего поля. На СЛЕДУЮЩЕМ завершённом уровне форсирует
   *  переход к следующему размеру поля (вместо ожидания level-based threshold). */
  pendingFieldUpgrade: boolean;
}

// --- Уровень / бой ---

export type ObstacleKind = 'zombie' | 'crate' | 'scrap';

export interface Obstacle {
  kind: ObstacleKind;
  hp: number; // hp зомби/ящика; 0 для кучи лома
  zombieTier?: ZombieTier;
  scrap: number; // сколько лома даёт (куча или лут из ящика)
  /** Если true — при поломке коробки боец получает ОБНОВЛЕНИЕ РЕСУРСА (hits → стартовое)
   *  для самого крутого оружия в арсенале своей линии. НЕ новый ствол. (Если false — только
   *  лом из коробки.) */
  givesWeapon?: boolean;
}

/** Сундук в конце линии. РОВНО одна награда (взвешенно выбирается на генерации):
 *  'scrap' — игроку даётся `scrap` лома;
 *  'weapon' — оружие тира `weaponTier`;
 *  'lootbox' — лутбокс типа `lootboxKind`, который кладётся в клетку поля или в инвентарь. */
export interface ChestDef {
  reward: ChestRewardKind;
  scrap?: number;
  weaponTier?: WeaponTier;
  lootboxKind?: LootboxKind;
}

export interface Lane {
  obstacles: Obstacle[];
  chest: ChestDef;
}

export interface Level {
  number: number;
  cols: number; // число линий = ширина поля для этого уровня
  rows: number;
  roadLength: number;
  lanes: Lane[];
}

/** Шаг прохождения линии — для проигрыша боя в BattleScene и подсчёта наград. */
export interface LaneStep {
  index: number; // индекс препятствия, либо -1 для сундука
  kind: ObstacleKind | 'chest';
  outcome: 'cleared' | 'picked' | 'opened' | 'stuck';
  hitsSpent: number; // для тайминга анимации; 0 если врага добил «пробивающий» урон
  scrap: number;
  weaponTier?: number;
  /** Для chest-step c reward='lootbox' — какой именно лутбокс игрок забирает. */
  lootboxKind?: LootboxKind;
  /** Текущее активное оружие у бойца ПОСЛЕ этого шага (если есть). Для UI. */
  weaponTierAfter?: number;
  weaponHitsAfter?: number;
  /** HP врага ДО атаки — для корректной анимации полоски HP с учётом carry. */
  hpStart?: number;
  /** HP врага ПОСЛЕ шага: 0 если убит, >0 если боец застрял (оружие кончилось до добивания). */
  hpAfter?: number;
  /** Сколько пробивающего урона поглотил этот шаг В НАЧАЛЕ (до собственных ударов).
   *  >0 — значит шаг "попал под рывок" предыдущего убийства. Для UI: эту часть HP нужно
   *  скинуть в кадре предыдущего удара (визуально). */
  carryIn?: number;
  /** Пробивающий урон, ОСТАВШИЙСЯ после последнего удара по этой цели (>0 — есть избыток
   *  для следующего препятствия = цепочка продолжается). */
  carryOut?: number;
}

export interface LaneResult {
  reachedChest: boolean;
  steps: LaneStep[];
  collectedScrap: number;
  collectedWeapons: WeaponTier[];
  collectedLootboxes: LootboxKind[];
}

export interface BattleResult {
  level: number;
  passed: boolean; // дошёл хотя бы один боец
  lanes: LaneResult[];
  totalScrap: number;
  totalWeapons: WeaponTier[];
  totalLootboxes: LootboxKind[];
}
