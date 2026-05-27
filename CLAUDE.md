# CLAUDE.md — ZombieMerge

Правила и ориентиры для работы над этим проектом. Глобальные правила Александра (в `~/.claude/CLAUDE.md`) тоже действуют.

## Что это

Большая merge-игра (merge + авто-бой по линиям + idle-прогрессия) на **Phaser 3 + TypeScript + Vite**, под Android/РуСтор (портрет). Дизайн — `docs/GDD.md`. Сейчас собираем **MVP кор-петли на примитивах** (утилитарно, без финального арта).

## Запуск / сборка

- Dev: `npm run dev` → **http://localhost:8777** (порт зафиксирован `strictPort`, конвенция мастерской `877<N>`, N=07). Превью-окно читает `.claude/launch.json`.
- Build: `npm run build` (→ `tsc --noEmit && vite build` → `dist/`). `base:'./'` — относительные пути для WebView/APK.
- Typecheck: `npm run typecheck`.
- APK — через html2apk (пакует `dist/`), после MVP.

## Архитектура

Логика (`src/core/*`) отделена от рендера (`src/scenes/*`, `src/ui/*`). Боёвка — чистый детерминированный симулятор (`battleSim`), выдаёт исход + timeline; `BattleScene` проигрывает timeline. Баланс — единый объект `src/config/balance.ts`.

## Дев/чит-код — ОБЯЗАТЕЛЬНО гейтить

Механизм (по глобальным правилам, приоритет №1 для Vite-SPA): **`import.meta.env.DEV`**.

```ts
if (import.meta.env.DEV) {
  initDevPanel(); // ресурсы, скип уровней, сброс сейва, редактор баланса
}
```

При `npm run build` (production) Vite tree-shaking **вырезает** дев-код — release-сборка чистая автоматически. В dev (`npm run dev`) — остаётся.

- **Дев-панель**: открытие — кнопка «DEV» в углу экрана (рисуется только в dev). *(точный хоткей/жест зафиксируем на этапе реализации — Stage 7)*.
- Вкладка **Баланс** умеет export/apply JSON для быстрой передачи новых значений — см. `docs/BALANCE.md`.
- Любой новый чит/дев-UI/мок оборачивай в `import.meta.env.DEV`. Обычные `console.error` для прод-диагностики — не трогаем.

## Сейвы

Один ключ `zm_save`, поле `schemaVersion`, каскадные миграции с авто-выводом версии. Контракт — `docs/SAVES.md`. Любое изменение формата сейва = новая миграция. Балансовые override'ы — в отдельном ключе `zm_balance_override`, не в сейве.

## Структура публикации

`Store_Info/` (keystore, иконки-заглушки, описание, политика), `.claude/build-config.json`, `.claude/release-state.json` — каноника РуСтор. Реклама/Review SDK — не в MVP (`docs/ADS.md`).

## Git

Удалённый: https://github.com/nevskij1703/07_ZombieMerge. Коммитим и пушим после каждого этапа (push в этот репозиторий авторизован). Деструктивные git-операции — только с подтверждения.
