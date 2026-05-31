# Сейв и миграции (ZombieMerge)

Реализация — `src/core/storage.ts` + `src/core/migrations.ts`. Паттерн как в мастерской (single-key + `schemaVersion` + каскадные миграции с авто-выводом версии).

## Хранилище

- **Один** ключ `localStorage`: **`zm_save`**. Единый JSON.
- Поле **`schemaVersion`** (целое) — отдельно от versionName приложения. Растёт **только** при изменении формата `data`.
- `getCurrentSchemaVersion()` авто-выводится из `max(Object.keys(migrations))` — **не дублируется** константой.

## Форма сейва (schemaVersion 3)

```jsonc
{
  "schemaVersion": 3,
  "scrap": 0,            // металлолом (софт-валюта)
  "diamonds": 0,         // хард-валюта — зарезервировано, мета отложена
  "level": 1,            // текущий уровень (1-based)
  "maxLevelReached": 1,
  "workshopTier": 1,     // тир, который производит Мастерская
  "field": {
    "cols": 2, "rows": 2,
    "cells": [null, null, null, null]  // row-major, длина = cols*rows; tier|null
  },
  "inventory": [],       // тиры предметов в буфере переполнения
  "settings": { "sound": true, "vibration": true },
  "stats": { "battlesWon": 0, "battlesRun": 0, "merges": 0 },
  // v2: динамическая подкрутка наград (см. balance.dynamicDifficulty + progression.ts).
  "rewardMultiplier": 1.0,  // 1.0=нейтрально. <1=nerf (силён), >1=buff (слаб). [multMin..multMax]
  "strongStreak": 0,        // подряд уровней с ratio ≥ strongChestRatio (default 0.8)
  "weakStreak": 0,          // подряд уровней с reached==0
  // v3: ранний апгрейд мердж-поля. Ставится в applyBattleResult если у игрока есть
  // оружие тира ≥ cols×rows; на СЛЕДУЮЩЕМ уровне форсирует переход к next field step.
  "pendingFieldUpgrade": false
}
```

### Миграции

- **v1 → v2**: добавлены `rewardMultiplier` (default 1.0), `strongStreak`, `weakStreak` (оба 0). Defensive — у старых сейвов поля проставляются нейтральными значениями, прогресс не теряется.
- **v2 → v3**: добавлено `pendingFieldUpgrade` (default false). Defensive.

## Контракт

- `migrations.ts` — реестр. Каждая миграция — чистая функция `(state) => state`, преобразует `v(N-1) → vN`.
- `migrations[1]` — **identity** (проект новый, legacy-хранилища нет).
- `storage.load()`:
  1. Читает `zm_save`. Нет — берёт `DEFAULT_STATE()`.
  2. Читает `schemaVersion`, прогоняет `runMigrations(state, from)` каскадно до текущей.
  3. Мёрджит с дефолтами (защита от недостающих полей), пишет обратно.
- `runMigrations` бросает ошибку при дыре в реестре (нет миграции N) — ловится self-test'ом.

## Как добавить миграцию (при изменении формата)

1. Поменял форму сейва в коде (новое поле / переименование / тип).
2. Добавь в `migrations.ts` функцию `N: (state) => { /* v(N-1) → vN */ return state; }`.
3. Обнови `DEFAULT_STATE()` в `storage.ts`.
4. После реальной публикации в РуСтор — обнови `.claude/release-state.json` (`lastPublishedSchemaVersion`). Делает skill `prepare-release-candidate`.

## Правила

- **Не меняй уже опубликованную миграцию** — у живых юзеров сейвы на этой схеме.
- Миграции **defensive**: `state.x ?? default` для отсутствующих полей.
- **Каскадные** — каждая выполняется ровно один раз на юзера.
- Балансовые dev-override'ы хранятся в **отдельном** ключе (`zm_balance_override`), **не** в сейве — чтобы не пухла схема. См. `docs/BALANCE.md`.

## Проверка перед релизом

Skill `prepare-release-candidate` гоняет self-test: пустой сейв через **все** миграции 1..N, проверка что не падает и `schemaVersion` корректен. Падает — релиз не собирается.
