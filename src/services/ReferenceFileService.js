const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const DATA_DIR = path.resolve(process.cwd(), 'data', 'dashboard');
const REGISTRY_PATH = path.join(DATA_DIR, 'reference-files.json');
const INDEX_PATH = path.join(DATA_DIR, 'reference-file-index.json');

const TEXT_EXTENSIONS = new Set([
    '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.log',
    '.js', '.jsx', '.ts', '.tsx', '.css', '.scss', '.html', '.xml', '.yml',
    '.yaml', '.toml', '.ini', '.env', '.sh', '.bash', '.zsh', '.py', '.rb',
    '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.php', '.sql',
]);

const OFFICE_EXTENSIONS = new Set(['.docx', '.pptx', '.xlsx']);
const SUPPORTED_EXTENSIONS = new Set([...TEXT_EXTENSIONS, ...OFFICE_EXTENSIONS, '.pdf']);
const MAX_FILE_BYTES = Number(process.env.GOLEM_REFERENCE_MAX_FILE_BYTES || 25 * 1024 * 1024);
const MAX_TEXT_CHARS = Number(process.env.GOLEM_REFERENCE_MAX_TEXT_CHARS || 800000);
const CHUNK_CHARS = Number(process.env.GOLEM_REFERENCE_CHUNK_CHARS || 1800);
const CHUNK_OVERLAP = Number(process.env.GOLEM_REFERENCE_CHUNK_OVERLAP || 180);

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function nowIso() {
    return new Date().toISOString();
}

function readJson(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return fallback;
    }
}

function writeJson(filePath, payload) {
    ensureDataDir();
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

function expandHome(inputPath) {
    return String(inputPath || '').trim().replace(/^~(?=$|\/|\\)/, os.homedir());
}

function normalizePath(inputPath) {
    const raw = expandHome(inputPath);
    if (!raw) return '';
    // If a Windows drive path is provided on non-Windows hosts, keep it as-is
    // so we can surface a clear "path not accessible on this host" error.
    if (process.platform !== 'win32' && /^[a-zA-Z]:[\\/]/.test(raw)) {
        return raw;
    }
    return path.resolve(raw);
}

function isHiddenName(name) {
    return name.startsWith('.') && name !== '.env';
}

function safeStat(targetPath) {
    try {
        return fs.statSync(targetPath);
    } catch {
        return null;
    }
}

function sha1(input) {
    return crypto.createHash('sha1').update(input).digest('hex');
}

function fileHash(filePath, maxBytes = 1024 * 1024) {
    const fd = fs.openSync(filePath, 'r');
    try {
        const st = fs.fstatSync(fd);
        const length = Math.min(st.size, maxBytes);
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, 0);
        return sha1(buffer);
    } finally {
        fs.closeSync(fd);
    }
}

function decodeXmlText(text) {
    return String(text || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

function zipEntriesText(filePath, entryPattern) {
    const zip = new AdmZip(filePath);
    const parts = [];
    for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        if (!entryPattern.test(entry.entryName)) continue;
        parts.push(decodeXmlText(entry.getData().toString('utf8')));
    }
    return parts.filter(Boolean).join('\n\n');
}

function extractOfficeText(filePath, ext) {
    if (ext === '.docx') return zipEntriesText(filePath, /^word\/document\.xml$/);
    if (ext === '.pptx') return zipEntriesText(filePath, /^ppt\/slides\/slide\d+\.xml$/);
    if (ext === '.xlsx') return zipEntriesText(filePath, /^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/);
    return '';
}

function extractPdfFallback(filePath) {
    const raw = fs.readFileSync(filePath);
    const ascii = raw.toString('latin1')
        .replace(/[^\x09\x0A\x0D\x20-\x7E]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return ascii.length > 200 ? ascii : '';
}

function chunkText(text, options = {}) {
    const max = Number(options.chunkChars || CHUNK_CHARS);
    const overlap = Math.max(0, Math.min(Number(options.overlap || CHUNK_OVERLAP), Math.floor(max / 3)));
    const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
    if (!normalized) return [];

    const chunks = [];
    let start = 0;
    while (start < normalized.length) {
        const hardEnd = Math.min(normalized.length, start + max);
        let end = hardEnd;
        if (hardEnd < normalized.length) {
            const newline = normalized.lastIndexOf('\n', hardEnd);
            const space = normalized.lastIndexOf(' ', hardEnd);
            const candidate = Math.max(newline, space);
            if (candidate > start + Math.floor(max * 0.55)) end = candidate;
        }
        const textChunk = normalized.slice(start, end).trim();
        if (textChunk) chunks.push(textChunk);
        if (end >= normalized.length) break;
        start = Math.max(0, end - overlap);
    }
    return chunks;
}

function tokenize(text) {
    const lowered = String(text || '').toLowerCase();
    const latin = lowered.match(/[a-z0-9_./:-]{2,}/g) || [];
    const cjk = lowered.match(/[\u4e00-\u9fff]{1,}/g) || [];
    return [...latin, ...cjk].filter(Boolean);
}

function scoreText(query, text, metadataText = '') {
    const haystack = `${metadataText}\n${text}`.toLowerCase();
    const tokens = tokenize(query);
    if (tokens.length === 0) return 0;
    let score = 0;
    for (const token of tokens) {
        if (haystack.includes(token)) score += token.length > 2 ? 2 : 1;
    }
    return score / tokens.length;
}

class ReferenceFileService {
    constructor() {
        ensureDataDir();
    }

    _readRegistry() {
        const payload = readJson(REGISTRY_PATH, { version: 1, files: [] });
        if (!Array.isArray(payload.files)) payload.files = [];
        return payload;
    }

    _writeRegistry(payload) {
        writeJson(REGISTRY_PATH, {
            version: 1,
            updatedAt: nowIso(),
            files: payload.files || [],
        });
    }

    _readIndex() {
        const payload = readJson(INDEX_PATH, { version: 1, chunks: [] });
        if (!Array.isArray(payload.chunks)) payload.chunks = [];
        return payload;
    }

    _writeIndex(payload) {
        writeJson(INDEX_PATH, {
            version: 1,
            updatedAt: nowIso(),
            chunks: payload.chunks || [],
        });
    }

    browse(inputPath) {
        const currentPath = normalizePath(inputPath || os.homedir());
        const st = safeStat(currentPath);
        if (!st || !st.isDirectory()) {
            const error = new Error('Selected path is not a readable directory.');
            error.statusCode = 400;
            throw error;
        }

        const entries = fs.readdirSync(currentPath, { withFileTypes: true })
            .filter((entry) => !isHiddenName(entry.name))
            .slice(0, 500)
            .map((entry) => {
                const fullPath = path.join(currentPath, entry.name);
                const ext = path.extname(entry.name).toLowerCase();
                const entryStat = safeStat(fullPath);
                return {
                    name: entry.name,
                    path: fullPath,
                    type: entry.isDirectory() ? 'directory' : 'file',
                    supported: entry.isDirectory() || SUPPORTED_EXTENSIONS.has(ext),
                    size: entryStat ? entryStat.size : 0,
                    mtimeMs: entryStat ? entryStat.mtimeMs : 0,
                };
            })
            .sort((a, b) => {
                if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
                return a.name.localeCompare(b.name);
            });

        return {
            currentPath,
            parentPath: path.dirname(currentPath) !== currentPath ? path.dirname(currentPath) : null,
            entries,
            roots: [
                { label: 'Home', path: os.homedir() },
                { label: 'Current Project', path: process.cwd() },
                { label: 'Desktop', path: path.join(os.homedir(), 'Desktop') },
                { label: 'Downloads', path: path.join(os.homedir(), 'Downloads') },
            ].filter((root) => safeStat(root.path)?.isDirectory()),
        };
    }

    list() {
        const registry = this._readRegistry();
        const index = this._readIndex();
        const counts = new Map();
        for (const chunk of index.chunks) {
            counts.set(chunk.fileId, (counts.get(chunk.fileId) || 0) + 1);
        }
        return registry.files.map((item) => ({ ...item, chunkCount: counts.get(item.id) || 0 }));
    }

    get(id) {
        return this.list().find((item) => item.id === id) || null;
    }

    _collectFiles(targetPath, maxFiles = 300) {
        const root = normalizePath(targetPath);
        if (process.platform !== 'win32' && /^[a-zA-Z]:[\\/]/.test(root)) {
            const error = new Error(`Windows path is not accessible on current host (${process.platform}): ${root}`);
            error.statusCode = 400;
            throw error;
        }
        const st = safeStat(root);
        if (!st) {
            const error = new Error('Path does not exist.');
            error.statusCode = 400;
            throw error;
        }
        if (st.isFile()) return [root];
        if (!st.isDirectory()) return [];

        const files = [];
        const stack = [root];
        while (stack.length > 0 && files.length < maxFiles) {
            const current = stack.pop();
            let entries = [];
            try {
                entries = fs.readdirSync(current, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const entry of entries) {
                if (isHiddenName(entry.name)) continue;
                const fullPath = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    stack.push(fullPath);
                } else if (entry.isFile()) {
                    files.push(fullPath);
                    if (files.length >= maxFiles) break;
                }
            }
        }
        return files;
    }

    addPath(inputPath, options = {}) {
        const files = this._collectFiles(inputPath, options.maxFiles || 300);
        const registry = this._readRegistry();
        const byPath = new Map(registry.files.map((item) => [item.path, item]));
        const added = [];

        for (const filePath of files) {
            const ext = path.extname(filePath).toLowerCase();
            if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
            const st = safeStat(filePath);
            if (!st || !st.isFile()) continue;

            let item = byPath.get(filePath);
            if (!item) {
                item = {
                    id: `ref_${Date.now().toString(36)}_${sha1(filePath).slice(0, 8)}`,
                    name: options.name || path.basename(filePath),
                    description: options.description || '',
                    tags: Array.isArray(options.tags) ? options.tags : [],
                    path: filePath,
                    ext,
                    enabled: true,
                    status: 'pending',
                    createdAt: nowIso(),
                };
                registry.files.push(item);
                byPath.set(filePath, item);
            }
            item.updatedAt = nowIso();
            item.size = st.size;
            item.mtimeMs = st.mtimeMs;
            item.ext = ext;
            added.push(item);
        }

        this._writeRegistry(registry);
        const indexed = added.map((item) => this.indexFile(item.id));
        return { added: indexed, skipped: files.length - added.length };
    }

    update(id, updates = {}) {
        const registry = this._readRegistry();
        const item = registry.files.find((file) => file.id === id);
        if (!item) return null;
        if (typeof updates.name === 'string') item.name = updates.name.trim() || item.name;
        if (typeof updates.description === 'string') item.description = updates.description;
        if (Array.isArray(updates.tags)) item.tags = updates.tags.map(String).map((tag) => tag.trim()).filter(Boolean);
        if (typeof updates.enabled === 'boolean') item.enabled = updates.enabled;
        item.updatedAt = nowIso();
        this._writeRegistry(registry);
        return this.get(id);
    }

    remove(id) {
        const registry = this._readRegistry();
        const before = registry.files.length;
        registry.files = registry.files.filter((item) => item.id !== id);
        this._writeRegistry(registry);
        const index = this._readIndex();
        index.chunks = index.chunks.filter((chunk) => chunk.fileId !== id);
        this._writeIndex(index);
        return before !== registry.files.length;
    }

    removeMany(ids = []) {
        const uniqueIds = Array.from(new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || '').trim()).filter(Boolean)));
        if (uniqueIds.length === 0) return { removed: 0, missing: 0 };
        const registry = this._readRegistry();
        const before = registry.files.length;
        const idSet = new Set(uniqueIds);
        registry.files = registry.files.filter((item) => !idSet.has(item.id));
        this._writeRegistry(registry);

        const index = this._readIndex();
        index.chunks = index.chunks.filter((chunk) => !idSet.has(chunk.fileId));
        this._writeIndex(index);

        const removed = before - registry.files.length;
        return { removed, missing: Math.max(0, uniqueIds.length - removed) };
    }

    extractText(filePath) {
        const resolved = normalizePath(filePath);
        const st = safeStat(resolved);
        if (!st || !st.isFile()) throw new Error('File does not exist.');
        if (st.size > MAX_FILE_BYTES) throw new Error(`File is too large (${st.size} bytes).`);

        const ext = path.extname(resolved).toLowerCase();
        let text = '';
        if (TEXT_EXTENSIONS.has(ext)) {
            text = fs.readFileSync(resolved, 'utf8');
        } else if (OFFICE_EXTENSIONS.has(ext)) {
            text = extractOfficeText(resolved, ext);
        } else if (ext === '.pdf') {
            text = extractPdfFallback(resolved);
        } else {
            throw new Error(`Unsupported file type: ${ext || 'unknown'}`);
        }

        text = String(text || '').replace(/\u0000/g, '').trim();
        if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);
        if (!text) throw new Error(`No readable text extracted from ${ext || 'file'}.`);
        return text;
    }

    indexFile(id) {
        const registry = this._readRegistry();
        const item = registry.files.find((file) => file.id === id);
        if (!item) throw new Error(`Reference file not found: ${id}`);

        try {
            const text = this.extractText(item.path);
            const st = safeStat(item.path);
            const hash = fileHash(item.path);
            const chunks = chunkText(text).map((chunk, index) => ({
                id: `${item.id}_${index}`,
                fileId: item.id,
                chunkIndex: index,
                text: chunk,
                path: item.path,
                name: item.name,
                description: item.description || '',
                tags: item.tags || [],
                ext: item.ext,
                indexedAt: nowIso(),
            }));

            const index = this._readIndex();
            index.chunks = index.chunks.filter((chunk) => chunk.fileId !== item.id).concat(chunks);
            this._writeIndex(index);

            Object.assign(item, {
                status: 'ready',
                error: null,
                indexedAt: nowIso(),
                chunkCount: chunks.length,
                hash,
                size: st ? st.size : item.size,
                mtimeMs: st ? st.mtimeMs : item.mtimeMs,
                textPreview: text.slice(0, 500),
            });
        } catch (error) {
            Object.assign(item, {
                status: 'failed',
                error: error.message || String(error),
                indexedAt: nowIso(),
                chunkCount: 0,
            });
        }

        this._writeRegistry(registry);
        return this.get(id);
    }

    reindexAll() {
        return this.list().map((item) => this.indexFile(item.id));
    }

    search(query, options = {}) {
        const limit = Number(options.limit || 5);
        const registry = this._readRegistry();
        const enabled = new Map(registry.files.filter((item) => item.enabled !== false).map((item) => [item.id, item]));
        const index = this._readIndex();
        const scored = [];

        for (const chunk of index.chunks) {
            const file = enabled.get(chunk.fileId);
            if (!file) continue;
            const metadataText = `${file.name} ${file.path} ${file.description || ''} ${(file.tags || []).join(' ')}`;
            const score = scoreText(query, chunk.text, metadataText);
            if (score <= 0) continue;
            scored.push({
                id: chunk.id,
                fileId: chunk.fileId,
                name: file.name,
                path: file.path,
                description: file.description || '',
                tags: file.tags || [],
                text: chunk.text,
                score,
                chunkIndex: chunk.chunkIndex,
            });
        }

        return scored.sort((a, b) => b.score - a.score).slice(0, limit);
    }

    read(id, options = {}) {
        const item = this.get(id);
        if (!item) return null;
        const maxChars = Number(options.maxChars || 12000);
        const text = this.extractText(item.path);
        return {
            ...item,
            text: text.length > maxChars ? `${text.slice(0, maxChars)}\n...(已截斷)` : text,
        };
    }

    buildContext(query, options = {}) {
        const results = this.search(query, { limit: options.limit || 4 });
        if (results.length === 0) return '';
        return results.map((result) => [
            `文件：${result.name}`,
            `路徑：${result.path}`,
            result.description ? `描述：${result.description}` : null,
            `片段：${result.text.slice(0, Number(options.maxChunkChars || 1200))}`,
        ].filter(Boolean).join('\n')).join('\n\n---\n\n');
    }
}

module.exports = new ReferenceFileService();
module.exports.ReferenceFileService = ReferenceFileService;
module.exports.REGISTRY_PATH = REGISTRY_PATH;
module.exports.INDEX_PATH = INDEX_PATH;
