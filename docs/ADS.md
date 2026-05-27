# Реклама — задел (ZombieMerge)

> **Статус: НЕ в MVP.** Реклама пока не подключена. Документ — план интеграции на потом.

Когда дойдём до монетизации, целимся (как в остальных проектах мастерской) в **Yandex Mobile Ads** через нативный мост html2apk — без веб-SDK (РСЯ `context.js` не подключаем, проект только под APK).

## План интеграции (после MVP)

1. Глобальный синглтон `AdManager` с ленивым выбором backend:
   - `native` — если в APK есть `window.YandexAds.*` (html2apk `-YandexAdsBridge`).
   - `mock` — в браузере (dev): рисуем оверлей-заглушку, отдаём `{watched:true}`.
2. Слоты: **interstitial** (напр. между боями по каденсу), **rewarded** (напр. ×2 к награде сундука, доп. спавн). unit-ID — в конфиге.
3. Сборка: `html2apk ... -YandexAdsBridge` сам добавляет gradle-зависимость, права, `YandexAdsBridge.java`, патчит MainActivity. Callback-контракт: `window.__yandexAdsCallback(kind, event)`.

Полный рабочий референс (Java-мост, каденс, mock) — `04_True-or-Do/docs/ADS.md` и `01_RS_GlitterSort/docs/ADS.md`.

## Что сделать при подключении

- Создать `src/ads/adManager.ts` (по образцу 04).
- Раскомментировать раздел Yandex Mobile Ads в `Store_Info/PRIVACY_POLICY.md`, поднять версию политики, перезалить PDF.
- В `.claude/build-config.json` — при необходимости `rustoreReviewSdk`.
- Указать наличие рекламы в `STORE_LISTING.md`.
