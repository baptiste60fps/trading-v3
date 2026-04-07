import assert from 'assert/strict';
import { AlpacaBrokerGateway } from '../../src/core/api/AlpacaBrokerGateway.mjs';

class FakeClient {
  constructor() {
    this.calls = [];
  }

  async requestBroker(path, options = {}) {
    this.calls.push({ path, options });
    return {
      id: 'order-1',
      status: 'accepted',
      filled_qty: null,
      filled_avg_price: null,
    };
  }
}

export const register = async ({ test }) => {
  test('AlpacaBrokerGateway submits a plain market order without broker-side stop loss', async () => {
    const client = new FakeClient();
    const gateway = new AlpacaBrokerGateway({ client, paper: true });

    const result = await gateway.submit({
      symbol: 'AAPL',
      action: 'open_long',
      notional: 800,
    });

    assert.equal(result.accepted, true);
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].path, '/orders');
    assert.equal(client.calls[0].options.method, 'POST');
    assert.deepEqual(client.calls[0].options.body, {
      symbol: 'AAPL',
      side: 'buy',
      type: 'market',
      time_in_force: 'day',
      notional: '800.00',
    });
  });

  test('AlpacaBrokerGateway submits an OTO market order with a simple stop loss', async () => {
    const client = new FakeClient();
    const gateway = new AlpacaBrokerGateway({ client, paper: true });

    const result = await gateway.submit({
      symbol: 'AAPL',
      action: 'open_long',
      qty: 8,
      referencePrice: 100,
      stopLossPct: 0.02,
    });

    assert.equal(result.accepted, true);
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].path, '/orders');
    assert.equal(client.calls[0].options.method, 'POST');
    assert.deepEqual(client.calls[0].options.body, {
      symbol: 'AAPL',
      side: 'buy',
      type: 'market',
      time_in_force: 'gtc',
      qty: '8.000000',
      order_class: 'oto',
      stop_loss: {
        stop_price: '98.00',
      },
    });
  });

  test('AlpacaBrokerGateway rejects a broker-side stop loss without reference price', async () => {
    const client = new FakeClient();
    const gateway = new AlpacaBrokerGateway({ client, paper: true });

    await assert.rejects(
      gateway.submit({
        symbol: 'AAPL',
        action: 'open_long',
        qty: 8,
        stopLossPct: 0.02,
      }),
      /referencePrice/,
    );
    assert.equal(client.calls.length, 0);
  });

  test('AlpacaBrokerGateway submits crypto market orders with gtc and no advanced stop wrapper', async () => {
    const client = new FakeClient();
    const gateway = new AlpacaBrokerGateway({ client, paper: true });

    const result = await gateway.submit({
      symbol: 'BTC/USD',
      assetClass: 'crypto',
      action: 'open_long',
      notional: 500,
    });

    assert.equal(result.accepted, true);
    assert.deepEqual(client.calls[0].options.body, {
      symbol: 'BTC/USD',
      side: 'buy',
      type: 'market',
      time_in_force: 'gtc',
      notional: '500.00',
    });
  });

  test('AlpacaBrokerGateway rejects broker-side stop loss for crypto market orders', async () => {
    const client = new FakeClient();
    const gateway = new AlpacaBrokerGateway({ client, paper: true });

    await assert.rejects(
      gateway.submit({
        symbol: 'BTC/USD',
        assetClass: 'crypto',
        action: 'open_long',
        qty: 0.01,
        referencePrice: 90000,
        stopLossPct: 0.03,
      }),
      /do not support broker-side simple stop loss/i,
    );
    assert.equal(client.calls.length, 0);
  });
};
