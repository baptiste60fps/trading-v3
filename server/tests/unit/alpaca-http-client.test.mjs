import assert from 'assert/strict';
import { formatAlpacaHttpErrorMessage } from '../../src/core/api/AlpacaHttpClient.mjs';

export const register = async ({ test }) => {
  test('formatAlpacaHttpErrorMessage preserves raw Alpaca 403 details', async () => {
    const message = formatAlpacaHttpErrorMessage({
      message: 'insufficient qty available for order (requested: 7, available: 0)',
      statusCode: 403,
      url: new URL('https://paper-api.alpaca.markets/v2/orders'),
    });

    assert.equal(
      message,
      'Alpaca access forbidden on paper-api.alpaca.markets (403): insufficient qty available for order (requested: 7, available: 0)',
    );
  });
};
