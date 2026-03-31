import assert from 'assert/strict';
import path from 'path';
import { loadLocalEnv } from '../../src/config/loadLocalEnv.mjs';
import { AlpacaHttpClient } from '../../src/core/api/AlpacaHttpClient.mjs';
import { AlpacaBrokerGateway } from '../../src/core/api/AlpacaBrokerGateway.mjs';
import { PortfolioService } from '../../src/services/portfolio/PortfolioService.mjs';

const createService = () => {
  const serverRootDir = path.resolve(process.cwd());
  const localEnv = loadLocalEnv(serverRootDir);
  const keyId = process.env.ALPACA_API_KEY ?? localEnv.values.ALPACA_API_KEY;
  const secretKey = process.env.ALPACA_SECRET_KEY ?? localEnv.values.ALPACA_SECRET_KEY;

  assert.ok(keyId, 'ALPACA_API_KEY is required for Alpaca integration tests');
  assert.ok(secretKey, 'ALPACA_SECRET_KEY is required for Alpaca integration tests');

  return new PortfolioService({
    brokerGateway: new AlpacaBrokerGateway({
      client: new AlpacaHttpClient({
        keyId,
        secretKey,
        paper: true,
      }),
      paper: true,
    }),
    configStore: {
      getSymbolConfig() {
        return {
          risk: {
            maxPositionPct: 0.05,
            maxPortfolioExposurePct: 0.5,
          },
        };
      },
    },
  });
};

export const register = async ({ test }) => {
  test('PortfolioService returns a real Alpaca snapshot', async () => {
    const service = createService();
    const snapshot = await service.getSnapshot();

    assert.ok(Number.isFinite(snapshot.cash));
    assert.ok(Number.isFinite(snapshot.equity));
    assert.ok(Array.isArray(snapshot.positions));
    assert.ok(Number.isFinite(snapshot.exposurePct));
  });

  test('PortfolioService computes a safe opening allowance', async () => {
    const service = createService();
    const allowance = await service.canOpenLong('AAPL', 500);

    assert.equal(typeof allowance.allowed, 'boolean');
    assert.ok(Number.isFinite(allowance.adjustedNotional));
  });
};
