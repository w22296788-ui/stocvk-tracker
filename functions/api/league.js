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
const OUTPUT_SIZE = '400';
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_BATCH_SIZE = 8;
const DEFAULT_BATCH_DELAY_SECONDS = 70;
const MEMORY_CACHE = {
  expiresAt: 0,
  payload: null
};

function jsonResponse(payload, { status = 200, ttl = DEFAULT_TTL_SECONDS } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=0, s-maxage=${ttl}`
    }
  });
}

function errorResponse(message, { status = 500, ttl = 60, details } = {}) {
  const payload = { error: message };
  if (details) {
    payload.details = details;
  }
  return jsonResponse(payload, { status, ttl });
}

function parseTtl(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTL_SECONDS;
  return Math.floor(parsed);
}

function parseBatchSize(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BATCH_SIZE;
  return Math.floor(parsed);
}

function parseDelaySeconds(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BATCH_DELAY_SECONDS;
  return Math.floor(parsed);
}

function withCacheMeta(payload, ttlSeconds) {
  const fetchedAt = payload.fetchedAt || new Date().toISOString();
  const fetchedAtMs = Date.parse(fetchedAt);
  const baseMs = Number.isFinite(fetchedAtMs) ? fetchedAtMs : Date.now();
  const expiresAtMs = baseMs + ttlSeconds * 1000;
  return {
    ...payload,
    fetchedAt,
    cacheTtlSeconds: ttlSeconds,
    cacheExpiresAt: new Date(expiresAtMs).toISOString()
  };
}

function parseIsoMs(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isNextFetchDue(payload, nowMs) {
  const nextFetchMs = parseIsoMs(payload?.nextFetchAfter);
  if (!nextFetchMs) return false;
  return nowMs >= nextFetchMs;
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

function buildError(message, { code, status } = {}) {
  return { message, code, status };
}

async function fetchSeries(symbol, apiKey, endDate) {
  try {
    const url = new URL('https://api.twelvedata.com/time_series');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', INTERVAL);
    url.searchParams.set('start_date', START_DATE);
    url.searchParams.set('end_date', endDate);
    url.searchParams.set('outputsize', OUTPUT_SIZE);
    url.searchParams.set('apikey', apiKey);
    url.searchParams.set('format', 'JSON');

    const response = await fetch(url.toString());
    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      payload = null;
    }
    if (!response.ok) {
      const message = payload?.message || `Upstream error (${response.status})`;
      return {
        symbol,
        error: buildError(message, { code: payload?.code, status: response.status })
      };
    }
    if (payload?.status === 'error') {
      return {
        symbol,
        error: buildError(payload?.message || 'Request failed', {
          code: payload?.code,
          status: response.status
        })
      };
    }
    const values = Array.isArray(payload?.values) ? payload.values : [];
    if (!values.length) {
      return { symbol, error: buildError('No data returned') };
    }
    return { symbol, series: normalizeSeries(values) };
  } catch (error) {
    return {
      symbol,
      error: buildError('Upstream fetch failed', { status: 500 })
    };
  }
}

export async function onRequestGet({ env, request, context }) {
  try {
    const apiKey = env.TWELVE_DATA_API_KEY;
    if (!apiKey) {
      return errorResponse('Missing TWELVE_DATA_API_KEY.', {
        status: 500,
        ttl: 60,
        details: 'Set this in Cloudflare Pages → Settings → Environment variables.'
      });
    }

    const ttl = parseTtl(env.CACHE_TTL_SECONDS);
    const batchSize = parseBatchSize(env.MAX_SYMBOLS_PER_REQUEST);
    const batchDelaySeconds = parseDelaySeconds(env.BATCH_DELAY_SECONDS);
    const nowMs = Date.now();
    const endDate = new Date().toISOString().slice(0, 10);
    const cache = typeof caches === 'undefined' ? null : caches.default;
    const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
    let basePayload = null;

    if (endDate < START_DATE) {
      const payload = {
        fetchedAt: new Date().toISOString(),
        cycleStartedAt: new Date().toISOString(),
        startDate: START_DATE,
        endDate,
        interval: INTERVAL,
        provider: 'twelvedata',
        symbols: SYMBOLS,
        fetchedSymbols: [],
        remainingSymbols: SYMBOLS,
        partial: false,
        nextFetchAfter: null,
        batchSize,
        series: {},
        errors: {},
        notice: `Season starts ${START_DATE}. No data available yet.`
      };
      const responsePayload = withCacheMeta(payload, ttl);
      const response = jsonResponse(responsePayload, { ttl });
      MEMORY_CACHE.payload = responsePayload;
      MEMORY_CACHE.expiresAt = Date.now() + ttl * 1000;
      if (cache && context?.waitUntil) {
        context.waitUntil(cache.put(cacheKey, response.clone()));
      }
      return response;
    }

    if (MEMORY_CACHE.payload && nowMs < MEMORY_CACHE.expiresAt) {
      if (!MEMORY_CACHE.payload.partial || !isNextFetchDue(MEMORY_CACHE.payload, nowMs)) {
        const remaining = Math.max(1, Math.floor((MEMORY_CACHE.expiresAt - nowMs) / 1000));
        return jsonResponse(MEMORY_CACHE.payload, { ttl: remaining });
      }
      basePayload = MEMORY_CACHE.payload;
    }
    if (!basePayload && cache) {
      const cached = await cache.match(cacheKey);
      if (cached) {
        let cachedPayload = null;
        try {
          cachedPayload = await cached.clone().json();
        } catch (error) {
          cachedPayload = null;
        }
        if (cachedPayload && (!cachedPayload.partial || !isNextFetchDue(cachedPayload, nowMs))) {
          return cached;
        }
        if (cachedPayload) {
          basePayload = cachedPayload;
        }
      }
    }

    let series = {};
    let errors = {};
    let remainingSymbols = SYMBOLS.slice();
    let cycleStartedAt = new Date().toISOString();

    if (basePayload?.partial) {
      series = { ...(basePayload.series || {}) };
      errors = { ...(basePayload.errors || {}) };
      remainingSymbols = Array.isArray(basePayload.remainingSymbols) && basePayload.remainingSymbols.length
        ? basePayload.remainingSymbols.slice()
        : SYMBOLS.filter((symbol) => !series[symbol] && !errors[symbol]);
      cycleStartedAt = basePayload.cycleStartedAt || basePayload.fetchedAt || cycleStartedAt;
    }

    const batch = remainingSymbols.slice(0, batchSize);
    const results = await Promise.all(
      batch.map((symbol) => fetchSeries(symbol, apiKey, endDate))
    );

    results.forEach((result) => {
      if (result.error) {
        errors[result.symbol] = result.error;
      } else {
        series[result.symbol] = result.series;
      }
    });

    const noDataMessage = 'No data is available on the specified dates';
    const noDataOnly = results.length
      && Object.keys(series).length === 0
      && results.every((result) => {
        const message = typeof result.error === 'string'
          ? result.error
          : result.error?.message;
        return message && message.includes(noDataMessage);
      });

    let updatedRemaining = SYMBOLS.filter((symbol) => !series[symbol] && !errors[symbol]);
    if (noDataOnly) {
      errors = {};
      updatedRemaining = [];
    }
    const partial = updatedRemaining.length > 0;
    const nextFetchAfter = partial
      ? new Date(nowMs + batchDelaySeconds * 1000).toISOString()
      : null;

    const payload = {
      fetchedAt: new Date().toISOString(),
      cycleStartedAt,
      startDate: START_DATE,
      endDate,
      interval: INTERVAL,
      provider: 'twelvedata',
      symbols: SYMBOLS,
      fetchedSymbols: results.map((result) => result.symbol),
      remainingSymbols: updatedRemaining,
      partial,
      nextFetchAfter,
      batchSize,
      series,
      errors,
      notice: noDataOnly
        ? `No trading data available yet for ${START_DATE}–${endDate}.`
        : null
    };

    const allFailed = Object.keys(series).length === 0 && Object.keys(errors).length === SYMBOLS.length;
    const nextFetchMs = partial ? parseIsoMs(nextFetchAfter) : null;
    const responseTtl = allFailed
      ? 60
      : partial && nextFetchMs
        ? Math.max(60, Math.ceil((nextFetchMs - nowMs) / 1000))
        : ttl;
    const responsePayload = withCacheMeta(payload, responseTtl);
    const response = jsonResponse(responsePayload, { ttl: responseTtl });

    MEMORY_CACHE.payload = responsePayload;
    MEMORY_CACHE.expiresAt = Date.now() + responseTtl * 1000;
    if (cache && context?.waitUntil) {
      context.waitUntil(cache.put(cacheKey, response.clone()));
    }
    return response;
  } catch (error) {
    return errorResponse('Server error while fetching data.', {
      status: 500,
      ttl: 60,
      details: error?.message
    });
  }
}
