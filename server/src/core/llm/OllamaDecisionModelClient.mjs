import http from 'http';
import https from 'https';
import { DecisionModelClient } from './DecisionModelClient.mjs';

const requestJson = ({ url, method = 'POST', body = null, timeoutMs = 30_000 }) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const payload = body === null ? null : JSON.stringify(body);
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (payload !== null) {
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const request = transport.request(
      target,
      {
        method,
        headers,
        timeout: timeoutMs,
      },
      (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          raw += chunk;
        });
        response.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            if ((response.statusCode ?? 500) >= 400) {
              reject(new Error(parsed?.error ?? `Ollama request failed (${response.statusCode})`));
              return;
            }
            resolve(parsed);
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    request.on('timeout', () => {
      request.destroy(new Error('Ollama request timed out'));
    });
    request.on('error', reject);
    if (payload !== null) request.write(payload);
    request.end();
  });

export class OllamaDecisionModelClient extends DecisionModelClient {
  constructor({
    baseUrl = 'http://127.0.0.1:11434',
    model = 'llama3.1:8b',
    temperature = 0.1,
    timeoutMs = 30_000,
    requestImpl = requestJson,
  } = {}) {
    super();
    this.baseUrl = baseUrl;
    this.model = model;
    this.temperature = temperature;
    this.timeoutMs = timeoutMs;
    this.requestImpl = typeof requestImpl === 'function' ? requestImpl : requestJson;
  }

  async generateDecision({ systemPrompt, userPrompt }) {
    return await this.generateJson({ systemPrompt, userPrompt });
  }

  async checkAvailability({ timeoutMs = Math.min(Math.max(1_000, Number(this.timeoutMs) || 30_000), 5_000) } = {}) {
    try {
      const response = await this.requestImpl({
        url: `${this.baseUrl.replace(/\/$/, '')}/api/tags`,
        method: 'GET',
        timeoutMs,
      });
      const models = Array.isArray(response?.models) ? response.models : [];
      const modelFound = models.some((entry) => String(entry?.name ?? '') === this.model);
      if (!modelFound) {
        return {
          available: false,
          reason: `Ollama model ${this.model} is not available at ${this.baseUrl}`,
        };
      }

      return {
        available: true,
        reason: null,
      };
    } catch (error) {
      return {
        available: false,
        reason: error?.message ?? 'ollama_unreachable',
      };
    }
  }

  async generateJson({ systemPrompt, userPrompt }) {
    const response = await this.requestImpl({
      url: `${this.baseUrl.replace(/\/$/, '')}/api/chat`,
      method: 'POST',
      body: {
        model: this.model,
        stream: false,
        format: 'json',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        options: {
          temperature: this.temperature,
        },
      },
      timeoutMs: this.timeoutMs,
    });

    return response?.message?.content ?? null;
  }
}
