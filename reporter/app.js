const REPORT_LOOKBACK_DAYS = 120;
const REPORT_BASE_PATH = '../server/storage/reports/runtime-daily';

const state = {
  reports: [],
  reportMap: new Map(),
  currentReportKey: null,
  currentSymbol: null,
  chart: null,
  candleSeries: null,
  volumeSeries: null,
  resizeObserver: null,
};

const elements = {
  app: document.getElementById('app'),
  reportSelect: document.getElementById('report-select'),
  symbolSelect: document.getElementById('symbol-select'),
  reloadButton: document.getElementById('reload-button'),
  fileInput: document.getElementById('file-input'),
  reportTitle: document.getElementById('report-title'),
  overviewGrid: document.getElementById('overview-grid'),
  summaryNarrative: document.getElementById('summary-narrative'),
  wakeupContent: document.getElementById('wakeup-content'),
  symbolTitle: document.getElementById('symbol-title'),
  symbolAnalysis: document.getElementById('symbol-analysis'),
  tradeTables: document.getElementById('trade-tables'),
  cycleAnalysis: document.getElementById('cycle-analysis'),
  cycleTable: document.getElementById('cycle-table'),
  chartContainer: document.getElementById('chart'),
};

const toFiniteOrNull = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const safeString = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const formatMoney = (value) => {
  const numeric = toFiniteOrNull(value);
  return numeric === null ? 'n/a' : `${numeric.toFixed(2)}$`;
};

const formatSignedMoney = (value) => {
  const numeric = toFiniteOrNull(value);
  if (numeric === null) return '<span class="value-neutral">n/a</span>';
  const sign = numeric > 0 ? '+' : '';
  const klass = numeric > 0 ? 'value-good' : numeric < 0 ? 'value-bad' : 'value-neutral';
  return `<span class="${klass}">${sign}${numeric.toFixed(2)}$</span>`;
};

const formatPct = (value) => {
  const numeric = toFiniteOrNull(value);
  return numeric === null ? 'n/a' : `${(numeric * 100).toFixed(2)}%`;
};

const formatSignedPct = (value) => {
  const numeric = toFiniteOrNull(value);
  if (numeric === null) return '<span class="value-neutral">n/a</span>';
  const percent = numeric * 100;
  const sign = percent > 0 ? '+' : '';
  const klass = percent > 0 ? 'value-good' : percent < 0 ? 'value-bad' : 'value-neutral';
  return `<span class="${klass}">${sign}${percent.toFixed(2)}%</span>`;
};

const escapeHtml = (value) =>
  safeString(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

const formatDateTime = (atMs, timezone = 'America/New_York') => {
  const numeric = Number(atMs);
  if (!Number.isFinite(numeric)) return 'n/a';
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(numeric));
};

const formatDate = (atMs, timezone = 'America/New_York') => {
  const numeric = Number(atMs);
  if (!Number.isFinite(numeric)) return 'n/a';
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(numeric));
};

const statusClass = (value) => {
  const text = safeString(value).toLowerCase();
  if (['ready', 'risk_on', 'accepted', 'filled'].includes(text)) return 'good';
  if (['block', 'risk_off', 'rejected', 'error'].includes(text)) return 'bad';
  if (['watch', 'mixed', 'dry_run'].includes(text)) return 'warn';
  return '';
};

const badge = (label, value = null) => {
  const text = value === null ? label : `${label}: ${value}`;
  return `<span class="badge ${statusClass(value ?? label)}">${escapeHtml(text)}</span>`;
};

const statCard = (label, value, subvalue = '') => `
  <article class="stat-card">
    <span class="label">${escapeHtml(label)}</span>
    <div class="value">${value}</div>
    ${subvalue ? `<div class="subvalue">${subvalue}</div>` : ''}
  </article>
`;

const narrativeParagraph = (text) => `<p>${escapeHtml(text)}</p>`;

const emptyState = (text) => `<div class="empty-state">${escapeHtml(text)}</div>`;

const toIsoDate = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const dateFromOffset = (offset) => {
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  now.setDate(now.getDate() - offset);
  return toIsoDate(now);
};

const reportPathForDate = (date) => `${REPORT_BASE_PATH}/runtime-report-${date}.json`;

const fetchJson = async (path) => {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
};

const discoverReports = async () => {
  const candidates = Array.from({ length: REPORT_LOOKBACK_DAYS }, (_, index) => dateFromOffset(index));
  const found = [];

  await Promise.all(
    candidates.map(async (date) => {
      const path = reportPathForDate(date);
      try {
        const report = await fetchJson(path);
        if (report?.type !== 'runtime_daily_report') return;
        found.push({ key: path, path, label: report.sessionDate ?? date, report });
      } catch {
        // Missing report for this day is expected.
      }
    }),
  );

  return found.sort((a, b) => String(b.label).localeCompare(String(a.label)));
};

const getReportSymbols = (report) => Object.keys(report?.symbols ?? {}).sort();

const getLatestAccount = (report) => report?.accountLatest ?? report?.wakeupReport?.account ?? null;

const computeExitMetrics = (report) => {
  const exits = Array.isArray(report?.exits) ? report.exits : [];
  const pnlValues = exits.map((entry) => toFiniteOrNull(entry?.pnl)).filter((entry) => entry !== null);
  const totalPnl = pnlValues.reduce((sum, entry) => sum + entry, 0);
  const wins = pnlValues.filter((entry) => entry > 0).length;
  const losses = pnlValues.filter((entry) => entry < 0).length;
  const flat = pnlValues.length - wins - losses;
  const winRate = pnlValues.length ? wins / pnlValues.length : null;
  return {
    totalPnl,
    wins,
    losses,
    flat,
    winRate,
  };
};

const aggregateExitPnlBySymbol = (report) => {
  const totals = new Map();
  for (const exit of report?.exits ?? []) {
    const symbol = safeString(exit?.symbol);
    if (!symbol) continue;
    const previous = totals.get(symbol) ?? 0;
    totals.set(symbol, previous + (toFiniteOrNull(exit?.pnl) ?? 0));
  }
  return Array.from(totals.entries())
    .map(([symbol, pnl]) => ({ symbol, pnl }))
    .sort((a, b) => b.pnl - a.pnl);
};

const summarizeCycles = (report) => {
  const cycles = Array.isArray(report?.cycleSummaries) ? report.cycleSummaries : [];
  const failures = cycles.filter((entry) => entry?.ok === false);
  const decisionFallbacks = cycles.filter((entry) => safeString(entry?.decisionAction) === 'skip');
  return {
    total: cycles.length,
    failures: failures.length,
    failureSymbols: Array.from(new Set(failures.map((entry) => safeString(entry?.symbol)).filter(Boolean))),
    decisionFallbacks: decisionFallbacks.length,
  };
};

const buildHumanNarrative = (report) => {
  const account = getLatestAccount(report);
  const exitMetrics = computeExitMetrics(report);
  const bySymbol = aggregateExitPnlBySymbol(report);
  const cycleStats = summarizeCycles(report);
  const wakeup = report?.wakeupReport?.llm?.analysis ?? report?.wakeupReport?.llm?.analysis ?? null;
  const wakeupTone = safeString(report?.wakeupReport?.llm?.analysis?.marketTone, 'mixed');
  const entries = Array.isArray(report?.entries) ? report.entries.length : 0;
  const exits = Array.isArray(report?.exits) ? report.exits.length : 0;
  const openPositions = Array.isArray(account?.positions) ? account.positions.length : 0;
  const paragraphs = [];

  paragraphs.push(
    `La session ${safeString(report?.sessionDate, 'n/a')} tourne en mode ${safeString(report?.runtime?.mode, 'n/a')}${report?.runtime?.executionDryRun ? ', avec execution encore en dry-run' : ', avec routage paper actif'}. Le wake-up report donne un ton de marche ${wakeupTone}.`,
  );

  if (entries === 0 && exits === 0) {
    paragraphs.push(
      `Aucune execution n’a ete enregistree sur la journee. Le moteur a surtout servi d’observateur: ${cycleStats.total} evaluation(s), ${cycleStats.failures} echec(s) de cycle, ${openPositions} position(s) encore ouverte(s) au dernier snapshot portefeuille.`,
    );
  } else {
    paragraphs.push(
      `Le moteur a journalise ${entries} entree(s) et ${exits} sortie(s). Le PnL realise visible dans le rapport ressort a ${exitMetrics.totalPnl >= 0 ? 'positif' : 'negatif'} (${exitMetrics.totalPnl.toFixed(2)}$), avec ${exitMetrics.wins} trade(s) gagnant(s), ${exitMetrics.losses} perdant(s) et un win rate de ${exitMetrics.winRate === null ? 'n/a' : `${(exitMetrics.winRate * 100).toFixed(1)}%`}.`,
    );
  }

  if (bySymbol.length) {
    const best = bySymbol[0];
    const worst = bySymbol[bySymbol.length - 1];
    paragraphs.push(
      `Par symbole, la meilleure contribution visible vient de ${best.symbol} (${best.pnl.toFixed(2)}$) tandis que la plus faible vient de ${worst.symbol} (${worst.pnl.toFixed(2)}$). Cela aide a distinguer si la journee a souffert d’un probleme general de regime ou d’un sous-panier de symboles.`,
    );
  }

  paragraphs.push(
    `Le dernier etat portefeuille affiche ${formatMoney(account?.equity)} d’equity, ${formatMoney(account?.cash)} de cash et ${formatPct(account?.exposurePct)} d’exposition. ${cycleStats.failures > 0 ? `Des erreurs restent presentes sur ${cycleStats.failureSymbols.join(', ')}.` : 'Aucune erreur de cycle n’est visible dans le journal.'}`,
  );

  return paragraphs;
};

const renderOverview = (report) => {
  const account = getLatestAccount(report);
  const exitMetrics = computeExitMetrics(report);
  const cycleStats = summarizeCycles(report);
  const entries = Array.isArray(report?.entries) ? report.entries.length : 0;
  const exits = Array.isArray(report?.exits) ? report.exits.length : 0;
  elements.reportTitle.textContent = `${safeString(report?.sessionDate, 'Rapport')} · ${safeString(report?.runtime?.mode, 'runtime')}`;
  elements.overviewGrid.innerHTML = [
    statCard('Equity', formatMoney(account?.equity), `Cash ${formatMoney(account?.cash)}`),
    statCard('Exposure', formatPct(account?.exposurePct), `${(account?.positions ?? []).length || 0} position(s)`),
    statCard('Entrées', String(entries), `Sorties ${exits}`),
    statCard('PnL réalisé', exitMetrics.totalPnl !== null ? `${exitMetrics.totalPnl.toFixed(2)}$` : 'n/a', exitMetrics.winRate === null ? 'Win rate n/a' : `Win rate ${(exitMetrics.winRate * 100).toFixed(1)}%`),
    statCard('Cycles', String(cycleStats.total), `${cycleStats.failures} erreur(s)`),
    statCard('Wake-up tone', safeString(report?.wakeupReport?.llm?.analysis?.marketTone, 'mixed'), report?.runtime?.executionDryRun ? 'dry-run actif' : 'paper actif'),
  ].join('');
};

const renderNarrative = (report) => {
  const paragraphs = buildHumanNarrative(report);
  elements.summaryNarrative.innerHTML = paragraphs.map((entry) => narrativeParagraph(entry)).join('');
};

const renderWakeup = (report) => {
  const wakeup = report?.wakeupReport;
  if (!wakeup) {
    elements.wakeupContent.innerHTML = emptyState('Aucun wake-up report embarqué dans ce rapport runtime.');
    return;
  }

  const llm = wakeup?.llm?.analysis ?? {};
  const checklist = Array.isArray(llm?.preOpenChecklist) ? llm.preOpenChecklist : [];
  const watchlist = Array.isArray(llm?.watchlist) ? llm.watchlist : [];
  const keyRisks = Array.isArray(llm?.keyRisks) ? llm.keyRisks : [];
  const keyCatalysts = Array.isArray(llm?.keyCatalysts) ? llm.keyCatalysts : [];

  elements.wakeupContent.innerHTML = `
    <section class="wakeup-section">
      <h3>Résumé du wake-up</h3>
      <p>${escapeHtml(safeString(llm?.summary, 'Pas de synthèse LLM disponible.'))}</p>
      <div class="meta-list">
        ${badge('Market tone', safeString(llm?.marketTone, 'mixed'))}
        ${badge('Report date', safeString(wakeup?.reportDate, 'n/a'))}
        ${badge('LLM status', safeString(wakeup?.llm?.status, 'unknown'))}
      </div>
    </section>
    <section class="wakeup-section">
      <h3>Checklist pré-open</h3>
      <div class="tag-list">
        ${checklist.length ? checklist.map((entry) => badge(entry.item, entry.status)).join('') : '<span class="badge">Aucune checklist</span>'}
      </div>
      <h3 style="margin-top:16px;">Catalyseurs & risques</h3>
      <div class="tag-list">
        ${keyCatalysts.length ? keyCatalysts.map((entry) => `<span class="tag">${escapeHtml(entry)}</span>`).join('') : '<span class="badge">Aucun catalyseur</span>'}
      </div>
      <div class="tag-list" style="margin-top:10px;">
        ${keyRisks.length ? keyRisks.map((entry) => `<span class="tag">${escapeHtml(entry)}</span>`).join('') : '<span class="badge">Aucun risque clé</span>'}
      </div>
      <h3 style="margin-top:16px;">Watchlist du wake-up</h3>
      <div class="tag-list">
        ${watchlist.length ? watchlist.map((entry) => badge(entry.symbol, entry.bias)).join('') : '<span class="badge">Watchlist absente</span>'}
      </div>
    </section>
  `;
};

const renderTrades = (report) => {
  const renderTable = (title, rows, columns) => `
    <section class="trade-section">
      <h3>${escapeHtml(title)}</h3>
      ${
        rows.length
          ? `<div class="table-wrap"><table><thead><tr>${columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join('')}</tr></thead><tbody>${rows
              .map((row) => `<tr>${columns.map((column) => `<td>${column.render(row)}</td>`).join('')}</tr>`)
              .join('')}</tbody></table></div>`
          : emptyState('Aucun évènement à afficher.')
      }
    </section>
  `;

  const entries = Array.isArray(report?.entries) ? report.entries : [];
  const exits = Array.isArray(report?.exits) ? report.exits : [];
  const timezone = report?.market?.timezone ?? 'America/New_York';

  elements.tradeTables.innerHTML = [
    renderTable('Entrées', entries, [
      { label: 'Heure', render: (row) => escapeHtml(formatDateTime(row.atMs, timezone)) },
      { label: 'Symbole', render: (row) => escapeHtml(row.symbol) },
      { label: 'Qty', render: (row) => escapeHtml(safeString(row.qty, 'n/a')) },
      { label: 'Prix ref', render: (row) => escapeHtml(formatMoney(row.referencePrice)) },
      { label: 'Stop', render: (row) => escapeHtml(formatPct(row.stopLossPct)) },
      { label: 'Raisons', render: (row) => escapeHtml((row.reasoning ?? []).join(', ')) },
    ]),
    renderTable('Sorties', exits, [
      { label: 'Heure', render: (row) => escapeHtml(formatDateTime(row.atMs, timezone)) },
      { label: 'Symbole', render: (row) => escapeHtml(row.symbol) },
      { label: 'Qty', render: (row) => escapeHtml(safeString(row.qty, 'n/a')) },
      { label: 'Entry', render: (row) => escapeHtml(formatMoney(row.entryPrice)) },
      { label: 'Exit', render: (row) => escapeHtml(formatMoney(row.exitPrice)) },
      { label: 'Delta', render: (row) => formatSignedMoney(row.pnl) },
    ]),
  ].join('');
};

const renderCyclePanel = (report) => {
  const cycles = Array.isArray(report?.cycleSummaries) ? report.cycleSummaries.slice().reverse() : [];
  const timezone = report?.market?.timezone ?? 'America/New_York';
  const failures = cycles.filter((entry) => entry?.ok === false);
  const failureSymbols = Array.from(new Set(failures.map((entry) => safeString(entry?.symbol)).filter(Boolean)));
  elements.cycleAnalysis.innerHTML = [
    narrativeParagraph(`Le journal runtime contient ${cycles.length} ligne(s) de cycle. ${failures.length ? `Les erreurs visibles concernent surtout ${failureSymbols.join(', ')}.` : 'Aucune erreur de cycle n’est visible.'}`),
    narrativeParagraph(`Le dernier cycle complete remonte au ${formatDateTime(report?.lastCompletedCycle?.completedAtMs, timezone)} avec ${safeString(report?.lastCompletedCycle?.okCount, '0')}/${safeString(report?.lastCompletedCycle?.totalCount, '0')} succès.`),
  ].join('');

  if (!cycles.length) {
    elements.cycleTable.innerHTML = emptyState('Aucun cycle enregistré.');
    return;
  }

  elements.cycleTable.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Cycle</th>
          <th>Heure</th>
          <th>Symbole</th>
          <th>Décision</th>
          <th>Execution</th>
          <th>Marché</th>
          <th>Statut</th>
          <th>Erreur</th>
        </tr>
      </thead>
      <tbody>
        ${cycles
          .slice(0, 120)
          .map(
            (entry) => `
              <tr>
                <td class="mono">${escapeHtml(safeString(entry?.cycle, 'n/a'))}</td>
                <td>${escapeHtml(formatDateTime(entry?.atMs, timezone))}</td>
                <td>${escapeHtml(safeString(entry?.symbol, 'n/a'))}</td>
                <td>${escapeHtml(safeString(entry?.decisionAction, 'n/a'))}</td>
                <td>${escapeHtml(safeString(entry?.executionStatus, 'n/a'))}</td>
                <td>${escapeHtml(safeString(entry?.marketSession, 'n/a'))}</td>
                <td>${badge(entry?.ok ? 'OK' : 'FAIL', entry?.ok ? 'ready' : 'block')}</td>
                <td>${escapeHtml(safeString(entry?.error, ''))}</td>
              </tr>
            `,
          )
          .join('')}
      </tbody>
    </table>
  `;
};

const getSymbolEvents = (report, symbol) => {
  const entries = (report?.entries ?? []).filter((entry) => safeString(entry?.symbol) === symbol);
  const exits = (report?.exits ?? []).filter((entry) => safeString(entry?.symbol) === symbol);
  return { entries, exits };
};

const renderSymbolAnalysis = (report, symbol) => {
  const details = report?.symbols?.[symbol];
  if (!details) {
    elements.symbolAnalysis.innerHTML = emptyState('Aucune donnée symbole disponible.');
    return;
  }

  const { entries, exits } = getSymbolEvents(report, symbol);
  const lastExit = exits[exits.length - 1] ?? null;
  const openPosition = details.position;
  elements.symbolAnalysis.innerHTML = [
    statCard('Prix courant', formatMoney(details.currentPrice), safeString(details.strategyProfile, 'n/a')),
    statCard('Position', openPosition ? 'LONG' : 'FLAT', openPosition ? `Qty ${safeString(openPosition.qty, 'n/a')}` : 'Aucune position'),
    statCard('RSI 1h', safeString(details?.timeframes?.['1h']?.rsi14, 'n/a'), `EMA gap ${safeString(details?.timeframes?.['1h']?.emaGap12_26, 'n/a')}`),
    statCard('Executions', `${entries.length}/${exits.length}`, lastExit ? `Dernier delta ${lastExit.pnl?.toFixed?.(2) ?? 'n/a'}$` : 'Aucune sortie'),
  ].join('');
};

const toChartTime = (timestamp) => {
  const numeric = Number(timestamp);
  if (!Number.isFinite(numeric)) return null;
  return Math.floor(numeric / 1000);
};

const setSeriesMarkersCompat = (series, markers) => {
  if (!series) return;
  if (typeof LightweightCharts.createSeriesMarkers === 'function') {
    LightweightCharts.createSeriesMarkers(series, markers);
    return;
  }
  if (typeof series.setMarkers === 'function') {
    series.setMarkers(markers);
  }
};

const ensureChart = () => {
  if (state.chart) return;
  state.chart = LightweightCharts.createChart(elements.chartContainer, {
    layout: {
      background: { color: '#fffdf8' },
      textColor: '#42515a',
      fontFamily: 'IBM Plex Mono, monospace',
    },
    grid: {
      vertLines: { color: 'rgba(18, 34, 45, 0.05)' },
      horzLines: { color: 'rgba(18, 34, 45, 0.05)' },
    },
    rightPriceScale: {
      borderColor: 'rgba(18, 34, 45, 0.12)',
    },
    timeScale: {
      borderColor: 'rgba(18, 34, 45, 0.12)',
      timeVisible: true,
      secondsVisible: false,
    },
    crosshair: {
      vertLine: { color: 'rgba(13, 139, 125, 0.35)' },
      horzLine: { color: 'rgba(13, 139, 125, 0.35)' },
    },
  });

  state.candleSeries = state.chart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: '#148a42',
    borderUpColor: '#148a42',
    wickUpColor: '#148a42',
    downColor: '#bf3f34',
    borderDownColor: '#bf3f34',
    wickDownColor: '#bf3f34',
  });

  state.volumeSeries = state.chart.addSeries(LightweightCharts.HistogramSeries, {
    priceFormat: { type: 'volume' },
    priceScaleId: '',
    color: 'rgba(13, 139, 125, 0.28)',
  });

  state.chart.priceScale('').applyOptions({
    scaleMargins: {
      top: 0.78,
      bottom: 0,
    },
  });

  state.resizeObserver = new ResizeObserver((entries) => {
    const size = entries[0]?.contentRect;
    if (!size || !state.chart) return;
    state.chart.resize(size.width, Math.max(360, size.height));
  });
  state.resizeObserver.observe(elements.chartContainer);
};

const renderChart = (report, symbol) => {
  ensureChart();
  const details = report?.symbols?.[symbol];
  elements.symbolTitle.textContent = symbol ? `${symbol} · lecture bar par bar` : 'Symbole';
  if (!details || !Array.isArray(details.shortBars) || !details.shortBars.length) {
    state.candleSeries.setData([]);
    state.volumeSeries.setData([]);
    setSeriesMarkersCompat(state.candleSeries, []);
    return;
  }

  const candleData = details.shortBars
    .map((bar) => ({
      time: toChartTime(bar.t),
      open: toFiniteOrNull(bar.o),
      high: toFiniteOrNull(bar.h),
      low: toFiniteOrNull(bar.l),
      close: toFiniteOrNull(bar.c),
    }))
    .filter((bar) => bar.time !== null && [bar.open, bar.high, bar.low, bar.close].every((value) => value !== null));

  const volumeData = details.shortBars
    .map((bar) => ({
      time: toChartTime(bar.t),
      value: toFiniteOrNull(bar.v) ?? 0,
      color: (toFiniteOrNull(bar.c) ?? 0) >= (toFiniteOrNull(bar.o) ?? 0) ? 'rgba(20, 138, 66, 0.25)' : 'rgba(191, 63, 52, 0.25)',
    }))
    .filter((bar) => bar.time !== null);

  state.candleSeries.setData(candleData);
  state.volumeSeries.setData(volumeData);

  const { entries, exits } = getSymbolEvents(report, symbol);
  const markers = [
    ...entries.map((entry) => ({
      time: toChartTime(entry.atMs),
      position: 'belowBar',
      color: '#148a42',
      shape: 'arrowUp',
      text: `IN ${entry.qty ?? 'n/a'}`,
    })),
    ...exits.map((entry) => ({
      time: toChartTime(entry.atMs),
      position: 'aboveBar',
      color: (toFiniteOrNull(entry.pnl) ?? 0) >= 0 ? '#148a42' : '#bf3f34',
      shape: 'arrowDown',
      text: `OUT ${(toFiniteOrNull(entry.pnl) ?? 0).toFixed(2)}$`,
    })),
  ].filter((marker) => marker.time !== null);
  setSeriesMarkersCompat(state.candleSeries, markers);
  state.chart.timeScale().fitContent();
};

const renderSymbolSelector = (report) => {
  const symbols = getReportSymbols(report);
  elements.symbolSelect.innerHTML = symbols.length
    ? symbols.map((symbol) => `<option value="${escapeHtml(symbol)}">${escapeHtml(symbol)}</option>`).join('')
    : '<option value="">Aucun symbole</option>';

  if (!symbols.length) {
    state.currentSymbol = null;
    return;
  }

  if (!symbols.includes(state.currentSymbol)) {
    const mostActiveSymbol = aggregateExitPnlBySymbol(report)[0]?.symbol ?? symbols[0];
    state.currentSymbol = symbols.includes(mostActiveSymbol) ? mostActiveSymbol : symbols[0];
  }

  elements.symbolSelect.value = state.currentSymbol;
};

const renderReport = (report) => {
  state.currentReportKey = report?.reportPath ?? state.currentReportKey;
  elements.app.classList.remove('is-loading');
  renderOverview(report);
  renderNarrative(report);
  renderWakeup(report);
  renderTrades(report);
  renderCyclePanel(report);
  renderSymbolSelector(report);
  renderSymbolAnalysis(report, state.currentSymbol);
  renderChart(report, state.currentSymbol);
};

const populateReportSelector = () => {
  elements.reportSelect.innerHTML = state.reports.length
    ? state.reports
        .map(
          (entry) => `
            <option value="${escapeHtml(entry.key)}">
              ${escapeHtml(entry.label)} · ${escapeHtml(safeString(entry.report?.runtime?.mode, 'runtime'))}
            </option>
          `,
        )
        .join('')
    : '<option value="">Aucun rapport détecté</option>';

  if (!state.reports.length) {
    elements.app.classList.remove('is-loading');
    elements.reportTitle.textContent = 'Aucun rapport runtime détecté';
    elements.overviewGrid.innerHTML = emptyState('Aucun fichier `runtime-report-YYYY-MM-DD.json` trouvé automatiquement.');
    elements.summaryNarrative.innerHTML = emptyState('Lance `npm start` en mode paper/live pour générer les rapports runtime quotidiens, ou charge un fichier JSON manuellement.');
    elements.wakeupContent.innerHTML = '';
    elements.tradeTables.innerHTML = '';
    elements.cycleAnalysis.innerHTML = '';
    elements.cycleTable.innerHTML = '';
    elements.symbolAnalysis.innerHTML = '';
    return;
  }

  const selectedKey = state.reportMap.has(state.currentReportKey) ? state.currentReportKey : state.reports[0].key;
  state.currentReportKey = selectedKey;
  elements.reportSelect.value = selectedKey;
  renderReport(state.reportMap.get(selectedKey));
};

const reloadReports = async () => {
  elements.app.classList.add('is-loading');
  try {
    const reports = await discoverReports();
    state.reports = reports;
    state.reportMap = new Map(reports.map((entry) => [entry.key, entry.report]));
    populateReportSelector();
  } catch (error) {
    elements.app.classList.remove('is-loading');
    elements.reportTitle.textContent = 'Erreur de chargement';
    elements.overviewGrid.innerHTML = emptyState(`Impossible de scanner les rapports: ${error?.message ?? error}`);
  }
};

const handleManualFile = async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const report = JSON.parse(text);
    if (report?.type !== 'runtime_daily_report') {
      throw new Error('Le fichier chargé n’est pas un runtime_daily_report.');
    }
    const key = `manual:${file.name}`;
    state.reportMap.set(key, report);
    state.reports = [{ key, path: key, label: report.sessionDate ?? file.name, report }, ...state.reports.filter((entry) => entry.key !== key)];
    state.currentReportKey = key;
    populateReportSelector();
  } catch (error) {
    alert(`Impossible de charger le fichier: ${error?.message ?? error}`);
  } finally {
    event.target.value = '';
  }
};

const handleReportChange = () => {
  const key = elements.reportSelect.value;
  if (!state.reportMap.has(key)) return;
  state.currentReportKey = key;
  renderReport(state.reportMap.get(key));
};

const handleSymbolChange = () => {
  state.currentSymbol = elements.symbolSelect.value;
  const report = state.reportMap.get(state.currentReportKey);
  if (!report) return;
  renderSymbolAnalysis(report, state.currentSymbol);
  renderChart(report, state.currentSymbol);
};

const init = async () => {
  elements.reloadButton.addEventListener('click', () => {
    void reloadReports();
  });
  elements.fileInput.addEventListener('change', (event) => {
    void handleManualFile(event);
  });
  elements.reportSelect.addEventListener('change', handleReportChange);
  elements.symbolSelect.addEventListener('change', handleSymbolChange);

  await reloadReports();
};

void init();
