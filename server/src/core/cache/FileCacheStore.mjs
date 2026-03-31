import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

const sanitizeNamespace = (value) => String(value ?? 'generic').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-');
const serializeKey = (value) => createHash('sha1').update(String(value)).digest('hex');

export class FileCacheStore {
  constructor({ rootDir, defaultTtlMs = 24 * 60 * 60 * 1000 } = {}) {
    this.rootDir = rootDir ?? path.resolve(process.cwd(), 'storage/cache');
    this.defaultTtlMs = defaultTtlMs;
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  async get(namespace, key) {
    const filePath = this.#getPath(namespace, key);
    if (!fs.existsSync(filePath)) return null;

    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (raw.expiresAt !== null && Date.now() > raw.expiresAt) {
        fs.unlinkSync(filePath);
        return null;
      }
      return raw.value ?? null;
    } catch {
      return null;
    }
  }

  async set(namespace, key, value, ttlMs = this.defaultTtlMs) {
    const filePath = this.#getPath(namespace, key);
    const expiresAt = Number.isFinite(ttlMs) && ttlMs > 0 ? Date.now() + ttlMs : null;
    const payload = {
      namespace: sanitizeNamespace(namespace),
      key: serializeKey(key),
      savedAt: Date.now(),
      expiresAt,
      value,
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  }

  async has(namespace, key) {
    return (await this.get(namespace, key)) !== null;
  }

  async delete(namespace, key) {
    const filePath = this.#getPath(namespace, key);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  #getPath(namespace, key) {
    const dir = path.resolve(this.rootDir, sanitizeNamespace(namespace));
    fs.mkdirSync(dir, { recursive: true });
    return path.resolve(dir, `${serializeKey(key)}.json`);
  }
}
