import Phaser from 'phaser';
import { SceneKey } from './sceneKeys';
import { DESIGN_WIDTH, COLORS } from '../config/constants';
import { getState, save, update } from '../core/storage';
import { produceCost, canAfford } from '../core/economy';
import { weaponName } from '../core/weapons';

import { placeFirstFree, isFull, pullFromInventory } from '../core/merge';
import { generateLevel } from '../core/levelGen';
import { laneArsenals } from '../core/progression';
import { Hud } from '../ui/hud';
import { MergeBoard } from '../ui/mergeBoard';
import { InventoryBar } from '../ui/inventoryBar';
import { Button } from '../ui/button';

// Главный экран базы: HUD + мердж-поле + Мастерская (произвести) + кнопка «В бой».
// Бой (BattleScene) подключится на этапе 9 — сейчас кнопка-заглушка.
export class BaseScene extends Phaser.Scene {
  private hud!: Hud;
  private board!: MergeBoard;
  private inv!: InventoryBar;
  private produceBtn!: Button;
  private battleBtn!: Button;

  constructor() {
    super(SceneKey.Base);
  }

  create(): void {
    const cx = DESIGN_WIDTH / 2;

    // Фон-зоны: город (зона боя) / забор / база.
    this.add.rectangle(cx, 250, DESIGN_WIDTH, 340, COLORS.city).setOrigin(0.5);
    this.add.rectangle(cx, 430, DESIGN_WIDTH, 16, COLORS.fence).setOrigin(0.5);
    this.add.rectangle(cx, 855, DESIGN_WIDTH, 850, COLORS.base).setOrigin(0.5);
    this.add
      .text(cx, 250, 'ГОРОД · зона боя (этап 9)', {
        fontFamily: 'monospace',
        fontSize: '22px',
        color: '#5c7a5c',
      })
      .setOrigin(0.5);

    this.hud = new Hud(this);

    const s = getState();
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
      },
    );

    this.inv = new InventoryBar(
      this,
      { x: 30, y: 885, w: DESIGN_WIDTH - 60, h: 74 },
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

  private goBattle(): void {
    const s = getState();
    const hasWeapon = s.field.cells.some((c) => c != null);
    if (!hasWeapon) {
      this.toast('Сначала собери оружие');
      return;
    }
    this.scene.start(SceneKey.Battle, {
      level: generateLevel(s.level),
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
        fontSize: '24px',
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
      duration: 1100,
      delay: 600,
      onComplete: () => t.destroy(),
    });
  }
}
