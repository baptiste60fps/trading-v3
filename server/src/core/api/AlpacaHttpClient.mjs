import http from 'http';
import https from 'https';

const jsonHeaders = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

const makeError = (message, extra = {}) => {
  const error = new Error(message);
  Object.assign(error, extra);
  return error;
};

const sleep = (delayMs) => new Promise((resolve) => {
  setTimeout(resolve, delayMs);
});

const buildHttpErrorMessage = ({ message, statusCode, url }) => {
  const text = String(message ?? '').trim();
  const host = url?.host ?? 'alpaca';
  if (statusCode === 401) {
    return `Alpaca auth failed on ${host} (401). Verify API key/secret and that ALPACA_PAPER matches the account environment.`;
  }
  if (statusCode === 403) {
    return `Alpaca access forbidden on ${host} (403). Verify account permissions and endpoint configuration.`;
  }
  return text || `Alpaca request failed (${statusCode})`;
};

export class AlpacaHttpClient {
  constructor({
    keyId,
    secretKey,
    brokerUrl,
    dataUrl,
    paper = true,
    maxRetries = 4,
    retryBaseDelayMs = 750,
    retryMaxDelayMs = 5_000,
  } = {}) {
    this.keyId = keyId ?? null;
    this.secretKey = secretKey ?? null;
    this.paper = paper !== false;
    this.brokerUrl = brokerUrl ?? 'https://paper-api.alpaca.markets/v2';
    this.dataUrl = dataUrl ?? 'https://data.alpaca.markets/v2';
    this.maxRetries = Number.isFinite(Number(maxRetries)) ? Number(maxRetries) : 4;
    this.retryBaseDelayMs = Number.isFinite(Number(retryBaseDelayMs)) ? Number(retryBaseDelayMs) : 750;
    this.retryMaxDelayMs = Number.isFinite(Number(retryMaxDelayMs)) ? Number(retryMaxDelayMs) : 5_000;
  }

  hasCredentials() {
    return Boolean(this.keyId && this.secretKey);
  }

  async requestData(pathname, options = {}) {
    return this.#request(this.dataUrl, pathname, options);
  }

  async requestBroker(pathname, options = {}) {
    return this.#request(this.brokerUrl, pathname, options);
  }

  async #request(baseUrl, pathname, { method = 'GET', query = null, body = null } = {}) {
    if (!this.hasCredentials()) {
      throw makeError('Missing Alpaca credentials', {
        category: 'auth',
        statusCode: 401,
      });
    }

    const normalizedPath = String(pathname ?? '').startsWith('/') ? String(pathname).slice(1) : String(pathname ?? '');
    const url = new URL(normalizedPath, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    if (query && typeof query === 'object') {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        url.searchParams.set(key, String(value));
      }
    }

    const headers = {
      ...jsonHeaders,
      'APCA-API-KEY-ID': this.keyId,
      'APCA-API-SECRET-KEY': this.secretKey,
    };

    const payload = body === null ? null : JSON.stringify(body);
    if (payload !== null) headers['Content-Length'] = Buffer.byteLength(payload);

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.#rawRequest(url, {
          method,
          headers,
          body: payload,
        });

        const parsed = this.#safeParseJson(response.body);
        if (response.statusCode >= 400) {
          if (this.#shouldRetryStatus(response.statusCode) && attempt < this.maxRetries) {
            await sleep(this.#computeRetryDelay(attempt, response.headers?.['retry-after']));
            continue;
          }

          const rawMessage = parsed?.message ?? parsed?.error ?? '';

          throw makeError(buildHttpErrorMessage({
            message: rawMessage,
            statusCode: response.statusCode,
            url,
          }), {
            statusCode: response.statusCode,
            code: parsed?.code ?? null,
            category: this.#classifyError(rawMessage, response.statusCode),
            details: parsed,
          });
        }

        return parsed;
      } catch (error) {
        if (this.#shouldRetryError(error) && attempt < this.maxRetries) {
          await sleep(this.#computeRetryDelay(attempt));
          continue;
        }

        throw error;
      }
    }

    throw makeError('Alpaca request exhausted retries', {
      category: 'rate_limit',
      statusCode: 429,
    });
  }

  #classifyError(message, statusCode) {
    const text = String(message ?? '').toLowerCase();
    if (statusCode === 401 || text.includes('unauthorized')) return 'auth';
    if (statusCode === 403 || text.includes('forbidden')) return 'permission';
    if (statusCode === 429 || text.includes('too many requests') || text.includes('rate limit')) return 'rate_limit';
    if (text.includes('buying power') || text.includes('insufficient')) return 'funding';
    if (text.includes('tradable') || text.includes('asset')) return 'asset';
    return 'unknown';
  }

  #shouldRetryStatus(statusCode) {
    return statusCode === 429 || statusCode >= 500;
  }

  #shouldRetryError(error) {
    if (!error) return false;
    const code = String(error.code ?? '').toUpperCase();
    return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code);
  }

  #computeRetryDelay(attempt, retryAfterHeader = null) {
    const retryAfterSeconds = Number(Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : retryAfterHeader);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
      return Math.min(retryAfterSeconds * 1_000, this.retryMaxDelayMs);
    }

    const exponentialDelay = this.retryBaseDelayMs * 2 ** attempt;
    return Math.min(exponentialDelay, this.retryMaxDelayMs);
  }

  #safeParseJson(raw) {
    try {
      return JSON.parse(raw);
    } catch {
      return { raw };
    }
  }

  #rawRequest(url, options) {
    const transport = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const request = transport.request(
        url,
        {
          method: options.method ?? 'GET',
          headers: options.headers ?? {},
        },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            body += chunk;
          });
          response.on('end', () => {
            resolve({
              statusCode: response.statusCode ?? 500,
              headers: response.headers,
              body,
            });
          });
        },
      );

      request.on('error', reject);
      if (options.body) request.write(options.body);
      request.end();
    });
  }
}
