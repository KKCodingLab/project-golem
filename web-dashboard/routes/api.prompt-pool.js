const express = require('express');
const fs = require('fs');
const path = require('path');
const { buildOperationGuard } = require('../server/security');

const PROMPT_POOL_DIR = path.resolve(process.cwd(), 'data', 'dashboard');
const PROMPT_POOL_PATH = path.join(PROMPT_POOL_DIR, 'prompt-pool.json');
const PROMPT_POOL_AUDIT_DIR = path.resolve(process.cwd(), 'logs');
const PROMPT_POOL_AUDIT_PATH = path.join(PROMPT_POOL_AUDIT_DIR, 'prompt-pool-audit.log');
const MAX_AUDIT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_AUDIT_RETENTION_LINES = 3000;

const MAX_SHORTCUT_LENGTH = 64;
const MAX_PROMPT_LENGTH = 8000;
const MAX_NOTE_LENGTH = 240;
const MAX_ITEMS = 300;
const MAX_TOP_USED_SHORTCUTS = 10;
const DEFAULT_USAGE_TREND_DAYS = 14;
let cachedSystemCommandSet = null;
let mutationQueue = Promise.resolve();

function createHttpError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function toIsoDate(value) {
    const parsed = Date.parse(String(value || ''));
    if (Number.isNaN(parsed)) return new Date().toISOString();
    return new Date(parsed).toISOString();
}

function createPromptId() {
    return `pp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeShortcut(value) {
    const shortcut = String(value || '').trim();
    if (!shortcut) {
        throw createHttpError(400, '快捷指令不可為空');
    }
    if (shortcut.length > MAX_SHORTCUT_LENGTH) {
        throw createHttpError(400, `快捷指令不可超過 ${MAX_SHORTCUT_LENGTH} 字元`);
    }
    if (/\s/.test(shortcut)) {
        throw createHttpError(400, '快捷指令不可包含空白字元');
    }
    if (/[\u0000-\u001f\u007f]/.test(shortcut)) {
        throw createHttpError(400, '快捷指令不可包含控制字元');
    }
    return shortcut;
}

function normalizePrompt(value) {
    const prompt = String(value || '').trim();
    if (!prompt) {
        throw createHttpError(400, 'Prompt 內容不可為空');
    }
    if (prompt.length > MAX_PROMPT_LENGTH) {
        throw createHttpError(400, `Prompt 內容不可超過 ${MAX_PROMPT_LENGTH} 字元`);
    }
    return prompt;
}

function normalizeNote(value) {
    const note = String(value || '').trim();
    if (!note) return '';
    return note.slice(0, MAX_NOTE_LENGTH);
}

function stripTelegramBotMentionSuffix(value) {
    const shortcut = String(value || '').trim();
    return shortcut.replace(/^((?:\/)?[a-z0-9_]{1,32})@[a-z0-9_]{3,}$/i, '$1');
}

function toShortcutKey(value) {
    const raw = stripTelegramBotMentionSuffix(value).toLowerCase();
    if (!raw) return '';
    return raw.replace(/^\/+/, '');
}

function isShortcutFormatValid(shortcut) {
    try {
        normalizeShortcut(shortcut);
        return true;
    } catch {
        return false;
    }
}

function normalizePromptItem(raw, index) {
    if (!raw || typeof raw !== 'object') return null;
    const record = raw;

    const shortcut = String(record.shortcut || '').trim();
    const prompt = String(record.prompt || '').trim();
    if (!shortcut || !prompt) return null;

    const idRaw = String(record.id || '').trim();
    const id = idRaw || `pp_legacy_${index + 1}`;

    return {
        id,
        shortcut: shortcut.slice(0, MAX_SHORTCUT_LENGTH),
        prompt: prompt.slice(0, MAX_PROMPT_LENGTH),
        note: String(record.note || '').trim().slice(0, MAX_NOTE_LENGTH),
        createdAt: toIsoDate(record.createdAt),
        updatedAt: toIsoDate(record.updatedAt || record.createdAt),
    };
}

function ensurePromptPoolStorage() {
    if (!fs.existsSync(PROMPT_POOL_DIR)) {
        fs.mkdirSync(PROMPT_POOL_DIR, { recursive: true });
    }
    if (!fs.existsSync(PROMPT_POOL_PATH)) {
        fs.writeFileSync(PROMPT_POOL_PATH, '[]', 'utf8');
    }
}

function ensurePromptPoolAuditStorage() {
    if (!fs.existsSync(PROMPT_POOL_AUDIT_DIR)) {
        fs.mkdirSync(PROMPT_POOL_AUDIT_DIR, { recursive: true });
    }
    if (!fs.existsSync(PROMPT_POOL_AUDIT_PATH)) {
        fs.writeFileSync(PROMPT_POOL_AUDIT_PATH, '', 'utf8');
    }
}

function compactAuditLogIfNeeded() {
    try {
        if (!fs.existsSync(PROMPT_POOL_AUDIT_PATH)) return;
        const stat = fs.statSync(PROMPT_POOL_AUDIT_PATH);
        if (!stat.isFile() || stat.size <= MAX_AUDIT_FILE_BYTES) return;
        const raw = fs.readFileSync(PROMPT_POOL_AUDIT_PATH, 'utf8');
        const lines = raw.split('\n').filter((line) => line.trim());
        const kept = lines.slice(-MAX_AUDIT_RETENTION_LINES);
        fs.writeFileSync(PROMPT_POOL_AUDIT_PATH, `${kept.join('\n')}${kept.length ? '\n' : ''}`, 'utf8');
    } catch (error) {
        console.warn('[PromptPool] Failed to compact audit log:', error.message);
    }
}

function appendPromptPoolAuditRecord(record) {
    try {
        ensurePromptPoolAuditStorage();
        compactAuditLogIfNeeded();
        fs.appendFileSync(PROMPT_POOL_AUDIT_PATH, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (error) {
        console.warn('[PromptPool] Failed to append audit record:', error.message);
    }
}

function readPromptPoolAuditRecords(limit = 50) {
    ensurePromptPoolAuditStorage();
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    try {
        const raw = fs.readFileSync(PROMPT_POOL_AUDIT_PATH, 'utf8');
        const lines = raw.split('\n').filter((line) => line.trim());
        const recent = lines.slice(-safeLimit);
        const parsed = [];
        for (const line of recent) {
            try {
                const item = JSON.parse(line);
                if (item && typeof item === 'object') parsed.push(item);
            } catch {
                // ignore malformed line
            }
        }
        return parsed.reverse();
    } catch (error) {
        console.warn('[PromptPool] Failed to read audit records:', error.message);
        return [];
    }
}

function readAllPromptPoolAuditRecords() {
    ensurePromptPoolAuditStorage();
    try {
        const raw = fs.readFileSync(PROMPT_POOL_AUDIT_PATH, 'utf8');
        const lines = raw.split('\n').filter((line) => line.trim());
        const parsed = [];
        for (const line of lines) {
            try {
                const item = JSON.parse(line);
                if (item && typeof item === 'object') parsed.push(item);
            } catch {
                // ignore malformed line
            }
        }
        return parsed;
    } catch (error) {
        console.warn('[PromptPool] Failed to read full audit records:', error.message);
        return [];
    }
}

function buildPromptUsageMap(records, windowDays = 0) {
    const usageMap = new Map();
    const nowMs = Date.now();
    const hasWindow = Number(windowDays) > 0;
    const windowMs = hasWindow ? Number(windowDays) * 24 * 60 * 60 * 1000 : 0;
    const lowerBoundMs = hasWindow ? nowMs - windowMs : 0;

    for (const record of records) {
        if (!record || record.event !== 'prompt_pool_use') continue;
        if (hasWindow) {
            const tsMs = Date.parse(String(record.ts || ''));
            if (!Number.isFinite(tsMs) || tsMs < lowerBoundMs) continue;
        }

        const details = record.details && typeof record.details === 'object'
            ? record.details
            : {};
        const shortcutKey = toShortcutKey(details.shortcutKey || details.shortcut);
        if (!shortcutKey) continue;

        const previous = usageMap.get(shortcutKey) || { recentUseCount: 0, lastUsedAt: '' };
        previous.recentUseCount += 1;
        const tsIso = toIsoDate(record.ts);
        if (!previous.lastUsedAt || Date.parse(tsIso) >= Date.parse(previous.lastUsedAt)) {
            previous.lastUsedAt = tsIso;
        }
        usageMap.set(shortcutKey, previous);
    }
    return usageMap;
}

function withPromptUsageStats(items, usageMap) {
    const map = usageMap || new Map();
    return items.map((item) => {
        const shortcutKey = toShortcutKey(item.shortcut);
        const usage = map.get(shortcutKey) || { recentUseCount: 0, lastUsedAt: '' };
        return {
            ...item,
            recentUseCount: usage.recentUseCount,
            lastUsedAt: usage.lastUsedAt || '',
        };
    });
}

function buildTopUsedShortcuts(items) {
    return [...items]
        .filter((item) => Number(item.recentUseCount || 0) > 0)
        .sort((a, b) => {
            const countDiff = Number(b.recentUseCount || 0) - Number(a.recentUseCount || 0);
            if (countDiff !== 0) return countDiff;
            const aTs = Date.parse(String(a.lastUsedAt || '1970-01-01T00:00:00.000Z'));
            const bTs = Date.parse(String(b.lastUsedAt || '1970-01-01T00:00:00.000Z'));
            return bTs - aTs;
        })
        .slice(0, MAX_TOP_USED_SHORTCUTS)
        .map((item) => ({
            id: item.id,
            shortcut: item.shortcut,
            note: item.note || '',
            recentUseCount: Number(item.recentUseCount || 0),
            lastUsedAt: item.lastUsedAt || '',
        }));
}

function buildTopUsedShortcutsFromUsageMap(baseItems, usageMap) {
    const enriched = withPromptUsageStats(baseItems, usageMap);
    return buildTopUsedShortcuts(enriched);
}

function buildUsageTrend(records, days = DEFAULT_USAGE_TREND_DAYS, shortcutKeyFilter = '') {
    const safeDays = Math.max(1, Math.min(Number(days) || DEFAULT_USAGE_TREND_DAYS, 90));
    const filterKey = toShortcutKey(shortcutKeyFilter);
    const countsByDate = new Map();

    for (const record of records) {
        if (!record || record.event !== 'prompt_pool_use') continue;
        const details = record.details && typeof record.details === 'object'
            ? record.details
            : {};
        const recordShortcutKey = toShortcutKey(details.shortcutKey || details.shortcut);
        if (filterKey && recordShortcutKey !== filterKey) continue;

        const tsMs = Date.parse(String(record.ts || ''));
        if (!Number.isFinite(tsMs)) continue;
        const dateKey = new Date(tsMs).toISOString().slice(0, 10);
        countsByDate.set(dateKey, (countsByDate.get(dateKey) || 0) + 1);
    }

    const todayUtc = new Date();
    todayUtc.setUTCHours(0, 0, 0, 0);
    const trend = [];

    for (let i = safeDays - 1; i >= 0; i -= 1) {
        const day = new Date(todayUtc);
        day.setUTCDate(todayUtc.getUTCDate() - i);
        const dateKey = day.toISOString().slice(0, 10);
        trend.push({
            date: dateKey,
            count: Number(countsByDate.get(dateKey) || 0),
        });
    }

    return trend;
}

function buildPromptPoolItemsPayload(rawItems) {
    const baseItems = sortPromptItems(rawItems);
    const auditRecords = readAllPromptPoolAuditRecords();
    const usageAll = buildPromptUsageMap(auditRecords);
    const usage7d = buildPromptUsageMap(auditRecords, 7);
    const usage30d = buildPromptUsageMap(auditRecords, 30);

    const items = withPromptUsageStats(baseItems, usageAll);
    const topUsedShortcuts = buildTopUsedShortcutsFromUsageMap(baseItems, usageAll);
    const topUsedShortcuts7d = buildTopUsedShortcutsFromUsageMap(baseItems, usage7d);
    const topUsedShortcuts30d = buildTopUsedShortcutsFromUsageMap(baseItems, usage30d);
    const usageTrend14d = buildUsageTrend(auditRecords, DEFAULT_USAGE_TREND_DAYS);
    return {
        items,
        topUsedShortcuts,
        topUsedShortcuts7d,
        topUsedShortcuts30d,
        usageTrend14d,
    };
}

function atomicWriteFile(targetPath, content) {
    const dir = path.dirname(targetPath);
    const base = path.basename(targetPath);
    const tempPath = path.join(
        dir,
        `.${base}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );

    try {
        fs.writeFileSync(tempPath, content, 'utf8');
        fs.renameSync(tempPath, targetPath);
    } catch (error) {
        try {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        } catch {
            // ignore cleanup error
        }
        throw error;
    }
}

function quarantineCorruptedPool(rawText, reason) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(PROMPT_POOL_DIR, `prompt-pool.json.corrupt.${stamp}.bak`);
    try {
        fs.writeFileSync(backupPath, String(rawText || ''), 'utf8');
        console.warn(`[PromptPool] Corrupted prompt pool quarantined to ${backupPath} (${reason})`);
    } catch (error) {
        console.warn(`[PromptPool] Failed to quarantine corrupted prompt pool (${reason}):`, error.message);
    }
}

function getSystemCommandSet() {
    if (cachedSystemCommandSet) return cachedSystemCommandSet;

    try {
        const commands = require('../../src/config/commands.js');
        const set = new Set();
        if (Array.isArray(commands)) {
            for (const item of commands) {
                const commandKey = toShortcutKey(item && item.command ? item.command : '');
                if (commandKey) set.add(commandKey);
            }
        }
        cachedSystemCommandSet = set;
        return set;
    } catch (error) {
        console.warn('[PromptPool] Failed to load system commands:', error.message);
        cachedSystemCommandSet = new Set();
        return cachedSystemCommandSet;
    }
}

function isReservedSystemCommandShortcut(shortcut) {
    const normalized = toShortcutKey(shortcut);
    if (!normalized) return false;
    return getSystemCommandSet().has(normalized);
}

function collectLegacyConflicts(items) {
    const conflictsById = new Map();
    const duplicateBucket = new Map();

    for (const item of items) {
        if (!item || !item.id) continue;
        const shortcut = String(item.shortcut || '').trim();
        const shortcutKey = toShortcutKey(shortcut);

        if (shortcutKey) {
            if (!duplicateBucket.has(shortcutKey)) duplicateBucket.set(shortcutKey, []);
            duplicateBucket.get(shortcutKey).push(item.id);
        }

        if (isReservedSystemCommandShortcut(item.shortcut)) {
            conflictsById.set(item.id, {
                id: item.id,
                shortcut: item.shortcut,
                reason: 'reserved_system_command',
            });
            continue;
        }

        if (!isShortcutFormatValid(shortcut)) {
            conflictsById.set(item.id, {
                id: item.id,
                shortcut: item.shortcut,
                reason: 'invalid_shortcut_format',
            });
        }
    }

    for (const [, ids] of duplicateBucket.entries()) {
        if (!Array.isArray(ids) || ids.length <= 1) continue;
        for (const id of ids) {
            if (conflictsById.has(id)) continue;
            const item = items.find((entry) => entry.id === id);
            if (!item) continue;
            conflictsById.set(id, {
                id,
                shortcut: item.shortcut,
                reason: 'duplicate_shortcut',
            });
        }
    }

    return Array.from(conflictsById.values());
}

function sanitizeShortcutSeed(value) {
    const cleaned = String(value || '')
        .trim()
        .replace(/[\u0000-\u001f\u007f]+/g, '')
        .replace(/\s+/g, '_');
    return cleaned || 'prompt';
}

function buildRepairShortcutCandidate(sourceShortcut) {
    const seed = sanitizeShortcutSeed(sourceShortcut);
    const withPrefix = seed.startsWith('/') ? seed : `/${seed}`;
    return withPrefix.endsWith('_pp') ? withPrefix : `${withPrefix}_pp`;
}

function findAvailableRepairShortcut(sourceShortcut, occupiedShortcuts) {
    const occupied = occupiedShortcuts || new Set();
    const base = buildRepairShortcutCandidate(sourceShortcut);

    const isAvailable = (candidate) => {
        const key = toShortcutKey(candidate);
        if (!key) return false;
        if (occupied.has(key)) return false;
        if (isReservedSystemCommandShortcut(candidate)) return false;
        return isShortcutFormatValid(candidate);
    };

    if (isAvailable(base)) return base;

    for (let i = 2; i <= 999; i += 1) {
        const candidate = `${base}_${i}`;
        if (isAvailable(candidate)) return candidate;
    }

    for (let i = 0; i < 100; i += 1) {
        const candidate = `${base}_${Date.now().toString(36).slice(-4)}${i}`;
        if (isAvailable(candidate)) return candidate;
    }

    throw createHttpError(500, '無法生成可用的修復快捷指令');
}

async function withSerializedMutation(task) {
    const run = mutationQueue.then(() => Promise.resolve().then(task));
    mutationQueue = run.catch(() => { });
    return run;
}

function dedupePromptItems(items) {
    const idSeen = new Set();
    const deduped = [];

    for (const item of items) {
        const idKey = String(item.id || '').trim().toLowerCase();
        if (!idKey) continue;
        if (idSeen.has(idKey)) continue;
        idSeen.add(idKey);
        deduped.push(item);
    }

    return deduped.slice(0, MAX_ITEMS);
}

function sortPromptItems(items) {
    return [...items].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function normalizeImportMode(value) {
    const mode = String(value || '').trim().toLowerCase();
    if (mode === 'replace') return 'replace';
    return 'merge';
}

function parseImportedPromptItems(rawItems) {
    if (!Array.isArray(rawItems)) {
        throw createHttpError(400, '匯入格式錯誤：items 必須為陣列');
    }

    const parsed = [];
    const skipped = [];

    for (let i = 0; i < rawItems.length; i += 1) {
        const row = rawItems[i];
        const indexLabel = `#${i + 1}`;
        try {
            const shortcut = normalizeShortcut(row && row.shortcut);
            const prompt = normalizePrompt(row && row.prompt);
            const note = normalizeNote(row && row.note);

            if (isReservedSystemCommandShortcut(shortcut)) {
                skipped.push({ index: i, shortcut, reason: 'reserved_system_command' });
                continue;
            }

            parsed.push({ shortcut, prompt, note, sourceIndex: i, sourceLabel: indexLabel });
        } catch (error) {
            skipped.push({
                index: i,
                shortcut: String(row && row.shortcut ? row.shortcut : ''),
                reason: error instanceof Error ? error.message : 'invalid_row',
            });
        }
    }

    return { parsed, skipped };
}

function readPromptPool() {
    ensurePromptPoolStorage();
    try {
        const raw = fs.readFileSync(PROMPT_POOL_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            quarantineCorruptedPool(raw, 'root_not_array');
            atomicWriteFile(PROMPT_POOL_PATH, '[]');
            return [];
        }
        const normalized = parsed
            .map((item, index) => normalizePromptItem(item, index))
            .filter(Boolean);
        return dedupePromptItems(normalized);
    } catch (error) {
        if (fs.existsSync(PROMPT_POOL_PATH)) {
            try {
                const raw = fs.readFileSync(PROMPT_POOL_PATH, 'utf8');
                quarantineCorruptedPool(raw, error.message || 'parse_failed');
                atomicWriteFile(PROMPT_POOL_PATH, '[]');
            } catch (recoverError) {
                console.warn('[PromptPool] Recovery failed:', recoverError.message);
            }
        }
        console.warn('[PromptPool] Failed to read prompt pool, fallback to empty list:', error.message);
        return [];
    }
}

function writePromptPool(items) {
    ensurePromptPoolStorage();
    const nextItems = sortPromptItems(dedupePromptItems(items));
    atomicWriteFile(PROMPT_POOL_PATH, JSON.stringify(nextItems, null, 2));
    return nextItems;
}

function hasShortcutConflict(items, shortcut, ignoreId = '') {
    const target = toShortcutKey(shortcut);
    if (!target) return false;
    return items.some((item) => {
        if (ignoreId && item.id === ignoreId) return false;
        return toShortcutKey(item.shortcut) === target;
    });
}

function assertShortcutAllowed({ shortcut, items, ignoreId = '' }) {
    if (hasShortcutConflict(items, shortcut, ignoreId)) {
        throw createHttpError(409, `快捷指令已存在: ${shortcut}`);
    }
    if (isReservedSystemCommandShortcut(shortcut)) {
        throw createHttpError(409, `快捷指令與系統指令衝突: ${shortcut}`);
    }
}

module.exports = function registerPromptPoolRoutes(server) {
    const router = express.Router();
    const requirePromptPoolWrite = buildOperationGuard(server, 'prompt_pool_mutation');

    const createAuditMeta = (req, event, details = {}) => ({
        ts: new Date().toISOString(),
        event,
        actorIp: req.clientIp || req.ip || req.connection?.remoteAddress || '',
        details,
    });

    router.get('/api/prompt-pool', (req, res) => {
        try {
            const payload = buildPromptPoolItemsPayload(readPromptPool());
            const items = payload.items;
            const legacyConflicts = collectLegacyConflicts(items);
            return res.json({
                success: true,
                items,
                topUsedShortcuts: payload.topUsedShortcuts,
                topUsedShortcuts7d: payload.topUsedShortcuts7d,
                topUsedShortcuts30d: payload.topUsedShortcuts30d,
                usageTrend14d: payload.usageTrend14d,
                legacyConflicts,
                hasLegacyConflicts: legacyConflicts.length > 0,
            });
        } catch (error) {
            console.error('[PromptPool] Failed to fetch prompt pool:', error);
            return res.status(500).json({ error: 'Failed to fetch prompt pool' });
        }
    });

    router.get('/api/prompt-pool/audit', (req, res) => {
        try {
            const limit = Number(req.query.limit || 50);
            const records = readPromptPoolAuditRecords(limit);
            return res.json({ success: true, records });
        } catch (error) {
            console.error('[PromptPool] Failed to fetch audit records:', error);
            return res.status(500).json({ error: 'Failed to fetch audit records' });
        }
    });

    router.get('/api/prompt-pool/export', (req, res) => {
        try {
            const items = readPromptPool().map((item) => ({
                shortcut: item.shortcut,
                prompt: item.prompt,
                note: item.note || '',
            }));
            const payload = {
                schemaVersion: 1,
                exportedAt: new Date().toISOString(),
                itemCount: items.length,
                items,
            };
            return res.json({ success: true, ...payload });
        } catch (error) {
            console.error('[PromptPool] Failed to export prompt pool:', error);
            return res.status(500).json({ error: 'Failed to export prompt pool' });
        }
    });

    router.post('/api/prompt-pool/import', requirePromptPoolWrite, async (req, res) => {
        try {
            const mode = normalizeImportMode(req.body?.mode);
            const rawItems = Array.isArray(req.body?.items)
                ? req.body.items
                : (Array.isArray(req.body?.payload?.items) ? req.body.payload.items : null);
            const { parsed, skipped } = parseImportedPromptItems(rawItems);

            const result = await withSerializedMutation(() => {
                const now = new Date().toISOString();
                const current = readPromptPool();
                const baseItems = mode === 'replace' ? [] : current.map((item) => ({ ...item }));
                const byShortcut = new Map(baseItems.map((item) => [toShortcutKey(item.shortcut), item]));
                let created = 0;
                let updated = 0;

                // 匯入內部若同 shortcut 重覆，最後一筆覆蓋前一筆。
                const dedupedImported = new Map();
                for (const row of parsed) {
                    dedupedImported.set(toShortcutKey(row.shortcut), row);
                }

                for (const [, row] of dedupedImported.entries()) {
                    const shortcutKey = toShortcutKey(row.shortcut);
                    const existing = byShortcut.get(shortcutKey);
                    if (existing) {
                        existing.shortcut = row.shortcut;
                        existing.prompt = row.prompt;
                        existing.note = row.note;
                        existing.updatedAt = now;
                        updated += 1;
                    } else {
                        byShortcut.set(shortcutKey, {
                            id: createPromptId(),
                            shortcut: row.shortcut,
                            prompt: row.prompt,
                            note: row.note,
                            createdAt: now,
                            updatedAt: now,
                        });
                        created += 1;
                    }
                }

                const nextItems = [...byShortcut.values()];
                if (nextItems.length > MAX_ITEMS) {
                    throw createHttpError(400, `匯入後超過上限 ${MAX_ITEMS} 筆，請減少資料量`);
                }

                const written = writePromptPool(nextItems);
                return {
                    items: written,
                    created,
                    updated,
                    importedCount: dedupedImported.size,
                };
            });

            appendPromptPoolAuditRecord(createAuditMeta(req, 'prompt_pool_import', {
                mode,
                importedCount: result.importedCount,
                created: result.created,
                updated: result.updated,
                skippedCount: skipped.length,
            }));

            const payload = buildPromptPoolItemsPayload(result.items);
            return res.json({
                success: true,
                mode,
                importedCount: result.importedCount,
                created: result.created,
                updated: result.updated,
                skippedCount: skipped.length,
                skipped,
                items: payload.items,
                topUsedShortcuts: payload.topUsedShortcuts,
                topUsedShortcuts7d: payload.topUsedShortcuts7d,
                topUsedShortcuts30d: payload.topUsedShortcuts30d,
                usageTrend14d: payload.usageTrend14d,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const status = Number(error && error.statusCode) || 500;
            if (status === 500) {
                console.error('[PromptPool] Failed to import prompt pool:', error);
            }
            return res.status(status).json({ error: message });
        }
    });

    router.get('/api/prompt-pool/usage-trend', (req, res) => {
        try {
            const rawShortcut = String(req.query.shortcut || '').trim();
            if (!rawShortcut) {
                return res.status(400).json({ error: 'Missing shortcut' });
            }

            const shortcutKey = toShortcutKey(rawShortcut);
            if (!shortcutKey) {
                return res.status(400).json({ error: 'Invalid shortcut' });
            }

            const items = readPromptPool();
            const target = items.find((item) => toShortcutKey(item.shortcut) === shortcutKey);
            if (!target) {
                return res.status(404).json({ error: 'Prompt shortcut not found' });
            }

            const safeDays = Math.max(1, Math.min(Number(req.query.days) || DEFAULT_USAGE_TREND_DAYS, 90));
            const records = readAllPromptPoolAuditRecords();
            const trend = buildUsageTrend(records, safeDays, shortcutKey);
            const totalUseCount = trend.reduce((sum, point) => sum + Number(point.count || 0), 0);
            const peakDailyUse = trend.reduce((peak, point) => Math.max(peak, Number(point.count || 0)), 0);
            const averagePerDay = trend.length > 0 ? Number((totalUseCount / trend.length).toFixed(2)) : 0;

            return res.json({
                success: true,
                shortcut: target.shortcut,
                shortcutKey,
                days: safeDays,
                trend,
                totalUseCount,
                peakDailyUse,
                averagePerDay,
            });
        } catch (error) {
            console.error('[PromptPool] Failed to fetch usage trend:', error);
            return res.status(500).json({ error: 'Failed to fetch usage trend' });
        }
    });

    router.post('/api/prompt-pool/track-use', requirePromptPoolWrite, (req, res) => {
        try {
            const shortcutRaw = String(req.body?.shortcut || req.body?.shortcutKey || '').trim();
            const shortcutKey = toShortcutKey(shortcutRaw);
            if (!shortcutKey) {
                return res.status(400).json({ error: 'Missing shortcut' });
            }

            const source = String(req.body?.source || 'unknown').trim().slice(0, 48) || 'unknown';
            const platform = String(req.body?.platform || 'unknown').trim().slice(0, 24) || 'unknown';
            appendPromptPoolAuditRecord(createAuditMeta(req, 'prompt_pool_use', {
                shortcut: shortcutRaw || `/${shortcutKey}`,
                shortcutKey,
                source,
                platform,
            }));

            return res.json({ success: true });
        } catch (error) {
            console.error('[PromptPool] Failed to track shortcut usage:', error);
            return res.status(500).json({ error: 'Failed to track shortcut usage' });
        }
    });

    router.post('/api/prompt-pool', requirePromptPoolWrite, async (req, res) => {
        try {
            const { item, items } = await withSerializedMutation(() => {
                const current = readPromptPool();
                if (current.length >= MAX_ITEMS) {
                    throw createHttpError(400, `最多只能儲存 ${MAX_ITEMS} 筆 prompt`);
                }

                const shortcut = normalizeShortcut(req.body?.shortcut);
                assertShortcutAllowed({ shortcut, items: current });

                const now = new Date().toISOString();
                const nextItem = {
                    id: createPromptId(),
                    shortcut,
                    prompt: normalizePrompt(req.body?.prompt),
                    note: normalizeNote(req.body?.note),
                    createdAt: now,
                    updatedAt: now,
                };

                const nextItems = writePromptPool([nextItem, ...current]);
                return { item: nextItem, items: nextItems };
            });
            appendPromptPoolAuditRecord(createAuditMeta(req, 'prompt_pool_create', {
                id: item.id,
                shortcut: item.shortcut,
            }));
            const payload = buildPromptPoolItemsPayload(items);
            const enrichedItem = payload.items.find((entry) => entry.id === item.id) || item;
            return res.json({
                success: true,
                item: enrichedItem,
                items: payload.items,
                topUsedShortcuts: payload.topUsedShortcuts,
                topUsedShortcuts7d: payload.topUsedShortcuts7d,
                topUsedShortcuts30d: payload.topUsedShortcuts30d,
                usageTrend14d: payload.usageTrend14d,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const status = Number(error && error.statusCode) || 500;
            if (status === 500) {
                console.error('[PromptPool] Failed to create prompt item:', error);
            }
            return res.status(status).json({ error: message });
        }
    });

    router.put('/api/prompt-pool/:id', requirePromptPoolWrite, async (req, res) => {
        try {
            const id = String(req.params.id || '').trim();
            if (!id) return res.status(400).json({ error: 'Missing id' });

            const { updated, items, previousShortcut } = await withSerializedMutation(() => {
                const current = readPromptPool();
                const target = current.find((item) => item.id === id);
                if (!target) {
                    throw createHttpError(404, 'Prompt not found');
                }

                const shortcut = normalizeShortcut(req.body?.shortcut);
                assertShortcutAllowed({ shortcut, items: current, ignoreId: id });

                const nextUpdated = {
                    ...target,
                    shortcut,
                    prompt: normalizePrompt(req.body?.prompt),
                    note: normalizeNote(req.body?.note),
                    updatedAt: new Date().toISOString(),
                };

                const nextItems = writePromptPool(current.map((item) => (item.id === id ? nextUpdated : item)));
                return {
                    updated: nextUpdated,
                    items: nextItems,
                    previousShortcut: target.shortcut,
                };
            });
            appendPromptPoolAuditRecord(createAuditMeta(req, 'prompt_pool_update', {
                id,
                previousShortcut,
                nextShortcut: updated.shortcut,
            }));
            const payload = buildPromptPoolItemsPayload(items);
            const enrichedUpdated = payload.items.find((entry) => entry.id === updated.id) || updated;
            return res.json({
                success: true,
                item: enrichedUpdated,
                items: payload.items,
                topUsedShortcuts: payload.topUsedShortcuts,
                topUsedShortcuts7d: payload.topUsedShortcuts7d,
                topUsedShortcuts30d: payload.topUsedShortcuts30d,
                usageTrend14d: payload.usageTrend14d,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const status = Number(error && error.statusCode) || 500;
            if (status === 500) {
                console.error('[PromptPool] Failed to update prompt item:', error);
            }
            return res.status(status).json({ error: message });
        }
    });

    router.delete('/api/prompt-pool/:id', requirePromptPoolWrite, async (req, res) => {
        try {
            const id = String(req.params.id || '').trim();
            if (!id) return res.status(400).json({ error: 'Missing id' });

            const { items, deletedShortcut } = await withSerializedMutation(() => {
                const current = readPromptPool();
                const target = current.find((item) => item.id === id);
                if (!target) {
                    throw createHttpError(404, 'Prompt not found');
                }

                const nextItems = writePromptPool(current.filter((item) => item.id !== id));
                return { items: nextItems, deletedShortcut: target.shortcut };
            });
            appendPromptPoolAuditRecord(createAuditMeta(req, 'prompt_pool_delete', {
                id,
                shortcut: deletedShortcut,
            }));
            const payload = buildPromptPoolItemsPayload(items);
            return res.json({
                success: true,
                items: payload.items,
                topUsedShortcuts: payload.topUsedShortcuts,
                topUsedShortcuts7d: payload.topUsedShortcuts7d,
                topUsedShortcuts30d: payload.topUsedShortcuts30d,
                usageTrend14d: payload.usageTrend14d,
            });
        } catch (error) {
            if (!(error && error.statusCode)) {
                console.error('[PromptPool] Failed to delete prompt item:', error);
            }
            const message = error instanceof Error ? error.message : String(error);
            const status = Number(error && error.statusCode) || 500;
            return res.status(status).json({ error: message });
        }
    });

    router.post('/api/prompt-pool/repair-conflicts', requirePromptPoolWrite, async (req, res) => {
        try {
            const result = await withSerializedMutation(() => {
                const current = readPromptPool();
                const next = current.map((item) => ({ ...item }));
                const repaired = [];
                const occupied = new Set(
                    next
                        .map((item) => toShortcutKey(item.shortcut))
                        .filter(Boolean)
                );
                const keptDuplicateShortcutKeys = new Set();
                const conflictMap = new Map(collectLegacyConflicts(next).map((item) => [item.id, item]));

                for (const item of next) {
                    const conflict = conflictMap.get(item.id);
                    if (!conflict) continue;

                    const oldShortcut = String(item.shortcut || '').trim();
                    const oldKey = toShortcutKey(oldShortcut);
                    if (oldKey) occupied.delete(oldKey);

                    const canKeepExisting =
                        conflict.reason === 'duplicate_shortcut' &&
                        oldShortcut &&
                        isShortcutFormatValid(oldShortcut) &&
                        !isReservedSystemCommandShortcut(oldShortcut) &&
                        !keptDuplicateShortcutKeys.has(oldKey);

                    if (canKeepExisting) {
                        keptDuplicateShortcutKeys.add(oldKey);
                        occupied.add(oldKey);
                        continue;
                    }

                    const nextShortcut = findAvailableRepairShortcut(oldShortcut, occupied);
                    const nextKey = toShortcutKey(nextShortcut);
                    item.shortcut = nextShortcut;
                    item.updatedAt = new Date().toISOString();
                    occupied.add(nextKey);

                    repaired.push({
                        id: item.id,
                        oldShortcut,
                        newShortcut: nextShortcut,
                        reason: conflict.reason,
                    });
                }

                const items = writePromptPool(next);
                const legacyConflicts = collectLegacyConflicts(items);
                return {
                    items,
                    repaired,
                    repairedCount: repaired.length,
                    legacyConflicts,
                    hasLegacyConflicts: legacyConflicts.length > 0,
                };
            });
            appendPromptPoolAuditRecord(createAuditMeta(req, 'prompt_pool_repair_conflicts', {
                repairedCount: result.repairedCount,
                repaired: result.repaired,
                remainingConflicts: result.legacyConflicts.map((item) => ({
                    id: item.id,
                    shortcut: item.shortcut,
                    reason: item.reason,
                })),
            }));

            const payload = buildPromptPoolItemsPayload(result.items);
            return res.json({
                success: true,
                ...result,
                items: payload.items,
                topUsedShortcuts: payload.topUsedShortcuts,
                topUsedShortcuts7d: payload.topUsedShortcuts7d,
                topUsedShortcuts30d: payload.topUsedShortcuts30d,
                usageTrend14d: payload.usageTrend14d,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const status = Number(error && error.statusCode) || 500;
            if (status === 500) {
                console.error('[PromptPool] Failed to repair legacy conflicts:', error);
            }
            return res.status(status).json({ error: message });
        }
    });

    return router;
};

module.exports.__test__ = {
    PROMPT_POOL_DIR,
    PROMPT_POOL_PATH,
    PROMPT_POOL_AUDIT_DIR,
    PROMPT_POOL_AUDIT_PATH,
    normalizeShortcut,
    normalizePrompt,
    normalizeNote,
    toShortcutKey,
    isShortcutFormatValid,
    readPromptPool,
    writePromptPool,
    appendPromptPoolAuditRecord,
    readPromptPoolAuditRecords,
    readAllPromptPoolAuditRecords,
    buildPromptUsageMap,
    withPromptUsageStats,
    buildTopUsedShortcuts,
    buildTopUsedShortcutsFromUsageMap,
    buildUsageTrend,
    buildPromptPoolItemsPayload,
    collectLegacyConflicts,
    findAvailableRepairShortcut,
    withSerializedMutation,
    isReservedSystemCommandShortcut,
    getSystemCommandSet,
};
