import Phaser from 'phaser';
import { SceneKey } from './sceneKeys';
import { DESIGN_WIDTH, COLORS } from '../config/constants';
import { getState, save, update } from '../core/storage';
import { produceCost, canAfford } from '../core/economy';
import { weaponName } from '../core/weapons';

import { placeFirstFree, isFull, pullFromInventory } from '../core/merge';
import { generateLevel } from '../core/levelGen';
import { laneArsenals, bestWeaponTier } from '../core/progression';
import { isWeaponCellValue, rollLootboxTier } from '../core/lootbox';
import { getBalance } from '../core/balanceRuntime';
import { makeRng } from '../core/rng';
import { Hud } from '../ui/hud';
import { MergeBoard } from '../ui/mergeBoard';
import { InventoryBar } from '../ui/inventoryBar';
import { Button } from '../ui/button';

// Главный экран базы: HUD + мердж-поле + Мастерская + кнопка «В бой» + Трэш-зона.
export class BaseScene extends Phaser.Scene {
  private hud!: Hud;
  private board!: MergeBoard;
  private inv!: InventoryBar;
  private produceBtn!: Button;
  private battleBtn!: Button;
  private trashRect: { x: number; y: number; w: number; h: number } | null = null;
  // RNG для открытия лутбоксов: на каждую сессию свой seed (Date.now()), внутри сессии
  // последовательность детерминирована — но между запусками результаты разные. Это удобный
  // компромисс: внутри сессии можно сравнить «открою сейчас или подожду».
  private lootRng: () => number = () => Math.random();

  constructor() {
    super(SceneKey.Base);
  }

  create(): void {
    const cx = DESIGN_WIDTH / 2;
    this.lootRng = makeRng(Date.now() & 0x7fffffff);

    // Фон-зоны: город (зона боя) / забор / база.
    this.add.rectangle(cx, 250, DESIGN_WIDTH, 340, COLORS.city).setOrigin(0.5);
    this.add.rectangle(cx, 430, DESIGN_WIDTH, 16, COLORS.fence).setOrigin(0.5);
    this.add.rectangle(cx, 855, DESIGN_WIDTH, 850, COLORS.base).setOrigin(0.5);
    this.add
      .text(cx, 250, 'ГОРОД · зона боя', {
        fontFamily: 'monospace',
        fontSize: '22px',
        color: '#5c7a5c',
      })
      .setOrigin(0.5);

    this.hud = new Hud(this);

    const s = getState();

    // Трэш-зона справа от инвентаря на одной линии (drag оружие сюда → +50% scrap).
    const trashW = 110;
    const trashH = 74;
    const trashX = DESIGN_WIDTH - 20 - trashW;
    const trashY = 885;
    this.trashRect = { x: trashX, y: trashY, w: trashW, h: trashH };
    this.add
      .rectangle(trashX + trashW / 2, trashY + trashH / 2, trashW, trashH, 0x4a2020)
      .setOrigin(0.5)
      .setStrokeStyle(2, 0xb23b3b, 0.8);
    this.add
      .text(trashX + trashW / 2, trashY + trashH / 2 - 10, '🗑 ТРЭШ', {
        fontFamily: 'monospace',
        fontSize: '18px',
        color: '#ffb0b0',
      })
      .setOrigin(0.5);
    this.add
      .text(trashX + trashW / 2, trashY + trashH / 2 + 18, '50% лома', {
        fontFamily: 'monospace',
        fontSize: '11px',
        color: '#ffd0d0',
      })
      .setOrigin(0.5);

    this.board = new MergeBoard(
      this,
      s.field,
      { x: 40, y: 465, w: DESIGN_WIDTH - 80, h: 410 },
      {
        onChange: () => {
          save();
          this.hud.refresh();
          this.refreshButtons();
          this.inv?.rebuild();
        },
        onMerge: () => update((st) => st.stats.merges++),
        onOpenLootbox: (cellIndex, kind) => this.openLootbox(cellIndex, kind),
        onTrash: (cellIndex) => this.trashWeapon(cellIndex),
      },
    );
    this.board.setTrashZone(this.trashRect);

    // Инвентарь — слева от трэша, на одной линии.
    this.inv = new InventoryBar(
      this,
      { x: 20, y: 885, w: trashX - 20 - 10, h: 74 },
      (i) => this.pullItem(i),
    );

    this.produceBtn = new Button(this, {
      x: cx,
      y: 1010,
      width: 470,
      height: 78,
      label: '',
      fontSize: 26,
      onClick: () => this.produce(),
    });

    this.battleBtn = new Button(this, {
      x: cx,
      y: 1112,
      width: 470,
      height: 78,
      label: 'В БОЙ',
      fontSize: 30,
      bg: 0xb23b3b,
      onClick: () => this.goBattle(),
    });
    void this.battleBtn;

    this.refreshButtons();
  }

  private produce(): void {
    const s = getState();
    const cost = produceCost(s.workshopTier);
    if (!canAfford(s.scrap, cost)) {
      this.toast('Не хватает лома');
      return;
    }
    if (isFull(s.field)) {
      this.toast('Поле заполнено');
      return;
    }
    update((st) => {
      st.scrap -= cost;
      placeFirstFree(st.field, st.workshopTier);
    });
    this.board.rebuildTiles();
    this.hud.refresh();
    this.refreshButtons();
  }

  private pullItem(index: number): void {
    const s = getState();
    if (pullFromInventory(s.field, s.inventory, index)) {
      save();
      this.board.rebuildTiles();
      this.inv.rebuild();
      this.refreshButtons();
    } else {
      this.toast('Поле заполнено');
    }
  }

  /** Открыть лутбокс в клетке — заменяем клетку на оружие тира, который выпал. */
  private openLootbox(cellIndex: number, kind: 'medium' | 'elite'): boolean {
    const s = getState();
    const tier = rollLootboxTier(kind, s.workshopTier, bestWeaponTier(s), this.lootRng);
    update((st) => {
      st.field.cells[cellIndex] = tier;
    });
    this.toast(`Открыт ${kind === 'elite' ? 'крутой' : 'средний'} лутбокс: T${tier} ${weaponName(tier)}`);
    return true;
  }

  /** Выбросить оружие в трэш — возвращает 50% стоимости производства. */
  private trashWeapon(cellIndex: number): boolean {
    const s = getState();
    const v = s.field.cells[cellIndex];
    if (!isWeaponCellValue(v)) return false;
    const refund = Math.round(produceCost(v) * getBalance().trash.refundRatio);
    update((st) => {
      st.field.cells[cellIndex] = null;
      st.scrap += refund;
    });
    this.toast(`Удалено T${v}: +${refund} лома`);
    this.hud.refresh();
    return true;
  }

  private goBattle(): void {
    const s = getState();
    // Лутбоксы в клетках в бой не идут — нужен хотя бы один настоящий тир оружия.
    const hasWeapon = s.field.cells.some((c) => isWeaponCellValue(c));
    if (!hasWeapon) {
      this.toast('Сначала собери оружие');
      return;
    }
    this.scene.start(SceneKey.Battle, {
      level: generateLevel(s.level, {
        workshopTier: s.workshopTier,
        bestTier: bestWeaponTier(s),
      }),
      arsenals: laneArsenals(s.field),
      workshopTier: s.workshopTier,
    });
  }

  private refreshButtons(): void {
    const s = getState();
    const cost = produceCost(s.workshopTier);
    this.produceBtn.setLabel(`Произвести: ${weaponName(s.workshopTier)} (${cost})`);
    this.produceBtn.setEnabled(canAfford(s.scrap, cost) && !isFull(s.field));
  }

  private toast(msg: string): void {
    const t = this.add
      .text(DESIGN_WIDTH / 2, 1230, msg, {
        fontFamily: 'monospace',
        fontSize: '20px',
        color: '#ffd27f',
        backgroundColor: '#000000aa',
        padding: { x: 12, y: 7 },
      })
      .setOrigin(0.5)
      .setDepth(1000);
    this.tweens.add({
      targets: t,
      alpha: 0,
      y: 1195,
      duration: 1500,
      delay: 800,
      onComplete: () => t.destroy(),
    });
  }
}
