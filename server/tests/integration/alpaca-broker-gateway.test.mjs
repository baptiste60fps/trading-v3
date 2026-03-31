import assert from 'assert/strict';
import path from 'path';
import { loadLocalEnv } from '../../src/config/loadLocalEnv.mjs';
import { AlpacaHttpClient } from '../../src/core/api/AlpacaHttpClient.mjs';
import { AlpacaBrokerGateway } from '../../src/core/api/AlpacaBrokerGateway.mjs';

const createGateway = () => {
  const serverRootDir = path.resolve(process.cwd());
  const localEnv = loadLocalEnv(serverRootDir);
  const keyId = process.env.ALPACA_API_KEY ?? localEnv.values.ALPACA_API_KEY;
  const secretKey = process.env.ALPACA_SECRET_KEY ?? localEnv.values.ALPACA_SECRET_KEY;

  assert.ok(keyId, 'ALPACA_API_KEY is required for Alpaca integration tests');
  assert.ok(secretKey, 'ALPACA_SECRET_KEY is required for Alpaca integration tests');

  return new AlpacaBrokerGateway({
    client: new AlpacaHttpClient({
      keyId,
      secretKey,
      paper: true,
    }),
    paper: true,
  });
};

export const register = async ({ test }) => {
  test('AlpacaBrokerGateway returns account state', async () => {
    const gateway = createGateway();
    const state = await gateway.getAccountState();

    assert.ok(Number.isFinite(state.cash));
    assert.ok(Number.isFinite(state.equity));
  });

  test('AlpacaBrokerGateway can query an open position safely', async () => {
    const gateway = createGateway();
    const position = await gateway.getOpenPosition('AAPL');

    assert.ok(position === null || position.symbol === 'AAPL');
    if (position) {
      assert.equal(position.side, 'long');
      assert.ok(Number.isFinite(position.qty));
    }
  });
};
