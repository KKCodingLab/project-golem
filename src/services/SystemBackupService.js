const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const BACKUP_VERSION = '1.0.0';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

const EXCLUDED_DIRS = new Set([
    'logs',
    'tmp',
    '.tmp',
    'cache',
    'GraphiteDawnCache',
    'extensions_crx_cache',
    'component_crx_cache',
    'segmentation_platform',
    '.git'
]);

const EXCLUDED_FILES = new Set([
    '.DS_Store'
]);

const SQLITE_TRANSIENT_FILE_RE = /(?:-shm|-wal|-journal)$/i;

function shouldSkipEntry(name) {
    return EXCLUDED_DIRS.has(name) || EXCLUDED_FILES.has(name);
}

function isJsonLike(name) {
    return name.endsWith('.json') || name.endsWith('.md') || name.endsWith('.txt');
}

function walkFiles(rootDir, relativeDir = '', files = [], skipped = []) {
    const absDir = path.join(rootDir, relativeDir);
    let entries = [];
    try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (error) {
        skipped.push({ path: toUnixPath(relativeDir || '.'), reason: `readdir_failed:${error.code || 'unknown'}` });
        return { files, skipped };
    }
    for (const entry of entries) {
        if (shouldSkipEntry(entry.name)) continue;
        const relPath = path.join(relativeDir, entry.name);
        const absPath = path.join(rootDir, relPath);
        if (entry.isDirectory()) {
            walkFiles(rootDir, relPath, files, skipped);
            continue;
        }
        if (entry.isFile()) files.push({ relPath, absPath });
    }
    return { files, skipped };
}

function toUnixPath(p) {
    return p.split(path.sep).join('/');
}

function isLikelyWindowsLockError(error) {
    const code = String(error?.code || '').toUpperCase();
    if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'UNKNOWN') return true;
    const message = String(error?.message || '').toLowerCase();
    return message.includes('resource busy') || message.includes('permission denied') || message.includes('being used by another process');
}

function isSqliteTransientPath(relPath) {
    const normalized = String(relPath || '').replace(/\\/g, '/').toLowerCase();
    return normalized.endsWith('-shm') || normalized.endsWith('-wal') || normalized.endsWith('-journal');
}

function sha256Hex(input) {
    return crypto.createHash('sha256').update(input).digest('hex');
}

function encodeFile(absPath, relPath, stats) {
    const binary = fs.readFileSync(absPath);
    return {
        path: toUnixPath(relPath),
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        encoding: 'base64',
        sha256: sha256Hex(binary),
        content: binary.toString('base64')
    };
}

function collectSectionFromDir(sectionName, baseDir) {
    if (!baseDir || !fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) {
        return { name: sectionName, root: baseDir || null, files: [], skipped: [] };
    }

    const files = [];
    const skipped = [];
    let totalBytes = 0;
    const walked = walkFiles(baseDir);
    const entries = walked.files;
    skipped.push(...(walked.skipped || []));
    for (const item of entries) {
        let stat;
        try {
            stat = fs.statSync(item.absPath);
        } catch (error) {
            skipped.push({ path: toUnixPath(item.relPath), reason: `stat_failed:${error.code || 'unknown'}` });
            continue;
        }
        if (stat.size > MAX_FILE_BYTES) {
            skipped.push({ path: toUnixPath(item.relPath), reason: `file_too_large:${stat.size}` });
            continue;
        }
        if (isSqliteTransientPath(item.relPath) || SQLITE_TRANSIENT_FILE_RE.test(item.relPath)) {
            skipped.push({ path: toUnixPath(item.relPath), reason: 'sqlite_transient_runtime_file' });
            continue;
        }
        if (totalBytes + stat.size > MAX_TOTAL_BYTES) {
            skipped.push({ path: toUnixPath(item.relPath), reason: `section_limit_exceeded:${stat.size}` });
            continue;
        }
        try {
            files.push(encodeFile(item.absPath, item.relPath, stat));
        } catch (error) {
            skipped.push({ path: toUnixPath(item.relPath), reason: `read_failed:${error.code || 'unknown'}` });
            continue;
        }
        totalBytes += stat.size;
    }

    return {
        name: sectionName,
        root: baseDir,
        files,
        skipped
    };
}

function collectSingleFile(sectionName, filePath, relLabel) {
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return { name: sectionName, root: filePath || null, files: [], skipped: [] };
    }
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_BYTES) {
        return {
            name: sectionName,
            root: filePath,
            files: [],
            skipped: [{ path: relLabel, reason: `file_too_large:${stat.size}` }]
        };
    }
    return {
        name: sectionName,
        root: filePath,
        files: [encodeFile(filePath, relLabel, stat)],
        skipped: []
    };
}

function restoreSection(targetRoot, files) {
    if (!targetRoot) return { restored: 0, skipped: [] };
    fs.mkdirSync(targetRoot, { recursive: true });
    let restored = 0;
    const skipped = [];
    for (const file of files || []) {
        const relPath = String(file.path || '').replace(/^\/+/, '');
        if (!relPath || relPath.includes('..')) continue;
        const absPath = path.resolve(path.join(targetRoot, relPath));
        const rootResolved = path.resolve(targetRoot);
        if (!absPath.startsWith(`${rootResolved}${path.sep}`)) continue;
        try {
            fs.mkdirSync(path.dirname(absPath), { recursive: true });
            const content = Buffer.from(String(file.content || ''), 'base64');
            fs.writeFileSync(absPath, content);
            restored += 1;
        } catch (error) {
            const sqliteTransient = isSqliteTransientPath(relPath) || SQLITE_TRANSIENT_FILE_RE.test(relPath);
            const lockLike = isLikelyWindowsLockError(error);
            if (sqliteTransient || lockLike) {
                skipped.push({
                    path: toUnixPath(relPath),
                    reason: sqliteTransient ? `sqlite_transient_or_locked:${error.code || 'UNKNOWN'}` : `write_locked:${error.code || 'UNKNOWN'}`
                });
                continue;
            }
            throw error;
        }
    }
    return { restored, skipped };
}

function normalizeSection(section) {
    if (!section || typeof section !== 'object') return null;
    const name = String(section.name || '');
    if (!name) return null;
    return {
        name,
        root: section.root || null,
        files: Array.isArray(section.files) ? section.files : [],
        skipped: Array.isArray(section.skipped) ? section.skipped : []
    };
}

function normalizeV0Payload(payload) {
    const files = Array.isArray(payload?.files) ? payload.files : [];
    return {
        meta: {
            schemaVersion: SCHEMA_VERSION,
            backupVersion: payload?.backupVersion || '0-migrated',
            appVersion: payload?.appVersion || 'unknown',
            createdAt: payload?.createdAt || new Date().toISOString(),
            platform: payload?.platform || 'unknown',
            migratedFromSchema: 0
        },
        env: payload?.env && typeof payload.env === 'object' ? payload.env : {},
        sections: [{
            name: 'golem_memory',
            root: null,
            files,
            skipped: []
        }]
    };
}

function migratePayload(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid backup payload');
    if (Array.isArray(payload.sections)) {
        const normalized = {
            meta: payload.meta && typeof payload.meta === 'object' ? payload.meta : {},
            env: payload.env && typeof payload.env === 'object' ? payload.env : {},
            sections: payload.sections.map(normalizeSection).filter(Boolean)
        };
        normalized.meta.schemaVersion = Number(normalized.meta.schemaVersion || 1);
        return { migrated: normalized, migration: normalized.meta.schemaVersion === SCHEMA_VERSION ? 'none' : 'normalized' };
    }

    if (Array.isArray(payload.files)) {
        return { migrated: normalizeV0Payload(payload), migration: 'v0_to_v1' };
    }

    throw new Error('Unsupported backup format');
}

function withChecksum(payload) {
    const next = {
        meta: payload.meta,
        env: payload.env || {},
        sections: Array.isArray(payload.sections) ? payload.sections : []
    };
    return {
        ...next,
        checksum: sha256Hex(JSON.stringify(next))
    };
}

function buildBackupPayload({ appVersion, memoryBaseDir, repoRoot, envSnapshot }) {
    const calendarFile = path.join(repoRoot, 'data', 'dashboard', 'collab-calendar.json');
    const referenceFile = path.join(repoRoot, 'data', 'reference-files.json');

    const sections = [
        collectSectionFromDir('golem_memory', memoryBaseDir),
        collectSingleFile('collab_calendar', calendarFile, 'data/dashboard/collab-calendar.json'),
        collectSingleFile('reference_files', referenceFile, 'data/reference-files.json')
    ];

    const payload = {
        meta: {
            schemaVersion: SCHEMA_VERSION,
            backupVersion: BACKUP_VERSION,
            appVersion: appVersion || 'unknown',
            createdAt: new Date().toISOString(),
            platform: process.platform
        },
        env: {
            GOLEM_BACKEND: envSnapshot.GOLEM_BACKEND || '',
            GOLEM_MEMORY_MODE: envSnapshot.GOLEM_MEMORY_MODE || '',
            GOLEM_EMBEDDING_PROVIDER: envSnapshot.GOLEM_EMBEDDING_PROVIDER || '',
            GOLEM_LOCAL_EMBEDDING_MODEL: envSnapshot.GOLEM_LOCAL_EMBEDDING_MODEL || '',
            TZ: envSnapshot.TZ || ''
        },
        sections
    };
    return withChecksum(payload);
}

function validateAndMigrateBackupPayload(payload) {
    const { migrated, migration } = migratePayload(payload);
    const schemaVersion = Number(migrated?.meta?.schemaVersion || 0);
    if (schemaVersion !== SCHEMA_VERSION) {
        throw new Error(`Unsupported schema version: ${schemaVersion}`);
    }
    const expectedChecksum = sha256Hex(JSON.stringify({ meta: migrated.meta, env: migrated.env, sections: migrated.sections }));
    if (payload.checksum && payload.checksum !== expectedChecksum) {
        throw new Error('Backup checksum mismatch');
    }
    const withSum = withChecksum(migrated);
    return { payload: withSum, migration };
}

function previewRestoreBackupPayload(inputPayload) {
    const { payload, migration } = validateAndMigrateBackupPayload(inputPayload);
    const supported = new Set(['golem_memory', 'collab_calendar', 'reference_files']);
    const sections = Array.isArray(payload.sections) ? payload.sections : [];
    const previewSections = sections.map((section) => {
        const name = String(section?.name || '');
        const files = Array.isArray(section?.files) ? section.files : [];
        const skipped = Array.isArray(section?.skipped) ? section.skipped.length : 0;
        const bytes = files.reduce((sum, f) => sum + Number(f?.size || 0), 0);
        return {
            name,
            fileCount: files.length,
            bytes,
            skippedCount: skipped,
            restorable: supported.has(name),
            risk: skipped > 0 ? 'partial' : (supported.has(name) ? 'low' : 'unsupported_section')
        };
    });
    const totals = previewSections.reduce((acc, s) => {
        acc.files += s.fileCount;
        acc.bytes += s.bytes;
        if (!s.restorable) acc.unrestorableSections += 1;
        if (s.skippedCount > 0) acc.partialSections += 1;
        return acc;
    }, { files: 0, bytes: 0, unrestorableSections: 0, partialSections: 0 });

    return {
        schemaVersion: payload.meta?.schemaVersion || SCHEMA_VERSION,
        sourceAppVersion: payload.meta?.appVersion || 'unknown',
        createdAt: payload.meta?.createdAt || null,
        migrationApplied: migration,
        sections: previewSections,
        totals,
        warnings: [
            totals.unrestorableSections > 0 ? `${totals.unrestorableSections} section(s) are not supported by current restore logic.` : null,
            totals.partialSections > 0 ? `${totals.partialSections} section(s) include skipped items and may restore partially.` : null
        ].filter(Boolean)
    };
}

function restoreBackupPayload(inputPayload, { memoryBaseDir, repoRoot }) {
    const { payload, migration } = validateAndMigrateBackupPayload(inputPayload);
    const sections = Array.isArray(payload.sections) ? payload.sections : [];
    const summary = { restoredFiles: 0, sections: {}, skipped: [] };

    for (const section of sections) {
        if (!section || typeof section !== 'object') continue;
        const name = String(section.name || '');
        if (name === 'golem_memory') {
            const result = restoreSection(memoryBaseDir, section.files);
            summary.restoredFiles += result.restored;
            summary.sections.golem_memory = result.restored;
            if (Array.isArray(result.skipped) && result.skipped.length) {
                summary.skipped.push(...result.skipped.map((s) => ({ section: 'golem_memory', ...s })));
            }
            continue;
        }
        if (name === 'collab_calendar') {
            const targetRoot = path.join(repoRoot, 'data', 'dashboard');
            const result = restoreSection(targetRoot, section.files?.map((f) => ({ ...f, path: 'collab-calendar.json' })));
            summary.restoredFiles += result.restored;
            summary.sections.collab_calendar = result.restored;
            if (Array.isArray(result.skipped) && result.skipped.length) {
                summary.skipped.push(...result.skipped.map((s) => ({ section: 'collab_calendar', ...s })));
            }
            continue;
        }
        if (name === 'reference_files') {
            const targetRoot = path.join(repoRoot, 'data');
            const result = restoreSection(targetRoot, section.files?.map((f) => ({ ...f, path: 'reference-files.json' })));
            summary.restoredFiles += result.restored;
            summary.sections.reference_files = result.restored;
            if (Array.isArray(result.skipped) && result.skipped.length) {
                summary.skipped.push(...result.skipped.map((s) => ({ section: 'reference_files', ...s })));
            }
        }
    }

    return { ...summary, migrationApplied: migration };
}

module.exports = {
    SCHEMA_VERSION,
    BACKUP_VERSION,
    buildBackupPayload,
    previewRestoreBackupPayload,
    validateAndMigrateBackupPayload,
    restoreBackupPayload
};
