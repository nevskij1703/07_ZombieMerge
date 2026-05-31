# ZombieMerge — Project Map

**Для Claude:** читай этот файл В ПЕРВУЮ ОЧЕРЕДЬ в каждой сессии. Здесь — индекс,
который позволяет НЕ загружать большие куски кода для понимания структуры. Если
ответ есть здесь — не открывай файл.

---

## 1. File index

### Core (`src/core/`) — чистая логика, без UI

| Файл | Что | Размер |
|------|-----|--------|
| `storage.ts` | Single-key save `zm_save`. `getState/save/update/reset/load`. Merges with defaults on load. | ~130 |
| `migrations.ts` | Каскадные миграции схемы сейва. `migrations[N]: state → state`. `getCurrentSchemaVersion()` = max(keys). `migrationsSelfTest()`. | ~55 |
| `balanceRuntime.ts` | `getBalance()` = base `balance.ts` + dev override из LS (key `zm_balance_override`). В release override игнорируется (Vite tree-shaking by `import.meta.env?.DEV`). | ~70 |
| `weapons.ts` | `maxTier()`, `getWeapon(t)`, `weaponName(t)`, `canMergeTier(t)`, `nextTier(t)`. | ~28 |
| `economy.ts` | `produceCost(tier)`, `canAfford(scrap, cost)`. | ~13 |
| `merge.ts` | Field cell ops: `canMergeIndices`, `mergeInto`, `moveOrSwap`, `placeFirstFree`, `isFull`, `pullFromInventory`, `addLoot`, `resizeField`. **Лутбоксы блокируются `isWeaponCellValue` из `lootbox.ts`.** | ~120 |
| `lootbox.ts` | Кодирование лутбоксов в клетках: `LOOTBOX_MEDIUM_CODE=1001`, `LOOTBOX_ELITE_CODE=1002`. `isWeaponCellValue`, `isLootboxCode`, `lootboxKindOfCode`, `rollLootboxTier(kind, ws, best, rng)`. | ~55 |
| `levelGen.ts` | `generateLevel(level, ctx?)` детерминированная. Sample tier по `sampleZombieTier`. `enforceMinTypes` на L1. Crate HP = 2×max лиции, lootbox kind по `mediumShare`. **Длина дорог одинакова на всех линиях**: `zombieCount` fixed + `pilesCount` сэмплится один раз/уровень + crate ЗАМЕНЯЕТ зомби. **Anchored shuffle**: тиры зомби сортируются, режутся на 3 зоны (weak/mid/strong по ~1/3), внутри mid и strong — Fisher-Yates → финал линии 50/50 топ-или-предтоп. **Dynamic reward tuning**: `ctx.rewardMultiplier` через `scaleBalance` → scrapPerPile, chest.scrap*, chest.rewardWeights (weapon+lootbox × mult). | ~260 |
| `battleSim.ts` | Pure simulator. `simulateBattle(level, arsenals)` → `BattleResult`. Lunge-модель: carry-пробивание (`carryIn`/`carryOut`). Чистая, без RNG. | ~190 |
| `progression.ts` | `laneArsenals(field)` (фильтрует лутбоксы), `applyBattleResult(state, result)`, `bestWeaponTier(state)`. **Dynamic reward tuning**: внутренний `updateRewardTuning` после каждого боя обновляет `state.rewardMultiplier`/`strongStreak`/`weakStreak` по правилам `balance.dynamicDifficulty`. **Early field upgrade**: если best_tier ≥ cols×rows → ставит `pendingFieldUpgrade` для форсированного расширения на следующем уровне (через `nextFieldSize`). | ~130 |
| `autotest.ts` | Headless greedy player. `runAutotest(50)` → `AutotestReport`. Поля sample: `lanesReached`, `lanesTotal`, `weaponsLooted`, `lootboxesLooted`. | ~250 |
| `selfTest.ts` | Dev-time sanity. `coreSelfTest`, `battleSelfTest`, `levelSanityTest`. | ~95 |
| `rng.ts` | mulberry32 seeded RNG. `makeRng(seed)`, `rint(rng, lo, hi)`. | ~25 |

### Scenes (`src/scenes/`)

| Файл | Что |
|------|-----|
| `BootScene.ts` | Двухфазная загрузка: 1) Spine JSON локации, 2) PNG-слои (имена из JSON). Затем self-tests + → WorldScene. |
| `WorldScene.ts` | **Главная сцена** — база + бой в одной. Modes: `base/transition/battle/returning/showing_result`. Камера скроллит от Y=0 (base) к Y<0 (road). См. §3 для геометрии. |
| `sceneKeys.ts` | `{ Boot: 'Boot', World: 'World' }`. |

### UI (`src/ui/`)

| Файл | Что |
|------|-----|
| `hud.ts` | Топ-бар: лом + алмазы. |
| `mergeBoard.ts` | Мердж-грид: drag-merge, tap-merge, tap-to-open lootbox, drag-to-trash. Callbacks: `onChange/onMerge/onOpenLootbox/onTrash`. |
| `inventoryBar.ts` | Переполнение (`state.inventory`) как **бесконечный стек 1-ячейка**. Видна верхушка (последний добытый) + `×N` справа. Tap → `pullFromInventory` (pop + случайная свободная клетка). |
| `button.ts` | Прим. кнопка. `setLabel/setBg/setEnabled`. |
| `devPanel.ts` | DEV-only (`import.meta.env.DEV`): ресурсы / прогресс / баланс-редактор / autotest. |

### Art (`src/art/`) — финальный визуал локаций

| Файл | Что |
|------|-----|
| `locationLoader.ts` | Универсальный JSON-формат `figma-layout-1`: top-left coords (Y down) + width/height + drawOrder + flipX/Y. `parseLocation(json)` → `LocationManifest`. `buildLocation(scene, manifest, opts, overrides)` → Phaser.Image per layer (origin 0.5). `uniqueImages(manifest)` — дедуп для preload (несколько слоёв могут ссылаться на одну текстуру, например road_l1 → road_r* через flipX). |

### Editor (`src/editor/`) — визуальный редактор (DEV-only)

| Файл | Что |
|------|-----|
| `layoutOverrides.ts` | LocalStorage CRUD для per-id override (x/y/scaleX/scaleY/depth/visible/deleted). Ключ `zm_layout_overrides`. `applyOverride(obj, ovr)`, `exportOverridesJSON()`. |
| `layoutEditor.ts` | Класс `LayoutEditor(scene)`. Включается из dev-panel'и. Drag элементов, click → выделение, HTML overlay-panel с numeric inputs (X/Y/ScaleX/ScaleY/Uniform/Depth). Кнопки: Reset item / Hide / Duplicate / Delete / Export JSON / Reset ALL. |

### Public arts (`public/art/<location>/`)

| Путь | Что |
|------|-----|
| `public/art/base/base.json` | Манифест слоёв базы в формате `figma-layout-1` (импорт из Figma). |
| `public/art/base/images/*.png` | PNG-слои (имена = `image` из JSON). `road_l1.png` — общий для 8 сегментов дороги (road_l/r через flipX). |

### Config (`src/config/`)

| Файл | Что |
|------|-----|
| `balance.ts` | **Single source of truth.** Шапка файла — PRIMARY TUNING KNOBS (см. §4). |
| `constants.ts` | `DESIGN_WIDTH=720`, `DESIGN_HEIGHT=1280`, `COLORS`, `TIER_COLORS[1..12]`. |
| `gameConfig.ts` | Phaser config. Scene list. |

### Scripts (`scripts/`)

| Файл | Что |
|------|-----|
| `_shim.ts` | Общий localStorage-shim для CLI. |
| `balance-quick.ts` | **Дефолтная проверка** — только L5, L25, L50. ~5 строк вывода. |
| `balance-deep.ts` | Полный прогон 50 уровней (бывший autotest-cli). |

### Docs (`docs/`)

| Файл | Что |
|------|-----|
| `PROJECT_MAP.md` | Этот файл. |
| `SAVES.md` | Контракт сейва. |
| `BALANCE.md` | Архитектура баланса, override-проток. |
| `ADS.md` | Задел под Yandex Mobile Ads. |
| `GDD.md` | Геймдиз. |

---

## 2. Data flow

### При нажатии «В БОЙ»
```
WorldScene.goBattle
  ├─ generateLevel(state.level, {workshopTier, bestTier})    // levelGen.ts
  │    ├─ sampleZombieTier × N per lane                       // gaussian + wildcard
  │    └─ makeChest (взвешенно reward = scrap|weapon|lootbox)
  ├─ laneArsenals(state.field)                                // progression.ts
  │    └─ skip lootboxes (isWeaponCellValue)
  ├─ simulateBattle(level, arsenals)                          // battleSim.ts
  │    └─ per-lane lunge model with carry chain
  ├─ playOpeningSequence (gates → fighters → lanes)
  ├─ lunge playback per lane (UI animation of timeline)
  └─ onAllDone → showResult
      └─ applyBattleResult(state, result)                     // progression.ts
          ├─ scrap += totalScrap
          ├─ inventory.push(...totalWeapons)
          ├─ field.cells lootbox-codes pushed (или inventory если full)
          ├─ workshopTier++ if level ∈ upgradeAtLevels
          └─ resizeField if needed
```

### При тапе лутбокса на поле
```
mergeBoard.handleTap
  └─ if isLootboxCode → cb.onOpenLootbox(idx, kind)
      └─ WorldScene.openLootbox
          ├─ rollLootboxTier(kind, workshopTier, bestTier, rng)  // lootbox.ts
          └─ state.field.cells[idx] = tier
```

### При drag на трэш
```
mergeBoard.resolveDrop
  └─ if to==-1 && inTrashZone → cb.onTrash(idx)
      └─ WorldScene.trashWeapon
          ├─ refund = produceCost(tier) × refundRatio
          └─ cell=null, scrap+=refund
```

---

## 3. WorldScene geometry

```
World Y axis (positive grows down):
  Y < 0          : road area (extends upward, scrollable)
    chestRowY    = obstacleY(maxObsInLevel-1) - CHEST_GAP    (single Y per level)
    obstacleY(i) = GATE_Y - GATE_BUFFER - (i+0.5)*ZOMBIE_SPACING   // const spacing
  Y = 440        : GATE_Y — ворота (бывший забор)
  Y = 0..1280    : base view (всегда видно при scrollY=0)
                   ↳ 250: «ГОРОД» лейбл
                   ↳ 465..875: мердж-поле
                   ↳ 885..959: инвентарь (слева) + ТРЭШ (справа)
                   ↳ 1010: «Произвести»
                   ↳ 1112: «В БОЙ»
                   ↳ 1210: СКИП + speed (×0.5/×1/×4) при бое — scrollFactor=0
  Y > 1280       : off-screen below (куда уходят отступающие)

Camera:
  setBounds: Y=-3500 .. +1880 (room for max road + off-screen below)
  scrollY=0  : base view default
  scrollY<0  : road visible (battle)
  update()   : target = leadY - 45% viewport. ОНLY DECREASES during battle.
  on return  : tween scrollY=0 (animate back to base).

Constants in WorldScene:
  GATE_Y=440, GATE_BUFFER=50, ZOMBIE_SPACING=64, CHEST_GAP=64
  FIGHTER_VIEW_OFFSET = DESIGN_HEIGHT/3  ≈ 427   // лидер у сундука на верхней 1/3 экрана
  CAMERA_TOP_BUFFER = FIGHTER_VIEW_OFFSET-46+60 ≈ 441 // запас «неба» над сундуком
  WORLD_TOP_BOUND=-3500, WORLD_BOTTOM_BOUND=DESIGN_HEIGHT+600
  OFF_SCREEN_BELOW_Y = DESIGN_HEIGHT+200 (куда уходят retreating)

Render layers (depth scheme):
  • UI screen-space (scrollFactor=0) — поверх всего, не уезжает с камерой.
      depth 300: HUD.
      depth 150–152: result modal (dim/panel/text/back).
      depth 100: produceBtn/battleBtn (visible=false в бою), СКИП, ×speed.
  • World (scrollFactor=1) — уезжает с камерой.
      depth 50–51: mergeOverlay «В БОЮ» (затемнение мердж-поля).
      depth 15: renderChestContent (награда над сундуком).
      depth ≥5: бойцы.
      depth 0 (default): мердж-поле, инвентарь, ТРЭШ, зомби/коробки/сундуки/гейты/HP-бары.
      depth -10..-9: примитивы-фон (городский квадрат / забор / база — fallback если нет арта).
      depth -45: тайлы динамической дороги (road_l1).
      depth -50..-42: статические Figma-слои базы (ground/wall/gate/lamp в порядке drawOrder).
```

---

## 4. PRIMARY TUNING KNOBS

**Если просят «крутить баланс» — менять в первую очередь ЭТО.**

### Difficulty (как быстро игра становится сложнее)
- `balance.levelGen.zombieCountPerLevel` (0.45) — зомби/уровень.
- `balance.levelGen.zombieTierGrowthPerLevel` (0.18) — рост центра гауссиана.
- `balance.levelGen.zombieTierSpread` (1.5) — ширина распределения тиров.
- `balance.levelGen.zombieTierWildcardShare` (0.05) — равномерная примесь (high-tier surprises).

### Economy (сколько лома / оружий получает игрок)
- `balance.economy.startScrap` (30).
- `balance.levelGen.scrapPerPile` (9), `scrapPilesMin/Max` (2/3).
- `balance.chest.rewardWeights` ({scrap:0.15, weapon:0.20, lootbox:0.65}).
- `balance.chest.scrapMin/Max` (14/32) — лом из сундука когда reward=scrap.

### Player progression (как сильно растёт игрок)
- `balance.workshop.upgradeAtLevels` ([4, 12, 22]) — апгрейд цеха.
- `balance.weapons[N].hits` — линейный N+3.
- `balance.chest.chestWeaponOffsetMin/Max` ([-2, +2]) — тир оружия из сундука vs workshop.
- `balance.lootbox.eliteOffsetMin/Max` ([-2, 0]) — тир elite-лутбокса vs player best.

### Dynamic difficulty (подкрутка наград от силы игрока)
- `balance.dynamicDifficulty.strongChestRatio` (0.8) — порог «strong» уровня (reached/total).
- `balance.dynamicDifficulty.strongStreakTrigger` (3) — после скольких подряд strong-уровней начинается нерф.
- `balance.dynamicDifficulty.nerfStep` (0.7) — мультипликатор за каждый nerf-tick (-30%).
- `balance.dynamicDifficulty.buffStep` (1.5) — мультипликатор за каждый weak-уровень (+50%, с 1-го раза).
- `balance.dynamicDifficulty.multMin/Max` (0.1 / 10.0) — clamp для `state.rewardMultiplier`.

### Anchors (зомби-HP — линейная интерполяция между анкорами)
- `balance.zombies[1].hp=5`, `[6].hp=25`, `[12].hp=150`. Промежуточные piecewise linear.
- `balance.zombies[N].hp` — можно изменить любой.

---

## 5. Invariants (НЕ нарушать)

- **Cell encoding**: `field.cells[i]` и `inventory[i]` — `number | null`.
  - `1..maxTier` = оружие.
  - `1001` = medium lootbox.
  - `1002` = elite lootbox.
  - Лотбоксы не мерджатся (`canMergeIndices` отсекает через `isWeaponCellValue`).
- **Determinism**:
  - `generateLevel(level, ctx)` — детерминированна (seed=level + ctx).
  - `simulateBattle(level, arsenals)` — без RNG, чистый функционал.
  - Lootbox tier roll — при ОТКРЫТИИ, не при выпадении (отдельный `lootRng`).
- **Lane length parity**: `lanes[i].obstacles.length` ОДИНАКОВ для всех линий уровня
  (`zombieCount + pilesCount` где оба не зависят от линии). Сундуки выровнены по единой Y.
  Если меняешь genLane — не нарушай это.
- **Save schema**: один ключ `zm_save`. Если изменяешь формат `SaveState` — миграция В `core/migrations.ts` обязательна. Бамп `schemaVersion` через `migrations[N]`.
- **Render order**: камера показывает `setScrollFactor(0)` для UI (СКИП, ×speed, result modal, toast). Остальное в мировом пространстве.

---

## 6. Common tasks (готовые рецепты)

### «Добавь параметр в balance»
1. `src/config/balance.ts`: добавь поле в `Balance` interface + значение в `balance:` объекте.
2. Использование: `getBalance().{path}` из `balanceRuntime.ts`.
3. Если параметр — primary tunable, занеси в §4 этого файла.

### «Тюнь сложность»
1. Редактируй §4 → Difficulty.
2. **НЕ запускай автотест** без явной просьбы — это много токенов.
3. Если просят проверить → `npx tsx scripts/balance-quick.ts` (L5/25/50).
4. Если просят глубоко → `npx tsx scripts/balance-deep.ts`.

### «Добавь новый зомби-тир / оружие-тир»
1. `balance.maxTier` (если 12+).
2. `balance.weapons[N]` или `balance.zombies[N]` — HP/dmg/hits.
3. `balance.workshop.produceCostByTier[N]` если оружие.
4. `constants.TIER_COLORS[N]` для оружия / WorldScene `ZOMBIE_TIER_COLORS[N]` для зомби.

### «Изменить визуал/анимацию боя»
- Всё в `WorldScene.ts`. Структура файла:
  1. Imports + Layout constants + ZOMBIE_TIER_COLORS + Lunge types.
  2. Class: state, lifecycle (create/update).
  3. Base UI (build + handlers: produce/pullItem/openLootbox/trash).
  4. `goBattle` → `buildRoad` + `buildSpeedHud` + `playOpeningSequence`.
  5. Lunge model: `buildLaneEvents`, `runEvents`, `playLunge`, `playChest`, `playStuck`, `applyHpSnap`.
  6. `returnFighterOffscreen`, `showResult`, `returnToBase`.
- Геометрия — §3 здесь.

### «Поправь сейв»
1. Если меняется СТРУКТУРА `SaveState` — добавь миграцию в `core/migrations.ts`.
2. Иначе — просто редактируй `DEFAULT_STATE()` в `storage.ts`.
3. Self-test (`migrationsSelfTest`) ловит дыры в реестре.

---

## 7. Behavioral rules for Claude

- **Don't re-read** этот файл и большие исходники без необходимости. Если ответ здесь — используй.
- **Don't run autotest** (balance-quick/deep) **без явной просьбы пользователя**. Балансовые правки сами по себе не требуют прогона.
- **Quick > deep**: дефолтная проверка баланса — `balance-quick.ts` (5 строк). Только по запросу «прогони полностью / 50 уровней» — `balance-deep.ts`.
- **Read with `offset`/`limit`**: если знаешь, что нужен только конкретный кусок файла — читай только его.
- **Используй Grep с `-A`/`-B`** вместо последующего Read.
- **Не пиши «защитные» переcчёты** — если значение не изменилось, кэш через `getBalance()` уже его держит.
