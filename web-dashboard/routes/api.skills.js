const express = require('express');
const fs = require('fs');
const path = require('path');
const { MANDATORY_SKILLS, OPTIONAL_SKILLS: OPTIONAL_SKILL_LIST, resolveEnabledSkills } = require('../../src/skills/skillsConfig');
const { ProtocolFormatter } = require('../../packages/protocol');
const { buildOperationGuard } = require('../server/security');
const { resolveActiveContext } = require('./utils/context');
const SkillPackageRegistry = require('../../src/managers/SkillPackageRegistry');

function extractSkillTitle(record) {
    const content = String(record.content || '');
    if (!content) return '';

    const headingMatch = content.match(/^#+\s+(.+)$/m);
    if (headingMatch && headingMatch[1]) {
        return headingMatch[1].trim();
    }

    const bracketMatch = content.match(/^【(.+)】/m);
    if (bracketMatch && bracketMatch[1]) {
        return bracketMatch[1].replace(/^已載入技能：/, '').trim();
    }

    const firstLineMatch = content.match(/^([^\n]+)/);
    return firstLineMatch && firstLineMatch[1] ? firstLineMatch[1].trim() : '';
}

function normalizeSkillRecord(record, enabledSkills) {
    const id = String(record.id || '').trim().toLowerCase();
    if (!id) return null;

    const category = String(record.category || 'lib').trim().toLowerCase();
    const isDynamic = category === 'user_dynamic' || category === 'runtime' || category === 'runtime_user';
    const isMandatory = MANDATORY_SKILLS.includes(id);

    let title = String(record.name || '').trim();
    if (!title) title = extractSkillTitle(record);
    if (!title) title = id;

    return {
        id,
        title,
        isOptional: isDynamic ? false : !isMandatory,
        isDeletable: !isMandatory,
        isEnabled: isDynamic ? true : (isMandatory || enabledSkills.has(id)),
        content: String(record.content || ''),
        category
    };
}

function safeExportToken(value, fallback = 'default') {
    const normalized = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return normalized || fallback;
}

function safeSkillId(value, fallback = 'imported_skill') {
    const normalized = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return normalized || fallback;
}

function parseBooleanLike(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
    return fallback;
}

function normalizeImportedSkill(raw, index = 0) {
    if (!raw || typeof raw !== 'object') return null;
    const record = raw;
    const title = String(record.title || record.name || `Imported Skill ${index + 1}`).trim();
    const idSeed = String(record.id || title || '').trim();
    const id = safeSkillId(idSeed, `imported_skill_${index + 1}`);
    const content = String(record.content || '').trim();
    if (!content) return null;

    return {
        id,
        title: title || id,
        content,
        category: String(record.category || 'lib').trim().toLowerCase() || 'lib',
        isEnabled: parseBooleanLike(record.isEnabled, false),
        isOptional: parseBooleanLike(record.isOptional, true)
    };
}

function parseImportedSkillsFromJsonPayload(payload) {
    let parsed = payload;
    if (typeof payload === 'string') {
        parsed = JSON.parse(payload);
    }

    const list = Array.isArray(parsed)
        ? parsed
        : (parsed && Array.isArray(parsed.skills) ? parsed.skills : null);

    if (!list) {
        throw new Error('Invalid JSON skill backup format');
    }

    const normalized = [];
    for (let i = 0; i < list.length; i += 1) {
        const item = normalizeImportedSkill(list[i], i);
        if (item) normalized.push(item);
    }
    return normalized;
}

function parseImportedSkillsFromMarkdown(markdown) {
    const raw = String(markdown || '').replace(/^\uFEFF/, '').trim();
    if (!raw) return [];

    const sectionPattern = /(?:^|\n)---\n\n## ([^\n]+)\n\n- ID: ([^\n]+)\n- Category: ([^\n]+)\n- Enabled: (true|false)\n- Optional: (true|false)\n\n([\s\S]*?)(?=\n---\n\n## |\s*$)/g;
    const skills = [];
    let match;
    while ((match = sectionPattern.exec(raw)) !== null) {
        const normalized = normalizeImportedSkill({
            title: String(match[1] || '').trim(),
            id: String(match[2] || '').trim(),
            category: String(match[3] || '').trim().toLowerCase(),
            isEnabled: String(match[4] || '').trim().toLowerCase() === 'true',
            isOptional: String(match[5] || '').trim().toLowerCase() === 'true',
            content: String(match[6] || '').trim(),
        }, skills.length);
        if (normalized) skills.push(normalized);
    }

    if (skills.length > 0) return skills;

    const headingMatch = raw.match(/^#+\s+(.+)$/m);
    const bracketMatch = raw.match(/^【已載入技能：(.+?)】/m);
    const inferredTitle = (headingMatch && headingMatch[1])
        ? headingMatch[1].trim()
        : (bracketMatch && bracketMatch[1] ? bracketMatch[1].trim() : 'Imported Skill');
    const single = normalizeImportedSkill({
        id: inferredTitle,
        title: inferredTitle,
        content: raw,
        category: 'lib',
        isEnabled: false,
        isOptional: true,
    }, 0);
    return single ? [single] : [];
}

async function resolveSkillUserDataDir(server, golemIdQuery) {
    const { context } = resolveActiveContext(server, golemIdQuery);
    const { MEMORY_BASE_DIR } = require('../../src/config');
    return (context && context.brain && context.brain.userDataDir)
        ? context.brain.userDataDir
        : MEMORY_BASE_DIR;
}

function buildSkillsMarkdownBook(skillsData, golemId) {
    const lines = [
        '# Golem Skills Book Export',
        '',
        `- Exported At: ${new Date().toISOString()}`,
        `- Golem ID: ${golemId || 'default'}`,
        `- Total Skills: ${skillsData.length}`,
        ''
    ];

    for (const skill of skillsData) {
        const rawContent = String(skill.content || '').trim();
        lines.push('---');
        lines.push('');
        lines.push(`## ${skill.title}`);
        lines.push('');
        lines.push(`- ID: ${skill.id}`);
        lines.push(`- Category: ${skill.category || 'lib'}`);
        lines.push(`- Enabled: ${skill.isEnabled ? 'true' : 'false'}`);
        lines.push(`- Optional: ${skill.isOptional ? 'true' : 'false'}`);
        lines.push('');
        lines.push(rawContent || '_No content_');
        lines.push('');
    }

    return lines.join('\n');
}

async function collectInstalledSkills(server, golemIdQuery) {
    const libPath = path.join(process.cwd(), 'src', 'skills', 'lib');
    const files = fs.existsSync(libPath)
        ? fs.readdirSync(libPath).filter(f => f.endsWith('.md'))
        : [];
    const enabledSkills = resolveEnabledSkills(process.env.OPTIONAL_SKILLS || '', []);
    const skillsMap = new Map();

    try {
        const userDataDir = await resolveSkillUserDataDir(server, golemIdQuery);

        const SkillIndexManager = require('../../src/managers/SkillIndexManager');
        const idx = new SkillIndexManager(userDataDir);

        try {
            const records = await idx.listSkillEntries();
            for (const record of records) {
                const normalized = normalizeSkillRecord(record, enabledSkills);
                if (normalized) skillsMap.set(normalized.id, normalized);
            }
        } finally {
            await idx.close();
        }
    } catch (e) {
        console.warn('⚠️ [WebServer] Failed to load skills from SQLite, fallback to filesystem:', e.message);
    }

    if (fs.existsSync(libPath)) {
        for (const file of files) {
            const content = fs.readFileSync(path.join(libPath, file), 'utf8');
            const baseName = file.replace('.md', '').toLowerCase();

            const existing = skillsMap.get(baseName);
            if (existing) {
                if (!existing.content) {
                    existing.content = content;
                    skillsMap.set(baseName, existing);
                }
                continue;
            }

            const normalized = normalizeSkillRecord({
                id: baseName,
                name: '',
                content,
                category: 'lib'
            }, enabledSkills);
            if (normalized) skillsMap.set(baseName, normalized);
        }
    }

    const userDataDir = await resolveSkillUserDataDir(server, golemIdQuery);
    for (const pkg of SkillPackageRegistry.listSkillPackages({ userDataDir })) {
        if (skillsMap.has(pkg.id)) continue;
        const content = SkillPackageRegistry.buildPromptContent(pkg);
        const normalized = normalizeSkillRecord({
            id: pkg.id,
            name: pkg.name,
            description: pkg.description,
            content,
            path: pkg.dir,
            category: pkg.type || 'core',
        }, enabledSkills);
        if (normalized) {
            normalized.isEnabled = pkg.type === 'user_generated'
                ? pkg.enabled !== false
                : normalized.isEnabled && pkg.enabled !== false;
            skillsMap.set(pkg.id, normalized);
        }
    }

    const skillsData = Array.from(skillsMap.values());
    skillsData.sort((a, b) => {
        if (a.isEnabled && !b.isEnabled) return -1;
        if (!a.isEnabled && b.isEnabled) return 1;
        return a.id.localeCompare(b.id);
    });

    return skillsData;
}

module.exports = function(server) {
    const router = express.Router();
    const requireSkillAdmin = buildOperationGuard(server, 'skills_admin_operation');

    router.get('/api/skills/marketplace', (req, res) => {
        try {
            const marketplaceDir = path.join(process.cwd(), 'data', 'marketplace', 'skills');
            let allSkills = [];

            const { search, category, page = 1, limit = 20 } = req.query;

            if (category && category !== 'all') {
                const catFile = path.join(marketplaceDir, `${category}.json`);
                if (fs.existsSync(catFile)) {
                    allSkills = JSON.parse(fs.readFileSync(catFile, 'utf8'));
                }
            } else {
                if (fs.existsSync(marketplaceDir)) {
                    const files = fs.readdirSync(marketplaceDir).filter(f => f.endsWith('.json'));
                    for (const file of files) {
                        const data = JSON.parse(fs.readFileSync(path.join(marketplaceDir, file), 'utf8'));
                        allSkills = allSkills.concat(data);
                    }
                }
            }

            if (category && category !== 'all') {
                allSkills = allSkills.filter(s => s.category === category);
            }
            if (search) {
                const term = search.toLowerCase();
                allSkills = allSkills.filter(s => s.title.toLowerCase().includes(term) || s.description.toLowerCase().includes(term));
            }

            const total = allSkills.length;
            const startIndex = (Number(page) - 1) * Number(limit);
            const endIndex = startIndex + Number(limit);
            const skills = allSkills.slice(startIndex, endIndex);

            const categoryCounts = {};
            let totalMarketSkills = 0;
            if (fs.existsSync(marketplaceDir)) {
                const files = fs.readdirSync(marketplaceDir).filter(f => f.endsWith('.json'));
                for (const file of files) {
                    const data = JSON.parse(fs.readFileSync(path.join(marketplaceDir, file), 'utf8'));
                    const categoryId = file.replace('.json', '');
                    categoryCounts[categoryId] = data.length;
                    totalMarketSkills += data.length;
                }
            }
            categoryCounts['all'] = totalMarketSkills;

            return res.json({ skills, total, categoryCounts });
        } catch (e) {
            console.error("Failed to read marketplace skills:", e);
            return res.status(500).json({ error: e.message });
        }
    });

    router.post('/api/skills/marketplace/install', requireSkillAdmin, async (req, res) => {
        try {
            const { id, repoUrl } = req.body;
            if (!id || !repoUrl) return res.status(400).json({ error: 'Missing id or repoUrl' });

            // SSRF 防護：驗證 URL 來源是否安全
            const parsedUrl = new URL(repoUrl);
            const allowedHosts = ['github.com', 'raw.githubusercontent.com'];
            if (!allowedHosts.includes(parsedUrl.hostname)) {
                return res.status(400).json({ error: 'Invalid repository host. Only github.com is allowed.' });
            }

            let rawUrl = repoUrl
                .replace('github.com', 'raw.githubusercontent.com')
                .replace('/tree/', '/');

            if (!rawUrl.toLowerCase().endsWith('.md')) {
                if (rawUrl.endsWith('/')) rawUrl += 'SKILL.md';
                else rawUrl += '/SKILL.md';
            }

            const https = require('https');

            async function fetchWithFallback(url, id) {
                const tryUrls = [
                    url,
                    url.replace(/\/SKILL\.md$/i, `/${id}/SKILL.md`),
                    url.replace(/\/SKILL\.md$/i, `/${id}/skill.md`),
                    url.endsWith('SKILL.md') ? url.replace('SKILL.md', 'skill.md') : url + '/skill.md'
                ];
                const uniqueUrls = [...new Set(tryUrls)];

                for (const targetUrl of uniqueUrls) {
                    try {
                        const data = await new Promise((resolve) => {
                            const options = { headers: { 'User-Agent': 'Golem-Dashboard-Installer' } };
                            https.get(targetUrl, options, (response) => {
                                if (response.statusCode === 200) {
                                    let body = '';
                                    response.on('data', chunk => body += chunk);
                                    response.on('end', () => resolve(body));
                                } else {
                                    resolve(null);
                                }
                            }).on('error', () => resolve(null));
                        });
                        if (data) return data;
                    } catch {
                        continue;
                    }
                }
                return null;
            }

            const content = await fetchWithFallback(rawUrl, id);
            if (!content) {
                return res.status(404).json({ error: 'Skill markdown not found even after trying subdirectories' });
            }

            const safeId = id.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
            const userDataDir = await resolveSkillUserDataDir(server, req.query.golemId);
            const packageRoot = SkillPackageRegistry.getUserSkillPackageDir(userDataDir);
            const packageDir = path.join(packageRoot, safeId);
            const filePath = path.join(packageDir, 'skill.md');

            let title = safeId;
            let parsedContent = content.toString().replace(/^\uFEFF/, '').trim();

            const fmMatch = parsedContent.match(/^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
            if (fmMatch) {
                const yaml = fmMatch[1];
                const nameMatch = yaml.match(/^name:\s*(.+)$/m);
                if (nameMatch) {
                    title = nameMatch[1].replace(/^["']|["']$/g, '').trim();
                }
                parsedContent = fmMatch[2].trim();
            } else {
                const hMatch = parsedContent.match(/^#+\s+(.+)$/m);
                if (hMatch) title = hMatch[1].trim();
            }

            const finalContent = `【已載入技能：${title}】\n\n${parsedContent}`;
            if (!fs.existsSync(packageDir)) fs.mkdirSync(packageDir, { recursive: true });
            fs.writeFileSync(filePath, finalContent, 'utf8');
            fs.writeFileSync(path.join(packageDir, 'manifest.json'), JSON.stringify({
                id: safeId,
                name: title,
                description: '',
                type: 'user_prompt',
                enabled: true,
                action: safeId,
                entry: null,
                prompt: 'skill.md',
                toolsets: ['assistant'],
                triggers: [],
                createdBy: 'marketplace',
                createdAt: new Date().toISOString(),
                version: '1.0.0'
            }, null, 2) + '\n', 'utf8');
            console.log(`✨ [WebServer] Marketplace skill package installed: ${safeId}`);

            const SkillIndexManager = require('../../src/managers/SkillIndexManager');
            const idx = new SkillIndexManager(userDataDir);
            await idx.addSkillPackage(SkillPackageRegistry.loadPackage(packageDir)).catch(e => console.error(`[SkillIndex] MarketplaceInstall-Add Error for ${safeId}:`, e.message));
            await idx.close();

            return res.json({ success: true, id: safeId });
        } catch (e) {
            console.error('Failed to install marketplace skill:', e);
            return res.status(500).json({ error: e.message });
        }
    });

    router.get('/api/skills', async (req, res) => {
        try {
            const skillsData = await collectInstalledSkills(server, req.query.golemId);
            return res.json(skillsData);
        } catch (e) {
            console.error("Failed to read skills:", e);
            return res.status(500).json({ error: e.message });
        }
    });

    router.get('/api/skills/export', async (req, res) => {
        try {
            const requestedId = String(req.query.id || '').trim().toLowerCase();
            const requestedIdsRaw = Array.isArray(req.query.ids)
                ? req.query.ids.join(',')
                : String(req.query.ids || '');
            const requestedIds = [...new Set(
                requestedIdsRaw
                    .split(',')
                    .map((item) => String(item || '').trim().toLowerCase())
                    .filter(Boolean)
            )];
            const requestedFormat = String(req.query.format || '').trim().toLowerCase();
            const { golemId } = resolveActiveContext(server, req.query.golemId);
            const golemToken = safeExportToken(golemId, 'export');
            const now = Date.now();

            const skillsData = await collectInstalledSkills(server, req.query.golemId);

            if (requestedId) {
                const matched = skillsData.find(skill => skill.id === requestedId);
                if (!matched) {
                    return res.status(404).json({ error: `Skill '${requestedId}' not found` });
                }

                const fileName = `skill_${matched.id}_${golemToken}_${now}.md`;
                res.setHeader('Content-disposition', `attachment; filename=${fileName}`);
                res.setHeader('Content-type', 'text/markdown; charset=utf-8');
                return res.send(String(matched.content || '').trim());
            }

            let exportSkills = skillsData;
            if (requestedIds.length > 0) {
                const requestedSet = new Set(requestedIds);
                exportSkills = skillsData.filter((skill) => requestedSet.has(skill.id));

                if (exportSkills.length === 0) {
                    return res.status(404).json({ error: 'Requested skills not found' });
                }
            }

            if (requestedFormat === 'json') {
                const exportPayload = {
                    exportedAt: new Date().toISOString(),
                    golemId: golemId || null,
                    total: exportSkills.length,
                    skills: exportSkills.map((skill) => ({
                        id: skill.id,
                        title: skill.title,
                        content: skill.content,
                        category: skill.category,
                        isEnabled: skill.isEnabled,
                        isOptional: skill.isOptional
                    }))
                };

                const fileName = requestedIds.length > 0
                    ? `skills_selected_${exportSkills.length}_${golemToken}_${now}.json`
                    : `skills_backup_${golemToken}_${now}.json`;
                res.setHeader('Content-disposition', `attachment; filename=${fileName}`);
                res.setHeader('Content-type', 'application/json');
                return res.send(JSON.stringify(exportPayload, null, 2));
            }

            const markdownBook = buildSkillsMarkdownBook(exportSkills, golemId);
            const fileName = requestedIds.length > 0
                ? `skills_selected_${exportSkills.length}_${golemToken}_${now}.md`
                : `skills_book_${golemToken}_${now}.md`;
            res.setHeader('Content-disposition', `attachment; filename=${fileName}`);
            res.setHeader('Content-type', 'text/markdown; charset=utf-8');
            return res.send(markdownBook);
        } catch (e) {
            console.error('Failed to export skills:', e);
            return res.status(500).json({ error: e.message });
        }
    });

    router.post('/api/skills/import', requireSkillAdmin, async (req, res) => {
        try {
            const format = String(req.body?.format || 'auto').trim().toLowerCase();
            const payload = req.body?.payload;
            const restoreEnabled = parseBooleanLike(req.body?.restoreEnabled, true);
            const overwriteExisting = parseBooleanLike(req.body?.overwriteExisting, true);

            if (payload === undefined || payload === null) {
                return res.status(400).json({ error: 'Missing payload' });
            }

            let importedSkills;
            if (format === 'json') {
                importedSkills = parseImportedSkillsFromJsonPayload(payload);
            } else if (format === 'markdown' || format === 'md') {
                importedSkills = parseImportedSkillsFromMarkdown(payload);
            } else {
                if (typeof payload === 'string') {
                    try {
                        importedSkills = parseImportedSkillsFromJsonPayload(payload);
                    } catch {
                        importedSkills = parseImportedSkillsFromMarkdown(payload);
                    }
                } else {
                    importedSkills = parseImportedSkillsFromJsonPayload(payload);
                }
            }

            if (!Array.isArray(importedSkills) || importedSkills.length === 0) {
                return res.status(400).json({ error: 'No valid skills found in import payload' });
            }

            const userDataDir = await resolveSkillUserDataDir(server, req.query.golemId);
            const packageRoot = SkillPackageRegistry.getUserSkillPackageDir(userDataDir);
            if (!fs.existsSync(packageRoot)) fs.mkdirSync(packageRoot, { recursive: true });

            const currentOptionalRaw = process.env.OPTIONAL_SKILLS || '';
            const currentOptionalSkills = currentOptionalRaw
                .split(',')
                .map((item) => item.trim().toLowerCase())
                .filter(Boolean);
            const optionalSet = new Set(currentOptionalSkills);

            const importedIds = [];
            const skippedMandatory = [];
            const skippedInvalid = [];
            const skippedExisting = [];
            const seenIds = new Set();

            for (const item of importedSkills) {
                const skill = normalizeImportedSkill(item, importedIds.length + skippedInvalid.length);
                if (!skill) {
                    skippedInvalid.push('(invalid_record)');
                    continue;
                }

                const safeId = safeSkillId(skill.id);
                if (!safeId) {
                    skippedInvalid.push('(invalid_id)');
                    continue;
                }

                if (seenIds.has(safeId)) continue;
                seenIds.add(safeId);

                if (MANDATORY_SKILLS.includes(safeId)) {
                    skippedMandatory.push(safeId);
                    continue;
                }

                const packageDir = path.join(packageRoot, safeId);
                const filePath = path.join(packageDir, 'skill.md');
                if (!overwriteExisting && fs.existsSync(packageDir)) {
                    skippedExisting.push(safeId);
                    continue;
                }

                if (!fs.existsSync(packageDir)) fs.mkdirSync(packageDir, { recursive: true });
                fs.writeFileSync(filePath, String(skill.content || '').trim(), 'utf8');
                fs.writeFileSync(path.join(packageDir, 'manifest.json'), JSON.stringify({
                    id: safeId,
                    name: skill.title || safeId,
                    description: '',
                    type: skill.category === 'user_dynamic' ? 'user_generated' : 'user_prompt',
                    enabled: Boolean(skill.isEnabled),
                    action: safeId,
                    entry: null,
                    prompt: 'skill.md',
                    toolsets: ['assistant'],
                    triggers: [],
                    createdBy: 'import',
                    createdAt: new Date().toISOString(),
                    version: '1.0.0'
                }, null, 2) + '\n', 'utf8');
                importedIds.push(safeId);

                if (restoreEnabled && skill.isOptional && skill.isEnabled) {
                    optionalSet.add(safeId);
                }
            }

            let enabledAdded = 0;
            if (restoreEnabled) {
                const mergedOptional = [...currentOptionalSkills];
                for (const id of optionalSet) {
                    if (!mergedOptional.includes(id)) {
                        mergedOptional.push(id);
                        enabledAdded += 1;
                    }
                }
                const updatedOptional = mergedOptional.join(',');
                process.env.OPTIONAL_SKILLS = updatedOptional;

                const envPath = path.resolve(process.cwd(), '.env');
                if (fs.existsSync(envPath)) {
                    let envContent = fs.readFileSync(envPath, 'utf8');
                    const regex = /^OPTIONAL_SKILLS=.*$/m;
                    if (regex.test(envContent)) {
                        envContent = envContent.replace(regex, `OPTIONAL_SKILLS=${updatedOptional}`);
                    } else {
                        envContent += `\nOPTIONAL_SKILLS=${updatedOptional}\n`;
                    }
                    fs.writeFileSync(envPath, envContent, 'utf8');
                }
            }

            const SkillIndexManager = require('../../src/managers/SkillIndexManager');
            const idx = new SkillIndexManager(userDataDir);
            try {
                for (const id of importedIds) {
                    const pkg = SkillPackageRegistry.listSkillPackages({ userDataDir }).find(item => item.id === id);
                    if (pkg) await idx.addSkillPackage(pkg);
                }
            } finally {
                await idx.close();
            }

            ProtocolFormatter._lastScanTime = 0;

            return res.json({
                success: true,
                totalReceived: importedSkills.length,
                importedCount: importedIds.length,
                enabledAdded,
                skippedMandatory,
                skippedExisting,
                skippedInvalid,
                message: `Imported ${importedIds.length} skills`
            });
        } catch (e) {
            console.error('Failed to import skills:', e);
            return res.status(500).json({ error: e.message });
        }
    });

    router.post('/api/skills/toggle', requireSkillAdmin, async (req, res) => {
        try {
            const { id, enabled } = req.body;
            if (!id) return res.status(400).json({ error: "Missing skill ID" });

            const safeId = safeSkillId(id);
            const userDataDir = await resolveSkillUserDataDir(server, req.query.golemId);
            const pkg = SkillPackageRegistry.listSkillPackages({ userDataDir }).find(item => item.id === safeId);
            if (!pkg) {
                return res.status(400).json({ error: `Skill "${safeId}" not found` });
            }
            if (MANDATORY_SKILLS.includes(safeId)) {
                return res.status(400).json({ error: `"${safeId}" is a mandatory skill and cannot be toggled` });
            }

            let currentStr = process.env.OPTIONAL_SKILLS || '';
            let currentSkills = currentStr.split(',').map(s => s.trim().toLowerCase()).filter(s => s !== '');

            if (enabled && !currentSkills.includes(safeId)) {
                currentSkills.push(safeId);
            } else if (!enabled && currentSkills.includes(safeId)) {
                currentSkills = currentSkills.filter(s => s !== safeId);
            }

            const newSkillsStr = currentSkills.join(',');
            process.env.OPTIONAL_SKILLS = newSkillsStr;

            const envPath = path.resolve(process.cwd(), '.env');
            if (fs.existsSync(envPath)) {
                let envContent = fs.readFileSync(envPath, 'utf8');
                const regex = /^OPTIONAL_SKILLS=.*$/m;
                if (regex.test(envContent)) {
                    envContent = envContent.replace(regex, `OPTIONAL_SKILLS=${newSkillsStr}`);
                } else {
                    envContent += `\nOPTIONAL_SKILLS=${newSkillsStr}\n`;
                }
                fs.writeFileSync(envPath, envContent, 'utf8');
            }

            if (fs.existsSync(pkg.manifestPath)) {
                const manifest = JSON.parse(fs.readFileSync(pkg.manifestPath, 'utf8'));
                manifest.enabled = Boolean(enabled);
                fs.writeFileSync(pkg.manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
            }

            ProtocolFormatter._lastScanTime = 0;

            const SkillIndexManager = require('../../src/managers/SkillIndexManager');
            const idx = new SkillIndexManager(userDataDir);
            
            if (enabled) {
                await idx.addSkillPackage(SkillPackageRegistry.loadPackage(pkg.dir)).catch(e => console.error(`[SkillIndex] Toggle-Add Error for ${safeId}:`, e.message));
            } else {
                await idx.removeSkill(safeId).catch(e => console.error(`[SkillIndex] Toggle-Remove Error for ${safeId}:`, e.message));
            }
            await idx.close();

            return res.json({ success: true, enabled, skillsStr: newSkillsStr });
        } catch (e) {
            console.error("Failed to toggle skill:", e);
            return res.status(500).json({ error: e.message });
        }
    });

    router.post('/api/skills/create', requireSkillAdmin, async (req, res) => {
        try {
            const { id, content } = req.body;
            if (!id || !content) return res.status(400).json({ error: 'Missing id or content' });

            const safeId = id.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
            if (MANDATORY_SKILLS.includes(safeId)) {
                return res.status(400).json({ error: `Cannot overwrite mandatory skill '${safeId}'` });
            }

            const userDataDir = await resolveSkillUserDataDir(server, req.query.golemId);
            const packageRoot = SkillPackageRegistry.getUserSkillPackageDir(userDataDir);
            const packageDir = path.join(packageRoot, safeId);
            const filePath = path.join(packageDir, 'skill.md');

            if (fs.existsSync(packageDir)) {
                return res.status(409).json({ error: `Skill '${safeId}' already exists` });
            }

            if (!fs.existsSync(packageDir)) fs.mkdirSync(packageDir, { recursive: true });
            fs.writeFileSync(filePath, content, 'utf8');
            fs.writeFileSync(path.join(packageDir, 'manifest.json'), JSON.stringify({
                id: safeId,
                name: extractSkillTitle({ content }) || safeId,
                description: '',
                type: 'user_prompt',
                enabled: true,
                action: safeId,
                entry: null,
                prompt: 'skill.md',
                toolsets: ['assistant'],
                triggers: [],
                createdBy: 'dashboard',
                createdAt: new Date().toISOString(),
                version: '1.0.0'
            }, null, 2) + '\n', 'utf8');
            console.log(`✨ [WebServer] Custom skill package created: ${safeId}`);

            const SkillIndexManager = require('../../src/managers/SkillIndexManager');
            const idx = new SkillIndexManager(userDataDir);
            const pkg = SkillPackageRegistry.loadPackage(packageDir);
            await idx.addSkillPackage(pkg).catch(e => console.error(`[SkillIndex] Create-Add Error for ${safeId}:`, e.message));
            await idx.close();

            return res.json({ success: true, id: safeId });
        } catch (e) {
            console.error('Failed to create skill:', e);
            return res.status(500).json({ error: e.message });
        }
    });

    router.post('/api/skills/update', requireSkillAdmin, async (req, res) => {
        try {
            const { id, content } = req.body;
            if (!id || !content) return res.status(400).json({ error: 'Missing id or content' });

            const safeId = id.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
            if (MANDATORY_SKILLS.includes(safeId)) {
                return res.status(403).json({ error: `Cannot edit mandatory skill '${safeId}'` });
            }

            const userDataDir = await resolveSkillUserDataDir(server, req.query.golemId);
            const pkg = SkillPackageRegistry.listSkillPackages({ userDataDir }).find(item => item.id === safeId);
            const filePath = pkg ? pkg.promptPath : '';

            if (!pkg || !filePath || !fs.existsSync(filePath)) {
                return res.status(404).json({ error: `Skill '${safeId}' not found` });
            }

            fs.writeFileSync(filePath, content, 'utf8');
            console.log(`📝 [WebServer] Custom skill package updated: ${safeId}`);

            const SkillIndexManager = require('../../src/managers/SkillIndexManager');
            const idx = new SkillIndexManager(userDataDir);
            await idx.addSkillPackage(pkg).catch(e => console.error(`[SkillIndex] Update-Add Error for ${safeId}:`, e.message));
            await idx.close();

            return res.json({ success: true, id: safeId });
        } catch (e) {
            console.error('Failed to update skill:', e);
            return res.status(500).json({ error: e.message });
        }
    });

    router.post('/api/skills/delete', requireSkillAdmin, async (req, res) => {
        try {
            const { id } = req.body;
            if (!id) return res.status(400).json({ error: 'Missing skill ID' });

            const safeId = id.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();

            if (MANDATORY_SKILLS.includes(safeId)) {
                return res.status(403).json({ error: `Cannot delete mandatory skill '${safeId}'` });
            }

            const libPath = path.join(process.cwd(), 'src', 'skills', 'lib');
            const userPath = path.join(process.cwd(), 'src', 'skills', 'user');
            const userDataDir = await resolveSkillUserDataDir(server, req.query.golemId);
            const modulePath = path.join(process.cwd(), 'src', 'skills', 'modules');
            const generatedPath = path.join(process.cwd(), 'src', 'skills', 'generated');
            const packageUserPath = SkillPackageRegistry.getUserSkillPackageDir(userDataDir);
            const allowedRoots = [path.resolve(libPath), path.resolve(userPath), path.resolve(modulePath), path.resolve(generatedPath), path.resolve(packageUserPath)];
            const SkillIndexManager = require('../../src/managers/SkillIndexManager');
            const idx = new SkillIndexManager(userDataDir);
            let deletedPath = '';
            try {
                let indexedRecord = null;
                try {
                    const records = await idx.listSkillEntries();
                    indexedRecord = records.find((record) => String(record.id || '').trim().toLowerCase() === safeId) || null;
                } catch (e) {
                    console.warn(`⚠️ [WebServer] Failed to load indexed skill before delete (${safeId}): ${e.message}`);
                }

                const candidatePaths = [];
                if (indexedRecord && indexedRecord.path) {
                    candidatePaths.push(String(indexedRecord.path));
                }
                const pkg = SkillPackageRegistry.listSkillPackages({ userDataDir }).find(item => item.id === safeId);
                if (pkg && pkg.dir) candidatePaths.push(pkg.dir);
                candidatePaths.push(path.join(libPath, `${safeId}.md`));
                candidatePaths.push(path.join(userPath, `${safeId}.js`));

                for (const candidate of candidatePaths) {
                    if (!candidate) continue;
                    const resolved = path.resolve(candidate);
                    const inAllowedRoot = allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
                    if (!inAllowedRoot) continue;
                    if (!fs.existsSync(resolved)) continue;
                    if (fs.statSync(resolved).isDirectory()) {
                        fs.rmSync(resolved, { recursive: true, force: true });
                    } else {
                        fs.unlinkSync(resolved);
                    }
                    deletedPath = resolved;
                    break;
                }

                if (!deletedPath) {
                    return res.status(404).json({ error: `Skill '${safeId}' not found` });
                }

                await idx.removeSkill(safeId).catch(e => console.error(`[SkillIndex] Delete-Remove Error for ${safeId}:`, e.message));
            } finally {
                await idx.close().catch((closeErr) => {
                    console.warn(`⚠️ [WebServer] Skill index close warning after delete (${safeId}): ${closeErr.message}`);
                });
            }

            try {
                const skillManager = require('../../src/managers/SkillManager');
                skillManager.refresh();
            } catch (refreshError) {
                console.warn(`⚠️ [WebServer] SkillManager refresh failed after delete (${safeId}): ${refreshError.message}`);
            }

            console.log(`🗑️ [WebServer] Custom skill deleted: ${deletedPath}`);

            ProtocolFormatter._lastScanTime = 0;

            return res.json({ success: true, id: safeId });
        } catch (e) {
            console.error('Failed to delete skill:', e);
            return res.status(500).json({ error: e.message });
        }
    });

    router.post('/api/skills/reload', requireSkillAdmin, (req, res) => {
        try {
            console.log("🔄 [WebServer] Hot-reloading skills... Clearing ProtocolFormatter cache.");
            ProtocolFormatter._lastScanTime = 0;
            return res.json({ success: true, message: "Skills cache cleared" });
        } catch (e) {
            console.error("Failed to reload skills cache:", e);
            return res.status(500).json({ error: e.message });
        }
    });

    router.post('/api/skills/inject', requireSkillAdmin, async (req, res) => {
        try {
            ProtocolFormatter._lastScanTime = 0;

            const results = [];
            for (const [id, context] of server.contexts.entries()) {
                if (context.brain && typeof context.brain.reloadSkills === 'function') {
                    try {
                        console.log(`🚀 [WebServer] 啟動 [${id}] 完整重啟程序...`);
                        await context.brain.reloadSkills();
                        results.push({ id, status: 'success' });

                        const tgBot = context.brain.tgBot;
                        if (tgBot) {
                            const enabledSkills = resolveEnabledSkills(process.env.OPTIONAL_SKILLS || '', []);
                            const enabledOptional = OPTIONAL_SKILL_LIST.filter(s => enabledSkills.has(s));
                            const disabledOptional = OPTIONAL_SKILL_LIST.filter(s => !enabledSkills.has(s));

                            const mandatoryList = MANDATORY_SKILLS.map(s => `• ${s}`).join('\n');
                            const optionalList = enabledOptional.length > 0 ? enabledOptional.map(s => `• ${s}`).join('\n') : '（無）';
                            const disabledList = disabledOptional.length > 0 ? disabledOptional.map(s => `• ${s}`).join('\n') : '（無）';

                            const msg = `⚡ *[${id}] 技能書已重新注入*\n\n🔒 *必要技能（永久啟用）:*\n${mandatoryList}\n\n✅ *已啟用選用技能:*\n${optionalList}\n\n⛔ *未啟用選用技能:*\n${disabledList}`;

                            const gCfg = tgBot.golemConfig || {};
                            const targetId = gCfg.adminId || gCfg.chatId;
                            if (targetId) {
                                tgBot.sendMessage(targetId, msg, { parse_mode: 'Markdown' })
                                    .catch(e => console.warn(`⚠️ [WebServer] TG skill notify failed [${id}]:`, e.message));
                                tgBot.sendMessage(targetId, `🔄 *[${id}] 技能書注入完成*\n已為您重新開啟全新的 Gemini 對話視窗並注入技能，人格設定與歷史記憶已完整保留，不需重新設定。`, { parse_mode: 'Markdown' })
                                    .catch(e => console.warn(`⚠️ [WebServer] TG inject notify failed [${id}]:`, e.message));
                            }
                        }
                    } catch (e) {
                        console.error(`❌ [WebServer] Failed to inject skills into Golem [${id}]:`, e.message);
                        results.push({ id, status: 'error', error: e.message });
                    }
                } else {
                    results.push({ id, status: 'skipped', error: 'Brain not ready or reloadSkills not available' });
                }
            }

            if (results.length === 0) {
                return res.status(503).json({ success: false, message: "No active Golem instances found" });
            }

            const allSuccess = results.every(r => r.status === 'success');
            return res.json({
                success: allSuccess,
                message: allSuccess ? `技能書已成功注入 ${results.length} 個 Golem 實體` : `部分注入失敗`,
                results
            });
        } catch (e) {
            console.error("Failed to inject skills:", e);
            return res.status(500).json({ error: e.message });
        }
    });

    return router;
};
