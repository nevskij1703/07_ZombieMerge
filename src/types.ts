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
