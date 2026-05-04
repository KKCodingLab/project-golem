const fs = require('fs');
const path = require('path');

const DIRECTORY_DIR = path.resolve(process.cwd(), 'data', 'dashboard');
const DIRECTORY_PATH = path.join(DIRECTORY_DIR, 'stock-symbol-directory.json');
const REFRESH_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12_000;

const SOURCES = {
    TWSE_LISTED: 'https://mopsfin.twse.com.tw/opendata/t187ap03_L.csv',
    TPEX_OTC: 'https://mopsfin.twse.com.tw/opendata/t187ap03_O.csv',
    NASDAQ_LISTED: 'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt',
    NASDAQ_OTHER: 'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt',
    FINMIND_TAIWAN: 'https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInfo',
};

const SEED_SYMBOLS = [
    { symbol: '2330', yahooSymbol: '2330.TW', name: '台積電', market: 'tw', exchange: 'TWSE', type: 'EQUITY', sector: '半導體', source: 'Seed fallback' },
    { symbol: '0050', yahooSymbol: '0050.TW', name: '元大台灣50', market: 'tw', exchange: 'TWSE', type: 'ETF', sector: 'ETF', source: 'Seed fallback' },
    { symbol: '0056', yahooSymbol: '0056.TW', name: '元大高股息', market: 'tw', exchange: 'TWSE', type: 'ETF', sector: 'ETF', source: 'Seed fallback' },
    { symbol: '2317', yahooSymbol: '2317.TW', name: '鴻海', market: 'tw', exchange: 'TWSE', type: 'EQUITY', sector: '電子代工', source: 'Seed fallback' },
    { symbol: '2454', yahooSymbol: '2454.TW', name: '聯發科', market: 'tw', exchange: 'TWSE', type: 'EQUITY', sector: 'IC 設計', source: 'Seed fallback' },
    { symbol: 'AAPL', yahooSymbol: 'AAPL', name: 'Apple Inc.', market: 'us', exchange: 'NASDAQ', type: 'EQUITY', sector: '', source: 'Seed fallback' },
    { symbol: 'NVDA', yahooSymbol: 'NVDA', name: 'NVIDIA Corporation', market: 'us', exchange: 'NASDAQ', type: 'EQUITY', sector: '', source: 'Seed fallback' },
    { symbol: 'TSM', yahooSymbol: 'TSM', name: 'Taiwan Semiconductor Manufacturing Company Limited', market: 'us', exchange: 'NYSE', type: 'ADR', sector: '', source: 'Seed fallback' },
];

const TAIWAN_SYMBOL_RE = /^\d{4,6}[A-Z]{0,3}$/;

const TAIWAN_INDUSTRY_NAMES = {
    '01': '水泥工業',
    '02': '食品工業',
    '03': '塑膠工業',
    '04': '紡織纖維',
    '05': '電機機械',
    '06': '電器電纜',
    '08': '玻璃陶瓷',
    '09': '造紙工業',
    '10': '鋼鐵工業',
    '11': '橡膠工業',
    '12': '汽車工業',
    '14': '建材營造',
    '15': '航運業',
    '16': '觀光事業',
    '17': '金融保險',
    '18': '貿易百貨',
    '20': '其他',
    '21': '化學工業',
    '22': '生技醫療',
    '23': '油電燃氣',
    '24': '半導體業',
    '25': '電腦及週邊設備',
    '26': '光電業',
    '27': '通信網路業',
    '28': '電子零組件',
    '29': '電子通路',
    '30': '資訊服務',
    '31': '其他電子',
    '32': '文化創意',
    '33': '農業科技',
    '34': '電子商務',
    '35': '綠能環保',
    '36': '數位雲端',
    '37': '運動休閒',
    '38': '居家生活',
};

let memoryDirectory = null;
let refreshPromise = null;

function ensureDirectory() {
    if (!fs.existsSync(DIRECTORY_DIR)) {
        fs.mkdirSync(DIRECTORY_DIR, { recursive: true });
    }
}

function normalizeText(value) {
    return String(value || '').trim();
}

function stripBom(value) {
    return String(value || '').replace(/^\uFEFF/, '');
}

function normalizeSymbol(input) {
    return String(input || '').trim().toUpperCase().replace(/\s+/g, '');
}

function inferTaiwanYahooSymbol(symbol, exchange) {
    const safeSymbol = normalizeSymbol(symbol);
    if (!TAIWAN_SYMBOL_RE.test(safeSymbol)) return safeSymbol;
    return exchange === 'TPEX' ? `${safeSymbol}.TWO` : `${safeSymbol}.TW`;
}

function normalizeDirectoryItem(item) {
    const symbol = normalizeSymbol(item.symbol);
    const yahooSymbol = normalizeSymbol(item.yahooSymbol || symbol);
    const name = normalizeText(item.name);
    if (!symbol || !yahooSymbol || !name) return null;
    return {
        symbol,
        yahooSymbol,
        name,
        market: item.market === 'tw' ? 'tw' : 'us',
        exchange: normalizeText(item.exchange),
        type: normalizeText(item.type || 'EQUITY'),
        sector: normalizeText(item.sector),
        source: normalizeText(item.source),
    };
}

function normalizeTaiwanIndustry(value) {
    const raw = normalizeText(value).replace('－', '');
    return TAIWAN_INDUSTRY_NAMES[raw] || raw;
}

function dedupeItems(items) {
    const map = new Map();
    for (const item of items) {
        const normalized = normalizeDirectoryItem(item);
        if (!normalized) continue;
        const existing = map.get(normalized.yahooSymbol);
        if (!existing || existing.source === 'Seed fallback') {
            map.set(normalized.yahooSymbol, normalized);
        }
    }
    return Array.from(map.values()).sort((a, b) => a.yahooSymbol.localeCompare(b.yahooSymbol));
}

async function fetchText(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const response = await fetch(url, {
        signal: controller.signal,
        headers: {
            'Accept': 'text/plain,text/csv,application/json',
            'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.7,en;q=0.6',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 GolemDashboard/1.0',
        },
    }).finally(() => clearTimeout(timeout));
    try {
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`Fetch failed ${response.status}: ${url}`);
        }
        return text;
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error(`Fetch timed out: ${url}`);
        }
        throw error;
    }
}

function parseCsvLine(line) {
    const cells = [];
    let current = '';
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (char === '"') {
            if (quoted && line[index + 1] === '"') {
                current += '"';
                index += 1;
            } else {
                quoted = !quoted;
            }
        } else if (char === ',' && !quoted) {
            cells.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    cells.push(current);
    return cells.map((cell) => stripBom(cell).trim());
}

function parseCsv(text) {
    const lines = String(text || '').split(/\r?\n/).filter((line) => line.trim());
    if (!lines.length) return [];
    const headers = parseCsvLine(lines[0]);
    return lines.slice(1).map((line) => {
        const cells = parseCsvLine(line);
        const row = {};
        headers.forEach((header, index) => {
            row[header] = cells[index] || '';
        });
        return row;
    });
}

function parseTwCompanyCsv(text, exchange) {
    return parseCsv(text)
        .map((row) => {
            const symbol = normalizeSymbol(row['公司代號']);
            const companyName = normalizeText(row['公司簡稱'] || row['公司名稱']);
            if (!symbol || !companyName) return null;
            return {
                symbol,
                yahooSymbol: inferTaiwanYahooSymbol(symbol, exchange),
                name: companyName,
                market: 'tw',
                exchange,
                type: /^\d{4}$/.test(symbol) ? 'EQUITY' : 'ETF',
                sector: normalizeTaiwanIndustry(row['產業別']),
                source: exchange === 'TWSE' ? 'TWSE open data' : 'TPEX open data',
            };
        })
        .filter(Boolean);
}

function parseNasdaqDirectory(text, sourceName) {
    const lines = String(text || '').split(/\r?\n/).filter((line) => line.trim());
    if (lines.length < 2) return [];
    const headers = lines[0].split('|').map(stripBom);
    const footerPattern = /^File Creation Time/i;
    return lines.slice(1)
        .filter((line) => !footerPattern.test(line))
        .map((line) => {
            const cells = line.split('|');
            const row = {};
            headers.forEach((header, index) => {
                row[header] = cells[index] || '';
            });
            const rawSymbol = normalizeSymbol(row['Symbol'] || row['ACT Symbol']);
            const name = normalizeText(row['Security Name'] || row['Security Name']);
            const testIssue = normalizeSymbol(row['Test Issue']);
            if (!rawSymbol || !name || testIssue === 'Y') return null;
            const symbol = rawSymbol.replace(/\$/g, '-P');
            return {
                symbol,
                yahooSymbol: symbol,
                name,
                market: 'us',
                exchange: normalizeText(row['Exchange'] || (sourceName === 'NASDAQ' ? 'NASDAQ' : 'US')),
                type: /ETF|ETN|FUND/i.test(name) ? 'ETF' : 'EQUITY',
                sector: '',
                source: `${sourceName} Symbol Directory`,
            };
        })
        .filter(Boolean);
}

async function fetchFinMindTaiwanInfo() {
    const text = await fetchText(SOURCES.FINMIND_TAIWAN);
    const payload = JSON.parse(text);
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    return rows
        .map((row) => {
            const symbol = normalizeSymbol(row.stock_id);
            const name = normalizeText(row.stock_name);
            const category = normalizeText(row.industry_category);
            if (!symbol || !name || !/^[0-9A-Z]{4,6}$/.test(symbol)) return null;
            if (category === '所有證券' || /權證|購|售|牛|熊/.test(name)) return null;
            const type = /ETF|指數股票型基金/i.test(row.type || category) ? 'ETF' : 'EQUITY';
            const exchange = /上櫃|otc|tpex/i.test(row.type || row.market || '') ? 'TPEX' : 'TWSE';
            return {
                symbol,
                yahooSymbol: inferTaiwanYahooSymbol(symbol, exchange),
                name,
                market: 'tw',
                exchange,
                type,
                sector: category,
                source: 'FinMind TaiwanStockInfo',
            };
        })
        .filter(Boolean);
}

function readDirectoryFromDisk() {
    try {
        if (!fs.existsSync(DIRECTORY_PATH)) return null;
        const parsed = JSON.parse(fs.readFileSync(DIRECTORY_PATH, 'utf8'));
        if (!parsed || !Array.isArray(parsed.items)) return null;
        return parsed;
    } catch (error) {
        console.warn('[StockSymbolDirectory] Failed to read cache:', error.message);
        return null;
    }
}

function writeDirectory(payload) {
    ensureDirectory();
    fs.writeFileSync(DIRECTORY_PATH, JSON.stringify(payload, null, 2), 'utf8');
    memoryDirectory = payload;
    return payload;
}

function getDirectory({ allowStale = true } = {}) {
    if (memoryDirectory) return memoryDirectory;
    const disk = readDirectoryFromDisk();
    if (disk) {
        memoryDirectory = disk;
        return disk;
    }
    if (!allowStale) return null;
    return {
        generatedAt: new Date(0).toISOString(),
        sourceStatus: [{ source: 'Seed fallback', status: 'fallback' }],
        items: SEED_SYMBOLS,
    };
}

function isFresh(directory) {
    const ts = Date.parse(directory?.generatedAt);
    return Number.isFinite(ts) && Date.now() - ts < REFRESH_TTL_MS;
}

async function refreshStockSymbolDirectory({ force = false } = {}) {
    const current = getDirectory();
    if (!force && current && isFresh(current) && Array.isArray(current.items) && current.items.length > SEED_SYMBOLS.length) {
        return current;
    }
    if (refreshPromise) return refreshPromise;

    refreshPromise = (async () => {
        const sourceStatus = [];
        const batches = [SEED_SYMBOLS];
        const jobs = [
            ['TWSE listed', async () => parseTwCompanyCsv(await fetchText(SOURCES.TWSE_LISTED), 'TWSE')],
            ['TPEX OTC', async () => parseTwCompanyCsv(await fetchText(SOURCES.TPEX_OTC), 'TPEX')],
            ['FinMind TaiwanStockInfo', fetchFinMindTaiwanInfo],
            ['NASDAQ listed', async () => parseNasdaqDirectory(await fetchText(SOURCES.NASDAQ_LISTED), 'NASDAQ')],
            ['US other listed', async () => parseNasdaqDirectory(await fetchText(SOURCES.NASDAQ_OTHER), 'US Other')],
        ];

        for (const [source, job] of jobs) {
            try {
                const rows = await job();
                batches.push(rows);
                sourceStatus.push({ source, status: 'ok', count: rows.length });
            } catch (error) {
                sourceStatus.push({ source, status: 'error', error: error.message || String(error) });
            }
        }

        const items = dedupeItems(batches.flat());
        return writeDirectory({
            generatedAt: new Date().toISOString(),
            sourceStatus,
            items,
        });
    })();

    try {
        return await refreshPromise;
    } finally {
        refreshPromise = null;
    }
}

function scoreItem(item, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return 0;
    const symbol = item.symbol.toLowerCase();
    const yahoo = item.yahooSymbol.toLowerCase();
    const name = item.name.toLowerCase();
    if (symbol === q || yahoo === q) return 100;
    if (symbol.startsWith(q) || yahoo.startsWith(q)) return 90;
    if (name === q) return 85;
    if (name.startsWith(q)) return 75;
    if (symbol.includes(q) || yahoo.includes(q)) return 65;
    if (name.includes(q)) return 55;
    return 0;
}

async function searchStockSymbols(query, options = {}) {
    const safeQuery = String(query || '').trim();
    if (!safeQuery) return [];
    const directory = await refreshStockSymbolDirectory({ force: options.forceRefresh === true }).catch(() => getDirectory());
    const items = Array.isArray(directory?.items) ? directory.items : SEED_SYMBOLS;
    return items
        .map((item) => ({ ...item, score: scoreItem(item, safeQuery) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || a.yahooSymbol.localeCompare(b.yahooSymbol))
        .slice(0, options.limit || 16)
        .map(({ score, ...item }) => ({
            ...item,
            dataSource: item.source || 'Symbol directory',
        }));
}

module.exports = {
    DIRECTORY_PATH,
    refreshStockSymbolDirectory,
    searchStockSymbols,
    getDirectory,
};
