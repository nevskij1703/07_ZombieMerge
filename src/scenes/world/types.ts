// Общие runtime-типы для подсистем WorldScene (battleTick, fighters, chestReward).
// Сами по себе не описывают сейв (`src/types.ts`) или конфиг (`src/config/balance.ts`) —
// только то, что живёт В ПАМЯТИ во время одного боя.

import type Phaser from 'phaser';
import type { LootboxKind } from '../../types';

/** Глобальный mode WorldScene. Управляет: какие тики бегут, видны ли base-UI кнопки. */
export type SceneMode = 'base' | 'transition' | 'battle' | 'showing_result';

/** Per-lane FSM в бою. tickLane диспатчит на соответствующий tickFighterXxx. */
export type LaneState = 'walking' | 'backstep' | 'retreating' | 'at_chest' | 'finished';

/** Одно оружие в арсенале бойца (per-lane). Тратится hits → как только 0, switchWeapon
 *  выбирает следующее по силе из `arsenal`. */
export interface ArsenalWeapon {
  tier: number;
  hits: number;
  maxHits: number;
}

/** Препятствие на линии (zombie / crate / scrap-pile). Visuals (token + hp-bar + text)
 *  держим тут, чтобы `moveLaneZombies`/`killObstacle` двигали/уничтожали их атомарно. */
export interface ObRuntime {
  kind: 'zombie' | 'crate' | 'scrap';
  token: Phaser.GameObjects.GameObject;
  bar: Phaser.GameObjects.Rectangle | null;
  barBg: Phaser.GameObjects.Rectangle | null;
  hpText: Phaser.GameObjects.Text | null;
  hp: number;
  maxHp: number;
  scrap: number;
  givesWeapon: boolean;
  zombieTier: number;
  stunnedUntil: number;
  dead: boolean;
}

/** Полное runtime-состояние одной линии (= одного бойца). Создаётся в
 *  `buildLaneRuntime` (BattleTickEngine.build), мутируется в tick'ах, собирается в
 *  `BattleResult` в конце через `assembleResult`. */
export interface LaneRuntime {
  li: number;
  state: LaneState;
  fighter: Phaser.GameObjects.Container;
  /** Текущее активное оружие (`null` = арсенал пуст). */
  active: ArsenalWeapon | null;
  /** Остальные оружия (отсортированы DESC по тиру — strongest first). */
  arsenal: ArsenalWeapon[];
  obs: ObRuntime[];
  /** Image (ui.chest_close → ui.chest_opened по openChestVisual). */
  chest: Phaser.GameObjects.Image;
  chestY: number;
  chestOpened: boolean;
  reachedChest: boolean;
  scrapCollected: number;
  weaponsCollected: number[];
  lootboxesCollected: LootboxKind[];
  /** Y до которого боец должен отскочить во время backstep. */
  backstepTargetY: number;
}
