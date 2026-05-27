// Дев-панель (HTML-оверлей). ТОЛЬКО для dev: вызывается из main.ts под import.meta.env.DEV,
// поэтому Vite tree-shaking вырезает её из release-сборки. См. CLAUDE.md / docs/BALANCE.md.
//
// Вкладки: Ресурсы (лом/алмазы/тир Мастерской), Прогресс (уровень/скип/сброс сейва),
// Баланс (export/copy/apply/reset JSON для быстрой передачи новых значений).

import type Phaser from 'phaser';
import { getState, update, reset } from '../core/storage';
import { maxTier } from '../core/weapons';
import {
  exportBalanceJSON,
  applyBalanceOverrideJSON,
  resetBalanceOverride,
  hasBalanceOverride,
} from '../core/balanceRuntime';

const css = (el: HTMLElement, style: string): void => {
  el.style.cssText = style;
};

function refreshGame(game: Phaser.Game): void {
  // Перерисовать активный экран после изменения сейва/баланса (без полной перезагрузки).
  const base = game.scene.getScene('Base');
  if (base) base.scene.restart();
}

function btn(label: string, id: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.id = id;
  b.textContent = label;
  css(
    b,
    'background:#2e7d32;color:#fff;border:0;border-radius:6px;padding:6px 10px;margin:3px 3px 3px 0;font:12px monospace;cursor:pointer;',
  );
  return b;
}

function field(labelText: string, id: string, value: string): HTMLDivElement {
  const wrap = document.createElement('div');
  css(wrap, 'display:flex;align-items:center;gap:6px;margin:4px 0;');
  const lab = document.createElement('label');
  lab.textContent = labelText;
  css(lab, 'flex:1;');
  const inp = document.createElement('input');
  inp.id = id;
  inp.value = value;
  inp.type = 'number';
  css(inp, 'width:90px;background:#15171c;color:#fff;border:1px solid #3a414d;border-radius:4px;padding:4px;font:12px monospace;');
  wrap.append(lab, inp);
  return wrap;
}

export function initDevPanel(game: Phaser.Game): void {
  if (document.getElementById('zm-dev-toggle')) return; // не дублировать

  const toggle = document.createElement('button');
  toggle.id = 'zm-dev-toggle';
  toggle.textContent = 'DEV';
  css(
    toggle,
    'position:fixed;top:6px;right:6px;z-index:99999;background:#b23b3b;color:#fff;border:0;border-radius:6px;padding:6px 10px;font:bold 12px monospace;cursor:pointer;opacity:.85;',
  );

  const panel = document.createElement('div');
  panel.id = 'zm-dev-panel';
  css(
    panel,
    'position:fixed;top:40px;right:6px;z-index:99999;width:300px;max-height:88vh;overflow:auto;background:#0a0b0e;color:#ddd;border:1px solid #3a414d;border-radius:8px;padding:10px;font:12px monospace;display:none;box-shadow:0 6px 24px #000a;',
  );

  const tabsBar = document.createElement('div');
  css(tabsBar, 'display:flex;gap:4px;margin-bottom:8px;');
  const contentHost = document.createElement('div');

  const tabs: Record<string, HTMLDivElement> = {};
  const makeTab = (key: string, title: string): HTMLDivElement => {
    const tb = document.createElement('button');
    tb.textContent = title;
    css(tb, 'flex:1;background:#20242c;color:#fff;border:0;border-radius:6px;padding:6px;font:12px monospace;cursor:pointer;');
    tb.onclick = () => {
      Object.values(tabs).forEach((t) => (t.style.display = 'none'));
      tabs[key].style.display = 'block';
    };
    tabsBar.appendChild(tb);
    const div = document.createElement('div');
    div.style.display = 'none';
    tabs[key] = div;
    contentHost.appendChild(div);
    return div;
  };

  // --- Вкладка «Ресурсы» ---
  const resTab = makeTab('res', 'Ресурсы');
  const s = getState();
  resTab.append(
    field('Лом', 'zm-scrap', String(s.scrap)),
    field('Алмазы', 'zm-diamonds', String(s.diamonds)),
    field(`Тир Цеха (1..${maxTier()})`, 'zm-tier', String(s.workshopTier)),
  );
  const setRes = btn('Применить', 'zm-set-res');
  setRes.onclick = () => {
    const scrap = Math.max(0, Number((document.getElementById('zm-scrap') as HTMLInputElement).value) || 0);
    const diamonds = Math.max(0, Number((document.getElementById('zm-diamonds') as HTMLInputElement).value) || 0);
    const tier = Math.min(maxTier(), Math.max(1, Number((document.getElementById('zm-tier') as HTMLInputElement).value) || 1));
    update((st) => {
      st.scrap = scrap;
      st.diamonds = diamonds;
      st.workshopTier = tier;
    });
    refreshGame(game);
  };
  const add1k = btn('+1000 лома', 'zm-add-scrap');
  add1k.onclick = () => {
    update((st) => (st.scrap += 1000));
    (document.getElementById('zm-scrap') as HTMLInputElement).value = String(getState().scrap);
    refreshGame(game);
  };
  resTab.append(setRes, add1k);

  // --- Вкладка «Прогресс» ---
  const progTab = makeTab('prog', 'Прогресс');
  progTab.append(field('Уровень', 'zm-level', String(s.level)));
  const setLvl = btn('Уст. уровень', 'zm-set-level');
  setLvl.onclick = () => {
    const lvl = Math.max(1, Number((document.getElementById('zm-level') as HTMLInputElement).value) || 1);
    update((st) => {
      st.level = lvl;
      st.maxLevelReached = Math.max(st.maxLevelReached, lvl);
    });
    refreshGame(game);
  };
  const skip = btn('Скип +1', 'zm-skip');
  skip.onclick = () => {
    update((st) => {
      st.level += 1;
      st.maxLevelReached = Math.max(st.maxLevelReached, st.level);
    });
    (document.getElementById('zm-level') as HTMLInputElement).value = String(getState().level);
    refreshGame(game);
  };
  const resetBtn = btn('Сбросить сейв', 'zm-reset');
  css(resetBtn, resetBtn.style.cssText.replace('#2e7d32', '#b23b3b'));
  resetBtn.onclick = () => {
    if (!confirm('Сбросить весь прогресс?')) return;
    reset();
    refreshGame(game);
    rebuildResInputs();
  };
  progTab.append(setLvl, skip, resetBtn);

  const rebuildResInputs = (): void => {
    const st = getState();
    (document.getElementById('zm-scrap') as HTMLInputElement).value = String(st.scrap);
    (document.getElementById('zm-diamonds') as HTMLInputElement).value = String(st.diamonds);
    (document.getElementById('zm-tier') as HTMLInputElement).value = String(st.workshopTier);
    (document.getElementById('zm-level') as HTMLInputElement).value = String(st.level);
  };

  // --- Вкладка «Баланс» ---
  const balTab = makeTab('bal', 'Баланс');
  const status = document.createElement('div');
  css(status, 'margin:2px 0 6px;color:#9fe870;');
  const ta = document.createElement('textarea');
  ta.id = 'zm-bal-text';
  ta.value = exportBalanceJSON();
  css(ta, 'width:100%;height:260px;background:#15171c;color:#cfe;border:1px solid #3a414d;border-radius:4px;padding:6px;font:11px monospace;white-space:pre;');
  const updateStatus = (): void => {
    status.textContent = hasBalanceOverride() ? 'override АКТИВЕН' : 'override нет (значения из balance.ts)';
  };
  updateStatus();

  const refreshBtn = btn('Обновить из игры', 'zm-bal-refresh');
  refreshBtn.onclick = () => {
    ta.value = exportBalanceJSON();
    updateStatus();
  };
  const copyBtn = btn('Скопировать', 'zm-bal-copy');
  copyBtn.onclick = () => {
    ta.select();
    try {
      navigator.clipboard?.writeText(ta.value);
    } catch {
      document.execCommand('copy');
    }
    copyBtn.textContent = 'Скопировано!';
    setTimeout(() => (copyBtn.textContent = 'Скопировать'), 1200);
  };
  const applyBtn = btn('Применить', 'zm-bal-apply');
  applyBtn.onclick = () => {
    try {
      applyBalanceOverrideJSON(ta.value);
      updateStatus();
      refreshGame(game);
    } catch (e) {
      alert('Невалидный JSON: ' + (e as Error).message);
    }
  };
  const resetBalBtn = btn('Сбросить override', 'zm-bal-reset');
  css(resetBalBtn, resetBalBtn.style.cssText.replace('#2e7d32', '#555'));
  resetBalBtn.onclick = () => {
    resetBalanceOverride();
    ta.value = exportBalanceJSON();
    updateStatus();
    refreshGame(game);
  };
  balTab.append(status, ta, refreshBtn, copyBtn, applyBtn, resetBalBtn);

  // показать первую вкладку
  tabs.res.style.display = 'block';

  panel.append(tabsBar, contentHost);
  toggle.onclick = () => {
    const showing = panel.style.display !== 'none';
    panel.style.display = showing ? 'none' : 'block';
    if (!showing) {
      rebuildResInputs();
      updateStatus();
    }
  };

  // хоткей: backtick `~` тоже тогглит панель
  window.addEventListener('keydown', (e) => {
    if (e.key === '`' || e.key === '~') toggle.click();
  });

  document.body.append(toggle, panel);
}
