const SYMBOLS = [
  'DC',
  'GOOG',
  'IBM',
  'SOFI',
  'NVDA',
  'AMZN',
  'LLY',
  'TTWO',
  'PLTR',
  'GOOGL',
  'AVGO',
  'MSFT',
  'AZO',
  'VZ',
  'HD'
];
const START_DATE = '2026-01-01';
const INTERVAL = '1day';
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

function jsonResponse(payload, { status = 200, ttl = DEFAULT_TTL_SECONDS } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=0, s-maxage=${ttl}`
    }
  });
}

function parseTtl(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTL_SECONDS;
  return Math.floor(parsed);
}

function normalizeSeries(values) {
  return values
    .map((item) => {
      const rawDate = item?.datetime || item?.date;
      const close = Number(item?.close);
      if (!rawDate || !Number.isFinite(close)) return null;
      return {
        date: rawDate.slice(0, 10),
        close
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchSeries(symbol, apiKey) {
  const url = new URL('https://api.twelvedata.com/time_series');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', INTERVAL);
  url.searchParams.set('start_date', START_DATE);
  url.searchParams.set('apikey', apiKey);
  url.searchParams.set('format', 'JSON');

  const response = await fetch(url.toString());
  const payload = await response.json();
  if (payload?.status === 'error') {
    return { symbol, error: payload?.message || 'Request failed' };
  }
  const values = Array.isArray(payload?.values) ? payload.values : [];
  return { symbol, series: normalizeSeries(values) };
}

export async function onRequestGet({ env, request, context }) {
  const apiKey = env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    return jsonResponse({ error: 'Missing TWELVE_DATA_API_KEY.' }, { status: 500, ttl: 60 });
  }

  const ttl = parseTtl(env.CACHE_TTL_SECONDS);
  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }

  const results = await Promise.all(
    SYMBOLS.map((symbol) => fetchSeries(symbol, apiKey))
  );

  const series = {};
  const errors = {};
  results.forEach((result) => {
    if (result.error) {
      errors[result.symbol] = result.error;
    } else {
      series[result.symbol] = result.series;
    }
  });

  const payload = {
    fetchedAt: new Date().toISOString(),
    startDate: START_DATE,
    interval: INTERVAL,
    symbols: SYMBOLS,
    series,
    errors
  };

  const response = jsonResponse(payload, { ttl });
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
