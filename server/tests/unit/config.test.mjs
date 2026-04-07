import assert from 'assert/strict';
import path from 'path';
import { ConfigStore } from '../../src/config/ConfigStore.mjs';
import { makeServerRootFixture } from '../helpers/fixtures.mjs';

export const register = async ({ test }) => {
  test('ConfigStore merges file and env with env priority', async () => {
    const rootDir = makeServerRootFixture({
      runtimeConfig: {
        runtime: { mode: 'paper' },
        relatedSymbols: { AAPL: ['QQQ', 'XLK'] },
      },
    });

    const store = new ConfigStore({
      serverRootDir: rootDir,
      env: {
        BAPTISTO_RUNTIME_MODE: 'backtest',
        ALPACA_PAPER: 'false',
      },
    });
    await store.load();

    assert.equal(store.getRuntimeConfig().mode, 'backtest');
    assert.equal(store.getAlpacaConfig().paper, false);
    assert.equal(store.getAlpacaConfig().brokerUrl, 'https://api.alpaca.markets/v2');
    assert.deepEqual(store.getRelatedSymbols('AAPL'), ['QQQ', 'XLK']);
    assert.ok(path.isAbsolute(store.getStorageConfig().cacheDir));
  });

  test('ConfigStore preserves an explicit Alpaca broker URL override', async () => {
    const rootDir = makeServerRootFixture({
      runtimeConfig: {
        alpaca: {
          brokerUrl: 'https://custom-broker.example/v2',
        },
      },
    });

    const store = new ConfigStore({
      serverRootDir: rootDir,
      env: {
        ALPACA_PAPER: 'false',
      },
    });
    await store.load();

    assert.equal(store.getAlpacaConfig().brokerUrl, 'https://custom-broker.example/v2');
  });

  test('ConfigStore resolves symbol-specific config on top of default config', async () => {
    const rootDir = makeServerRootFixture({
      runtimeConfig: {
        symbols: {
          default: {
            enabled: true,
            strategy: 'llm_long_v1',
            risk: {
              maxPositionPct: 0.05,
              maxPortfolioExposurePct: 0.5,
            },
          },
          AAPL: {
            strategy: 'llm_long_aapl',
            risk: {
              maxPositionPct: 0.08,
            },
          },
        },
      },
    });

    const store = new ConfigStore({
      serverRootDir: rootDir,
      env: {},
    });
    await store.load();

    const symbolConfig = store.getSymbolConfig('AAPL');
    assert.equal(symbolConfig.strategy, 'llm_long_aapl');
    assert.equal(symbolConfig.risk.maxPositionPct, 0.08);
    assert.equal(symbolConfig.risk.maxPortfolioExposurePct, 0.5);
  });

  test('ConfigStore exposes enabled symbols and strategy profile mapping', async () => {
    const rootDir = makeServerRootFixture({
      runtimeConfig: {
        symbols: {
          default: {
            enabled: true,
            strategyProfile: 'single_stock',
          },
          AAPL: {
            enabled: true,
            strategyProfile: 'single_stock_quality',
          },
          NVDA: {
            enabled: true,
            strategyProfile: 'high_beta_stock',
          },
          TSLA: {
            enabled: false,
            strategyProfile: 'high_beta_stock',
          },
          SPY: {
            enabled: true,
            strategyProfile: 'index_etf',
          },
        },
      },
    });

    const store = new ConfigStore({
      serverRootDir: rootDir,
      env: {},
    });
    await store.load();

    assert.equal(store.getStrategyProfile('AAPL'), 'single_stock_quality');
    assert.equal(store.getStrategyProfile('MSFT'), 'single_stock');
    assert.deepEqual(store.getStrategyProfileMap(), {
      AAPL: 'single_stock_quality',
      NVDA: 'high_beta_stock',
      SPY: 'index_etf',
      TSLA: 'high_beta_stock',
    });
    assert.deepEqual(store.getEnabledSymbols(), ['AAPL', 'NVDA', 'SPY']);
  });

  test('ConfigStore supports crypto symbols and asset classes', async () => {
    const rootDir = makeServerRootFixture({
      runtimeConfig: {
        symbols: {
          default: {
            enabled: true,
            assetClass: 'stock',
            strategyProfile: 'single_stock',
          },
          'BTC/USD': {
            enabled: true,
            assetClass: 'crypto',
            strategyProfile: 'high_beta_stock',
            brokerProtection: {
              enabled: false,
            },
          },
        },
        relatedSymbols: {
          'BTC/USD': ['ETH/USD'],
        },
      },
    });

    const store = new ConfigStore({
      serverRootDir: rootDir,
      env: {},
    });
    await store.load();

    assert.equal(store.getAssetClass('BTC/USD'), 'crypto');
    assert.equal(store.getSymbolConfig('BTC/USD').brokerProtection.enabled, false);
    assert.deepEqual(store.getRelatedSymbols('BTC/USD'), ['ETH/USD']);
    assert.deepEqual(store.getEnabledSymbols(), ['BTC/USD']);
  });
};
