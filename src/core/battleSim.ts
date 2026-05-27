// Детерминированная боевая симуляция по линиям. Возвращает исход + пошаговый timeline
// (для проигрыша в BattleScene). Модель оружия: сильнейшее бьёт первым; когда его ресурс
// кончился — следующее по силе; всё израсходовано — боец отступает. Нельзя умереть.

import type { Level, Lane, LaneResult, LaneStep, BattleResult, WeaponTier } from '../types';
import { getWeapon, maxTier } from './weapons';
import { getBalance } from './balanceRuntime';

export interface BattleCtx {
  /** Текущий тир Мастерской — от него масштабируется лут (ящики/сундук). */
  workshopTier: number;
}

interface ArsenalWeapon {
  tier: number;
  hits: number;
}

function clampTier(t: number): number {
  return Math.max(1, Math.min(maxTier(), t));
}

function buildArsenal(tiers: number[]): ArsenalWeapon[] {
  return tiers.map((t) => ({ tier: t, hits: getWeapon(t).hits }));
}

function strongestAvailable(ars: ArsenalWeapon[]): ArsenalWeapon | null {
  let best: ArsenalWeapon | null = null;
  for (const w of ars) {
    if (w.hits > 0 && (best === null || w.tier > best.tier)) best = w;
  }
  return best;
}

function simulateLane(lane: Lane, tiers: number[], ctx: BattleCtx): LaneResult {
  const ars = buildArsenal(tiers);
  const steps: LaneStep[] = [];
  let collectedScrap = 0;
  const collectedWeapons: WeaponTier[] = [];
  let blueprint = false;

  for (let i = 0; i < lane.obstacles.length; i++) {
    const ob = lane.obstacles[i];

    if (ob.kind === 'scrap') {
      collectedScrap += ob.scrap;
      steps.push({ index: i, kind: 'scrap', outcome: 'picked', hitsSpent: 0, scrap: ob.scrap });
      continue;
    }

    // Бой с зомби/ящиком: бьём, пока hp>0 или не кончились все оружия.
    let hp = ob.hp;
    let hitsSpent = 0;
    let depleted = false;
    while (hp > 0) {
      const w = strongestAvailable(ars);
      if (!w) {
        depleted = true;
        break;
      }
      hp -= getWeapon(w.tier).damagePerHit;
      w.hits -= 1;
      hitsSpent += 1;
    }

    if (depleted) {
      steps.push({ index: i, kind: ob.kind, outcome: 'stuck', hitsSpent, scrap: 0 });
      return { reachedChest: false, steps, collectedScrap, collectedWeapons, blueprint };
    }

    let gainedScrap = 0;
    let gainedTier: number | undefined;
    if (ob.kind === 'crate') {
      gainedScrap = ob.scrap;
      collectedScrap += gainedScrap;
      if (ob.weapon) {
        gainedTier = clampTier(ctx.workshopTier - 1);
        collectedWeapons.push(gainedTier);
        // Подобранное оружие можно пускать в ход на этой же линии.
        ars.push({ tier: gainedTier, hits: getWeapon(gainedTier).hits });
      }
    }
    steps.push({
      index: i,
      kind: ob.kind,
      outcome: 'cleared',
      hitsSpent,
      scrap: gainedScrap,
      weaponTier: gainedTier,
    });
  }

  // Дошёл до конца — открывает сундук.
  const chest = lane.chest;
  collectedScrap += chest.scrap;
  let chestTier: number | undefined;
  if (chest.weapon) {
    chestTier = clampTier(ctx.workshopTier + getBalance().chest.weaponTierOffset);
    collectedWeapons.push(chestTier);
  }
  if (chest.blueprint) blueprint = true;
  steps.push({
    index: -1,
    kind: 'chest',
    outcome: 'opened',
    hitsSpent: 0,
    scrap: chest.scrap,
    weaponTier: chestTier,
    blueprint: chest.blueprint,
  });
  return { reachedChest: true, steps, collectedScrap, collectedWeapons, blueprint };
}

/** arsenals[i] — список тиров оружия на i-м столбце (линии). */
export function simulateBattle(level: Level, arsenals: number[][], ctx: BattleCtx): BattleResult {
  const lanes = level.lanes.map((lane, i) => simulateLane(lane, arsenals[i] ?? [], ctx));
  return {
    level: level.number,
    passed: lanes.some((l) => l.reachedChest),
    lanes,
    totalScrap: lanes.reduce((a, l) => a + l.collectedScrap, 0),
    totalWeapons: lanes.flatMap((l) => l.collectedWeapons),
    blueprints: lanes.reduce((a, l) => a + (l.blueprint ? 1 : 0), 0),
  };
}
