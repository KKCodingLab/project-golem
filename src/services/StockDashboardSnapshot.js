const fs = require('fs');
const path = require('path');

const SNAPSHOT_DIR = path.resolve(process.cwd(), 'data', 'dashboard');
const SNAPSHOT_PATH = path.join(SNAPSHOT_DIR, 'stock-dashboard-snapshot.json');
const MAX_SNAPSHOT_BYTES = 700 * 1024;
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_SYMBOLS = ['2330.TW', '0050.TW', '2454.TW', 'AAPL', 'NVDA', 'TSM'];
const US_NEWS_ALIASES = {
    AAPL: ['蘋果', 'Apple'],
    NVDA: ['輝達', 'NVIDIA'],
    TSLA: ['特斯拉', 'Tesla'],
    MSFT: ['微軟', 'Microsoft'],
    AMZN: ['亞馬遜', 'Amazon'],
    META: ['Meta', 'Facebook'],
    GOOGL: ['Google', '谷歌', 'Alphabet'],
    GOOG: ['Google', '谷歌', 'Alphabet'],
    TSM: ['台積電', 'TSMC'],
};
const RANGE_MAP = {
    '1D': { range: '1d', interval: '5m' },
    '1M': { range: '1mo', interval: '1d' },
    '3M': { range: '3mo', interval: '1d' },
    '6M': { range: '6mo', interval: '1d' },
    '1Y': { range: '1y', interval: '1d' },
};
const TAIWAN_SYMBOL_RE = /^\d{4,6}[A-Z]{0,3}$/;
const TAIWAN_YAHOO_SYMBOL_RE = /^\d{4,6}[A-Z]{0,3}\.(TW|TWO)$/;

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

let memorySnapshot = null;

function ensureStorage() {
    if (!fs.existsSync(SNAPSHOT_DIR)) {
        fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    }
}

function trimSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    const cloned = JSON.parse(JSON.stringify(snapshot));
    if (Array.isArray(cloned.watchlist)) cloned.watchlist = cloned.watchlist.slice(0, 30);
    if (Array.isArray(cloned.quoteErrors)) cloned.quoteErrors = cloned.quoteErrors.slice(0, 20);
    return cloned;
}

function saveStockSnapshot(snapshot) {
    const safeSnapshot = trimSnapshot(snapshot);
    if (!safeSnapshot) {
        throw new Error('Invalid stock dashboard snapshot');
    }
    const payload = {
        ...safeSnapshot,
        savedAt: new Date().toISOString(),
    };
    const raw = JSON.stringify(payload, null, 2);
    if (Buffer.byteLength(raw, 'utf8') > MAX_SNAPSHOT_BYTES) {
        throw new Error('Stock dashboard snapshot is too large');
    }
    ensureStorage();
    fs.writeFileSync(SNAPSHOT_PATH, raw, 'utf8');
    memorySnapshot = payload;
    return payload;
}

function readStockSnapshot() {
    if (memorySnapshot) return memorySnapshot;
    try {
        if (!fs.existsSync(SNAPSHOT_PATH)) return null;
        const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        memorySnapshot = parsed;
        return parsed;
    } catch (error) {
        console.warn('[StockSnapshot] Failed to read stock dashboard snapshot:', error.message);
        return null;
    }
}

function createHttpError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
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

function getDisplaySymbol(symbol) {
    return String(symbol || '').replace(/\.(TW|TWO)$/i, '');
}

function inferMarket(symbol) {
    return /\.(TW|TWO)$/.test(symbol) ? 'tw' : 'us';
}

function formatDateForQuery(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function decodeHtml(value) {
    return String(value || '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#x2F;/g, '/')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function resolveDuckDuckGoUrl(value) {
    const raw = decodeHtml(value);
    try {
        const parsed = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
        const uddg = parsed.searchParams.get('uddg');
        if (uddg) return decodeURIComponent(uddg);
        return parsed.toString();
    } catch {
        return raw;
    }
}

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseRssItems(xml, sourceName) {
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    return Array.from(String(xml || '').matchAll(itemRegex)).map((match) => {
        const block = match[1] || '';
        const readTag = (tag) => {
            const tagMatch = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
            return decodeHtml(tagMatch?.[1] || '');
        };
        const publishedAt = readTag('pubDate');
        return {
            title: readTag('title'),
            url: readTag('link'),
            snippet: readTag('description'),
            source: sourceName,
            publishedAt: publishedAt ? new Date(publishedAt).toISOString() : '',
        };
    }).filter((item) => item.title && item.url);
}

function getNewsKeywords(queryInfo) {
    const symbol = String(queryInfo.symbol || '').toUpperCase();
    const name = String(queryInfo.name || '').trim();
    const keywords = [symbol, queryInfo.yahooSymbol, name];
    if (US_NEWS_ALIASES[symbol]) keywords.push(...US_NEWS_ALIASES[symbol]);
    if (name.includes(' ')) keywords.push(...name.split(/\s+/).filter((word) => word.length >= 3));
    return Array.from(new Set(keywords.map((item) => String(item || '').trim()).filter((item) => item.length >= 2)));
}

function isWithinDateWindow(item, queryInfo) {
    if (!item.publishedAt) return true;
    const published = Date.parse(item.publishedAt);
    const since = Date.parse(queryInfo.dateWindow.since);
    const until = Date.parse(queryInfo.dateWindow.until) + 24 * 60 * 60 * 1000;
    if (!Number.isFinite(published)) return true;
    return published >= since && published <= until;
}

function isRelevantNews(item, queryInfo) {
    const haystack = `${item.title || ''} ${item.snippet || ''} ${item.url || ''}`.toLowerCase();
    return getNewsKeywords(queryInfo).some((keyword) => haystack.includes(keyword.toLowerCase()));
}

function dedupeNews(items, limit) {
    const unique = new Map();
    for (const item of items) {
        if (!item?.title || !item?.url) continue;
        const key = item.url.split('?')[0] || item.title;
        if (!unique.has(key)) unique.set(key, item);
    }
    return Array.from(unique.values())
        .sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0))
        .slice(0, limit);
}

function buildStockNewsQuery(quoteOrSymbol, options = {}) {
    const now = options.now instanceof Date ? options.now : new Date();
    const since = options.since instanceof Date ? options.since : new Date(now.getTime() - TWO_WEEKS_MS);
    const until = options.until instanceof Date ? options.until : now;
    const symbol = normalizeSymbol(quoteOrSymbol?.yahooSymbol || quoteOrSymbol?.symbol || quoteOrSymbol);
    const displaySymbol = getDisplaySymbol(symbol);
    const name = String(quoteOrSymbol?.name || TW_FALLBACK_NAMES[symbol]?.name || displaySymbol).trim();
    const market = quoteOrSymbol?.market || inferMarket(symbol);
    const sinceText = formatDateForQuery(since);
    const untilText = formatDateForQuery(until);
    const terms = market === 'tw'
        ? `${displaySymbol} ${name} 股票 新聞 最新`
        : `${displaySymbol} ${name} 股票 新聞 美股 最新`;

    return {
        symbol: displaySymbol,
        yahooSymbol: symbol,
        name,
        market,
        languagePriority: 'zh-TW',
        dateWindow: {
            since: sinceText,
            until: untilText,
            days: Math.round((until.getTime() - since.getTime()) / (24 * 60 * 60 * 1000)),
        },
        query: `${terms} after:${sinceText} before:${untilText}`,
    };
}

async function fetchDuckDuckGoNews(queryInfo, options = {}) {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(queryInfo.query)}&kl=tw-tzh&df=m`;
    const html = await fetchJsonLikeText(url);
    const results = [];
    const anchorRegex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const anchors = Array.from(html.matchAll(anchorRegex));

    for (const [index, linkMatch] of anchors.entries()) {
        const nextAnchorIndex = anchors[index + 1]?.index ?? html.length;
        const block = html.slice(linkMatch.index || 0, nextAnchorIndex);
        const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/);
        const sourceMatch = block.match(/class="result__url"[^>]*>([\s\S]*?)<\/(?:a|span)>/);
        const title = decodeHtml(linkMatch[2]);
        const resultUrl = resolveDuckDuckGoUrl(linkMatch[1]);
        const snippet = decodeHtml(snippetMatch?.[1] || '');
        const source = decodeHtml(sourceMatch?.[1] || '');
        if (!title || !resultUrl) continue;
        results.push({
            title,
            url: resultUrl,
            snippet,
            source: source || 'DuckDuckGo HTML search',
            publishedAt: '',
        });
        if (results.length >= (options.limit || 12)) break;
    }
    return results;
}

async function fetchYahooRssNews(queryInfo) {
    const categories = queryInfo.market === 'tw' ? ['tw-market', 'news'] : ['intl-markets', 'news'];
    const batches = await Promise.all(categories.map(async (category) => {
        const xml = await fetchText(`https://tw.stock.yahoo.com/rss?category=${encodeURIComponent(category)}`, {
            Accept: 'application/rss+xml,text/xml,text/plain',
            Referer: 'https://tw.stock.yahoo.com/',
        });
        return parseRssItems(xml, `Yahoo 股市 RSS ${category}`);
    }));
    const rows = batches.flat().filter((item) => isWithinDateWindow(item, queryInfo));
    const relevant = rows.filter((item) => isRelevantNews(item, queryInfo));
    return relevant.length ? relevant : rows.slice(0, 8);
}

async function fetchYahooFinanceNews(queryInfo) {
    const searchTerms = `${queryInfo.yahooSymbol} ${queryInfo.name}`;
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(searchTerms)}&quotesCount=0&newsCount=12`;
    const payload = await fetchJson(url);
    const rows = Array.isArray(payload?.news) ? payload.news : [];
    return rows.map((item) => ({
        title: decodeHtml(item.title || ''),
        url: item.link || item.url || '',
        snippet: decodeHtml(item.summary || item.publisher || ''),
        source: item.publisher ? `Yahoo Finance · ${item.publisher}` : 'Yahoo Finance news',
        publishedAt: item.providerPublishTime ? new Date(Number(item.providerPublishTime) * 1000).toISOString() : '',
    })).filter((item) => item.title && item.url && isWithinDateWindow(item, queryInfo) && isRelevantNews(item, queryInfo));
}

async function fetchGoogleNewsRss(queryInfo) {
    const terms = queryInfo.market === 'tw'
        ? `${queryInfo.symbol} ${queryInfo.name} 股票 when:14d`
        : `${queryInfo.symbol} ${queryInfo.name} stock 股票 when:14d`;
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(terms)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
    const xml = await fetchText(url, {
        Accept: 'application/rss+xml,text/xml,text/plain',
        Referer: 'https://news.google.com/',
    });
    return parseRssItems(xml, 'Google News RSS')
        .filter((item) => isWithinDateWindow(item, queryInfo) && isRelevantNews(item, queryInfo));
}

async function fetchStockNews(quoteOrSymbol, options = {}) {
    const queryInfo = buildStockNewsQuery(quoteOrSymbol, options);
    if (!queryInfo.yahooSymbol) throw createHttpError(400, 'Missing symbol for news search');
    const limit = options.limit || 12;
    const sourceStatus = [];
    const jobs = [
        ['Yahoo 股市 RSS', () => fetchYahooRssNews(queryInfo)],
        ['Yahoo Finance news', () => fetchYahooFinanceNews(queryInfo)],
        ['Google News RSS', () => fetchGoogleNewsRss(queryInfo)],
        ['DuckDuckGo HTML search', () => fetchDuckDuckGoNews(queryInfo, { limit })],
    ];
    const collected = [];
    for (const [source, job] of jobs) {
        try {
            const rows = await job();
            collected.push(...rows);
            sourceStatus.push({ source, status: 'ok', count: rows.length });
        } catch (error) {
            sourceStatus.push({ source, status: 'error', error: error.message || String(error) });
        }
    }

    return {
        ...queryInfo,
        source: sourceStatus.map((item) => item.source).join(' + '),
        sourceStatus,
        fetchedAt: new Date().toISOString(),
        results: dedupeNews(collected, limit),
    };
}

async function fetchText(url, extraHeaders = {}) {
    const response = await fetch(url, {
        headers: {
            'Accept': 'text/html,application/xhtml+xml,text/plain',
            'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.7,en;q=0.6',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 GolemDashboard/1.0',
            ...extraHeaders,
        },
    });
    const text = await response.text();
    if (!response.ok) {
        throw createHttpError(response.status === 404 ? 404 : 502, `Text request failed (${response.status})`);
    }
    return text;
}

async function fetchJsonLikeText(url) {
    return fetchText(url, {
        Accept: 'text/html,application/xhtml+xml',
        Referer: 'https://html.duckduckgo.com/',
    });
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

async function fetchChart(symbol, range = '1d', interval = '5m') {
    const safeSymbol = normalizeSymbol(symbol);
    if (!safeSymbol) throw createHttpError(400, 'Missing symbol');
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(safeSymbol)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=false&events=div%2Csplits`;
    const payload = await fetchJson(url);
    const result = payload?.chart?.result?.[0];
    if (!result) {
        const message = payload?.chart?.error?.description || `No chart data for ${safeSymbol}`;
        throw createHttpError(404, message);
    }
    return result;
}

function getQuoteName(symbol, meta) {
    const fallback = TW_FALLBACK_NAMES[symbol];
    return meta.longName || meta.shortName || fallback?.name || getDisplaySymbol(symbol);
}

function normalizeQuote(symbol, chartResult) {
    const meta = chartResult?.meta || {};
    const quoteData = chartResult?.indicators?.quote?.[0] || {};
    const closes = Array.isArray(quoteData.close) ? quoteData.close.filter((value) => Number.isFinite(Number(value))).map(Number) : [];
    const volumes = Array.isArray(quoteData.volume) ? quoteData.volume.filter((value) => Number.isFinite(Number(value))).map(Number) : [];
    const price = toNumber(meta.regularMarketPrice, closes[closes.length - 1] || meta.previousClose || 0);
    const previousClose = toNumber(meta.chartPreviousClose ?? meta.previousClose, price);
    const change = price - previousClose;
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
        dayHigh: toPositiveNullableNumber(meta.regularMarketDayHigh),
        dayLow: toPositiveNullableNumber(meta.regularMarketDayLow),
        fiftyTwoWeekHigh: toPositiveNullableNumber(meta.fiftyTwoWeekHigh),
        fiftyTwoWeekLow: toPositiveNullableNumber(meta.fiftyTwoWeekLow),
        change,
        changePercent: previousClose ? (change / previousClose) * 100 : 0,
        volume: toNumber(meta.regularMarketVolume, volumes[volumes.length - 1] || 0),
        turnover: price * toNumber(meta.regularMarketVolume, volumes[volumes.length - 1] || 0),
        marketCap: toPositiveNullableNumber(meta.marketCap),
        sector: fallback.sector || (inferMarket(symbol) === 'tw' ? '台股' : 'US Equity'),
        dataSource: 'Yahoo Finance',
        lastUpdatedAt: meta.regularMarketTime
            ? new Date(Number(meta.regularMarketTime) * 1000).toISOString()
            : new Date().toISOString(),
        hasIntradayData: Array.isArray(chartResult?.timestamp) && chartResult.timestamp.length > 0,
        dataQuality: 'live',
    };
}

function calculateSma(values, period) {
    if (!Array.isArray(values) || values.length < period) return null;
    const slice = values.slice(-period);
    return slice.reduce((sum, value) => sum + value, 0) / period;
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
    let previous = values[0];
    return values.map((value, index) => {
        previous = index === 0 ? value : (value - previous) * multiplier + previous;
        return previous;
    });
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
    return { macd, signal, histogram: macd - signal };
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
    return { k: kSeries[kSeries.length - 1] ?? null, d: calculateSma(kSeries, 3) };
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
        if (peak > 0) maxDrawdown = Math.min(maxDrawdown, ((value - peak) / peak) * 100);
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
            close,
            open,
            high,
            low,
            volume: toNumber(volumesRaw[index], 0),
        });
    }

    const closeValues = points.map((point) => point.close);
    const last = closeValues[closeValues.length - 1] || 0;
    const sma20 = calculateSma(closeValues, 20);
    const macd = calculateMacd(closeValues);
    const stochastic = calculateStochastic(points, 9);
    const latestVolume = points[points.length - 1]?.volume || 0;
    const avgVolume20 = calculateSma(points.map((point) => point.volume || 0), 20);

    return {
        symbol: getDisplaySymbol(symbol),
        yahooSymbol: symbol,
        indicators: {
            sma5: calculateSma(closeValues, 5),
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

function getSymbolsForRefresh(snapshot, overrideSymbols) {
    const rawSymbols = Array.isArray(overrideSymbols) && overrideSymbols.length
        ? overrideSymbols
        : Array.isArray(snapshot?.watchlist)
            ? snapshot.watchlist.map((quote) => quote?.yahooSymbol || quote?.symbol)
            : DEFAULT_SYMBOLS;
    return Array.from(new Set(rawSymbols.map(normalizeSymbol).filter(Boolean))).slice(0, 20);
}

function calculateBreadth(quotes) {
    const source = Array.isArray(quotes) ? quotes : [];
    const advancers = source.filter((quote) => quote.change > 0).length;
    const decliners = source.filter((quote) => quote.change < 0).length;
    const averageMove = source.reduce((sum, quote) => sum + quote.changePercent, 0) / Math.max(1, source.length);
    const totalTurnover = source.reduce((sum, quote) => sum + quote.turnover, 0);
    return { advancers, decliners, averageMove, totalTurnover, count: source.length };
}

async function refreshStockSnapshot(options = {}) {
    const previous = options.snapshot || readStockSnapshot() || {};
    const symbols = getSymbolsForRefresh(previous, options.symbols);
    const selectedSymbol = normalizeSymbol(options.selectedSymbol || previous?.selected?.yahooSymbol || previous?.selected?.symbol || symbols[0]);
    const selectedRange = options.selectedRange || previous.selectedRange || '3M';
    const marketFilter = options.marketFilter || previous.marketFilter || 'all';
    const rangeConfig = RANGE_MAP[selectedRange] || RANGE_MAP['3M'];

    const settled = await Promise.allSettled(symbols.map(async (symbol) => normalizeQuote(symbol, await fetchChart(symbol, '1d', '5m'))));
    const quotes = [];
    const quoteErrors = [];
    settled.forEach((result, index) => {
        if (result.status === 'fulfilled') quotes.push(result.value);
        else quoteErrors.push({ symbol: symbols[index], error: result.reason?.message || String(result.reason) });
    });
    if (!quotes.length) {
        throw createHttpError(502, 'Unable to refresh any stock quote from Yahoo Finance');
    }

    let indicators = previous.indicators || null;
    let news = previous.news || null;
    const historyErrors = [];
    try {
        const history = normalizeHistory(selectedSymbol, await fetchChart(selectedSymbol, rangeConfig.range, rangeConfig.interval));
        indicators = history.indicators;
    } catch (error) {
        historyErrors.push({ symbol: selectedSymbol, error: error.message || String(error) });
    }

    const visibleQuotes = quotes.filter((quote) => marketFilter === 'all' || quote.market === marketFilter);
    const selected = quotes.find((quote) => quote.yahooSymbol === selectedSymbol) || quotes[0] || previous.selected || null;
    if (selected && options.includeNews !== false) {
        try {
            news = await fetchStockNews(selected, { limit: 6 });
        } catch (error) {
            historyErrors.push({ symbol: selectedSymbol, error: `news: ${error.message || String(error)}` });
        }
    }
    return saveStockSnapshot({
        source: 'dashboard-stock-analysis',
        dataStatus: quoteErrors.length || historyErrors.length ? 'partial-live-market-data' : 'live-market-data',
        marketFilter,
        selectedRange,
        selected,
        indicators,
        news,
        watchlist: visibleQuotes.length ? visibleQuotes : quotes,
        breadth: calculateBreadth(visibleQuotes.length ? visibleQuotes : quotes),
        quoteErrors: [...quoteErrors, ...historyErrors],
        generatedAt: new Date().toISOString(),
        refresh: {
            trigger: options.trigger || 'server-refresh',
            status: quoteErrors.length || historyErrors.length ? 'partial' : 'ok',
            previousSavedAt: previous.savedAt || null,
        },
    });
}

function buildStockSnapshotInjection(snapshot = readStockSnapshot()) {
    if (!snapshot) {
        return [
            '[Dashboard Stock Snapshot]',
            '目前沒有可用的股市看板快照。請先開啟 Dashboard 的「股市分析」頁，等待行情載入後再要求分析。',
        ].join('\n');
    }

    return [
        '[Dashboard Stock Snapshot]',
        '以下是 Dashboard「股市分析」頁最近同步的結構化看板資料。請以此為主要資料來源，並說明資料時間與限制。',
        JSON.stringify(snapshot, null, 2),
    ].join('\n');
}

async function buildFreshStockSnapshotInjection(options = {}) {
    try {
        return buildStockSnapshotInjection(await refreshStockSnapshot({
            ...options,
            trigger: options.trigger || 'ai-command',
        }));
    } catch (error) {
        const snapshot = readStockSnapshot();
        const fallbackNotice = [
            '[Dashboard Stock Snapshot Refresh Warning]',
            `刷新 Yahoo Finance 即時資料失敗：${error.message || String(error)}`,
            snapshot ? '以下改用 Dashboard 最近保存的快照，請清楚提醒使用者資料可能不是最新。' : '目前也沒有可用的舊快照。',
        ].join('\n');
        return `${fallbackNotice}\n\n${buildStockSnapshotInjection(snapshot)}`;
    }
}

module.exports = {
    SNAPSHOT_PATH,
    saveStockSnapshot,
    readStockSnapshot,
    refreshStockSnapshot,
    fetchStockNews,
    buildStockNewsQuery,
    buildStockSnapshotInjection,
    buildFreshStockSnapshotInjection,
};
