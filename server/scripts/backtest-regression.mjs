import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRuntime } from '../src/app/createRuntime.mjs';
import { BacktestEngine } from '../src/core/backtest/BacktestEngine.mjs';
import { SimpleRuleDecisionEngine } from '../src/core/backtest/SimpleRuleDecisionEngine.mjs';
import { normalizeEpochMs } from '../src/core/market/time.mjs';
import { assertSymbolId, assertTimeframe } from '../src/core/types/validators.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_PATH = path.resolve(__dirname, '../storage/configs/backtest-regressions.json');
const SUMMARY_REPORTS_DIR = path.resolve(__dirname, '../storage/reports/backtests/regressions');

const clone = (value) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return JSON.parse(JSON.stringify(value));
};

const deepMerge = (base, extra) => {
  if (Array.isArray(base) && Array.isArray(extra)) return extra.slice();
  if (base && typeof base === 'object' && extra && typeof extra === 'object' && !Array.isArray(base) && !Array.isArray(extra)) {
    const result = { ...base };
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) continue;
      result[key] = key in base ? deepMerge(base[key], value) : clone(value);
    }
    return result;
  }

  return clone(extra);
};

const remapProfiles = (symbolProfiles, replacements) =>
  Object.fromEntries(
    Object.entries(symbolProfiles).map(([symbol, profile]) => [symbol, replacements[profile] ?? profile]),
  );

const PRESET_FACTORIES = Object.freeze({
  current: ({ symbolProfiles }) => ({
    decisionEngine: new SimpleRuleDecisionEngine({ symbolProfiles }),
    configPatch: null,
  }),
  no_symbol_rules: ({ symbol, symbolProfiles }) => ({
    decisionEngine: new SimpleRuleDecisionEngine({ symbolProfiles }),
    configPatch: {
      symbols: {
        [symbol]: {
          strategyRules: null,
        },
      },
    },
  }),
  no_high_beta: ({ symbolProfiles }) => ({
    decisionEngine: new SimpleRuleDecisionEngine({
      symbolProfiles: remapProfiles(symbolProfiles, {
        high_beta_stock: 'single_stock',
      }),
    }),
    configPatch: null,
  }),
  no_index_etf: ({ symbolProfiles }) => ({
    decisionEngine: new SimpleRuleDecisionEngine({
      symbolProfiles: remapProfiles(symbolProfiles, {
        index_etf: 'single_stock',
      }),
    }),
    configPatch: null,
  }),
  no_index_etf_no_high_beta: ({ symbolProfiles }) => ({
    decisionEngine: new SimpleRuleDecisionEngine({
      symbolProfiles: remapProfiles(symbolProfiles, {
        index_etf: 'single_stock',
        high_beta_stock: 'single_stock',
      }),
    }),
    configPatch: null,
  }),
  force_single_stock: ({ symbol, symbolProfiles }) => ({
    decisionEngine: new SimpleRuleDecisionEngine({
      symbolProfiles: {
        ...symbolProfiles,
        [symbol]: 'single_stock',
      },
    }),
    configPatch: {
      symbols: {
        [symbol]: {
          strategyProfile: 'single_stock',
        },
      },
    },
  }),
  force_index_etf: ({ symbol, symbolProfiles }) => ({
    decisionEngine: new SimpleRuleDecisionEngine({
      symbolProfiles: {
        ...symbolProfiles,
        [symbol]: 'index_etf',
      },
    }),
    configPatch: {
      symbols: {
        [symbol]: {
          strategyProfile: 'index_etf',
        },
      },
    },
  }),
  force_high_beta: ({ symbol, symbolProfiles }) => ({
    decisionEngine: new SimpleRuleDecisionEngine({
      symbolProfiles: {
        ...symbolProfiles,
        [symbol]: 'high_beta_stock',
      },
    }),
    configPatch: {
      symbols: {
        [symbol]: {
          strategyProfile: 'high_beta_stock',
        },
      },
    },
  }),
  force_quality_single_stock: ({ symbol, symbolProfiles }) => ({
    decisionEngine: new SimpleRuleDecisionEngine({
      symbolProfiles: {
        ...symbolProfiles,
        [symbol]: 'single_stock_quality',
      },
    }),
    configPatch: {
      symbols: {
        [symbol]: {
          strategyProfile: 'single_stock_quality',
        },
      },
    },
  }),
});

const mergeConfigPatches = (...patches) =>
  patches.reduce((result, patch) => {
    if (!patch || typeof patch !== 'object') return result;
    return deepMerge(result, patch);
  }, {});

const createPatchedConfigStore = (baseConfigStore, configPatch = null) => {
  if (!configPatch || typeof configPatch !== 'object' || !Object.keys(configPatch).length) {
    return baseConfigStore;
  }

  return {
    ...baseConfigStore,
    getSymbolConfig(symbol) {
      const safeSymbol = String(symbol ?? '').toUpperCase();
      const symbolPatch = configPatch?.symbols?.[safeSymbol] ?? null;
      return symbolPatch ? deepMerge(baseConfigStore.getSymbolConfig(safeSymbol), symbolPatch) : baseConfigStore.getSymbolConfig(safeSymbol);
    },
    getRelatedSymbols(symbol) {
      const safeSymbol = String(symbol ?? '').toUpperCase();
      const patched = configPatch?.relatedSymbols?.[safeSymbol];
      if (Array.isArray(patched)) return patched.slice();
      return baseConfigStore.getRelatedSymbols(safeSymbol);
    },
    getStrategyProfile(symbol) {
      return this.getSymbolConfig(symbol)?.strategyProfile ?? baseConfigStore.getStrategyProfile(symbol);
    },
    getStrategyProfileMap() {
      const baseMap = { ...baseConfigStore.getStrategyProfileMap() };
      for (const [symbol, patch] of Object.entries(configPatch?.symbols ?? {})) {
        if (typeof patch?.strategyProfile === 'string' && patch.strategyProfile) {
          baseMap[String(symbol).toUpperCase()] = patch.strategyProfile;
        }
      }
      return baseMap;
    },
  };
};

const pickDefined = (...values) => values.find((value) => value !== undefined && value !== null && value !== '');

const toFiniteOr = (value, fallback) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const parseArgs = (argv) => {
  const args = {
    symbol: null,
    scenario: null,
    start: null,
    end: null,
    stepTimeframe: null,
    initialCash: null,
    baselinePreset: null,
    candidatePreset: null,
    slippageBps: null,
    feePerOrder: null,
    feePerShare: null,
    writeBacktestReports: false,
    writeSummary: true,
    listScenarios: false,
    listPresets: false,
    runAll: false,
    help: false,
  };

  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith('--')) {
      positional.push(entry);
      continue;
    }

    const [flag, inlineValue] = entry.split('=');
    const value = inlineValue ?? argv[index + 1];

    switch (flag) {
      case '--symbol':
        args.symbol = value;
        if (inlineValue === undefined) index += 1;
        break;
      case '--scenario':
        args.scenario = value;
        if (inlineValue === undefined) index += 1;
        break;
      case '--start':
        args.start = value;
        if (inlineValue === undefined) index += 1;
        break;
      case '--end':
        args.end = value;
        if (inlineValue === undefined) index += 1;
        break;
      case '--step':
        args.stepTimeframe = value;
        if (inlineValue === undefined) index += 1;
        break;
      case '--cash':
        args.initialCash = value;
        if (inlineValue === undefined) index += 1;
        break;
      case '--baseline':
        args.baselinePreset = value;
        if (inlineValue === undefined) index += 1;
        break;
      case '--candidate':
        args.candidatePreset = value;
        if (inlineValue === undefined) index += 1;
        break;
      case '--slippage-bps':
        args.slippageBps = value;
        if (inlineValue === undefined) index += 1;
        break;
      case '--fee-order':
        args.feePerOrder = value;
        if (inlineValue === undefined) index += 1;
        break;
      case '--fee-share':
        args.feePerShare = value;
        if (inlineValue === undefined) index += 1;
        break;
      case '--write-backtests':
        args.writeBacktestReports = true;
        break;
      case '--no-write-summary':
        args.writeSummary = false;
        break;
      case '--list-scenarios':
        args.listScenarios = true;
        break;
      case '--list-presets':
        args.listPresets = true;
        break;
      case '--all':
        args.runAll = true;
        break;
      case '--help':
        args.help = true;
        break;
      default:
        throw new Error(`Unsupported flag ${flag}`);
    }
  }

  if (!args.symbol && positional[0]) args.symbol = positional[0];
  return args;
};

const loadScenarios = () => {
  if (!fs.existsSync(SCENARIOS_PATH)) return {};
  const raw = fs.readFileSync(SCENARIOS_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === 'object' ? parsed : {};
};

const assertPresetName = (presetName, label) => {
  if (!PRESET_FACTORIES[presetName]) {
    const available = Object.keys(PRESET_FACTORIES).join(', ');
    throw new Error(`Unsupported ${label} preset '${presetName}'. Available presets: ${available}`);
  }

  return presetName;
};

const evaluateExpectations = ({ expectations = null, baseline, candidate, delta }) => {
  const checks = [];
  if (!expectations || typeof expectations !== 'object') {
    return {
      checks,
      enforced: false,
      passed: null,
    };
  }

  if (Number.isFinite(Number(expectations.minNetPnlDelta))) {
    const threshold = Number(expectations.minNetPnlDelta);
    checks.push({
      type: 'minNetPnlDelta',
      expected: threshold,
      actual: delta.netPnl,
      passed: delta.netPnl >= threshold,
    });
  }

  if (Number.isFinite(Number(expectations.maxCandidateTradeCount))) {
    const threshold = Number(expectations.maxCandidateTradeCount);
    checks.push({
      type: 'maxCandidateTradeCount',
      expected: threshold,
      actual: candidate.tradeCount,
      passed: candidate.tradeCount <= threshold,
    });
  }

  if (expectations.requireReducedDrawdown === true) {
    checks.push({
      type: 'requireReducedDrawdown',
      expected: true,
      actual: candidate.maxDrawdownPct < baseline.maxDrawdownPct,
      passed: candidate.maxDrawdownPct < baseline.maxDrawdownPct,
    });
  }

  if (expectations.requireImprovedNetPnl === true) {
    checks.push({
      type: 'requireImprovedNetPnl',
      expected: true,
      actual: candidate.netPnl > baseline.netPnl,
      passed: candidate.netPnl > baseline.netPnl,
    });
  }

  return {
    checks,
    enforced: checks.length > 0,
    passed: checks.length > 0 ? checks.every((entry) => entry.passed) : null,
  };
};

const buildWindow = ({ start, end, stepTimeframe }) => {
  const startMs = normalizeEpochMs(start, 'start');
  const endMs = normalizeEpochMs(end, 'end');
  const safeStepTimeframe = assertTimeframe(stepTimeframe);

  if (endMs <= startMs) {
    throw new Error(`Regression end must be after start, received ${startMs} -> ${endMs}`);
  }

  return {
    startMs,
    endMs,
    stepTimeframe: safeStepTimeframe,
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
  };
};

const resolveConfig = (args, scenarios) => {
  const scenarioConfig = args.scenario ? scenarios?.[args.scenario] : null;
  if (args.scenario && !scenarioConfig) {
    const available = Object.keys(scenarios).sort();
    throw new Error(`Unknown scenario '${args.scenario}'. Available scenarios: ${available.join(', ')}`);
  }

  const symbol = assertSymbolId(String(pickDefined(args.symbol, scenarioConfig?.symbol, '')).toUpperCase());
  const window = buildWindow({
    start: pickDefined(args.start, scenarioConfig?.start),
    end: pickDefined(args.end, scenarioConfig?.end),
    stepTimeframe: pickDefined(args.stepTimeframe, scenarioConfig?.stepTimeframe, '30m'),
  });
  const initialCash = toFiniteOr(pickDefined(args.initialCash, scenarioConfig?.initialCash), 100_000);
  const slippageBps = toFiniteOr(pickDefined(args.slippageBps, scenarioConfig?.slippageBps), 3);
  const feePerOrder = toFiniteOr(pickDefined(args.feePerOrder, scenarioConfig?.feePerOrder), 0.5);
  const feePerShare = toFiniteOr(pickDefined(args.feePerShare, scenarioConfig?.feePerShare), 0);
  const baselinePreset = assertPresetName(pickDefined(args.baselinePreset, scenarioConfig?.baselinePreset, 'no_high_beta'), 'baseline');
  const candidatePreset = assertPresetName(pickDefined(args.candidatePreset, scenarioConfig?.candidatePreset, 'current'), 'candidate');

  return {
    scenarioName: args.scenario ?? null,
    scenarioDescription: scenarioConfig?.description ?? null,
    symbol,
    window,
    initialCash,
    slippageBps,
    feePerOrder,
    feePerShare,
    baselinePreset,
    candidatePreset,
    expectations: scenarioConfig?.expectations ?? null,
    baselineConfigPatch: scenarioConfig?.baselineConfigPatch ?? null,
    candidateConfigPatch: scenarioConfig?.candidateConfigPatch ?? null,
    writeBacktestReports: args.writeBacktestReports,
    writeSummary: args.writeSummary,
  };
};

const summarizeReport = (report, preset) => ({
  preset,
  tradeCount: report.metrics.tradeCount,
  wins: report.metrics.wins,
  losses: report.metrics.losses,
  winRate: report.metrics.winRate,
  netPnl: report.metrics.netPnl,
  grossPnlBeforeCosts: report.metrics.grossPnlBeforeCosts,
  costDrag: report.metrics.costDrag,
  maxDrawdownPct: report.metrics.maxDrawdownPct,
  finalEquity: report.metrics.finalEquity,
  reportPath: report.reportPath ?? null,
});

const buildDelta = (baseline, candidate) => ({
  tradeCount: candidate.tradeCount - baseline.tradeCount,
  wins: candidate.wins - baseline.wins,
  losses: candidate.losses - baseline.losses,
  winRate: candidate.winRate - baseline.winRate,
  netPnl: candidate.netPnl - baseline.netPnl,
  grossPnlBeforeCosts: candidate.grossPnlBeforeCosts - baseline.grossPnlBeforeCosts,
  costDrag: candidate.costDrag - baseline.costDrag,
  maxDrawdownPct: candidate.maxDrawdownPct - baseline.maxDrawdownPct,
  finalEquity: candidate.finalEquity - baseline.finalEquity,
  improvedNetPnl: candidate.netPnl > baseline.netPnl,
  reducedDrawdown: candidate.maxDrawdownPct < baseline.maxDrawdownPct,
});

const writeSummaryReport = (payload, symbol) => {
  fs.mkdirSync(SUMMARY_REPORTS_DIR, { recursive: true });
  const reportPath = path.resolve(SUMMARY_REPORTS_DIR, `regression-${symbol}-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(payload, null, 2));
  return reportPath;
};

const writeSuiteReport = (payload) => {
  fs.mkdirSync(SUMMARY_REPORTS_DIR, { recursive: true });
  const reportPath = path.resolve(SUMMARY_REPORTS_DIR, `regression-suite-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(payload, null, 2));
  return reportPath;
};

const runBacktestForPreset = async ({ runtime, config, presetName, scenarioConfigPatch = null }) => {
  const preset = PRESET_FACTORIES[presetName]({
    symbol: config.symbol,
    symbolProfiles: runtime.configStore.getStrategyProfileMap(),
  });
  const effectiveConfigStore = createPatchedConfigStore(
    runtime.configStore,
    mergeConfigPatches(preset.configPatch, scenarioConfigPatch),
  );
  const backtestEngine = new BacktestEngine({
    configStore: effectiveConfigStore,
    marketCalendar: runtime.marketCalendar,
    sourceMarketDataProvider: runtime.marketDataProvider,
    indicatorEngine: runtime.indicatorEngine,
  });

  return await backtestEngine.run({
    symbol: config.symbol,
    startMs: config.window.startMs,
    endMs: config.window.endMs,
    stepTimeframe: config.window.stepTimeframe,
    initialCash: config.initialCash,
    brokerOptions: {
      slippageBps: config.slippageBps,
      feePerOrder: config.feePerOrder,
      feePerShare: config.feePerShare,
    },
    writeReport: config.writeBacktestReports,
    decisionEngine: preset.decisionEngine,
  });
};

const runScenario = async ({ runtime, config }) => {
  const commonOptions = {
    symbol: config.symbol,
    startMs: config.window.startMs,
    endMs: config.window.endMs,
    stepTimeframe: config.window.stepTimeframe,
    initialCash: config.initialCash,
    brokerOptions: {
      slippageBps: config.slippageBps,
      feePerOrder: config.feePerOrder,
      feePerShare: config.feePerShare,
    },
    writeReport: config.writeBacktestReports,
  };

  const baselineReport = await runBacktestForPreset({
    runtime,
    config,
    presetName: config.baselinePreset,
    scenarioConfigPatch: config.baselineConfigPatch,
  });
  const candidateReport = await runBacktestForPreset({
    runtime,
    config,
    presetName: config.candidatePreset,
    scenarioConfigPatch: config.candidateConfigPatch,
  });

  const baseline = summarizeReport(baselineReport, config.baselinePreset);
  const candidate = summarizeReport(candidateReport, config.candidatePreset);
  const delta = buildDelta(baseline, candidate);
  const evaluation = evaluateExpectations({
    expectations: config.expectations,
    baseline,
    candidate,
    delta,
  });

  return {
    type: 'backtest_regression',
    generatedAtMs: Date.now(),
    scenario: config.scenarioName,
    description: config.scenarioDescription,
    runtime: runtime.describe(),
    symbol: config.symbol,
    window: config.window,
    costModel: {
      slippageBps: config.slippageBps,
      feePerOrder: config.feePerOrder,
      feePerShare: config.feePerShare,
    },
    baseline,
    candidate,
    delta,
    checks: evaluation.checks,
    enforced: evaluation.enforced,
    passed: evaluation.passed,
    summaryReportPath: null,
  };
};

const printHelp = () => {
  console.log(`Usage:
  node ./scripts/backtest-regression.mjs --scenario <name>
  node ./scripts/backtest-regression.mjs --all
  node ./scripts/backtest-regression.mjs <SYMBOL> --start <ISO|ms> --end <ISO|ms> [options]

Options:
  --scenario <name>        Load a named fixed-window regression scenario
  --symbol <ticker>        Override symbol
  --start <ISO|ms>         Absolute start timestamp
  --end <ISO|ms>           Absolute end timestamp
  --step <timeframe>       Evaluation timeframe, default 30m
  --cash <amount>          Initial cash, default 100000
  --baseline <preset>      Baseline preset, default no_high_beta
  --candidate <preset>     Candidate preset, default current
  --slippage-bps <bps>     Slippage in basis points, default 3
  --fee-order <amount>     Fixed fee per order, default 0.5
  --fee-share <amount>     Fee per share, default 0
  --write-backtests        Persist baseline and candidate backtest reports
  --no-write-summary       Do not persist the combined regression summary
  --list-scenarios         Print available scenarios
  --list-presets           Print available decision engine presets
  --all                    Run every configured scenario
  --help                   Print this help
`);
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const scenarios = loadScenarios();

  if (args.help) {
    printHelp();
    return;
  }

  if (args.listPresets) {
    console.log(JSON.stringify({ presets: Object.keys(PRESET_FACTORIES).sort() }, null, 2));
    return;
  }

  if (args.listScenarios) {
    const list = Object.entries(scenarios)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, scenario]) => ({
        name,
        description: scenario?.description ?? null,
        symbol: scenario?.symbol ?? null,
        start: scenario?.start ?? null,
        end: scenario?.end ?? null,
        baselinePreset: scenario?.baselinePreset ?? null,
        candidatePreset: scenario?.candidatePreset ?? null,
      }));
    console.log(JSON.stringify({ scenarios: list }, null, 2));
    return;
  }
  const runtime = await createRuntime();

  if (args.runAll) {
    const scenarioNames = Object.keys(scenarios).sort();
    if (!scenarioNames.length) {
      throw new Error('No regression scenarios are configured.');
    }

    const results = [];
    for (const scenarioName of scenarioNames) {
      const config = resolveConfig({ ...args, scenario: scenarioName }, scenarios);
      results.push(await runScenario({
        runtime,
        config,
      }));
    }

    const payload = {
      type: 'backtest_regression_suite',
      generatedAtMs: Date.now(),
      runtime: runtime.describe(),
      scenarioCount: results.length,
      enforcedScenarioCount: results.filter((entry) => entry.enforced).length,
      passed: results.filter((entry) => entry.enforced).every((entry) => entry.passed),
      scenarios: results,
      summaryReportPath: null,
    };

    if (args.writeSummary) {
      payload.summaryReportPath = writeSuiteReport(payload);
    }

    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const config = resolveConfig(args, scenarios);
  const payload = await runScenario({
    runtime,
    config,
  });

  if (config.writeSummary) {
    payload.summaryReportPath = writeSummaryReport(payload, config.symbol);
  }

  console.log(JSON.stringify(payload, null, 2));
};

main().catch((error) => {
  console.error('[BACKTEST REGRESSION] Failure');
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
