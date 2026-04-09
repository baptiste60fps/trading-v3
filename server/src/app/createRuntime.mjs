import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ConfigStore } from '../config/ConfigStore.mjs';
import { loadLocalEnv } from '../config/loadLocalEnv.mjs';
import { MarketCalendar } from '../core/market/MarketCalendar.mjs';
import { FileCacheStore } from '../core/cache/FileCacheStore.mjs';
import { AlpacaHttpClient } from '../core/api/AlpacaHttpClient.mjs';
import { AlpacaMarketDataProvider } from '../core/api/AlpacaMarketDataProvider.mjs';
import { AlpacaBrokerGateway } from '../core/api/AlpacaBrokerGateway.mjs';
import { UnavailableMarketDataProvider } from '../core/api/UnavailableMarketDataProvider.mjs';
import { UnavailableBrokerGateway } from '../core/api/UnavailableBrokerGateway.mjs';
import { BarsRepository } from '../services/features/BarsRepository.mjs';
import { IndicatorEngine } from '../core/indicators/IndicatorEngine.mjs';
import { FeatureSnapshotService } from '../services/features/FeatureSnapshotService.mjs';
import { PortfolioService } from '../services/portfolio/PortfolioService.mjs';
import { DecisionEngine } from '../core/llm/DecisionEngine.mjs';
import { UnavailableDecisionModelClient } from '../core/llm/UnavailableDecisionModelClient.mjs';
import { OllamaDecisionModelClient } from '../core/llm/OllamaDecisionModelClient.mjs';
import { ExecutionEngine } from '../core/runtime/ExecutionEngine.mjs';
import { PersistentRuntimeOrchestrator } from '../core/runtime/PersistentRuntimeOrchestrator.mjs';
import { RuntimeSessionStateStore } from '../core/runtime/RuntimeSessionStateStore.mjs';
import { StrategyInstance } from '../core/strategy/StrategyInstance.mjs';
import { HeuristicEntryPolicy } from '../core/strategy/HeuristicEntryPolicy.mjs';
import { RssFeedService } from '../services/news/RssFeedService.mjs';
import { DailyMarketReportService } from '../services/reports/DailyMarketReportService.mjs';
import { DailyGitCommitService } from '../services/reports/DailyGitCommitService.mjs';
import { DailyRuntimeReportService } from '../services/reports/DailyRuntimeReportService.mjs';
import { ConsoleTradingLogger } from '../core/telemetry/ConsoleTradingLogger.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_SERVER_ROOT = path.resolve(__dirname, '../..');

export const createRuntime = async ({
  serverRootDir = DEFAULT_SERVER_ROOT,
  env = process.env,
  ollamaClientFactory = (config) => new OllamaDecisionModelClient(config),
} = {}) => {
  const localEnv = loadLocalEnv(serverRootDir);
  const mergedEnv = {
    ...localEnv.values,
    ...env,
  };

  const configStore = new ConfigStore({ serverRootDir, env: mergedEnv });
  await configStore.load();

  const storage = configStore.getStorageConfig();
  for (const directory of Object.values(storage)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const marketCalendar = new MarketCalendar(configStore.getMarketConfig());
  const cacheStore = new FileCacheStore({ rootDir: storage.cacheDir });
  const runtimeSessionStateStore = new RuntimeSessionStateStore({
    runsDir: storage.runsDir,
    timezone: configStore.getMarketConfig().timezone,
  });
  const alpacaConfig = configStore.getAlpacaConfig();
  const llmConfig = configStore.getLlmConfig();
  const newsConfig = configStore.getNewsConfig();
  const executionConfig = configStore.getExecutionConfig();
  const telemetryConfig = configStore.getTelemetryConfig();
  const llmHealth = {
    enabled: llmConfig.enabled === true,
    ready: false,
    provider: llmConfig.provider ?? null,
    message: llmConfig.enabled === true ? 'Decision model is not configured' : 'LLM disabled by configuration',
  };

  let marketDataProvider = new UnavailableMarketDataProvider('Alpaca market data is not ready: missing credentials or disabled provider');
  let brokerGateway = new UnavailableBrokerGateway('Alpaca broker is not ready: missing credentials or disabled provider');
  let decisionModelClient = new UnavailableDecisionModelClient('Decision model is not configured');

  if (alpacaConfig.enabled && alpacaConfig.keyId && alpacaConfig.secretKey) {
    const client = new AlpacaHttpClient(alpacaConfig);
    marketDataProvider = new AlpacaMarketDataProvider({
      client,
      feed: alpacaConfig.feed,
      adjustment: alpacaConfig.adjustment,
      cryptoLocation: alpacaConfig.cryptoLocation,
    });
    brokerGateway = new AlpacaBrokerGateway({
      client,
      paper: alpacaConfig.paper,
    });
  }

  if (llmConfig.enabled && llmConfig.provider === 'ollama') {
    const candidate = ollamaClientFactory(llmConfig);
    const availability = typeof candidate?.checkAvailability === 'function'
      ? await candidate.checkAvailability()
      : { available: true, reason: null };

    if (availability?.available === false) {
      llmHealth.message = `Ollama healthcheck failed: ${availability.reason ?? 'ollama_unreachable'}`;
      decisionModelClient = new UnavailableDecisionModelClient(llmHealth.message);
    } else {
      decisionModelClient = candidate;
      llmHealth.ready = true;
      llmHealth.message = null;
    }
  } else if (llmConfig.enabled && llmConfig.provider) {
    llmHealth.message = `Unsupported LLM provider: ${llmConfig.provider}`;
  }

  const barsRepository = new BarsRepository({
    marketDataProvider,
    cacheStore,
  });
  const indicatorEngine = new IndicatorEngine();
  const portfolioService = new PortfolioService({
    brokerGateway,
    configStore,
  });
  const featureSnapshotService = new FeatureSnapshotService({
    configStore,
    barsRepository,
    indicatorEngine,
    marketCalendar,
    portfolioService,
  });
  const decisionEngine = new DecisionEngine({
    modelClient: decisionModelClient,
    llmConfig,
  });
  const rssFeedService = new RssFeedService({
    ...newsConfig,
    cacheStore,
  });
  const dailyMarketReportService = new DailyMarketReportService({
    configStore,
    marketCalendar,
    portfolioService,
    featureSnapshotService,
    rssFeedService,
    modelClient: decisionModelClient,
    llmConfig,
  });
  const dailyGitCommitService = new DailyGitCommitService({
    repoRootDir: path.resolve(serverRootDir, '..'),
    configStore,
  });
  const dailyRuntimeReportService = new DailyRuntimeReportService({
    configStore,
    dailyMarketReportService,
    dailyGitCommitService,
  });
  const entryPolicy = new HeuristicEntryPolicy({
    configStore,
    enabled: executionConfig.entryPolicyGuardEnabled !== false,
    clampRequestedSize: executionConfig.clampEntrySizeToHeuristic !== false,
  });
  const executionEngine = new ExecutionEngine({
    brokerGateway,
    portfolioService,
    configStore,
    dryRun: executionConfig.dryRun,
  });
  const consoleTradingLogger = new ConsoleTradingLogger({
    timezone: configStore.getMarketConfig().timezone,
    enabled: telemetryConfig?.console?.enabled !== false,
    colors: telemetryConfig?.console?.colors !== false,
    preview: telemetryConfig?.console?.preview === true,
    runtimeSessionStateStore,
  });

  return {
    configStore,
    marketCalendar,
    cacheStore,
    runtimeSessionStateStore,
    marketDataProvider,
    brokerGateway,
    barsRepository,
    indicatorEngine,
    decisionModelClient,
    portfolioService,
    featureSnapshotService,
    decisionEngine,
    rssFeedService,
    dailyMarketReportService,
    dailyGitCommitService,
    dailyRuntimeReportService,
    executionEngine,
    consoleTradingLogger,
    createPersistentRuntimeOrchestrator(options = {}) {
      const runtimeConfig = configStore.getRuntimeConfig();
      return new PersistentRuntimeOrchestrator({
        runtimeMode: options.runtimeMode ?? runtimeConfig.mode,
        configStore,
        marketCalendar,
        symbols: options.symbols ?? runtimeConfig.symbols ?? null,
        loopIntervalMs: options.loopIntervalMs ?? runtimeConfig.loopIntervalMs,
        idleIntervalMs: options.idleIntervalMs ?? runtimeConfig.idleIntervalMs,
        startupWarmup: options.startupWarmup ?? runtimeConfig.startupWarmup,
        logger: options.logger ?? console,
        scheduler: options.scheduler,
        now: options.now,
        onCycleStarted: options.onCycleStarted ?? ((payload) => dailyRuntimeReportService.onCycleStarted(payload)),
        onStrategyEvaluated: options.onStrategyEvaluated ?? ((payload) => dailyRuntimeReportService.onStrategyEvaluated(payload)),
        onCycleCompleted: options.onCycleCompleted ?? ((payload) => dailyRuntimeReportService.onCycleCompleted(payload)),
        strategyFactory: options.strategyFactory ?? ((symbol, runtimeMode) => new StrategyInstance({
          symbol,
          runtimeMode,
          configStore,
          featureSnapshotService,
          decisionEngine,
          executionEngine,
          entryPolicy,
          runtimeSessionStateStore,
          consoleLogger: consoleTradingLogger,
        })),
      });
    },
    createStrategyInstance(symbol, runtimeMode = configStore.getRuntimeConfig().mode) {
      return new StrategyInstance({
        symbol,
        runtimeMode,
        configStore,
        featureSnapshotService,
        decisionEngine,
        executionEngine,
        entryPolicy,
        runtimeSessionStateStore,
        consoleLogger: consoleTradingLogger,
      });
    },
    describe() {
      const config = configStore.getAll();
      return {
        runtimeMode: config.runtime.mode,
        timezone: config.market.timezone,
        alpacaEnabled: config.alpaca.enabled,
        alpacaReady: Boolean(config.alpaca.keyId && config.alpaca.secretKey),
        llmEnabled: config.llm.enabled,
        llmReady: llmHealth.ready,
        llmProvider: config.llm.provider,
        llmHealthMessage: llmHealth.message,
        executionDryRun: config.execution.dryRun,
        runtimeLoopIntervalMs: config.runtime.loopIntervalMs,
        runtimeIdleIntervalMs: config.runtime.idleIntervalMs,
        runtimeStartupWarmup: config.runtime.startupWarmup,
        runtimeSymbols: Array.isArray(config.runtime.symbols) ? config.runtime.symbols : null,
        enabledSymbols: configStore.getEnabledSymbols(),
        consoleTelemetryEnabled: config.telemetry?.console?.enabled !== false,
        consoleTelemetryPreview: config.telemetry?.console?.preview === true,
        envFilePath: localEnv.path,
        storage,
      };
    },
  };
};
