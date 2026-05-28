// Рантайм-баланс = base (config/balance.ts) + dev-override (localStorage 'zm_balance_override').
// В release override игнорируется. Override НЕ влияет на схему сейва. См. docs/BALANCE.md.

import { balance as baseBalance, type Balance } from '../config/balance';

const OVERRIDE_KEY = 'zm_balance_override';
let runtime: Balance | null = null;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge(base: any, override: any): any {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const out: any = { ...base };
  for (const k of Object.keys(override)) {
    const bv = base[k];
    const ov = override[k];
    out[k] = isPlainObject(bv) && isPlainObject(ov) ? deepMerge(bv, ov) : ov;
  }
  return out;
}

function compute(): Balance {
  // import.meta.env инжектится Vite при сборке. В чистом node (например, CLI-прогон autotest
  // через tsx) объект env undefined — тогда работаем без override.
  if (!import.meta.env?.DEV) return baseBalance;
  try {
    const raw = localStorage.getItem(OVERRIDE_KEY);
    if (!raw) return clone(baseBalance);
    return deepMerge(clone(baseBalance), JSON.parse(raw));
  } catch {
    return clone(baseBalance);
  }
}

export function getBalance(): Balance {
  if (!runtime) runtime = compute();
  return runtime;
}

export function invalidateBalance(): void {
  runtime = null;
}

// --- dev-only управление override (вкладка Баланс дев-панели) ---

export function exportBalanceJSON(): string {
  return JSON.stringify(getBalance(), null, 2);
}

export function applyBalanceOverrideJSON(json: string): void {
  JSON.parse(json); // бросит при невалидном JSON — поймает дев-панель
  localStorage.setItem(OVERRIDE_KEY, json);
  runtime = null;
}

export function resetBalanceOverride(): void {
  localStorage.removeItem(OVERRIDE_KEY);
  runtime = null;
}

export function hasBalanceOverride(): boolean {
  try {
    return localStorage.getItem(OVERRIDE_KEY) != null;
  } catch {
    return false;
  }
}
