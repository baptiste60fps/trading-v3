import dns from 'dns/promises';
import { createRuntime } from '../src/app/createRuntime.mjs';

const parseArgs = (argv) => {
  const args = {
    feeds: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    const [flag, inlineValue] = entry.split('=');
    const value = inlineValue ?? argv[index + 1];

    switch (flag) {
      case '--feeds':
        args.feeds = String(value)
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
        if (inlineValue === undefined) index += 1;
        break;
      default:
        if (entry.startsWith('--')) {
          throw new Error(`Unsupported flag ${flag}`);
        }
    }
  }

  return args;
};

const safeString = (value, fallback = null) => {
  const text = String(value ?? '').trim();
  return text ? text : fallback;
};

const summarizeFeedResult = (result) => ({
  feedId: safeString(result?.feedId),
  status: safeString(result?.status, 'error'),
  source: safeString(result?.source, 'unknown'),
  itemCount: Number.isFinite(Number(result?.itemCount)) ? Number(result.itemCount) : 0,
  error: safeString(result?.error),
  fetchedAtMs: Number.isFinite(Number(result?.fetchedAtMs)) ? Number(result.fetchedAtMs) : null,
});

const resolveHost = async (url) => {
  const host = new URL(url).hostname;

  try {
    const answers = await dns.lookup(host, { all: true });
    return {
      host,
      ok: true,
      addresses: answers.map((entry) => ({
        address: entry.address,
        family: entry.family,
      })),
      error: null,
    };
  } catch (error) {
    return {
      host,
      ok: false,
      addresses: [],
      error: error?.message ?? 'dns_lookup_failed',
    };
  }
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const runtime = await createRuntime();
  const feeds = Array.isArray(runtime.configStore.getNewsConfig()?.feeds)
    ? runtime.configStore.getNewsConfig().feeds
    : [];
  const selectedFeeds = Array.isArray(args.feeds) && args.feeds.length
    ? feeds.filter((feed) => args.feeds.includes(String(feed?.id ?? '').trim()))
    : feeds;

  const results = [];
  for (const feed of selectedFeeds) {
    const dnsResult = await resolveHost(feed.url);
    const networkResult = await runtime.rssFeedService.fetchFeed(feed, { useCache: false });
    const cacheResult = await runtime.rssFeedService.fetchFeed(feed, { useCache: true });

    results.push({
      feedId: safeString(feed.id),
      name: safeString(feed.name),
      url: safeString(feed.url),
      dns: dnsResult,
      network: summarizeFeedResult(networkResult),
      cache: summarizeFeedResult(cacheResult),
      cacheHit: cacheResult?.source === 'cache',
    });
  }

  const payload = {
    type: 'rss_smoke',
    generatedAtMs: Date.now(),
    runtime: runtime.describe(),
    selectedFeedCount: results.length,
    okDnsCount: results.filter((entry) => entry.dns.ok).length,
    okNetworkCount: results.filter((entry) => entry.network.status === 'ok').length,
    cacheHitCount: results.filter((entry) => entry.cacheHit).length,
    feeds: results,
  };

  console.log(JSON.stringify(payload, null, 2));
};

main().catch((error) => {
  console.error('[RSS SMOKE] Failure');
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
