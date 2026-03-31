import http from 'http';
import https from 'https';
import { DecisionModelClient } from './DecisionModelClient.mjs';

const requestJson = (url, body, timeoutMs = 30_000) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);

    const request = transport.request(
      target,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
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
    request.write(payload);
    request.end();
  });

export class OllamaDecisionModelClient extends DecisionModelClient {
  constructor({
    baseUrl = 'http://127.0.0.1:11434',
    model = 'llama3.1:8b',
    temperature = 0.1,
    timeoutMs = 30_000,
  } = {}) {
    super();
    this.baseUrl = baseUrl;
    this.model = model;
    this.temperature = temperature;
    this.timeoutMs = timeoutMs;
  }

  async generateDecision({ systemPrompt, userPrompt }) {
    return await this.generateJson({ systemPrompt, userPrompt });
  }

  async generateJson({ systemPrompt, userPrompt }) {
    const response = await requestJson(
      `${this.baseUrl.replace(/\/$/, '')}/api/chat`,
      {
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
      this.timeoutMs,
    );

    return response?.message?.content ?? null;
  }
}
