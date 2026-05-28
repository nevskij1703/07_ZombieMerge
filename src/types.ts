// Общие типы домена. Игровая логика (core/*) и сцены (scenes/*) опираются на них.

/** Тир оружия (1..N). В MVP до 12. Просто число — для гибкости при расширении до 50-100. */
export type WeaponTier = number;

/** Типы зомби в MVP. */
export type ZombieKind = 'weak' | 'medium' | 'strong';

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
}

// --- Уровень / бой ---

export type ObstacleKind = 'zombie' | 'crate' | 'scrap';

export interface Obstacle {
  kind: ObstacleKind;
  hp: number; // hp зомби/ящика; 0 для кучи лома
  zombieKind?: ZombieKind;
  scrap: number; // сколько лома даёт (куча или лут из ящика)
  weapon: boolean; // ящик роняет оружие
}

export interface ChestDef {
  scrap: number;
  weapon: boolean;
  blueprint: boolean;
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
  blueprint?: boolean;
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
  blueprint: boolean;
}

export interface BattleResult {
  level: number;
  passed: boolean; // дошёл хотя бы один боец
  lanes: LaneResult[];
  totalScrap: number;
  totalWeapons: WeaponTier[];
  blueprints: number;
}
