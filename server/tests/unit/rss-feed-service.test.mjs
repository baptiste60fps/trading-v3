import assert from 'assert/strict';
import { parseFeedXml, RssFeedService } from '../../src/services/news/RssFeedService.mjs';

export const register = async ({ test }) => {
  test('RssFeedService parses RSS items and sorts them by publish date', async () => {
    const xml = `<?xml version="1.0"?>
      <rss version="2.0">
        <channel>
          <title>Feed</title>
          <item>
            <title>Older headline</title>
            <link>https://example.com/older</link>
            <pubDate>Mon, 30 Mar 2026 12:00:00 GMT</pubDate>
          </item>
          <item>
            <title><![CDATA[Newer &amp; stronger headline]]></title>
            <link>https://example.com/newer</link>
            <pubDate>Mon, 30 Mar 2026 13:00:00 GMT</pubDate>
            <description>Latest context</description>
          </item>
        </channel>
      </rss>`;

    const parsed = parseFeedXml(xml, {
      feedId: 'demo',
      name: 'Demo Feed',
      url: 'https://example.com/feed.xml',
      maxItemsPerFeed: 5,
    });

    assert.equal(parsed.feedId, 'demo');
    assert.equal(parsed.itemCount, 2);
    assert.equal(parsed.items[0].title, 'Newer & stronger headline');
    assert.equal(parsed.items[0].link, 'https://example.com/newer');
    assert.equal(parsed.items[0].summary, 'Latest context');
    assert.equal(parsed.items[1].title, 'Older headline');
  });

  test('RssFeedService can serve a cached Atom feed result without a network call', async () => {
    const cacheStore = {
      async get(namespace, key) {
        assert.equal(namespace, 'rss_feeds');
        assert.ok(key.includes('atom-demo'));
        return {
          feedId: 'atom-demo',
          name: 'Atom Demo',
          url: 'https://example.com/atom.xml',
          status: 'ok',
          fetchedAtMs: 1,
          itemCount: 1,
          items: [
            {
              title: 'Cached headline',
              link: 'https://example.com/cached',
              publishedAt: '2026-03-30T13:00:00.000Z',
              publishedAtMs: Date.parse('2026-03-30T13:00:00.000Z'),
              summary: 'cached summary',
            },
          ],
        };
      },
      async set() {
        throw new Error('cache should not be written when a valid value already exists');
      },
    };

    const service = new RssFeedService({
      feeds: [],
      cacheStore,
    });

    const result = await service.fetchFeed({
      id: 'atom-demo',
      name: 'Atom Demo',
      url: 'https://example.com/atom.xml',
    });

    assert.equal(result.source, 'cache');
    assert.equal(result.itemCount, 1);
    assert.equal(result.items[0].title, 'Cached headline');
  });
};
