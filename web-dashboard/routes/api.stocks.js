const express = require('express');
const {
    saveStockSnapshot,
    readStockSnapshot,
    refreshStockSnapshot,
    fetchStockNews,
    buildStockNewsQuery,
} = require('../../src/services/StockDashboardSnapshot');
const {
    refreshStockSymbolDirectory,
    searchStockSymbols,
    getDirectory,
} = require('../../src/services/StockSymbolDirectory');

const CACHE_TTL_MS = 45 * 1000;
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_SYMBOLS = 20;

const cache = new Map();

const DEFAULT_SYMBOLS = ['2330.TW', '0050.TW', '2454.TW', 'AAPL', 'NVDA', 'TSM'];

const TW_FALLBACK_NAMES = {
    '2330.TW': { name: '台積電', sector: '半導體' },
    '0050.TW': { name: '元大台灣50', sector: 'ETF' },
    '0056.TW': { name: '元大高股息', sector: 'ETF' },
    '2317.TW': { name: '鴻海', sector: '電子代工' },
    '2454.TW': { name: '聯發科', sector: 'IC 設計' },
    '2303.TW': { name: '聯電', sector: '半導體' },
    '2412.TW': { name: '中華電', sector: '電信' },
    '2881.TW': { name: '富邦金', sector: '金融' },
    '2882.TW': { name: '國泰金', sector: '金融' },
    '2891.TW': { name: '中信金', sector: '金融' },
};
const TAIWAN_SYMBOL_RE = /^\d{4,6}[A-Z]{0,3}$/;
const TAIWAN_YAHOO_SYMBOL_RE = /^\d{4,6}[A-Z]{0,3}\.(TW|TWO)$/;

function createHttpError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function attachCacheMeta(value, meta) {
    if (Array.isArray(value)) {
        const nextValue = value.slice();
        Object.defineProperty(nextValue, '_cache', {
            value: meta,
            enumerable: false,
            configurable: true,
        });
        return nextValue;
    }
    if (value && typeof value === 'object') {
        return { ...value, _cache: meta };
    }
    return value;
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function getCached(key, options = {}) {
    const item = cache.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
        if (options.allowStale) {
            return attachCacheMeta(item.value, { isStale: true, cachedAt: item.cachedAt, expiresAt: item.expiresAt });
        }
        return null;
    }
    return attachCacheMeta(item.value, { isStale: false, cachedAt: item.cachedAt, expiresAt: item.expiresAt });
}

function setCached(key, value, ttlMs = CACHE_TTL_MS) {
    const cachedAt = new Date().toISOString();
    const expiresAt = Date.now() + ttlMs;
    cache.set(key, {
        value,
        cachedAt,
        expiresAt,
    });
    return attachCacheMeta(value, { isStale: false, cachedAt, expiresAt });
}

function toNumber(value, fallback = 0) {
    if (value === null || value === undefined || value === '') return fallback;
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : fallback;
}

function toNullableNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : null;
}

function toPositiveNullableNumber(value) {
    const numericValue = toNullableNumber(value);
    return numericValue && numericValue > 0 ? numericValue : null;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function normalizeSymbol(input) {
    const raw = String(input || '').trim().toUpperCase();
    if (!raw) return '';
    const cleaned = raw.replace(/\s+/g, '');
    if (TAIWAN_SYMBOL_RE.test(cleaned)) return `${cleaned}.TW`;
    if (TAIWAN_YAHOO_SYMBOL_RE.test(cleaned)) return cleaned;
    return cleaned.replace(/[^A-Z0-9.^=-]/g, '').slice(0, 24);
}

function isTaiwanSymbol(symbol) {
    return TAIWAN_YAHOO_SYMBOL_RE.test(symbol) || TAIWAN_SYMBOL_RE.test(symbol);
}

function getDisplaySymbol(symbol) {
    return symbol.replace(/\.(TW|TWO)$/i, '');
}

function inferMarket(symbol) {
    if (/\.(TW|TWO)$/.test(symbol)) return 'tw';
    return 'us';
}

async function fetchJson(url) {
    const response = await fetch(url, {
        headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 GolemDashboard/1.0',
        },
    });
    const text = await response.text();
    let payload = null;
    try {
        payload = text ? JSON.parse(text) : null;
    } catch (error) {
        throw createHttpError(502, `Invalid upstream JSON: ${error.message}`);
    }
    if (!response.ok) {
        const message = payload?.chart?.error?.description || payload?.finance?.error?.description || `Upstream request failed (${response.status})`;
        throw createHttpError(response.status === 404 ? 404 : 502, message);
    }
    return payload;
}

function getQuoteName(symbol, meta) {
    const directory = getDirectory();
    const directoryItem = Array.isArray(directory?.items)
        ? directory.items.find((item) => item.yahooSymbol === symbol || item.symbol === getDisplaySymbol(symbol))
        : null;
    const fallback = TW_FALLBACK_NAMES[symbol];
    if (directoryItem?.name) return directoryItem.name;
    return meta.longName || meta.shortName || fallback?.name || getDisplaySymbol(symbol);
}

function normalizeQuote(symbol, chartResult) {
    const meta = chartResult?.meta || {};
    const timestamps = Array.isArray(chartResult?.timestamp) ? chartResult.timestamp : [];
    const quoteData = chartResult?.indicators?.quote?.[0] || {};
    const closes = Array.isArray(quoteData.close) ? quoteData.close.filter((value) => Number.isFinite(Number(value))).map(Number) : [];
    const volumes = Array.isArray(quoteData.volume) ? quoteData.volume.filter((value) => Number.isFinite(Number(value))).map(Number) : [];
    const price = toNumber(meta.regularMarketPrice, closes[closes.length - 1] || meta.previousClose || 0);
    const previousClose = toNumber(meta.chartPreviousClose ?? meta.previousClose, price);
    const change = price - previousClose;
    const changePercent = previousClose ? (change / previousClose) * 100 : 0;
    const dayHigh = toPositiveNullableNumber(meta.regularMarketDayHigh);
    const dayLow = toPositiveNullableNumber(meta.regularMarketDayLow);
    const fiftyTwoWeekHigh = toPositiveNullableNumber(meta.fiftyTwoWeekHigh);
    const fiftyTwoWeekLow = toPositiveNullableNumber(meta.fiftyTwoWeekLow);
    const volume = toNumber(meta.regularMarketVolume, volumes[volumes.length - 1] || 0);
    const directory = getDirectory();
    const directoryItem = Array.isArray(directory?.items)
        ? directory.items.find((item) => item.yahooSymbol === symbol || item.symbol === getDisplaySymbol(symbol))
        : null;
    const fallback = TW_FALLBACK_NAMES[symbol] || {};

    return {
        symbol: getDisplaySymbol(symbol),
        yahooSymbol: symbol,
        name: getQuoteName(symbol, meta),
        market: inferMarket(symbol),
        currency: meta.currency || (inferMarket(symbol) === 'tw' ? 'TWD' : 'USD'),
        exchangeName: meta.exchangeName || '',
        exchangeTimezoneName: meta.exchangeTimezoneName || '',
        price,
        previousClose,
        open: toPositiveNullableNumber(meta.regularMarketOpen),
        dayHigh,
        dayLow,
        fiftyTwoWeekHigh,
        fiftyTwoWeekLow,
        change,
        changePercent,
        volume,
        turnover: price * volume,
        marketCap: toPositiveNullableNumber(meta.marketCap),
        sector: directoryItem?.sector || fallback.sector || (inferMarket(symbol) === 'tw' ? '台股' : 'US Equity'),
        dataSource: 'Yahoo Finance',
        lastUpdatedAt: meta.regularMarketTime
            ? new Date(Number(meta.regularMarketTime) * 1000).toISOString()
            : new Date().toISOString(),
        hasIntradayData: timestamps.length > 0,
        dataQuality: chartResult?._cache?.isStale ? 'stale-cache' : 'live',
    };
}

function calculateSma(values, period) {
    if (!Array.isArray(values) || values.length < period) return null;
    const slice = values.slice(-period);
    const total = slice.reduce((sum, value) => sum + value, 0);
    return total / period;
}

function calculateRsi(values, period = 14) {
    if (!Array.isArray(values) || values.length <= period) return null;
    const slice = values.slice(-(period + 1));
    let gains = 0;
    let losses = 0;
    for (let i = 1; i < slice.length; i += 1) {
        const diff = slice[i] - slice[i - 1];
        if (diff >= 0) gains += diff;
        else losses += Math.abs(diff);
    }
    const averageGain = gains / period;
    const averageLoss = losses / period;
    if (averageLoss === 0) return 100;
    const rs = averageGain / averageLoss;
    return 100 - (100 / (1 + rs));
}

function calculateEmaSeries(values, period) {
    if (!Array.isArray(values) || values.length === 0) return [];
    const multiplier = 2 / (period + 1);
    const result = [];
    let previous = values[0];
    for (let index = 0; index < values.length; index += 1) {
        const value = values[index];
        if (index === 0) {
            previous = value;
        } else {
            previous = (value - previous) * multiplier + previous;
        }
        result.push(previous);
    }
    return result;
}

function calculateMacd(values) {
    if (!Array.isArray(values) || values.length < 35) {
        return { macd: null, signal: null, histogram: null };
    }
    const ema12 = calculateEmaSeries(values, 12);
    const ema26 = calculateEmaSeries(values, 26);
    const macdSeries = values.map((_, index) => ema12[index] - ema26[index]);
    const signalSeries = calculateEmaSeries(macdSeries, 9);
    const macd = macdSeries[macdSeries.length - 1];
    const signal = signalSeries[signalSeries.length - 1];
    return {
        macd,
        signal,
        histogram: macd - signal,
    };
}

function calculateStochastic(points, period = 9) {
    if (!Array.isArray(points) || points.length < period) {
        return { k: null, d: null };
    }
    const kSeries = [];
    for (let index = period - 1; index < points.length; index += 1) {
        const slice = points.slice(index - period + 1, index + 1);
        const high = Math.max(...slice.map((point) => toNumber(point.high, point.close)));
        const low = Math.min(...slice.map((point) => toNumber(point.low, point.close)));
        const close = toNumber(points[index].close, 0);
        const rawK = high === low ? 50 : ((close - low) / (high - low)) * 100;
        kSeries.push(clamp(rawK, 0, 100));
    }
    const k = kSeries[kSeries.length - 1] ?? null;
    const d = calculateSma(kSeries, 3);
    return { k, d };
}

function calculateVolatility(values) {
    if (!Array.isArray(values) || values.length < 3) return null;
    const returns = [];
    for (let i = 1; i < values.length; i += 1) {
        if (!values[i - 1]) continue;
        returns.push((values[i] - values[i - 1]) / values[i - 1]);
    }
    if (!returns.length) return null;
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance = returns.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / returns.length;
    return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

function calculateMaxDrawdown(values) {
    if (!Array.isArray(values) || values.length < 2) return null;
    let peak = values[0];
    let maxDrawdown = 0;
    for (const value of values) {
        if (value > peak) peak = value;
        if (peak > 0) {
            maxDrawdown = Math.min(maxDrawdown, ((value - peak) / peak) * 100);
        }
    }
    return maxDrawdown;
}

function normalizeHistory(symbol, chartResult) {
    const meta = chartResult?.meta || {};
    const timestamps = Array.isArray(chartResult?.timestamp) ? chartResult.timestamp : [];
    const quoteData = chartResult?.indicators?.quote?.[0] || {};
    const closesRaw = Array.isArray(quoteData.close) ? quoteData.close : [];
    const opensRaw = Array.isArray(quoteData.open) ? quoteData.open : [];
    const highsRaw = Array.isArray(quoteData.high) ? quoteData.high : [];
    const lowsRaw = Array.isArray(quoteData.low) ? quoteData.low : [];
    const volumesRaw = Array.isArray(quoteData.volume) ? quoteData.volume : [];
    const points = [];

    for (let index = 0; index < timestamps.length; index += 1) {
        const isLastPoint = index === timestamps.length - 1;
        const fallbackClose = isLastPoint ? toPositiveNullableNumber(meta.regularMarketPrice) : null;
        const close = toPositiveNullableNumber(closesRaw[index]) ?? fallbackClose;
        if (close === null) continue;
        const open = toPositiveNullableNumber(opensRaw[index]) ?? close;
        const high = toPositiveNullableNumber(highsRaw[index]) ?? Math.max(open, close);
        const low = toPositiveNullableNumber(lowsRaw[index]) ?? Math.min(open, close);
        if (high < Math.max(open, close) || low > Math.min(open, close)) continue;
        points.push({
            time: new Date(Number(timestamps[index]) * 1000).toISOString(),
            price: close,
            close,
            open,
            high,
            low,
            volume: toNumber(volumesRaw[index], 0),
        });
    }

    const closeValues = points.map((point) => point.close);
    const last = closeValues[closeValues.length - 1] || 0;
    const sma5 = calculateSma(closeValues, 5);
    const sma20 = calculateSma(closeValues, 20);
    const macd = calculateMacd(closeValues);
    const stochastic = calculateStochastic(points, 9);
    const latestVolume = points[points.length - 1]?.volume || 0;
    const avgVolume20 = calculateSma(points.map((point) => point.volume || 0), 20);

    return {
        symbol: getDisplaySymbol(symbol),
        yahooSymbol: symbol,
        points,
        dataQuality: chartResult?._cache?.isStale ? 'stale-cache' : 'live',
        indicators: {
            sma5,
            sma20,
            rsi14: calculateRsi(closeValues, 14),
            macd: macd.macd,
            macdSignal: macd.signal,
            macdHistogram: macd.histogram,
            stochasticK: stochastic.k,
            stochasticD: stochastic.d,
            volatility: calculateVolatility(closeValues),
            maxDrawdown: calculateMaxDrawdown(closeValues),
            avgVolume20,
            volumeRatio: avgVolume20 ? latestVolume / avgVolume20 : null,
            distanceToSma20Percent: sma20 && last ? ((last - sma20) / sma20) * 100 : null,
        },
    };
}

async function fetchChart(symbol, range = '1d', interval = '5m') {
    const safeSymbol = normalizeSymbol(symbol);
    if (!safeSymbol) throw createHttpError(400, 'Missing symbol');
    const cacheKey = `chart:${safeSymbol}:${range}:${interval}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(safeSymbol)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=false&events=div%2Csplits`;
    try {
        const payload = await fetchJson(url);
        const result = payload?.chart?.result?.[0];
        if (!result) {
            const message = payload?.chart?.error?.description || `No chart data for ${safeSymbol}`;
            throw createHttpError(404, message);
        }
        return setCached(cacheKey, result);
    } catch (error) {
        const stale = getCached(cacheKey, { allowStale: true });
        if (stale) return stale;
        throw error;
    }
}

async function fetchQuote(symbol) {
    const result = await fetchChart(symbol, '1d', '5m');
    return normalizeQuote(normalizeSymbol(symbol), result);
}

async function searchYahoo(query) {
    const safeQuery = String(query || '').trim();
    if (!safeQuery) return [];
    const cacheKey = `search:${safeQuery.toLowerCase()}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(safeQuery)}&quotesCount=12&newsCount=0`;
    const payload = await fetchJson(url);
    const quotes = Array.isArray(payload?.quotes) ? payload.quotes : [];
    const results = quotes
        .filter((quote) => quote?.symbol && ['EQUITY', 'ETF', 'INDEX'].includes(String(quote.quoteType || '').toUpperCase()))
        .slice(0, 12)
        .map((quote) => ({
            symbol: getDisplaySymbol(String(quote.symbol).toUpperCase()),
            yahooSymbol: String(quote.symbol).toUpperCase(),
            name: quote.longname || quote.shortname || quote.symbol,
            market: inferMarket(String(quote.symbol).toUpperCase()),
            exchange: quote.exchange || quote.exchDisp || '',
            type: quote.quoteType || '',
            dataSource: 'Yahoo Finance',
        }));

    return setCached(cacheKey, results, SEARCH_CACHE_TTL_MS);
}

function searchTaiwanFallback(query) {
    const normalized = String(query || '').trim().toLowerCase();
    if (!normalized) return [];
    return Object.entries(TW_FALLBACK_NAMES)
        .filter(([symbol, info]) => {
            const displaySymbol = getDisplaySymbol(symbol).toLowerCase();
            return displaySymbol.includes(normalized) ||
                String(info.name).toLowerCase().includes(normalized) ||
                String(info.sector).toLowerCase().includes(normalized);
        })
        .map(([symbol, info]) => ({
            symbol: getDisplaySymbol(symbol),
            yahooSymbol: symbol,
            name: info.name,
            market: 'tw',
            exchange: symbol.endsWith('.TWO') ? 'TPEX' : 'TWSE',
            type: 'EQUITY',
            dataSource: 'Local Taiwan symbol list',
        }));
}

module.exports = function registerStockRoutes() {
    const router = express.Router();

    refreshStockSymbolDirectory().catch((error) => {
        console.warn('[Stocks] Initial symbol directory refresh failed:', error.message || error);
    });

    router.get('/api/stocks/quotes', async (req, res) => {
        try {
            const symbolsRaw = String(req.query.symbols || DEFAULT_SYMBOLS.join(','));
            const symbols = symbolsRaw
                .split(',')
                .map(normalizeSymbol)
                .filter(Boolean)
                .slice(0, MAX_SYMBOLS);
            if (!symbols.length) return res.status(400).json({ error: 'No symbols provided' });

            const settled = await Promise.allSettled(symbols.map(fetchQuote));
            const quotes = [];
            const errors = [];
            settled.forEach((result, index) => {
                if (result.status === 'fulfilled') quotes.push(result.value);
                else errors.push({ symbol: symbols[index], error: result.reason?.message || String(result.reason) });
            });

            return res.json({
                success: true,
                quotes,
                errors,
                dataSource: 'Yahoo Finance',
                cacheTtlMs: CACHE_TTL_MS,
                generatedAt: new Date().toISOString(),
            });
        } catch (error) {
            console.error('[Stocks] Failed to fetch quotes:', error);
            return res.status(error.statusCode || 500).json({ error: error.message });
        }
    });

    router.get('/api/stocks/history', async (req, res) => {
        try {
            const symbol = normalizeSymbol(req.query.symbol);
            const range = String(req.query.range || '3mo');
            const interval = String(req.query.interval || (range === '1d' ? '5m' : '1d'));
            const allowedRanges = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y']);
            const allowedIntervals = new Set(['1m', '5m', '15m', '30m', '60m', '1d', '1wk']);
            if (!symbol) return res.status(400).json({ error: 'Missing symbol' });
            if (!allowedRanges.has(range)) return res.status(400).json({ error: 'Unsupported range' });
            if (!allowedIntervals.has(interval)) return res.status(400).json({ error: 'Unsupported interval' });

            const chart = await fetchChart(symbol, range, interval);
            return res.json({
                success: true,
                history: normalizeHistory(symbol, chart),
                dataSource: 'Yahoo Finance',
                cacheTtlMs: CACHE_TTL_MS,
                generatedAt: new Date().toISOString(),
            });
        } catch (error) {
            console.error('[Stocks] Failed to fetch history:', error);
            return res.status(error.statusCode || 500).json({ error: error.message });
        }
    });

    router.get('/api/stocks/search', async (req, res) => {
        try {
            const query = String(req.query.q || '').trim();
            if (!query) return res.json({ success: true, results: [] });
            const normalizedSymbol = normalizeSymbol(query);
            const [directoryResultsRaw, yahooResultsRaw, taiwanFallbackRaw] = await Promise.all([
                searchStockSymbols(query, { limit: 16 }).catch(() => []),
                searchYahoo(query).catch(() => []),
                Promise.resolve(searchTaiwanFallback(query)),
            ]);
            const directoryResults = asArray(directoryResultsRaw);
            const yahooResults = asArray(yahooResultsRaw);
            const taiwanFallback = asArray(taiwanFallbackRaw);
            const directoryMatch = directoryResults.find((item) =>
                item.yahooSymbol === normalizedSymbol ||
                item.symbol === getDisplaySymbol(normalizedSymbol)
            );
            const directTaiwanSymbol = directoryMatch?.yahooSymbol || normalizedSymbol;
            const directTaiwan = isTaiwanSymbol(normalizedSymbol)
                ? [{
                    symbol: getDisplaySymbol(directTaiwanSymbol),
                    yahooSymbol: directTaiwanSymbol,
                    name: directoryMatch?.name ||
                        TW_FALLBACK_NAMES[directTaiwanSymbol]?.name ||
                        getDisplaySymbol(directTaiwanSymbol),
                    market: 'tw',
                    exchange: directTaiwanSymbol.endsWith('.TWO') ? 'TPEX' : 'TWSE',
                    type: directoryMatch?.type || 'EQUITY',
                    dataSource: directoryMatch?.dataSource || 'Taiwan symbol normalizer',
                }]
                : [];
            const unique = new Map();
            [...directTaiwan, ...directoryResults, ...taiwanFallback, ...yahooResults].forEach((item) => {
                if (!item?.yahooSymbol || unique.has(item.yahooSymbol)) return;
                unique.set(item.yahooSymbol, item);
            });

            return res.json({
                success: true,
                results: Array.from(unique.values()).slice(0, 16),
                dataSource: 'Symbol directory + Yahoo Finance fallback',
                generatedAt: new Date().toISOString(),
            });
        } catch (error) {
            console.error('[Stocks] Failed to search symbols:', error);
            return res.status(error.statusCode || 500).json({ error: error.message });
        }
    });

    router.post('/api/stocks/symbols/refresh', async (req, res) => {
        try {
            const directory = await refreshStockSymbolDirectory({ force: req.body?.force === true });
            return res.json({
                success: true,
                generatedAt: directory.generatedAt,
                count: Array.isArray(directory.items) ? directory.items.length : 0,
                sourceStatus: directory.sourceStatus || [],
            });
        } catch (error) {
            console.error('[Stocks] Failed to refresh symbol directory:', error);
            return res.status(error.statusCode || 500).json({ error: error.message });
        }
    });

    router.get('/api/stocks/news', async (req, res) => {
        try {
            const symbol = normalizeSymbol(req.query.symbol);
            if (!symbol) return res.status(400).json({ error: 'Missing symbol' });
            const quote = req.query.name
                ? { symbol, yahooSymbol: symbol, name: String(req.query.name || ''), market: inferMarket(symbol) }
                : null;
            const news = await fetchStockNews(quote || symbol, { limit: 6 });
            return res.json({
                success: true,
                news,
                query: buildStockNewsQuery(quote || symbol),
                generatedAt: new Date().toISOString(),
            });
        } catch (error) {
            console.error('[Stocks] Failed to fetch news:', error);
            return res.status(error.statusCode || 500).json({ error: error.message });
        }
    });

    router.get('/api/stocks/snapshot', (req, res) => {
        try {
            return res.json({
                success: true,
                snapshot: readStockSnapshot(),
            });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    });

    router.post('/api/stocks/snapshot', (req, res) => {
        try {
            const snapshot = saveStockSnapshot(req.body?.snapshot || req.body);
            return res.json({
                success: true,
                snapshot,
            });
        } catch (error) {
            return res.status(400).json({ error: error.message });
        }
    });

    router.post('/api/stocks/snapshot/refresh', async (req, res) => {
        try {
            const snapshot = await refreshStockSnapshot({
                snapshot: req.body?.snapshot,
                symbols: req.body?.symbols,
                selectedSymbol: req.body?.selectedSymbol,
                selectedRange: req.body?.selectedRange,
                marketFilter: req.body?.marketFilter,
                trigger: req.body?.trigger || 'dashboard-refresh',
            });
            return res.json({
                success: true,
                snapshot,
            });
        } catch (error) {
            console.error('[Stocks] Failed to refresh snapshot:', error);
            return res.status(error.statusCode || 500).json({ error: error.message });
        }
    });

    return router;
};
