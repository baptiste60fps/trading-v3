import assert from 'assert/strict';
import { AlpacaBrokerGateway } from '../../src/core/api/AlpacaBrokerGateway.mjs';

class FakeClient {
  constructor({ responder = null } = {}) {
    this.calls = [];
    this.responder = responder;
  }

  async requestBroker(path, options = {}) {
    this.calls.push({ path, options });
    if (this.responder) return await this.responder(path, options);
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
      qty: '8',
      order_class: 'oto',
      stop_loss: {
        stop_price: '98.00',
      },
    });
  });

  test('AlpacaBrokerGateway rounds broker-protected stock quantities down to whole shares', async () => {
    const client = new FakeClient();
    const gateway = new AlpacaBrokerGateway({ client, paper: true });

    const result = await gateway.submit({
      symbol: 'AAPL',
      action: 'open_long',
      qty: 8.75,
      referencePrice: 100,
      stopLossPct: 0.02,
    });

    assert.equal(result.accepted, true);
    assert.equal(client.calls[0].options.body.qty, '8');
    assert.equal(client.calls[0].options.body.time_in_force, 'gtc');
    assert.equal(client.calls[0].options.body.order_class, 'oto');
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

  test('AlpacaBrokerGateway cancels open protective stop orders before closing a position', async () => {
    const client = new FakeClient({
      responder(path, options) {
        if (path === '/orders' && (!options.method || options.method === 'GET')) {
          return [
            {
              id: 'stop-aapl',
              symbol: 'AAPL',
              status: 'new',
              side: 'sell',
              type: 'stop',
              position_intent: 'sell_to_close',
              stop_price: '243.43',
            },
            {
              id: 'limit-aapl',
              symbol: 'AAPL',
              status: 'new',
              side: 'buy',
              type: 'limit',
            },
            {
              id: 'stop-msft',
              symbol: 'MSFT',
              status: 'new',
              side: 'sell',
              type: 'stop',
              position_intent: 'sell_to_close',
              stop_price: '390.00',
            },
          ];
        }

        if (path === '/orders/stop-aapl' && options.method === 'DELETE') {
          return {};
        }

        if (path === '/positions/AAPL' && options.method === 'DELETE') {
          return {
            id: 'close-1',
            status: 'closed',
            filled_qty: '7',
            filled_avg_price: '258.50',
          };
        }

        throw new Error(`Unexpected broker call ${path}`);
      },
    });
    const gateway = new AlpacaBrokerGateway({ client, paper: true });

    const result = await gateway.close('AAPL');

    assert.equal(result.accepted, true);
    assert.deepEqual(
      client.calls.map((entry) => [entry.path, entry.options.method ?? 'GET']),
      [
        ['/orders', 'GET'],
        ['/orders/stop-aapl', 'DELETE'],
        ['/positions/AAPL', 'DELETE'],
      ],
    );
  });

  test('AlpacaBrokerGateway aborts position close when protective stop cancellation fails', async () => {
    const client = new FakeClient({
      responder(path, options) {
        if (path === '/orders' && (!options.method || options.method === 'GET')) {
          return [
            {
              id: 'stop-aapl',
              symbol: 'AAPL',
              status: 'new',
              side: 'sell',
              type: 'stop',
              position_intent: 'sell_to_close',
              stop_price: '243.43',
            },
          ];
        }

        if (path === '/orders/stop-aapl' && options.method === 'DELETE') {
          const error = new Error('cannot cancel order while it is pending');
          error.statusCode = 403;
          throw error;
        }

        throw new Error(`Unexpected broker call ${path}`);
      },
    });
    const gateway = new AlpacaBrokerGateway({ client, paper: true });

    const result = await gateway.close('AAPL');

    assert.equal(result.accepted, false);
    assert.equal(result.status, 'rejected');
    assert.equal(result.error.message, 'cannot cancel order while it is pending');
    assert.equal(client.calls.some((entry) => entry.path === '/positions/AAPL'), false);
  });

  test('AlpacaBrokerGateway closes crypto positions using the compact Alpaca broker symbol', async () => {
    const client = new FakeClient({
      responder(path, options) {
        if (path === '/orders' && (!options.method || options.method === 'GET')) {
          return [];
        }

        if (path === '/positions/BTCUSD' && options.method === 'DELETE') {
          return {
            id: 'close-btc',
            status: 'closed',
            filled_qty: '0.02',
            filled_avg_price: '73123.50',
          };
        }

        throw new Error(`Unexpected broker call ${path}`);
      },
    });
    const gateway = new AlpacaBrokerGateway({ client, paper: true });

    const result = await gateway.close('BTC/USD');

    assert.equal(result.accepted, true);
    assert.deepEqual(
      client.calls.map((entry) => [entry.path, entry.options.method ?? 'GET']),
      [
        ['/orders', 'GET'],
        ['/positions/BTCUSD', 'DELETE'],
      ],
    );
  });

  test('AlpacaBrokerGateway falls back to the encoded slash symbol when compact crypto close path is not found', async () => {
    const client = new FakeClient({
      responder(path, options) {
        if (path === '/orders' && (!options.method || options.method === 'GET')) {
          return [];
        }

        if (path === '/positions/BTCUSD' && options.method === 'DELETE') {
          const error = new Error('not found');
          error.statusCode = 404;
          throw error;
        }

        if (path === '/positions/BTC%2FUSD' && options.method === 'DELETE') {
          return {
            id: 'close-btc-fallback',
            status: 'closed',
            filled_qty: '0.02',
            filled_avg_price: '73123.50',
          };
        }

        throw new Error(`Unexpected broker call ${path}`);
      },
    });
    const gateway = new AlpacaBrokerGateway({ client, paper: true });

    const result = await gateway.close('BTC/USD');

    assert.equal(result.accepted, true);
    assert.deepEqual(
      client.calls.map((entry) => [entry.path, entry.options.method ?? 'GET']),
      [
        ['/orders', 'GET'],
        ['/positions/BTCUSD', 'DELETE'],
        ['/positions/BTC%2FUSD', 'DELETE'],
      ],
    );
  });

  test('AlpacaBrokerGateway leaves openedAtMs null when broker positions do not expose an open timestamp', async () => {
    const client = new FakeClient({
      responder(path) {
        if (path === '/positions') {
          return [
            {
              symbol: 'ETHUSD',
              qty: '0.4',
              avg_entry_price: '2124.82',
              current_price: '2238.75',
              market_value: '895.50',
              unrealized_pl: '45.20',
            },
          ];
        }

        throw new Error(`Unexpected broker call ${path}`);
      },
    });
    const gateway = new AlpacaBrokerGateway({ client, paper: true });

    const positions = await gateway.getOpenPositions();

    assert.equal(positions.length, 1);
    assert.equal(positions[0].symbol, 'ETH/USD');
    assert.equal(positions[0].openedAtMs, null);
  });
};
