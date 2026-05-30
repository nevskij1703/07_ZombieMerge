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
import { runAutotest, type AutotestReport } from '../core/autotest';

const css = (el: HTMLElement, style: string): void => {
  el.style.cssText = style;
};

function refreshGame(game: Phaser.Game): void {
  // Перерисовать активный экран после изменения сейва/баланса (без полной перезагрузки).
  // Сейчас единственная игровая сцена — World (бой — это режим внутри неё).
  const sc = game.scene.getScene('World');
  if (sc && sc.scene.isActive()) sc.scene.restart();
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

type ChartSeries = { label: string; color: string; values: Array<number | null> };

/** Простой линейный график на canvas. yMaxOpt — если задан, фиксированная шкала. */
function drawChart(
  canvas: HTMLCanvasElement,
  title: string,
  series: ChartSeries[],
  xMax: number,
  yMaxOpt?: number,
): void {
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0a0b0e';
  ctx.fillRect(0, 0, W, H);
  const PL = 32;
  const PR = 8;
  const PT = 22;
  const PB = 22;
  const cw = W - PL - PR;
  const ch = H - PT - PB;

  let yMax = yMaxOpt;
  if (yMax == null) {
    let m = 0;
    for (const s of series) for (const v of s.values) if (v != null && v > m) m = v;
    yMax = Math.max(1, m);
  }

  ctx.strokeStyle = '#1f232a';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = PT + (ch * i) / 4;
    ctx.beginPath();
    ctx.moveTo(PL, y);
    ctx.lineTo(PL + cw, y);
    ctx.stroke();
  }

  ctx.fillStyle = '#5a6068';
  ctx.font = '10px monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = yMax * (1 - i / 4);
    ctx.fillText(v >= 10 ? v.toFixed(0) : v.toFixed(1), PL - 3, PT + (ch * i) / 4);
  }

  const n = series[0]?.values.length ?? 0;
  const step = xMax <= 10 ? 2 : xMax <= 25 ? 5 : 10;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let x = step; x <= xMax; x += step) {
    const idx = x - 1;
    if (idx < 0 || idx >= n) continue;
    const px = PL + (cw * idx) / Math.max(1, n - 1);
    ctx.fillText(String(x), px, PT + ch + 3);
  }

  ctx.fillStyle = '#cfe';
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(title, PL, 4);

  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    let prev = false;
    const denom = Math.max(1, s.values.length - 1);
    for (let i = 0; i < s.values.length; i++) {
      const v = s.values[i];
      if (v == null) {
        prev = false;
        continue;
      }
      const px = PL + (cw * i) / denom;
      const py = PT + ch * (1 - v / yMax);
      if (!prev) {
        ctx.moveTo(px, py);
        prev = true;
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
  }
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

  // --- Вкладка «Автотест» ---
  const autoTab = makeTab('auto', 'Автотест');
  const autoStatus = document.createElement('div');
  css(autoStatus, 'margin:4px 0;color:#9aa0a6;');
  autoStatus.textContent = 'Не запускался';
  const autoSummary = document.createElement('pre');
  css(
    autoSummary,
    'background:#15171c;color:#cfe;border:1px solid #3a414d;border-radius:4px;padding:6px;font:11px monospace;white-space:pre-wrap;display:none;margin:4px 0;',
  );
  const chartTitles = [
    'Макс тир по столбцам (Бойцам)',
    'Лом получен за уровень',
    'Произведено оружия за уровень',
    'Размер поля (cols × rows)',
  ];
  const chartCanvases: HTMLCanvasElement[] = [];
  for (let i = 0; i < 4; i++) {
    const c = document.createElement('canvas');
    c.width = 268;
    c.height = 140;
    css(
      c,
      'width:100%;height:140px;background:#0a0b0e;border:1px solid #3a414d;border-radius:4px;margin:4px 0;',
    );
    chartCanvases.push(c);
  }
  let lastReport: AutotestReport | null = null;
  const colColors = ['#9fe870', '#ff6a00', '#3a7bd5', '#d53a9b', '#00e5ff'];

  const renderReport = (rep: AutotestReport): void => {
    autoStatus.textContent = rep.finished
      ? `Пройдено ${rep.reachedLevel}/${rep.totalLevels} ✓`
      : `Застрял на уровне ${rep.stuckAt} (прошёл ${rep.reachedLevel}/${rep.totalLevels})`;
    const last = rep.samples[rep.samples.length - 1];
    autoSummary.style.display = 'block';
    autoSummary.textContent = [
      `Уровней: ${rep.reachedLevel}/${rep.totalLevels}`,
      `Произведено оружий: ${rep.totalProduced}`,
      `Лутбоксов: ${rep.totalLootboxes}`,
      last
        ? `Финал: поле ${last.cols}×${last.rows}, Цех T${last.workshopTier}, макс на поле T${last.fieldMaxTier}`
        : '',
      `Макс попыток за уровень: ${Math.max(...rep.samples.map((s) => s.attempts), 1)}`,
    ]
      .filter(Boolean)
      .join('\n');

    if (rep.samples.length === 0) return;
    const xMax = Math.max(...rep.samples.map((s) => s.level), 1);
    const maxCols = Math.max(...rep.samples.map((s) => s.cols), 1);
    const series1: ChartSeries[] = [];
    for (let c = 0; c < maxCols; c++) {
      series1.push({
        label: `Б${c + 1}`,
        color: colColors[c] ?? '#fff',
        values: rep.samples.map((s) => (c < s.cols ? s.maxTierByColumn[c] : null)),
      });
    }
    drawChart(chartCanvases[0], chartTitles[0], series1, xMax, maxTier());
    drawChart(
      chartCanvases[1],
      chartTitles[1],
      [{ label: 'scrap', color: '#9fe870', values: rep.samples.map((s) => s.scrapGained) }],
      xMax,
    );
    drawChart(
      chartCanvases[2],
      chartTitles[2],
      [{ label: 'produced', color: '#3a7bd5', values: rep.samples.map((s) => s.weaponsProduced) }],
      xMax,
    );
    drawChart(
      chartCanvases[3],
      chartTitles[3],
      [{ label: 'size', color: '#d4af37', values: rep.samples.map((s) => s.cols * s.rows) }],
      xMax,
      25,
    );
  };

  const runAutoBtn = btn('Запустить (50 ур.)', 'zm-auto-run');
  runAutoBtn.onclick = () => {
    runAutoBtn.disabled = true;
    const prevText = runAutoBtn.textContent;
    runAutoBtn.textContent = '…';
    // даём UI обновиться перед синхронным прогоном
    setTimeout(() => {
      try {
        lastReport = runAutotest(50);
        renderReport(lastReport);
      } catch (e) {
        autoStatus.textContent = 'Ошибка: ' + (e as Error).message;
      } finally {
        runAutoBtn.textContent = prevText ?? 'Запустить (50 ур.)';
        runAutoBtn.disabled = false;
      }
    }, 10);
  };
  const copyAutoBtn = btn('Скопировать JSON', 'zm-auto-copy');
  copyAutoBtn.onclick = () => {
    if (!lastReport) return;
    const json = JSON.stringify(lastReport, null, 2);
    try {
      navigator.clipboard?.writeText(json);
    } catch {
      /* */
    }
    copyAutoBtn.textContent = 'Скопировано!';
    setTimeout(() => (copyAutoBtn.textContent = 'Скопировать JSON'), 1200);
  };
  autoTab.append(runAutoBtn, copyAutoBtn, autoStatus, autoSummary, ...chartCanvases);

  // --- Вкладка «Layout» (визуальный редактор расположения) ---
  const layoutTab = makeTab('layout', 'Layout');
  const layoutHint = document.createElement('div');
  layoutHint.textContent =
    'Включает drag/resize-редактор элементов локации (Base) и UI. Изменения сохраняются в LocalStorage, можно экспортировать в JSON.';
  css(layoutHint, 'color:#9aa0a6;margin-bottom:8px;font-size:11px;line-height:1.4;');
  layoutTab.append(layoutHint);

  const editorStatus = document.createElement('div');
  css(editorStatus, 'margin:4px 0 8px;color:#cfe9ff;');
  editorStatus.textContent = 'Редактор: ВЫКЛ';

  const toggleEditorBtn = btn('Включить редактор', 'zm-layout-toggle');
  toggleEditorBtn.onclick = () => {
    // Достаём WorldScene и его layoutEditor (он создаётся в WorldScene.create в dev).
    const sc = game.scene.getScene('World') as Phaser.Scene & {
      layoutEditor?: { toggle: () => void; isEnabled: () => boolean };
    };
    if (!sc || !sc.layoutEditor) {
      editorStatus.textContent = 'Редактор недоступен (сцена не готова).';
      return;
    }
    sc.layoutEditor.toggle();
    const on = sc.layoutEditor.isEnabled();
    toggleEditorBtn.textContent = on ? 'Выключить редактор' : 'Включить редактор';
    editorStatus.textContent = on ? 'Редактор: ВКЛ — drag/select на сцене' : 'Редактор: ВЫКЛ';
  };

  const resetLayoutBtn = btn('Сбросить ВСЕ overrides', 'zm-layout-reset');
  css(resetLayoutBtn, resetLayoutBtn.style.cssText.replace('#2e7d32', '#b23b3b'));
  resetLayoutBtn.onclick = () => {
    if (!confirm('Сбросить ВСЕ overrides расположения? Перезагрузить страницу для применения.')) return;
    localStorage.removeItem('zm_layout_overrides');
    editorStatus.textContent = 'Overrides сброшены. Перезагрузи страницу.';
  };

  layoutTab.append(toggleEditorBtn, resetLayoutBtn, editorStatus);

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
