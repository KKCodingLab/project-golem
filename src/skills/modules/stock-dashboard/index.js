const { buildFreshStockSnapshotInjection } = require('../../../services/StockDashboardSnapshot');

const SYMBOL_ALIASES = {
    台積電: '2330.TW',
    台灣積體電路: '2330.TW',
    聯發科: '2454.TW',
    鴻海: '2317.TW',
    輝達: 'NVDA',
    蘋果: 'AAPL',
    特斯拉: 'TSLA',
};
const TAIWAN_SYMBOL_RE = /^\d{4,6}[A-Z]{0,3}$/;
const TAIWAN_YAHOO_SYMBOL_RE = /^\d{4,6}[A-Z]{0,3}\.(TW|TWO)$/;

function normalizeSymbol(input) {
    const raw = String(input || '').trim().toUpperCase();
    if (!raw) return '';
    const cleaned = raw.replace(/\s+/g, '');
    if (TAIWAN_SYMBOL_RE.test(cleaned)) return `${cleaned}.TW`;
    if (TAIWAN_YAHOO_SYMBOL_RE.test(cleaned)) return cleaned;
    return cleaned.replace(/[^A-Z0-9.^=-]/g, '').slice(0, 24);
}

function extractSymbolsFromText(text) {
    const source = String(text || '');
    const symbols = [];

    for (const [label, symbol] of Object.entries(SYMBOL_ALIASES)) {
        if (source.includes(label)) symbols.push(symbol);
    }

    const tokenMatches = source.match(/\b(?:[A-Za-z]{1,5}|\d{4,6}[A-Za-z]{0,3})(?:\.(?:TW|TWO))?\b/g) || [];
    for (const token of tokenMatches) {
        const symbol = normalizeSymbol(token);
        if (symbol && !['STOCK', 'DASHBOARD', 'MARKET'].includes(symbol)) symbols.push(symbol);
    }

    return [...new Set(symbols)];
}

function resolveSymbols(args = {}) {
    const rawSymbols = []
        .concat(args.symbols || [])
        .concat(args.tickers || [])
        .concat(args.symbol || [])
        .filter(Boolean);

    const explicit = rawSymbols.map(normalizeSymbol).filter(Boolean);
    const inferred = extractSymbolsFromText([
        args.query,
        args.request,
        args.text,
        args.message,
        args.selectedSymbol,
    ].filter(Boolean).join('\n'));

    return [...new Set([...explicit, ...inferred])];
}

async function run(ctx = {}) {
    const args = ctx.args || {};
    const symbols = resolveSymbols(args);
    const selectedSymbol = normalizeSymbol(args.selectedSymbol || args.selected || symbols[0]);
    const selectedRange = String(args.selectedRange || args.range || '1D').toUpperCase();
    const marketFilter = String(args.marketFilter || args.market || 'all').toLowerCase();

    const injection = await buildFreshStockSnapshotInjection({
        trigger: 'skill-stock-dashboard',
        symbols,
        selectedSymbol: selectedSymbol || undefined,
        selectedRange,
        marketFilter,
        includeNews: args.includeNews !== false,
    });

    return [
        injection,
        '',
        '[Stock Dashboard Analysis Instructions]',
        '請根據以上資料輸出市場概況、主要強弱標的、技術指標、新聞脈絡、風險提醒。',
        '請明確說明資料時間與限制；不要做保證式投資建議，也不要承諾報酬。',
    ].join('\n');
}

module.exports = {
    name: 'stock-dashboard',
    description: '讀取並刷新 Dashboard 股市分析看板快照，協助分析台股、美股、自選股與新聞脈絡。',
    tags: ['finance', 'stocks', 'dashboard', 'market-analysis'],
    paramsSchema: {
        type: 'object',
        properties: {
            symbols: { type: 'array', items: { type: 'string' } },
            selectedSymbol: { type: 'string' },
            marketFilter: { type: 'string', enum: ['all', 'tw', 'us'] },
            selectedRange: { type: 'string', enum: ['1D', '1M', '3M', '6M', '1Y'] },
            includeNews: { type: 'boolean' },
        },
    },
    run,
};
