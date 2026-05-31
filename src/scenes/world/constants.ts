// Константы геометрии мира + тюнинг боя + камера + палитра зомби.
// Раньше жили в шапке WorldScene.ts; вынесены, чтобы можно было импортировать
// в подсистемы (baseArt, fighters, battleTick, chestReward) без циклов.

import { DESIGN_HEIGHT } from '../../config/constants';

// ============================ Геометрия мира ====================================

/** Y ворот — общая граница базы и города. base-view scrollY=0 → ворота видны. */
export const GATE_Y = 440;
/** Дистанция от ворот до ПЕРВОГО зомби. Первый зомби стартует за пределами видимой
 *  зоны базы, появляется по мере scroll'а камеры. */
export const FIRST_ZOMBIE_OFFSET = 500;
/** КОНСТАНТНЫЙ шаг между препятствиями в линии. */
export const ZOMBIE_SPACING = 64;
/** Зазор между самым дальним препятствием и сундуком в конце линии. */
export const CHEST_GAP = 64;
/** Idle позиция бойца на базе: между воротами (440) и мердж-полем (555). */
export const FIGHTER_IDLE_Y = 500;
/** Y «у мердж-поля» — pickup в начале боя (бойцы спускаются забрать оружие). */
export const FIGHTER_PICKUP_Y = 580;

// ============================ Тюнинг боя ========================================

export const FIGHTER_WALK_SPEED = 0.3;        // px/ms forward
export const FIGHTER_BACKSTEP_SPEED = 0.275;  // чуть медленнее walk (отскок после ранения)
export const FIGHTER_RETREAT_SPEED = 0.30;    // как walk; бежит на базу когда оружие кончилось
export const ATTACK_RANGE = 14;               // дистанция attack contact (px между center'ами)
export const BACKSTEP_DISTANCE = 36;          // насколько отлетает после ранения
export const ZOMBIE_SPEED_RATIO = 0.25;       // от скорости бойца (зомби автоматически замедляются вместе с бойцами)
export const ZOMBIE_STUN_MS = 200;            // не двигается после удара (= ~backstep duration)
export const ZOMBIE_STOP_MARGIN = 6;          // зазор перед бойцом/др зомби
export const CHEST_APPROACH_DIST = 50;        // когда бой подошёл к сундук area
export const RESULT_DELAY_MS = 1000;          // пауза после последней решённой лайн до модалки

// ============================ Камера / world bounds =============================

export const WORLD_TOP_BOUND = -3500;
export const WORLD_BOTTOM_BOUND = DESIGN_HEIGHT + 600;
export const FIGHTER_VIEW_OFFSET = DESIGN_HEIGHT / 3;
export const CAMERA_TOP_BUFFER = FIGHTER_VIEW_OFFSET - 46 + 60;
export const OFF_SCREEN_BELOW_Y = DESIGN_HEIGHT + 200;

// ============================ Палитра зомби =====================================

/** 12-тировая палитра зомби (1-based; index 0 — заглушка). T1 — мшистый зелёный,
 *  T12 — кроваво-красный, между ними плавный warm-shift через горчичный/оранжевый/охру. */
export const ZOMBIE_TIER_COLORS: number[] = [
  0x333333, 0x6b8e23, 0x7d931e, 0x90981e, 0xa68f1e, 0xb6851e,
  0xc77b1e, 0xbe6a1e, 0xb55a1e, 0xab4a1e, 0xa53a22, 0xa02e22, 0x9b2222,
];

export function zombieColor(tier: number): number {
  return ZOMBIE_TIER_COLORS[Math.max(1, Math.min(12, tier))] ?? ZOMBIE_TIER_COLORS[1];
}

/** Y-координата препятствия `idx` в линии (мировые координаты, отрицательные = над воротами). */
export function obstacleY(idx: number): number {
  return GATE_Y - FIRST_ZOMBIE_OFFSET - idx * ZOMBIE_SPACING;
}
