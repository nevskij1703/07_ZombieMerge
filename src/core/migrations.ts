// Реестр миграций сейва. Каждая запись N: (state) => state преобразует v(N-1) -> vN.
// getCurrentSchemaVersion авто-выводится из max(ключей) — НЕ дублируется константой.
// См. docs/SAVES.md.

type MigrationFn = (state: any) => any;

export const migrations: Record<number, MigrationFn> = {
  // v0 -> v1: проект новый, legacy-хранилища нет. Identity.
  1: (state) => state,
  // v1 -> v2: добавили динамическую подкрутку наград (rewardMultiplier + streaks).
  // У существующих сейвов этих полей нет — выставляем нейтральные дефолты.
  2: (state) => ({
    ...state,
    rewardMultiplier: typeof state?.rewardMultiplier === 'number' ? state.rewardMultiplier : 1.0,
    strongStreak: typeof state?.strongStreak === 'number' ? state.strongStreak : 0,
    weakStreak: typeof state?.weakStreak === 'number' ? state.weakStreak : 0,
  }),
  // v2 -> v3: добавили pendingFieldUpgrade для раннего расширения мердж-поля
  // когда у игрока есть оружие с тиром ≥ cols×rows.
  3: (state) => ({
    ...state,
    pendingFieldUpgrade: typeof state?.pendingFieldUpgrade === 'boolean'
      ? state.pendingFieldUpgrade
      : false,
  }),
  // v3 -> v4: добавили battledTiers — список тиров, с которыми игрок ходил в бой.
  // Используется для «NEW!»-ярлыка на новых тирах оружия (≥ NEW_BADGE_MIN_TIER).
  // У существующих сейвов поля не было — стартуем с []. Это означает что у текущих
  // игроков на ВСЕХ оружиях ≥5 тира одноразово вспыхнет «NEW!», пока они не сходят
  // в бой. Считаем это допустимым (онбординг-сигнал).
  4: (state) => ({
    ...state,
    battledTiers: Array.isArray(state?.battledTiers) ? state.battledTiers : [],
  }),
};

export function getCurrentSchemaVersion(): number {
  const keys = Object.keys(migrations).map(Number);
  return keys.length ? Math.max(...keys) : 1;
}

export function runMigrations(
  state: any,
  fromVersion: number,
): { state: any; schemaVersion: number } {
  const current = getCurrentSchemaVersion();
  let v = typeof fromVersion === 'number' ? fromVersion : 0;
  while (v < current) {
    const fn = migrations[v + 1];
    if (typeof fn !== 'function') {
      throw new Error(
        `[migrations] Missing migration ${v + 1} (target schemaVersion=${current})`,
      );
    }
    state = fn(state);
    v++;
  }
  return { state, schemaVersion: current };
}

/**
 * Dev-only self-test: реестр идёт подряд 1..N без дыр, и пустой сейв с любой
 * стартовой версии каскадно доходит до текущей. Бросает при проблеме.
 * Тот же инвариант проверяет skill `prepare-release-candidate` перед сборкой.
 */
export function migrationsSelfTest(): void {
  const current = getCurrentSchemaVersion();
  for (let n = 1; n <= current; n++) {
    if (typeof migrations[n] !== 'function') {
      throw new Error(`[migrations] self-test: missing migration ${n}`);
    }
  }
  for (let from = 0; from <= current; from++) {
    const res = runMigrations({ schemaVersion: from }, from);
    if (res.schemaVersion !== current) {
      throw new Error(
        `[migrations] self-test: from ${from} -> ${res.schemaVersion}, expected ${current}`,
      );
    }
  }
}
