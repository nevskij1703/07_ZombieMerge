# ZombieMerge — Project Map

**Для Claude:** читай этот файл В ПЕРВУЮ ОЧЕРЕДЬ в каждой сессии. Здесь — индекс,
который позволяет НЕ загружать большие куски кода для понимания структуры. Если
ответ есть здесь — не открывай файл.

---

## 1. File index

### Core (`src/core/`) — чистая логика, без UI

| Файл | Что | ~lines |
|------|-----|--------|
| `storage.ts` | Single-key save `zm_save`. `getState/save/update/reset/load`. Merges with defaults on load. mergeDefaults фолбэчит `inventory`/`battledTiers` в `[]` если в сейве мусор. | 120 |
| `migrations.ts` | Каскадные миграции схемы сейва. `migrations[N]: state → state`. `getCurrentSchemaVersion()` = max(keys). `migrationsSelfTest()`. **Current = v4** (battledTiers). | 75 |
| `balanceRuntime.ts` | `getBalance()` = base `balance.ts` + dev override из LS (key `zm_balance_override`). В release override игнорируется (Vite tree-shaking by `import.meta.env?.DEV`). | 70 |
| `weapons.ts` | `maxTier()`, `getWeapon(t)`, `weaponName(t)`, `canMergeTier(t)`, `nextTier(t)`. | 30 |
| `economy.ts` | `produceCost(tier)`, `canAfford(scrap, cost)`. | 15 |
| `merge.ts` | Field cell ops: `canMergeIndices`, `mergeInto`, `moveOrSwap`, `placeFirstFree`, `firstFreeIndex`, `isFull`, `freeCount`, `pullFromInventory`, `addLoot`, `resizeField`. **Лутбоксы блокируются `isWeaponCellValue` из `lootbox.ts`.** | 90 |
| `lootbox.ts` | Кодирование лутбоксов в клетках: `LOOTBOX_CHEAP_CODE=1003`, `LOOTBOX_MEDIUM_CODE=1001`, `LOOTBOX_ELITE_CODE=1002`. `isWeaponCellValue`, `isLootboxCode`, `lootboxKindOfCode`, `rollLootboxTier(kind, workshopTier, bestTier, rng)`: cheap=workshop+rand[-3..0], medium=center(workshop,best)+rand[-1..1], elite=best+rand[-2..0]. | 60 |
| `levelGen.ts` | `generateLevel(level, ctx?)` детерминированная. `ctx`: `workshopTier`, `bestTier`, `rewardMultiplier`, **`fieldColsOverride`** (для раннего апгрейда поля). Sample tier по `sampleZombieTier`. `enforceMinTypes` на L1. Crate HP = 2×max лиции, lootbox kind weighted по `balance.lootbox.shares` (cheap/medium/elite). **Длина дорог одинакова на всех линиях**. **Anchored shuffle** тиров зомби (weak в начале, mid/strong перемешаны). **Dynamic reward tuning** через `scaleBalance(b, rewardMultiplier)` → scrapPerPile, chest.scrap*, chest.rewardWeights, lootbox.shares. | 315 |
| `battleSim.ts` | **AUTOTEST-ONLY**. `simulateBattle(level, arsenals)` → `BattleResult`. Не используется в живой игре с момента Task 80 (rewrite на realtime tick в WorldScene). Lunge-модель: carry-пробивание (`carryIn`/`carryOut`). Чистая, без RNG. Нужен для headless-прогона баланса (`autotest.ts`, `balance-*.ts`) и `selfTest.ts`. При расхождении правил боя с `BattleTickEngine` — autotest перестаёт отражать live balance. | 215 |
| `progression.ts` | `laneArsenals(field)` (фильтрует лутбоксы), `applyBattleResult(state, result)`, `bestWeaponTier(state)`, **`levelPassBonus(workshopTier)`** (×6 от produceCost, округление до 100). **Dynamic reward tuning**: `updateRewardTuning` после боя обновляет `state.rewardMultiplier`/`strongStreak`/`weakStreak` по `balance.dynamicDifficulty`. **Early field upgrade**: если best_tier ≥ cols×rows → `pendingFieldUpgrade=true` для форсированного расширения на следующем уровне. | 145 |
| `autotest.ts` | Headless greedy player. `runAutotest(50)` → `AutotestReport`. Поля sample: `lanesReached`, `lanesTotal`, `weaponsLooted`, `lootboxesLooted`. Использует `simulateBattle`. | 235 |
| `selfTest.ts` | Dev-time sanity. `coreSelfTest`, `battleSelfTest`, `levelSanityTest`. | 90 |
| `rng.ts` | mulberry32 seeded RNG. `makeRng(seed)`, `rint(rng, lo, hi)`. | 25 |

### Scenes (`src/scenes/`)

| Файл | Что | ~lines |
|------|-----|--------|
| `BootScene.ts` | Двухфазная загрузка: 1) Spine JSON локации, 2) PNG-слои (имена из JSON). Затем self-tests + → WorldScene. | 220 |
| `WorldScene.ts` | **Оркестратор сцены** — lifecycle + base UI + переходы base↔battle + result modal + base actions. Делегирует подсистемам в `world/`. Modes: `base/transition/battle/showing_result`. См. §3 для геометрии. | 565 |
| `sceneKeys.ts` | `{ Boot: 'Boot', World: 'World' }`. | 5 |

### World subsystems (`src/scenes/world/`) — выделено из WorldScene

| Файл | Что | ~lines |
|------|-----|--------|
| `types.ts` | `SceneMode`, `LaneState`, `ArsenalWeapon`, `ObRuntime`, `LaneRuntime`. Per-battle runtime-типы (не save). | 54 |
| `constants.ts` | Геометрия (`GATE_Y=440`, `ZOMBIE_SPACING=64`, `CHEST_GAP=64`, …), тюнинг боя (`FIGHTER_WALK_SPEED=0.3`, `BACKSTEP_DISTANCE=36`, `ATTACK_RANGE=14`, `ZOMBIE_STUN_MS=200`, `RESULT_DELAY_MS=1000`, …), камера (`WORLD_TOP_BOUND=-3500`, `FIGHTER_VIEW_OFFSET`), палитра `ZOMBIE_TIER_COLORS[1..12]`, helper `obstacleY(idx)`. | 49 |
| `baseArt.ts` | Класс `BaseArtController` — base art tiles + road + gradients + lamps. Public: `byId`, `entries`, `build`, `openGates(onComplete)`, `closeGates`, `startLampBlink`, `fadeLampsOff`, `setGradientsVisible`, `extendRoadForBattle(targetTop, battleNodes)`. | 273 |
| `fighters.ts` | Класс `FightersController` — persistent fighter containers + tier/hits texts + weapon icons + rings. Public: `fighters` (array), `ensureExists`, `tweenAllToIdle`, `resetVisualToIdle`, `setTokenSize`, `renderFighterWeapon(lane)`. Helper `buildArsenal(tiers)` → `{active, rest}`. | 189 |
| `chestReward.ts` | Pure render-функции (без state-мутаций): `openChestVisual(scene, chest)` — лид взлетает + bouncing, `renderChestContent(scene, chestDef, cx, topY)` → Container с PNG weapon-иконки / lootbox PNG / fallback rect. Caller сам push'ит в `battleNodes`. | 142 |
| `battleTick.ts` | Класс `BattleTickEngine` — реалтайм-двигатель боя. Owns `laneRuntimes` + `battleNodes` + `level` + геометрию. Per-frame `tick(dt, now)`: движение зомби, FSM бойцов (walking/backstep/retreating/at_chest/finished), chest open. Public: `resetForBattle`, `buildLaneRuntime(li, tiers)`, `tick`, `skip` → `BattleResult \| null`, `assembleResult`. Communicates via `deps.onResultReady`. | 524 |

### UI (`src/ui/`)

| Файл | Что | ~lines |
|------|-----|--------|
| `hud.ts` | Топ-бар: «УРОВЕНЬ N-M» + монетка-фрейм со счётчиком scrap + кнопка-шестерёнка settings. | 110 |
| `mergeBoard.ts` | Мердж-грид: drag-merge, tap-merge, tap-to-open lootbox, drag-to-trash. Callbacks: `onChange/onMerge/onOpenLootbox/onTrash/onLayoutChanged`. Делегирует render плиток в `merge/tileFactory.ts`, VFX — в `merge/vfx.ts`. Section dividers: Input handling / Tap & drop resolver / Merge & move / Selection + glow / Geometry & cell rendering. | 485 |
| `merge/vfx.ts` | Pure VFX: `ensureMergeVfxTextures` (canvas radial-gradient для spark/flash/shockwave), `spawnMergeSparks`, `spawnLootboxFireworks`, `playMergeVfx` (5-phase: lunge → separate → shake → converge → flash+shockwave+fade-in new tile), `playLootboxBurst` (puff + collapse). | 318 |
| `merge/tileFactory.ts` | Pure фабрики: `makeWeaponTile(scene, center, tier, cellSize, battledTiers)` — иконка + tier-digit + «NEW!»-бейдж для tier ≥ NEW_BADGE_MIN_TIER если не в battledTiers. `makeLootboxTile`, `makeSlotBg`, `shouldShowNewBadge(tier, battledTiers)`. | 198 |
| `inventoryBar.ts` | Переполнение (`state.inventory`) как **бесконечный стек 1-ячейка**. Видна верхушка (последний добытый). Tap → `pullFromInventory` (pop + случайная свободная клетка). PNG-иконки для weapon (по WEAPON_FRAME_PX) и lootbox (× LOOTBOX_ICON_SCALE). | 130 |
| `mainScreen.ts` | Нижний ряд: 4 brown-кнопки (profile/upgrade/cards/shop) + большая зелёная «ПРОИЗВЕСТИ» + жёлтая «В БОЙ!». 3-state visuals (default/pressed/disabled) per figma. Section dividers: Button effect helpers / Button factories. | 385 |
| `button.ts` | Примитивная кнопка. `setLabel/setBg/setEnabled`. | 50 |
| `devPanel.ts` | DEV-only (`import.meta.env.DEV`): ресурсы / прогресс / баланс-редактор / autotest. | 435 |

### Art (`src/art/`) — финальный визуал локаций

| Файл | Что |
|------|-----|
| `locationLoader.ts` | Универсальный JSON-формат `figma-layout-1`: top-left coords (Y down) + width/height + drawOrder + flipX/Y. `parseLocation(json)` → `LocationManifest`. `buildLocation(scene, manifest, opts, overrides)` → Phaser.Image per layer (origin 0.5). `uniqueImages(manifest)` — дедуп для preload. `findTileset(manifest, name)` — поиск тайлсета (для динамической road-генерации). |

### Editor (`src/editor/`) — визуальный редактор (DEV-only)

| Файл | Что |
|------|-----|
| `layoutOverrides.ts` | LocalStorage CRUD для per-id override (x/y/scaleX/scaleY/depth/visible/deleted). Ключ `zm_layout_overrides`. `applyOverride(obj, ovr)`, `exportOverridesJSON()`, `loadOverrides()`. |
| `layoutEditor.ts` | Класс `LayoutEditor(scene)`. Drag элементов, click → выделение, HTML overlay-panel с numeric inputs (X/Y/ScaleX/ScaleY/Uniform/Depth). Кнопки: Reset item / Hide / Duplicate / Delete / Export JSON / Reset ALL. |

### Public arts (`public/art/<location>/`)

| Путь | Что |
|------|-----|
| `public/art/base/base.json` | Манифест слоёв базы в формате `figma-layout-1` (импорт из Figma). Содержит `overrides` для built-in patches (например `base.road`, `base.ground`). |
| `public/art/base/images/*.png` | PNG-слои (имена = `image` из JSON). `road_l1.png` — общий для 8 сегментов дороги. |
| `public/art/ui/main.json` + `images/*.svg`/`*.png` | UI ассеты (btn_brown/green/yellow, btn_green_disabled, иконки profile/upgrade/cards/shop/fight/coin/arrows, merge_slot, inv_place, trash_place, lootbox_cheap/medium/elite). |
| `public/art/weapons/weapons.json` + `images/weapon_t<N>.png` | 19 PNG-иконок оружия (T1-T19), 136×136 фрейм × pngScale 2 = 272 px (см. `WEAPON_FRAME_PX`). |

### Config (`src/config/`)

| Файл | Что |
|------|-----|
| `balance.ts` | **Single source of truth.** Шапка файла — PRIMARY TUNING KNOBS (см. §4). |
| `constants.ts` | `DESIGN_WIDTH=720`, `DESIGN_HEIGHT=1280`, `COLORS`, `TIER_COLORS[1..19]` для оружия, `WEAPON_FRAME_PX=272`, `LOOTBOX_ICON_SCALE=0.7`, `NEW_BADGE_MIN_TIER=5`, `UI` (slot/btn/text цвета). |
| `gameConfig.ts` | Phaser config. Scene list. |

### Top-level

| Файл | Что |
|------|-----|
| `src/types.ts` | Общие domain-типы: `WeaponTier`, `ZombieTier`, `LootboxKind`, `ChestRewardKind`, `FieldState`, **`SaveState`** (включая `battledTiers`, `rewardMultiplier`, `pendingFieldUpgrade`, `strongStreak`/`weakStreak`), `Obstacle`, `Lane`, `Level`, `LaneStep`, `LaneResult`, `BattleResult`. |
| `src/main.ts` | Bootstrap: создание Phaser.Game с `gameConfig`. Экспонирует `window.__zm` (helpers для dev console) и `window.__game` (Phaser instance) в DEV. |

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

`WorldScene.goBattle` → reset mode → ensure fighters → mark `battledTiers` →
generate level → compute geometry → battle engine init → spawn → start tick:

```
WorldScene.goBattle
  ├─ if no weapons on field: toast + return
  ├─ mode = 'transition'
  ├─ fightersCtl.ensureExists()                            // sync N с field.cols
  ├─ update battledTiers: add all field tiers ≥ NEW_BADGE_MIN_TIER (для «NEW!» бейджа)
  ├─ level = generateLevel(state.level, {
  │      workshopTier, bestTier, rewardMultiplier,
  │      fieldColsOverride: state.field.cols,              // ← для раннего апгрейда поля
  │    })                                                  // levelGen.ts
  ├─ arsenals = laneArsenals(state.field)                  // skip lootboxes
  ├─ compute maxObsCount, laneWidth, chestRowY, worldTopY (geometry)
  ├─ battle.resetForBattle(level, maxObsCount, chestRowY, worldTopY, laneWidth)
  ├─ baseArt.extendRoadForBattle(worldTopY, battle.battleNodes)
  ├─ for li ∈ cols: battle.buildLaneRuntime(li, arsenals[li])
  ├─ buildSpeedHud() + mainUI.setBottomVisible(false) + baseArt.setGradientsVisible(false)
  └─ baseArt.openGates(() => spawnAndDispatchFighters())   // 600ms tween
        └─ spawnAndDispatchFighters
              └─ for each fighter: tween к pickup-Y → board.hideWeaponTiles() →
                 tween к laneStartY → когда все arrived → startBattle()
                    └─ mode = 'battle'
                         (с этого момента WorldScene.update → battle.tick(dt, now))
```

### Per-frame battle tick (mode='battle' или 'showing_result')

```
WorldScene.update(dt)
  ├─ updateCameraFollow()                                  // scrollY ← min(target, scrollY)
  └─ battle.tick(subDt, now)                               // [BattleTickEngine]
        ├─ for lane: moveLaneZombies (collision/stun/crate-block/view-clip)
        ├─ for lane: tickLane → tickFighterWalking/Backstep/Retreating
        │     • walking → switch weapon → find next obstacle → attack/scrap/walk-chest
        │     • attack: -1 hit, -dmg HP → kill (continue) or backstep+stun
        │     • walkOrOpenChest → openChestForLane → openChestVisual + renderChestContent
        ├─ check allDone (all lanes ∈ {at_chest, retreating, finished})
        └─ если allDone + RESULT_DELAY_MS истекла → deps.onResultReady()
              └─ WorldScene.showResult()
                    ├─ result = battle.assembleResult()
                    ├─ passBonus = levelPassBonus(state.workshopTier)  (ДО applyBattleResult)
                    ├─ applyBattleResult(state, result)
                    │     ├─ scrap += totalScrap + passBonus
                    │     ├─ inventory.push(...totalWeapons)
                    │     ├─ field.cells lootbox-codes pushed (или inventory если full)
                    │     ├─ workshopTier++ if level ∈ upgradeAtLevels
                    │     ├─ updateRewardTuning(state, result) — динамическая подкрутка
                    │     ├─ pendingFieldUpgrade=true if bestTier ≥ cols×rows
                    │     └─ resizeField if needed
                    └─ modal: «УРОВЕНЬ ПРОЙДЕН/НЕ ПРОЙДЕН» + детали + кнопка НА БАЗУ
```

### При возврате на базу

```
WorldScene.returnToBase
  ├─ destroy result modal + speedHud + skipBtn
  ├─ mode = 'base'
  ├─ battle.level = null, battle.laneRuntimes = []
  ├─ mainUI.setBottomVisible(true) + baseArt.setGradientsVisible(true)
  ├─ camera tween scrollY=0, onComplete → destroy battle.battleNodes[]
  ├─ baseArt.closeGates() + fadeLampsOff
  ├─ board.relayout(state.field)                         // пересоздаёт плитки → «NEW!» исчезает
  ├─ inv.rebuild() + hud.refresh()
  └─ if field.cols changed: fightersCtl.ensureExists() else tweenAllToIdle(newCols)
```

### При тапе лутбокса на поле

```
mergeBoard.handleTap
  └─ if isLootboxCode → cb.onOpenLootbox(idx, kind)
      └─ WorldScene.openLootbox
          ├─ rollLootboxTier(kind, workshopTier, bestTier, lootRng)  // lootbox.ts
          └─ state.field.cells[idx] = tier
      └─ mergeBoard.playLootboxOpenVfx(idx)                          // merge/vfx.ts
          (puff + collapse + sparks → new weapon-tile fade-in)
```

### При drag на трэш

```
mergeBoard.resolveDrop → cb.onTrash(idx)
  └─ WorldScene.trashWeapon
      ├─ refund = produceCost(tier) × balance.trash.refundRatio
      └─ cell=null, scrap+=refund
```

---

## 3. WorldScene geometry

```
World Y axis (positive grows down):
  Y < 0          : road area (extends upward, scrollable)
    chestRowY    = obstacleY(maxObsInLevel-1) - CHEST_GAP    (single Y per level)
    obstacleY(i) = GATE_Y - FIRST_ZOMBIE_OFFSET - i*ZOMBIE_SPACING   // const spacing
  Y = 440        : GATE_Y — ворота (общая граница базы и города)
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
  update()   : target = leadY - FIGHTER_VIEW_OFFSET. ОНLY DECREASES during battle.
  on return  : tween scrollY=0 (animate back to base).

Constants (`src/scenes/world/constants.ts`):
  GATE_Y=440, FIRST_ZOMBIE_OFFSET=500, ZOMBIE_SPACING=64, CHEST_GAP=64
  FIGHTER_IDLE_Y=500, FIGHTER_PICKUP_Y=580
  FIGHTER_WALK_SPEED=0.3, FIGHTER_BACKSTEP_SPEED=0.275, FIGHTER_RETREAT_SPEED=0.30
  ATTACK_RANGE=14, BACKSTEP_DISTANCE=36
  ZOMBIE_SPEED_RATIO=0.25, ZOMBIE_STUN_MS=200, ZOMBIE_STOP_MARGIN=6
  CHEST_APPROACH_DIST=50, RESULT_DELAY_MS=1000
  FIGHTER_VIEW_OFFSET = DESIGN_HEIGHT/3 ≈ 427    // лидер у сундука на верхней 1/3 экрана
  CAMERA_TOP_BUFFER = FIGHTER_VIEW_OFFSET-46+60 ≈ 441  // запас «неба» над сундуком
  WORLD_TOP_BOUND=-3500, WORLD_BOTTOM_BOUND=DESIGN_HEIGHT+600
  OFF_SCREEN_BELOW_Y = DESIGN_HEIGHT+200 (куда уходят retreating)

Render layers (depth scheme):
  • UI screen-space (scrollFactor=0) — поверх всего, не уезжает с камерой.
      depth 1000: toast.
      depth 300: HUD.
      depth 250: top gradient.
      depth 150–152: result modal (dim/panel/text/back).
      depth 100: produceBtn/battleBtn (visible=false в бою), СКИП, ×speed.
      depth 99: bottom gradient.
  • World (scrollFactor=1) — уезжает с камерой.
      depth 60: merge flash (ADD-blend во время мерджа).
      depth 55: shockwave кольцо.
      depth 50: летающие искры (sparks).
      depth 15: renderChestContent (награда над сундуком).
      depth 10: мердж-плитки (weapon/lootbox).
      depth ≥5: бойцы.
      depth 1: merge slot backgrounds.
      depth 0 (default): мердж-ground, зомби/коробки/сундуки/HP-бары.
      depth -10..-9: примитивы-фон (fallback если нет арта).
      depth -49.5: тайлы дороги (road_l1).
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
- `balance.levelGen.crateLaneChance` — шанс что в линии будет коробка (вместо зомби).
- `balance.levelGen.crateHpMultiplier` — множитель HP коробки vs самого крепкого зомби уровня.
- `balance.levelGen.crateWeaponChance` — шанс что коробка `givesWeapon=true` (refill ресурса).

### Field progression

- `balance.field.steps[]` — прогрессия размеров поля по порогам уровней: 2×2 → 2×3 → 3×3 → 3×4 → 4×4 → 4×5 → 5×5. Cols определяет число Бойцов/линий.

### Economy (сколько лома / оружий получает игрок)

- `balance.economy.startScrap` (30).
- `balance.workshop.produceCostByTier[N]` — цена спавна оружия тира N (главная экономическая кривая).
- `balance.levelGen.scrapPerPile` (9), `scrapPilesMin/Max` (2/3).
- `balance.chest.rewardWeights` ({scrap, weapon, lootbox}) — взвешенный выбор награды сундука.
- `balance.chest.scrapMin/Max` (14/32) — лом из сундука когда reward=scrap.
- `balance.trash.refundRatio` — % от produceCost при удалении оружия в trash.

### Player progression (как сильно растёт игрок)

- `balance.workshop.upgradeAtLevels` ([4, 12, 22]) — апгрейд цеха (+1 тир производства).
- `balance.weapons[N].hits` — линейный N+3.
- `balance.weapons[N].damagePerHit` — ~1.4× / tier по дефолту.
- `balance.chest.chestWeaponOffsetMin/Max` ([-2, +2]) — тир оружия из сундука vs workshop.
- `balance.lootbox.shares` ({cheap, medium, elite}) — взвешенный выбор типа лутбокса.
- `balance.lootbox.cheapOffsetMin/Max` ([-3, 0]) — тир cheap-лутбокса vs workshop.
- `balance.lootbox.mediumOffsetMin/Max` ([-1, +1]) — тир medium-лутбокса vs center(workshop, best).
- `balance.lootbox.eliteOffsetMin/Max` ([-2, 0]) — тир elite-лутбокса vs best.

### Dynamic difficulty (подкрутка наград от силы игрока)

- `balance.dynamicDifficulty.strongChestRatio` (0.8) — порог «strong» уровня (reached/total).
- `balance.dynamicDifficulty.strongStreakTrigger` (1) — после скольких подряд strong-уровней начинается нерф. Default 1 = с 1-го раза, симметрично buff.
- `balance.dynamicDifficulty.nerfStep` (0.7) — мультипликатор за каждый nerf-tick (-30%).
- `balance.dynamicDifficulty.buffStep` (1.5) — мультипликатор за каждый weak-уровень (+50%).
- `balance.dynamicDifficulty.multMin/Max` (0.1 / 10.0) — clamp для `state.rewardMultiplier`.
- `scaleBalance(b, mult)` (в `levelGen.ts`) применяет `rewardMultiplier` к: scrapPerPile, chest.scrap*, chest.rewardWeights (weapon+lootbox × mult), lootbox.shares (cheap/mult, elite×mult).

### Anchors (зомби-HP — линейная интерполяция между анкорами)

- `balance.zombies[1].hp=5`, `[6].hp=25`, `[12].hp=150`. Промежуточные piecewise linear.
- `balance.zombies[N].hp` — можно изменить любой.

### Pass bonus

- `levelPassBonus(workshopTier)` в `progression.ts` = `ceil(produceCost(workshopTier) × 6 / 100) × 100`. Множитель `×6` — единственный tunable (можно вынести в balance при необходимости).

---

## 5. Invariants (НЕ нарушать)

- **Cell encoding**: `field.cells[i]` и `inventory[i]` — `number | null`.
  - `1..maxTier` (19) = оружие.
  - `1001` = medium lootbox.
  - `1002` = elite lootbox.
  - `1003` = **cheap** lootbox.
  - Лотбоксы не мерджатся (`canMergeIndices` отсекает через `isWeaponCellValue`).
- **battledTiers** (схема v4+) — список тиров оружия, с которыми игрок ходил в бой.
  Источник правды для «NEW!»-бейджа в `merge/tileFactory.ts`. Пополняется в
  `WorldScene.goBattle` (все weapon-тиры на поле ≥ `NEW_BADGE_MIN_TIER=5` →
  add to set). **НЕ сбрасывается** между играми. Уменьшаться не должен.
- **Determinism**:
  - `generateLevel(level, ctx)` — детерминированна (seed=level + ctx-зависимая mutation).
  - `simulateBattle(level, arsenals)` (AUTOTEST-ONLY) — без RNG, чистый функционал.
  - Live battle (`BattleTickEngine.tick`) — НЕдетерминированный (зависит от dt + frame timing).
  - Lootbox tier roll — при ОТКРЫТИИ, не при выпадении (отдельный `WorldScene.lootRng`).
- **Lane length parity**: `lanes[i].obstacles.length` ОДИНАКОВ для всех линий уровня
  (`zombieCount + pilesCount` где оба не зависят от линии). Сундуки выровнены по единой Y.
  Если меняешь genLane — не нарушай это.
- **Save schema**: один ключ `zm_save`. Если изменяешь формат `SaveState` — миграция В
  `core/migrations.ts` обязательна. Бамп `schemaVersion` через `migrations[N]`. Текущая v4.
- **Render order**: камера показывает `setScrollFactor(0)` для UI (СКИП, ×speed, result modal,
  toast, HUD, gradients, bottom buttons). Остальное в мировом пространстве (scrollFactor=1).

---

## 6. Common tasks (готовые рецепты)

### «Добавь параметр в balance»

1. `src/config/balance.ts`: добавь поле в `Balance` interface + значение в `balance:` объекте.
2. Использование: `getBalance().{path}` из `balanceRuntime.ts`.
3. Если параметр — primary tunable, занеси в §4 этого файла.

### «Тюнь сложность»

1. Редактируй §4 → Difficulty / Economy / Player progression.
2. **НЕ запускай автотест** без явной просьбы — это много токенов.
3. Если просят проверить → `npx tsx scripts/balance-quick.ts` (L5/25/50).
4. Если просят глубоко → `npx tsx scripts/balance-deep.ts`.

### «Добавь новый зомби-тир / оружие-тир»

1. `balance.maxTier` (если 19+).
2. `balance.weapons[N]` или `balance.zombies[N]` — HP/dmg/hits.
3. `balance.workshop.produceCostByTier[N]` если оружие.
4. `constants.TIER_COLORS[N]` для оружия / `world/constants.ts ZOMBIE_TIER_COLORS[N]` для зомби.
5. Если оружие — добавить PNG `public/art/weapons/images/weapon_t<N>.png` (136×136 фрейм).

### «Изменить визуал/анимацию боя»

- **Per-frame tick + FSM бойцов**: `src/scenes/world/battleTick.ts`. Методы:
  `tick`, `moveLaneZombies`, `tickFighterWalking`, `tickFighterBackstep`,
  `tickFighterRetreating`, `attackObstacle`, `killObstacle`.
- **Визуал бойца** (tier/hits/иконка оружия/ring): `src/scenes/world/fighters.ts` →
  `FightersController.renderFighterWeapon`.
- **Сундук open + reward visual**: `src/scenes/world/chestReward.ts` →
  `openChestVisual`, `renderChestContent`.
- **Ворота / лампы / дорога / градиенты**: `src/scenes/world/baseArt.ts` →
  `BaseArtController.openGates/closeGates/startLampBlink/extendRoadForBattle`.
- **Оркестрация**: `WorldScene.goBattle`, `spawnAndDispatchFighters`, `returnToBase`.
- Геометрия — §3 здесь.

### «Изменить визуал мерджа»

- **Tile rendering** (иконка оружия, tier-digit, «NEW!»-бейдж): `src/ui/merge/tileFactory.ts`.
- **Merge VFX** (bounce/shake/flash/shockwave/sparks): `src/ui/merge/vfx.ts` →
  `playMergeVfx`, `spawnMergeSparks`.
- **Lootbox open VFX** (puff/collapse/fireworks): `src/ui/merge/vfx.ts` →
  `playLootboxBurst`, `spawnLootboxFireworks`. New-tile fade-in после burst делает
  `MergeBoard.playLootboxOpenVfx` (нужен state-access).
- **Input / selection / glow**: `src/ui/mergeBoard.ts` (только эти концерны там остались).

### «Поправь сейв»

1. Если меняется СТРУКТУРА `SaveState` — добавь миграцию в `core/migrations.ts`.
2. Иначе — просто редактируй `DEFAULT_STATE()` в `storage.ts`.
3. Self-test (`migrationsSelfTest`) ловит дыры в реестре.
4. Текущая схема v4 — поля: scrap, diamonds, level, maxLevelReached, workshopTier,
   field, inventory, settings, stats, rewardMultiplier, strongStreak, weakStreak,
   pendingFieldUpgrade, battledTiers.

---

## 7. Behavioral rules for Claude

- **Don't re-read** этот файл и большие исходники без необходимости. Если ответ здесь — используй.
- **Don't run autotest** (balance-quick/deep) **без явной просьбы пользователя**. Балансовые правки сами по себе не требуют прогона.
- **Quick > deep**: дефолтная проверка баланса — `balance-quick.ts` (5 строк). Только по запросу «прогони полностью / 50 уровней» — `balance-deep.ts`.
- **Read with `offset`/`limit`**: если знаешь, что нужен только конкретный кусок файла — читай только его.
- **Используй Grep с `-A`/`-B`** вместо последующего Read.
- **WorldScene.ts (565 lines)** — оркестратор. Battle logic → `src/scenes/world/battleTick.ts`. Base art → `baseArt.ts`. Fighters → `fighters.ts`. Chest render → `chestReward.ts`. Не загружай весь WorldScene если нужна боевая правка — иди сразу в `world/`.
- **mergeBoard.ts (485 lines)** — input + selection + geometry. Tile render → `merge/tileFactory.ts`. VFX → `merge/vfx.ts`. Не загружай весь mergeBoard если правка по визуалу плиток или анимации мерджа.
- **battleSim.ts** — AUTOTEST-ONLY, не используется в live battle. Если правка реальной боёвки — иди в `world/battleTick.ts`.
