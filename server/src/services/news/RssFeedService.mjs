import http from 'http';
import https from 'https';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 3;

const sanitizeText = (value) =>
  String(value ?? '')
    .replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

const extractTagValue = (block, tagNames = []) => {
  for (const tagName of tagNames) {
    const pattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i');
    const match = block.match(pattern);
    if (match?.[1]) return sanitizeText(match[1]);
  }

  return null;
};

const extractAtomLink = (block) => {
  const candidates = [...block.matchAll(/<link\b([^>]*)\/?>/gi)];
  for (const [, rawAttributes] of candidates) {
    const attributes = String(rawAttributes ?? '');
    const hrefMatch = attributes.match(/\bhref="([^"]+)"/i) ?? attributes.match(/\bhref='([^']+)'/i);
    if (!hrefMatch?.[1]) continue;
    const relMatch = attributes.match(/\brel="([^"]+)"/i) ?? attributes.match(/\brel='([^']+)'/i);
    const rel = String(relMatch?.[1] ?? 'alternate').toLowerCase();
    if (rel === 'alternate' || rel === '') return hrefMatch[1].trim();
  }

  return null;
};

const parsePublishedAt = (value) => {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return {
    publishedAtMs: parsed,
    publishedAt: new Date(parsed).toISOString(),
  };
};

const parseItemBlock = (block, index) => {
  const title = extractTagValue(block, ['title']);
  const link = extractTagValue(block, ['link']) ?? extractAtomLink(block);
  const summary = extractTagValue(block, ['description', 'summary', 'content']);
  const guid = extractTagValue(block, ['guid', 'id']);
  const published = parsePublishedAt(extractTagValue(block, ['pubDate', 'published', 'updated']));

  return {
    id: guid ?? link ?? `entry-${index}`,
    title,
    link,
    summary,
    publishedAt: published?.publishedAt ?? null,
    publishedAtMs: published?.publishedAtMs ?? null,
  };
};

const extractBlocks = (xml) => {
  const rssBlocks = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((match) => match[1]);
  if (rssBlocks.length) return rssBlocks;
  return [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map((match) => match[1]);
};

export const parseFeedXml = (xml, { feedId = null, name = null, url = null, maxItemsPerFeed = 8 } = {}) => {
  const blocks = extractBlocks(String(xml ?? ''));
  const items = blocks
    .map((block, index) => parseItemBlock(block, index))
    .filter((entry) => entry.title || entry.link)
    .sort((left, right) => (right.publishedAtMs ?? 0) - (left.publishedAtMs ?? 0))
    .slice(0, Math.max(1, Number(maxItemsPerFeed) || 8));

  return {
    feedId,
    name,
    url,
    status: 'ok',
    fetchedAtMs: Date.now(),
    itemCount: items.length,
    items,
    error: null,
  };
};

const requestText = (url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, redirectCount = 0 } = {}) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;

    const request = transport.request(
      target,
      {
        method: 'GET',
        headers: {
          Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1',
          ...headers,
        },
        timeout: timeoutMs,
      },
      (response) => {
        const statusCode = response.statusCode ?? 500;
        if ([301, 302, 307, 308].includes(statusCode)) {
          const nextLocation = response.headers.location;
          if (!nextLocation) {
            reject(new Error(`RSS redirect without location (${statusCode})`));
            return;
          }
          if (redirectCount >= DEFAULT_MAX_REDIRECTS) {
            reject(new Error(`RSS redirect limit reached for ${url}`));
            return;
          }
          const resolvedLocation = new URL(nextLocation, target).toString();
          resolve(requestText(resolvedLocation, { timeoutMs, headers, redirectCount: redirectCount + 1 }));
          return;
        }

        if (statusCode >= 400) {
          reject(new Error(`RSS request failed (${statusCode}) for ${url}`));
          return;
        }

        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          raw += chunk;
        });
        response.on('end', () => {
          resolve(raw);
        });
      },
    );

    request.on('timeout', () => {
      request.destroy(new Error(`RSS request timed out for ${url}`));
    });
    request.on('error', reject);
    request.end();
  });

export class RssFeedService {
  constructor({
    feeds = [],
    enabled = true,
    cacheStore = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cacheTtlMs = 15 * 60 * 1000,
    maxItemsPerFeed = 8,
    userAgent = 'baptisto-trading-v3/0.1',
  } = {}) {
    this.feeds = Array.isArray(feeds) ? feeds.slice() : [];
    this.enabled = enabled !== false;
    this.cacheStore = cacheStore;
    this.timeoutMs = timeoutMs;
    this.cacheTtlMs = cacheTtlMs;
    this.maxItemsPerFeed = maxItemsPerFeed;
    this.userAgent = userAgent;
  }

  async fetchAll({ maxItemsPerFeed = this.maxItemsPerFeed, useCache = true } = {}) {
    if (!this.enabled) return [];

    const results = [];
    for (const feed of this.feeds) {
      results.push(await this.fetchFeed(feed, { maxItemsPerFeed, useCache }));
    }
    return results;
  }

  async fetchFeed(feed, { maxItemsPerFeed = this.maxItemsPerFeed, useCache = true } = {}) {
    const feedId = String(feed?.id ?? '').trim();
    const name = String(feed?.name ?? feedId).trim() || null;
    const url = String(feed?.url ?? '').trim();
    if (!feedId || !url) {
      return {
        feedId: feedId || null,
        name,
        url: url || null,
        status: 'error',
        fetchedAtMs: Date.now(),
        itemCount: 0,
        items: [],
        error: 'invalid_feed_config',
      };
    }

    const cacheKey = `${feedId}:${url}:${Number(maxItemsPerFeed) || this.maxItemsPerFeed}`;
    if (useCache && this.cacheStore) {
      const cached = await this.cacheStore.get('rss_feeds', cacheKey);
      if (cached) {
        return {
          ...cached,
          source: 'cache',
        };
      }
    }

    try {
      const xml = await requestText(url, {
        timeoutMs: Number(feed?.timeoutMs) || this.timeoutMs,
        headers: {
          'User-Agent': this.userAgent,
        },
      });
      const parsed = parseFeedXml(xml, {
        feedId,
        name,
        url,
        maxItemsPerFeed,
      });
      const payload = {
        ...parsed,
        source: 'network',
      };
      if (this.cacheStore) {
        await this.cacheStore.set('rss_feeds', cacheKey, payload, Number(feed?.cacheTtlMs) || this.cacheTtlMs);
      }
      return payload;
    } catch (error) {
      return {
        feedId,
        name,
        url,
        status: 'error',
        fetchedAtMs: Date.now(),
        itemCount: 0,
        items: [],
        error: error?.message ?? 'rss_fetch_failed',
        source: 'network',
      };
    }
  }
}
