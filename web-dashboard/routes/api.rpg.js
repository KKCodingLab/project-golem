const express = require('express');
const fs = require('fs');
const path = require('path');
const { normalizeRpgOutput } = require('./lib/rpgOutputNormalizer');

const RPG_MEMBERSHIP_FILE = path.resolve(process.cwd(), 'data', 'rpg-memberships.json');
const RPG_LINK_REQUEST_FILE = path.resolve(process.cwd(), 'data', 'rpg-mobile-link-requests.json');
const FIREBASE_WEB_API_KEY = process.env.RPG_FIREBASE_API_KEY || 'AIzaSyB432wAN9AhnrRJgOTORL6-qT1W2Lj30VA';
const FIREBASE_PROJECT_ID = process.env.RPG_FIREBASE_PROJECT_ID || 'serial-novel-generator';

function ensureDir(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (_) {
        return fallback;
    }
}

function writeJson(filePath, value) {
    ensureDir(filePath);
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function sanitizeTier(rawTier) {
    const tier = String(rawTier || '').trim().toLowerCase();
    if (tier === 'visitor' || tier === 'general' || tier === 'sponsor') return tier;
    return 'visitor';
}

function extractFirestoreStringField(docFields, key) {
    if (!docFields || typeof docFields !== 'object') return '';
    const field = docFields[key];
    if (!field || typeof field !== 'object') return '';
    if (typeof field.stringValue === 'string') return field.stringValue;
    return '';
}

async function verifyFirebaseIdToken(idToken) {
    const endpoint = `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(FIREBASE_WEB_API_KEY)}`;
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
    });
    if (!response.ok) throw new Error(`token_verify_failed_${response.status}`);
    const data = await response.json();
    const user = data && Array.isArray(data.users) ? data.users[0] : null;
    if (!user || !user.localId) throw new Error('token_verify_failed_no_user');
    return user;
}

async function fetchMembershipByUid(uid, idToken) {
    const docPath = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(FIREBASE_PROJECT_ID)}/databases/(default)/documents/users/${encodeURIComponent(uid)}`;
    const response = await fetch(docPath, {
        headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!response.ok) {
        if (response.status === 404) return 'visitor';
        throw new Error(`membership_fetch_failed_${response.status}`);
    }
    const data = await response.json();
    const tierRaw = extractFirestoreStringField(data.fields || {}, 'membershipTier');
    return sanitizeTier(tierRaw || 'visitor');
}

function extractPrompt(body) {
    if (!body) return '';
    if (typeof body.prompt === 'string') return body.prompt;

    const contents = Array.isArray(body.contents) ? body.contents : [];
    return contents
        .flatMap((content) => Array.isArray(content && content.parts) ? content.parts : [])
        .map((part) => typeof part.text === 'string' ? part.text : '')
        .filter(Boolean)
        .join('\n');
}

function getActiveBrain(server, requestedGolemId) {
    if (requestedGolemId && server.contexts && server.contexts.has(requestedGolemId)) {
        return server.contexts.get(requestedGolemId).brain;
    }

    if (server.contexts && server.contexts.size > 0) {
        const first = server.contexts.values().next().value;
        if (first && first.brain) return first.brain;
    }

    if (typeof global.getOrCreateGolem === 'function') {
        const instance = global.getOrCreateGolem();
        return instance && instance.brain ? instance.brain : null;
    }

    return null;
}

function getActiveGolemInstance(server, requestedGolemId) {
    try {
        const runtime = require('../../index.js');
        if (runtime && typeof runtime.getOrCreateGolem === 'function') {
            return runtime.getOrCreateGolem(requestedGolemId || 'golem_A');
        }
    } catch (_) { }

    const brain = getActiveBrain(server, requestedGolemId);
    return brain ? { brain } : null;
}

function enqueueRpgPrompt(convoManager, prompt, options, golemId) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timeoutMs = Number(options.responseTimeoutMs || 900000) + 30000;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error('RPG request timed out while waiting for Golem queue response.'));
        }, timeoutMs);

        const settle = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(value);
        };

        const ctx = {
            platform: 'web-rpg',
            chatId: `web-rpg-${golemId || 'golem_A'}`,
            isAdmin: true,
            text: prompt,
            messageTime: Date.now(),
            senderName: 'RPG',
            replyToName: '',
            instance: { username: golemId || 'golem_A' },
            sendTyping: async () => { },
            getAttachment: async () => null,
            reply: async (text) => {
                settle(resolve, typeof text === 'string' ? text : JSON.stringify(text || ''));
            },
        };

        Promise.resolve(convoManager.enqueue(ctx, prompt, {
            ...options,
            isPriority: true,
            bypassDebounce: true,
            attachment: null,
        })).catch((error) => settle(reject, error));
    });
}

async function generateWithBrain(brain, prompt, instance = null, golemId = 'golem_A') {
    const configuredTimeoutMs = Number(process.env.GOLEM_RPG_RESPONSE_TIMEOUT_MS);
    const responseTimeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
        ? configuredTimeoutMs
        : 900000;
    const generationOptions = {
        responseTimeoutMs,
        allowPartialOnTimeout: true,
        _rpgBypass: true,
        disableToolRouting: true,
        allowActions: false,
    };

    // 先走 direct brain 回覆，避免佇列回拋偶發失聯導致前端卡住
    if (typeof brain.sendMessage === 'function') {
        const result = await brain.sendMessage(prompt, false, generationOptions);
        return typeof result === 'string' ? result : (result && result.text) || '';
    }

    // 舊路徑保留為 fallback
    if (instance && instance.convoManager && typeof instance.convoManager.enqueue === 'function') {
        try {
            return await enqueueRpgPrompt(instance.convoManager, prompt, generationOptions, golemId);
        } catch (queueError) {
            console.warn(`[RPG] Queue path failed, fallback to direct brain call: ${queueError.message}`);
        }
    }

    if (typeof brain._wikiChat === 'function') {
        return brain._wikiChat(prompt, generationOptions);
    }

    throw new Error('Active Golem brain does not expose a text generation method.');
}

function buildRpgPrompt(userPrompt) {
    return `You are currently serving the Project Golem Text RPG web app, not a normal chat session.

RPG OUTPUT BOUNDARY:
- Follow the normal Project Golem response protocol required by the system.
- Put the RPG result only inside [GOLEM_REPLY].
- Do NOT call tools or describe actions being executed.
- Do NOT write memory notes, status narration, or assistant prefaces.
- Do NOT use [GOLEM_ACTION].
- If the RPG prompt requests JSON, the content inside [GOLEM_REPLY] must be valid JSON only.

RPG PROMPT:
${userPrompt}`;
}

module.exports = function registerRpgRoutes(server) {
    const router = express.Router();

    router.post('/api/rpg/mobile-link/request', async (req, res) => {
        try {
            const platform = String(req.body && req.body.platform || '').trim().toLowerCase();
            const userId = String(req.body && req.body.userId || '').trim();
            if (!platform || !userId) {
                return res.status(400).json({ error: 'platform_and_userId_required' });
            }
            if (platform !== 'telegram' && platform !== 'discord') {
                return res.status(400).json({ error: 'invalid_platform' });
            }

            const code = Math.random().toString(36).slice(2, 8).toUpperCase();
            const requests = readJson(RPG_LINK_REQUEST_FILE, {});
            const now = Date.now();
            requests[code] = {
                code,
                platform,
                userId,
                createdAt: now,
                expiresAt: now + (10 * 60 * 1000),
                consumed: false,
            };
            writeJson(RPG_LINK_REQUEST_FILE, requests);
            return res.json({
                ok: true,
                code,
                expiresInSec: 600,
            });
        } catch (e) {
            return res.status(500).json({ error: e.message || 'link_request_failed' });
        }
    });

    router.post('/api/rpg/mobile-link/consume', async (req, res) => {
        try {
            const code = String(req.body && req.body.code || '').trim().toUpperCase();
            const idToken = String(req.body && req.body.idToken || '').trim();
            if (!code || !idToken) {
                return res.status(400).json({ error: 'code_and_idToken_required' });
            }

            const requests = readJson(RPG_LINK_REQUEST_FILE, {});
            const pending = requests[code];
            if (!pending) return res.status(404).json({ error: 'link_code_not_found' });
            if (pending.consumed) return res.status(409).json({ error: 'link_code_already_used' });
            if (Number(pending.expiresAt || 0) < Date.now()) return res.status(410).json({ error: 'link_code_expired' });

            const verifiedUser = await verifyFirebaseIdToken(idToken);
            const tier = await fetchMembershipByUid(String(verifiedUser.localId), idToken);

            const key = `${pending.platform}:${pending.userId}`;
            const memberships = readJson(RPG_MEMBERSHIP_FILE, {});
            memberships[key] = {
                tier,
                source: 'dashboard_firebase',
                firebaseUid: String(verifiedUser.localId),
                email: String(verifiedUser.email || ''),
                updatedAt: new Date().toISOString(),
            };
            writeJson(RPG_MEMBERSHIP_FILE, memberships);

            pending.consumed = true;
            pending.consumedAt = Date.now();
            pending.firebaseUid = String(verifiedUser.localId);
            pending.tier = tier;
            requests[code] = pending;
            writeJson(RPG_LINK_REQUEST_FILE, requests);

            return res.json({ ok: true, tier, key });
        } catch (e) {
            return res.status(500).json({ error: e.message || 'link_consume_failed' });
        }
    });

    router.post('/api/rpg/generateContent', async (req, res) => {
        const startedAt = Date.now();
        try {
            const prompt = extractPrompt(req.body);
            if (!prompt.trim()) {
                return res.status(400).json({ error: 'Missing prompt text.' });
            }

            const golemId = String(req.query.golemId || req.body.golemId || '').trim();
            const instance = getActiveGolemInstance(server, golemId);
            const brain = instance && instance.brain ? instance.brain : getActiveBrain(server, golemId);
            if (!brain) {
                return res.status(503).json({ error: 'No active Golem brain is available.' });
            }

            const text = await generateWithBrain(brain, buildRpgPrompt(prompt), instance, golemId || 'golem_A');
            const output = normalizeRpgOutput(text);
            if (!output) {
                return res.status(502).json({ error: 'Golem returned an empty response.' });
            }

            server.broadcastLog({
                time: new Date().toLocaleTimeString('zh-TW', { hour12: false }),
                msg: `[RPG] Golem generated ${output.length} chars in ${Date.now() - startedAt}ms`,
                type: 'system',
                raw: output.slice(0, 500),
                golemId: golemId || 'golem_A'
            });

            return res.json({
                candidates: [{
                    content: {
                        parts: [{ text: output }]
                    }
                }],
                model: req.query.model || 'golem',
                source: 'project-golem'
            });
        } catch (e) {
            console.error('[RPG] generateContent failed:', e);
            return res.status(500).json({ error: e.message });
        }
    });

    return router;
};

module.exports._private = {
    buildRpgPrompt,
    enqueueRpgPrompt,
    generateWithBrain,
    getActiveGolemInstance,
    normalizeRpgOutput,
};
