import fs from 'fs';
import path from 'path';
import { defaultConfig } from './defaultConfig.mjs';
import { assertAssetClass, assertRuntimeMode, normalizeSymbolId } from '../core/types/validators.mjs';

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

const deepFreeze = (value) => {
  if (!value || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
};

const normalizeBoolean = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const lower = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(lower)) return true;
  if (['0', 'false', 'no', 'off'].includes(lower)) return false;
  return fallback;
};

const normalizeNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeStringList = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) => String(entry ?? '').trim())
      .filter(Boolean);
    return normalized.length ? normalized : fallback;
  }

  const normalized = String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  return normalized.length ? normalized : fallback;
};

export class ConfigStore {
  constructor({
    serverRootDir,
    env = process.env,
    configFilePath = null,
  } = {}) {
    this.serverRootDir = serverRootDir ?? process.cwd();
    this.env = env;
    this.configFilePath = configFilePath ?? path.resolve(this.serverRootDir, 'storage/configs/runtime.json');
    this.config = null;
  }

  async load() {
    const fileConfig = this.#readFileConfig();
    const envConfig = this.#readEnvConfig();

    const merged = deepMerge(deepMerge(defaultConfig, fileConfig), envConfig);
    merged.alpaca = this.#resolveAlpacaConfig({
      mergedConfig: merged.alpaca,
      fileConfig: fileConfig.alpaca,
      envConfig: envConfig.alpaca,
    });
    merged.runtime.mode = assertRuntimeMode(merged.runtime.mode);
    merged.storage = this.#resolveStoragePaths(merged.storage);
    this.config = deepFreeze(merged);
    return this.config;
  }

  getRuntimeConfig() {
    this.#ensureLoaded();
    return this.config.runtime;
  }

  getStorageConfig() {
    this.#ensureLoaded();
    return this.config.storage;
  }

  getMarketConfig() {
    this.#ensureLoaded();
    return this.config.market;
  }

  getAlpacaConfig() {
    this.#ensureLoaded();
    return this.config.alpaca;
  }

  getLlmConfig() {
    this.#ensureLoaded();
    return this.config.llm;
  }

  getNewsConfig() {
    this.#ensureLoaded();
    return this.config.news;
  }

  getReportsConfig() {
    this.#ensureLoaded();
    return this.config.reports;
  }

  getExecutionConfig() {
    this.#ensureLoaded();
    return this.config.execution;
  }

  getTelemetryConfig() {
    this.#ensureLoaded();
    return this.config.telemetry ?? {};
  }

  getSymbolConfig(symbol) {
    this.#ensureLoaded();
    const symbolKey = normalizeSymbolId(symbol ?? '');
    const base = this.config.symbols.default ?? {};
    const specific = symbolKey ? this.config.symbols[symbolKey] ?? {} : {};
    return deepFreeze(deepMerge(base, specific));
  }

  getAssetClass(symbol) {
    this.#ensureLoaded();
    const assetClass = this.getSymbolConfig(symbol)?.assetClass ?? this.config.symbols?.default?.assetClass ?? 'stock';
    return assertAssetClass(assetClass);
  }

  getRelatedSymbols(symbol) {
    this.#ensureLoaded();
    const symbolKey = normalizeSymbolId(symbol ?? '');
    const direct = this.config.relatedSymbols[symbolKey];
    if (Array.isArray(direct)) return direct.slice();
    const fallback = this.config.relatedSymbols.default;
    return Array.isArray(fallback) ? fallback.slice() : [];
  }

  getStrategyProfile(symbol) {
    this.#ensureLoaded();
    const symbolConfig = this.getSymbolConfig(symbol);
    return typeof symbolConfig?.strategyProfile === 'string' && symbolConfig.strategyProfile
      ? symbolConfig.strategyProfile
      : 'single_stock';
  }

  getStrategyProfileMap() {
    this.#ensureLoaded();
    const result = {};

    for (const [key, value] of Object.entries(this.config.symbols ?? {})) {
      if (key === 'default') continue;
      if (!value || typeof value !== 'object') continue;
      if (typeof value.strategyProfile !== 'string' || !value.strategyProfile) continue;
      result[normalizeSymbolId(key)] = value.strategyProfile;
    }

    return deepFreeze(result);
  }

  getEnabledSymbols() {
    this.#ensureLoaded();
    return Object.entries(this.config.symbols ?? {})
      .filter(([key]) => key !== 'default')
      .filter(([, value]) => value?.enabled !== false)
      .map(([key]) => normalizeSymbolId(key))
      .sort();
  }

  getAll() {
    this.#ensureLoaded();
    return this.config;
  }

  #readFileConfig() {
    try {
      if (!fs.existsSync(this.configFilePath)) return {};
      const raw = fs.readFileSync(this.configFilePath, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      throw new Error(`Unable to read config file ${this.configFilePath}: ${error.message}`);
    }
  }

  #readEnvConfig() {
    return {
      runtime: {
        mode: this.env.BAPTISTO_RUNTIME_MODE ?? undefined,
        logLevel: this.env.BAPTISTO_LOG_LEVEL ?? undefined,
        loopIntervalMs: this.env.BAPTISTO_RUNTIME_LOOP_INTERVAL_MS ? normalizeNumber(this.env.BAPTISTO_RUNTIME_LOOP_INTERVAL_MS, undefined) : undefined,
        idleIntervalMs: this.env.BAPTISTO_RUNTIME_IDLE_INTERVAL_MS ? normalizeNumber(this.env.BAPTISTO_RUNTIME_IDLE_INTERVAL_MS, undefined) : undefined,
        startupWarmup: normalizeBoolean(this.env.BAPTISTO_RUNTIME_STARTUP_WARMUP, undefined),
        symbols: normalizeStringList(this.env.BAPTISTO_RUNTIME_SYMBOLS, undefined),
      },
      alpaca: {
        enabled: normalizeBoolean(this.env.ALPACA_ENABLED, undefined),
        paper: normalizeBoolean(this.env.ALPACA_PAPER, undefined),
        keyId: this.env.ALPACA_API_KEY ?? this.env.APCA_API_KEY_ID ?? undefined,
        secretKey: this.env.ALPACA_SECRET_KEY ?? this.env.APCA_API_SECRET_KEY ?? undefined,
        brokerUrl: this.env.ALPACA_BROKER_URL ?? undefined,
        dataUrl: this.env.ALPACA_DATA_URL ?? undefined,
        feed: this.env.ALPACA_FEED ?? undefined,
        adjustment: this.env.ALPACA_ADJUSTMENT ?? undefined,
        cryptoLocation: this.env.ALPACA_CRYPTO_LOCATION ?? undefined,
      },
      llm: {
        enabled: normalizeBoolean(this.env.BAPTISTO_LLM_ENABLED, undefined),
        provider: this.env.BAPTISTO_LLM_PROVIDER ?? undefined,
        model: this.env.BAPTISTO_LLM_MODEL ?? undefined,
        baseUrl: this.env.BAPTISTO_LLM_BASE_URL ?? undefined,
        temperature: this.env.BAPTISTO_LLM_TEMPERATURE ? normalizeNumber(this.env.BAPTISTO_LLM_TEMPERATURE, undefined) : undefined,
        timeoutMs: this.env.BAPTISTO_LLM_TIMEOUT_MS ? normalizeNumber(this.env.BAPTISTO_LLM_TIMEOUT_MS, undefined) : undefined,
      },
      news: {
        enabled: normalizeBoolean(this.env.BAPTISTO_NEWS_ENABLED, undefined),
      },
      reports: {
        daily: {
          enabled: normalizeBoolean(this.env.BAPTISTO_DAILY_REPORT_ENABLED, undefined),
        },
      },
      execution: {
        dryRun: normalizeBoolean(this.env.BAPTISTO_EXECUTION_DRY_RUN, undefined),
      },
      telemetry: {
        console: {
          enabled: normalizeBoolean(this.env.BAPTISTO_CONSOLE_LOGS_ENABLED, undefined),
          colors: normalizeBoolean(this.env.BAPTISTO_CONSOLE_LOGS_COLORS, undefined),
        },
      },
      market: {
        timezone: this.env.BAPTISTO_MARKET_TIMEZONE ?? undefined,
        openMinutes: this.env.BAPTISTO_MARKET_OPEN_MINUTES ? normalizeNumber(this.env.BAPTISTO_MARKET_OPEN_MINUTES, undefined) : undefined,
        closeMinutes: this.env.BAPTISTO_MARKET_CLOSE_MINUTES ? normalizeNumber(this.env.BAPTISTO_MARKET_CLOSE_MINUTES, undefined) : undefined,
      },
    };
  }

  #resolveStoragePaths(storageConfig) {
    const resolved = {};
    for (const [key, value] of Object.entries(storageConfig ?? {})) {
      resolved[key] = path.isAbsolute(value) ? value : path.resolve(this.serverRootDir, value);
    }
    return resolved;
  }

  #resolveAlpacaConfig({ mergedConfig = {}, fileConfig = {}, envConfig = {} } = {}) {
    const hasExplicitBrokerUrl = Boolean(fileConfig?.brokerUrl || envConfig?.brokerUrl);
    const hasExplicitDataUrl = Boolean(fileConfig?.dataUrl || envConfig?.dataUrl);
    const paper = mergedConfig?.paper !== false;

    return {
      ...mergedConfig,
      brokerUrl: hasExplicitBrokerUrl
        ? mergedConfig?.brokerUrl
        : paper
          ? 'https://paper-api.alpaca.markets/v2'
          : 'https://api.alpaca.markets/v2',
      dataUrl: hasExplicitDataUrl
        ? mergedConfig?.dataUrl
        : 'https://data.alpaca.markets/v2',
    };
  }

  #ensureLoaded() {
    if (!this.config) throw new Error('ConfigStore.load() must be called before reading config');
  }
}
