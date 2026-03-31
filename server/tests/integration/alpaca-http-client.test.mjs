import assert from 'assert/strict';
import path from 'path';
import { loadLocalEnv } from '../../src/config/loadLocalEnv.mjs';
import { AlpacaHttpClient } from '../../src/core/api/AlpacaHttpClient.mjs';

const createClient = () => {
  const serverRootDir = path.resolve(process.cwd());
  const localEnv = loadLocalEnv(serverRootDir);
  const keyId = process.env.ALPACA_API_KEY ?? localEnv.values.ALPACA_API_KEY;
  const secretKey = process.env.ALPACA_SECRET_KEY ?? localEnv.values.ALPACA_SECRET_KEY;

  assert.ok(keyId, 'ALPACA_API_KEY is required for Alpaca integration tests');
  assert.ok(secretKey, 'ALPACA_SECRET_KEY is required for Alpaca integration tests');

  return new AlpacaHttpClient({
    keyId,
    secretKey,
    paper: true,
  });
};

export const register = async ({ test }) => {
  test('AlpacaHttpClient can read broker account state', async () => {
    const client = createClient();
    const account = await client.requestBroker('/account');
    assert.ok(account);
    assert.ok(Number.isFinite(Number(account.cash)));
    assert.ok(Number.isFinite(Number(account.equity)));
  });

  test('AlpacaHttpClient can read latest trade data', async () => {
    const client = createClient();
    const latest = await client.requestData('/stocks/AAPL/trades/latest', {
      query: { feed: 'iex' },
    });

    assert.ok(latest?.trade);
    assert.ok(Number.isFinite(Number(latest.trade.p ?? latest.trade.Price)));
  });
};
