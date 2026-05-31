// AUTOTEST-ONLY симулятор боя. Не используется в живой игре с момента полного rewrite
// боевой логики (Task 80): рантайм-бой делает `WorldScene.tickBattle` per-frame. Этот
// модуль остаётся для headless-прогона баланса (`core/autotest.ts` → `balance-quick.ts`
// / `balance-deep.ts`) и boot-time self-test (`core/selfTest.ts`). Модель оружия:
// сильнейшее бьёт первым; когда его ресурс кончился — следующее по силе; всё
// израсходовано — боец отступает. Нельзя умереть.
//
// Тиры оружия для коробок/сундуков уже зашиты в Level (см. levelGen). battleSim ничего
// не рандомит и не зависит от состояния игрока.
//
// ВАЖНО: при расхождении модели с WorldScene.tickBattle — autotest перестаёт отражать
// реальный баланс. Если меняешь правила боя в WorldScene, либо обнови этот файл
// синхронно, либо явно отметь autotest как «приблизительный» в docs/BALANCE.md.

import type { Level, Lane, LaneResult, LaneStep, BattleResult, WeaponTier, LootboxKind } from '../types';
import { getWeapon } from './weapons';

interface ArsenalWeapon {
  tier: number;
  hits: number;
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

function simulateLane(lane: Lane, tiers: number[]): LaneResult {
  const ars = buildArsenal(tiers);
  const steps: LaneStep[] = [];
  let collectedScrap = 0;
  const collectedWeapons: WeaponTier[] = [];
  const collectedLootboxes: LootboxKind[] = [];
  // «Серия убивающих ударов» (бывший «пробивающий урон»): если предыдущий удар нанёс
  // больше HP врага, остаток переносится на следующее препятствие. ВАЖНО: каждый kill в
  // серии (включая carry-kill) ТРАТИТ 1 hit активного оружия — баланс «один зомби = один
  // удар», даже если визуально серия выглядит как сквозной проход.
  let carry = 0;
  // Оружие, чей последний удар создал текущий carry. Если carry-kill потребует списать
  // hit, берём с него (если ещё есть hits), иначе с `strongestAvailable`.
  let carryWeapon: ArsenalWeapon | null = null;

  const snap = (): { tier?: number; hits?: number } => {
    const w = strongestAvailable(ars);
    return w ? { tier: w.tier, hits: w.hits } : {};
  };

  for (let i = 0; i < lane.obstacles.length; i++) {
    const ob = lane.obstacles[i];

    if (ob.kind === 'scrap') {
      collectedScrap += ob.scrap;
      const s = snap();
      steps.push({
        index: i,
        kind: 'scrap',
        outcome: 'picked',
        hitsSpent: 0,
        scrap: ob.scrap,
        weaponTierAfter: s.tier,
        weaponHitsAfter: s.hits,
      });
      continue;
    }

    // Бой с зомби/ящиком.
    const hpStart = ob.hp;
    let hp = ob.hp;
    let hitsSpent = 0;
    let depleted = false;

    // 1) Применяем накопленный пробивающий урон (вошёл из ПРОШЛОГО удара).
    let carryAbsorbed = 0;
    if (carry > 0) {
      carryAbsorbed = Math.min(carry, hp);
      hp -= carryAbsorbed;
      carry -= carryAbsorbed;
      // ВСЕГДА (kill или wound) carry-contact = +1 удар бойца по новому врагу. Физически
      // это отдельный «второй удар» в серии (последним пробил предыдущего, этим ударил
      // следующего). Списываем 1 hit с carryWeapon (если ещё есть ресурс) или с лучшего
      // доступного. hitsSpent НЕ инкрементируется — wound-events для оставшегося HP
      // (если carry только ранил) генерируются отдельно из `step.hitsSpent` (while-loop).
      const payer: ArsenalWeapon | null =
        carryWeapon && carryWeapon.hits > 0 ? carryWeapon : strongestAvailable(ars);
      if (payer) {
        payer.hits -= 1;
        carryWeapon = payer;
      }
      // Если payer == null — оружия нет вовсе. carry уже летел от прошлого удара,
      // contact «бесплатный». Следующий obstacle упрётся в depleted.
    }

    // 2) Бьём, пока враг жив или не кончатся оружия.
    while (hp > 0) {
      const w = strongestAvailable(ars);
      if (!w) {
        depleted = true;
        break;
      }
      const dmg = getWeapon(w.tier).damagePerHit;
      if (dmg >= hp) {
        carry = dmg - hp; // избыток уходит дальше
        hp = 0;
        carryWeapon = w; // запоминаем кто создал carry — он же платит за следующий kill
      } else {
        hp -= dmg;
      }
      w.hits -= 1;
      hitsSpent += 1;
    }

    if (depleted) {
      const s = snap();
      steps.push({
        index: i,
        kind: ob.kind,
        outcome: 'stuck',
        hitsSpent,
        scrap: 0,
        weaponTierAfter: s.tier,
        weaponHitsAfter: s.hits,
        hpStart,
        hpAfter: hp,
        carryIn: carryAbsorbed > 0 ? carryAbsorbed : undefined,
      });
      return { reachedChest: false, steps, collectedScrap, collectedWeapons, collectedLootboxes };
    }

    let gainedScrap = 0;
    let gainedTier: WeaponTier | undefined;
    if (ob.kind === 'crate') {
      gainedScrap = ob.scrap;
      collectedScrap += gainedScrap;
      if (ob.givesWeapon) {
        // По тз: коробка ОБНОВЛЯЕТ ресурс самого крутого оружия в арсенале линии
        // (даже если у него hits=0). НЕ выдаёт новое оружие → в collectedWeapons не пишем.
        let bestIdx = -1;
        let bestTier = 0;
        for (let k = 0; k < ars.length; k++) {
          if (ars[k].tier > bestTier) {
            bestTier = ars[k].tier;
            bestIdx = k;
          }
        }
        if (bestIdx >= 0) {
          ars[bestIdx].hits = getWeapon(ars[bestIdx].tier).hits;
          gainedTier = ars[bestIdx].tier; // для LaneStep (UI/инфа что было обновлено)
        }
      }
    }
    const s = snap();
    steps.push({
      index: i,
      kind: ob.kind,
      outcome: 'cleared',
      hitsSpent,
      scrap: gainedScrap,
      weaponTier: gainedTier,
      weaponTierAfter: s.tier,
      weaponHitsAfter: s.hits,
      hpStart,
      hpAfter: 0,
      carryIn: carryAbsorbed > 0 ? carryAbsorbed : undefined,
      carryOut: carry > 0 ? carry : undefined,
    });
  }

  // Дошёл до конца — открывает сундук. РОВНО одна награда.
  const chest = lane.chest;
  let chestScrap = 0;
  let chestWeaponTier: WeaponTier | undefined;
  let chestLootbox: LootboxKind | undefined;
  if (chest.reward === 'scrap') {
    chestScrap = chest.scrap ?? 0;
    collectedScrap += chestScrap;
  } else if (chest.reward === 'weapon' && chest.weaponTier !== undefined) {
    chestWeaponTier = chest.weaponTier;
    collectedWeapons.push(chestWeaponTier);
  } else if (chest.reward === 'lootbox' && chest.lootboxKind) {
    chestLootbox = chest.lootboxKind;
    collectedLootboxes.push(chestLootbox);
  }
  const s = snap();
  steps.push({
    index: -1,
    kind: 'chest',
    outcome: 'opened',
    hitsSpent: 0,
    scrap: chestScrap,
    weaponTier: chestWeaponTier,
    lootboxKind: chestLootbox,
    weaponTierAfter: s.tier,
    weaponHitsAfter: s.hits,
  });
  return { reachedChest: true, steps, collectedScrap, collectedWeapons, collectedLootboxes };
}

/** arsenals[i] — список тиров оружия на i-м столбце (линии). */
export function simulateBattle(level: Level, arsenals: number[][]): BattleResult {
  const lanes = level.lanes.map((lane, i) => simulateLane(lane, arsenals[i] ?? []));
  return {
    level: level.number,
    passed: lanes.some((l) => l.reachedChest),
    lanes,
    totalScrap: lanes.reduce((a, l) => a + l.collectedScrap, 0),
    totalWeapons: lanes.flatMap((l) => l.collectedWeapons),
    totalLootboxes: lanes.flatMap((l) => l.collectedLootboxes),
  };
}
