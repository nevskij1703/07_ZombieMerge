// Сейв в одном ключе localStorage `zm_save`: load/save/getState/update/reset.
// При load() читает schemaVersion, прогоняет миграции каскадно, мёрджит с дефолтами.
// См. docs/SAVES.md.

import type { SaveState } from '../types';
import { getCurrentSchemaVersion, runMigrations } from './migrations';

const STORAGE_KEY = 'zm_save';

export function DEFAULT_STATE(): SaveState {
  return {
    schemaVersion: getCurrentSchemaVersion(),
    scrap: 0,
    diamonds: 0,
    level: 1,
    maxLevelReached: 1,
    workshopTier: 1,
    field: { cols: 2, rows: 2, cells: [null, null, null, null] },
    inventory: [],
    settings: { sound: true, vibration: true },
    stats: { battlesWon: 0, battlesRun: 0, merges: 0 },
  };
}

let cached: SaveState | null = null;

function readRaw(): any | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function readSchemaVersion(payload: any): number {
  return typeof payload?.schemaVersion === 'number' ? payload.schemaVersion : 0;
}

function persist(): void {
  if (!cached) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
  } catch {
    /* quota/private mode — игнорируем, работаем из памяти */
  }
}

function resizeCells(cells: unknown, need: number): (number | null)[] {
  const out: (number | null)[] = Array.isArray(cells)
    ? (cells.slice(0, need) as (number | null)[])
    : [];
  while (out.length < need) out.push(null);
  return out;
}

/** Защитный мёрдж с дефолтами: добиваем недостающие поля и чиним целостность. */
function mergeDefaults(state: any): SaveState {
  const d = DEFAULT_STATE();
  const merged: SaveState = {
    ...d,
    ...state,
    field: { ...d.field, ...(state?.field ?? {}) },
    settings: { ...d.settings, ...(state?.settings ?? {}) },
    stats: { ...d.stats, ...(state?.stats ?? {}) },
    schemaVersion: getCurrentSchemaVersion(),
  };
  const need = merged.field.cols * merged.field.rows;
  if (!Array.isArray(merged.field.cells) || merged.field.cells.length !== need) {
    merged.field.cells = resizeCells(merged.field.cells, need);
  }
  if (!Array.isArray(merged.inventory)) merged.inventory = [];
  return merged;
}

export function load(): SaveState {
  if (cached) return cached;

  const parsed = readRaw();
  const target = getCurrentSchemaVersion();

  if (!parsed) {
    cached = DEFAULT_STATE();
    persist();
    return cached;
  }

  const from = readSchemaVersion(parsed);
  let state: any = parsed;

  if (from > target) {
    // Сейв из будущей версии (откат приложения) — бэкапим и стартуем с дефолта, чтобы не падать.
    try {
      localStorage.setItem(`${STORAGE_KEY}_backup_v${from}`, JSON.stringify(parsed));
    } catch {
      /* ignore */
    }
    state = DEFAULT_STATE();
  } else if (from < target) {
    const res = runMigrations(parsed, from);
    state = res.state;
    state.schemaVersion = res.schemaVersion;
  }

  cached = mergeDefaults(state);
  persist();
  return cached;
}

export function getState(): SaveState {
  return cached ?? load();
}

export function save(): void {
  persist();
}

/** Мутируем сейв и сразу персистим. Возвращает актуальный стейт. */
export function update(mutator: (s: SaveState) => void): SaveState {
  const s = getState();
  mutator(s);
  persist();
  return s;
}

export function reset(): SaveState {
  cached = DEFAULT_STATE();
  persist();
  return cached;
}
