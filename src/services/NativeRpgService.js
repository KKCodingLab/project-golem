const fs = require('fs');
const path = require('path');

const MEMBERSHIP_FILE = path.resolve(process.cwd(), 'data', 'rpg-memberships.json');

const TIER_CONFIG = {
    visitor: { maxActions: 5, label: '訪客' },
    general: { maxActions: 20, label: '一般會員' },
    sponsor: { maxActions: Infinity, label: '贊助會員' },
};

const WORLD_OPTIONS = [
    { key: 'fantasy', label: '奇幻' },
    { key: 'scifi', label: '科幻' },
    { key: 'wuxia', label: '武俠' },
    { key: 'mystery', label: '懸疑' },
    { key: 'cyberpunk', label: '賽博' },
    { key: 'horror', label: '恐怖' },
];

const ARCHETYPE_OPTIONS = [
    { key: 'warrior', label: '戰士', desc: '近戰先鋒，耐力高。' },
    { key: 'ranger', label: '遊俠', desc: '機動偵查，命中高。' },
    { key: 'mage', label: '法師', desc: '法術輸出，爆發高。' },
    { key: 'rogue', label: '盜賊', desc: '潛行奇襲，暴擊高。' },
];

function sanitizeTier(rawTier) {
    const tier = String(rawTier || '').trim().toLowerCase();
    if (tier === 'visitor' || tier === 'general' || tier === 'sponsor') return tier;
    return null;
}

function extractReplyText(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';

    const tagged = text.match(/\[GOLEM_REPLY\]([\s\S]*?)(?:\[\/GOLEM_REPLY\]|\[GOLEM_ACTION\]|$)/i);
    if (tagged && tagged[1]) return tagged[1].trim();

    return text.replace(/\[GOLEM_[A-Z_]+\][\s\S]*$/i, '').trim();
}

function parseNumberedChoices(text) {
    const lines = String(text || '').split('\n');
    const choices = [];
    for (const line of lines) {
        const m = line.match(/^\s*(?:\d+[\.\)\-、]|[1-3]️⃣)\s*(.+?)\s*$/);
        if (m && m[1]) choices.push(m[1].trim());
        if (choices.length >= 3) break;
    }
    return choices;
}

function stripChoiceLines(text) {
    const lines = String(text || '').split('\n');
    return lines
        .filter((line) => !/^\s*(?:\d+[\.\)\-、]|[1-3]️⃣)\s+/.test(line))
        .join('\n')
        .trim();
}

function buildEmojiChoiceBlock(choices) {
    const safe = (choices || []).slice(0, 3);
    return [
        '🎯 行動選項',
        `1️⃣ ${safe[0] || '觀察四周環境'}`,
        `2️⃣ ${safe[1] || '謹慎前進探索'}`,
        `3️⃣ ${safe[2] || '嘗試與目標互動'}`,
    ].join('\n');
}

function buildReplyMarkup(choices) {
    const base = (choices || []).slice(0, 3).map((_, index) => ({
        text: `選項${index + 1}`,
        callback_data: `RPG_CHOICE_${index + 1}`,
    }));
    const rows = [];
    for (let i = 0; i < base.length; i += 2) rows.push(base.slice(i, i + 2));
    rows.push([{ text: '角色狀態', callback_data: 'RPG_STATUS' }]);
    return { inline_keyboard: rows };
}

function buildWorldMarkup() {
    const items = WORLD_OPTIONS.map((option) => ({
        text: option.label,
        callback_data: `RPG_WORLD_${option.key}`,
    }));
    const rows = [];
    for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
    return { inline_keyboard: rows };
}

function buildArchetypeMarkup() {
    const items = ARCHETYPE_OPTIONS.map((option) => ({
        text: option.label,
        callback_data: `RPG_ARCH_${option.key}`,
    }));
    const rows = [];
    for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
    rows.push([{ text: '略過，手動描述', callback_data: 'RPG_ARCH_CUSTOM' }]);
    return { inline_keyboard: rows };
}

function buildStartMenuMarkup() {
    return {
        inline_keyboard: [
            [{ text: '開始遊戲', callback_data: 'RPG_MENU_BEGIN' }],
            [{ text: '手機會員綁定', callback_data: 'RPG_MENU_BIND' }],
            [{ text: '會員福利說明', callback_data: 'RPG_MENU_MEMBER' }],
            [{ text: '如何贊助', callback_data: 'RPG_MENU_SUPPORT' }],
            [{ text: '註冊 / 登入', callback_data: 'RPG_MENU_REGISTER' }],
        ],
    };
}

function resolveArchetypeText(key) {
    const found = ARCHETYPE_OPTIONS.find((item) => item.key === key);
    return found ? `${found.label}：${found.desc}` : '';
}

function resolveWorldText(key) {
    const found = WORLD_OPTIONS.find((item) => item.key === key);
    return found ? found.label : key;
}

function getDashboardBaseUrl() {
    const fromEnv = String(process.env.RPG_LINK_BASE_URL || '').trim();
    if (fromEnv) return fromEnv.replace(/\/$/, '');
    const port = String(process.env.DASHBOARD_PORT || '3000').trim() || '3000';
    return `http://127.0.0.1:${port}`;
}

class NativeRpgService {
    constructor() {
        this.sessions = new Map();
        this.memberships = this._loadMemberships();
    }

    _loadMemberships() {
        try {
            if (!fs.existsSync(MEMBERSHIP_FILE)) return {};
            const raw = fs.readFileSync(MEMBERSHIP_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (e) {
            console.warn(`[NativeRPG] Failed to load memberships: ${e.message}`);
            return {};
        }
    }

    _saveMemberships() {
        try {
            const dir = path.dirname(MEMBERSHIP_FILE);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(MEMBERSHIP_FILE, JSON.stringify(this.memberships, null, 2), 'utf8');
        } catch (e) {
            console.warn(`[NativeRPG] Failed to save memberships: ${e.message}`);
        }
    }

    _memberKey(ctx) {
        return `${ctx.platform}:${ctx.userId}`;
    }

    _getTier(ctx) {
        // 允許 Dashboard 綁定流程即時更新會員檔案；每次讀取前先重新載入
        this.memberships = this._loadMemberships();
        const key = this._memberKey(ctx);
        const tier = sanitizeTier(this.memberships[key] && this.memberships[key].tier);
        return tier || 'visitor';
    }

    setTier(platform, userId, tier) {
        const normalized = sanitizeTier(tier);
        if (!normalized) return { ok: false, error: 'invalid_tier' };
        const key = `${platform}:${userId}`;
        this.memberships[key] = { tier: normalized, updatedAt: new Date().toISOString() };
        this._saveMemberships();
        return { ok: true, key, tier: normalized };
    }

    getSession(chatId) {
        return this.sessions.get(String(chatId)) || null;
    }

    startSession(chatId, gmName = 'Golem') {
        const key = String(chatId);
        const session = {
            active: true,
            gmName,
            startedAt: Date.now(),
            history: [],
            usage: {},
            lastChoices: [],
            state: {
                hp: 100,
                maxHp: 100,
                mp: 40,
                maxMp: 40,
                level: 1,
                exp: 0,
                gold: 20,
            },
            setup: {
                phase: 'choose_world',
                world: '',
                character: '',
            },
            story: {
                turn: 0,
                timeline: [],
            },
        };
        this.sessions.set(key, session);
        return session;
    }

    stopSession(chatId) {
        const key = String(chatId);
        return this.sessions.delete(key);
    }

    isControlCommand(text) {
        return /^\/rpg(?:\s|$)/i.test(String(text || '').trim());
    }

    async _buildBindMessage(ctx) {
        const url = `${getDashboardBaseUrl()}/api/rpg/mobile-link/request`;
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    platform: String(ctx.platform || '').toLowerCase(),
                    userId: String(ctx.userId || '').trim(),
                }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data || data.ok !== true || !data.code) {
                throw new Error((data && data.error) || `http_${response.status}`);
            }
            return [
                '🔗 手機帳號綁定碼',
                `代碼：${data.code}`,
                '有效時間：10 分鐘',
                '',
                '請在電腦版文字 RPG（已登入你的會員帳號）',
                '到「我的帳戶」輸入這組代碼完成綁定。',
                'https://text-rpg-generator.pages.dev',
            ].join('\n');
        } catch (e) {
            return `❌ 無法產生綁定碼：${e.message}`;
        }
    }

    async handleControlCommand(ctx, brain) {
        const text = String(ctx.text || '').trim();
        const args = text.split(/\s+/);
        const sub = String(args[1] || 'status').toLowerCase();
        const chatId = String(ctx.chatId);

        if (sub === 'start') {
            const tier = this._getTier(ctx);
            const conf = TIER_CONFIG[tier];
            return {
                text: [
                    '🎮 歡迎來到 Golem 原生文字 RPG',
                    `👤 目前會員：${conf.label} (${tier})`,
                    '請先選擇要進行的項目：',
                ].join('\n'),
                replyOptions: { reply_markup: buildStartMenuMarkup() },
            };
        }

        if (sub === 'stop') {
            const existed = this.stopSession(chatId);
            return existed ? '🛑 原生 RPG 模式已關閉。' : 'ℹ️ 目前沒有啟用中的 RPG 模式。';
        }

        if (sub === 'tier') {
            if (ctx.isAdmin !== true) return '⛔ 權限不足：只有管理員可以設定會員等級。';
            const targetUserId = String(args[2] || '').trim();
            const targetTier = String(args[3] || '').trim().toLowerCase();
            if (!targetUserId || !targetTier) {
                return '用法：`/rpg tier <userId> <visitor|general|sponsor>`';
            }
            const result = this.setTier(ctx.platform, targetUserId, targetTier);
            if (!result.ok) return '❌ 無效等級，請使用 visitor / general / sponsor。';
            return `✅ 已設定 ${result.key} 為 ${TIER_CONFIG[result.tier].label}。`;
        }

        if (sub === 'bind' || sub === 'link') {
            return await this._buildBindMessage(ctx);
        }

        const session = this.getSession(chatId);
        const tier = this._getTier(ctx);
        const conf = TIER_CONFIG[tier];
        const used = session && session.usage && session.usage[this._memberKey(ctx)] ? session.usage[this._memberKey(ctx)] : 0;
        const limitText = Number.isFinite(conf.maxActions) ? `${used}/${conf.maxActions}` : `${used}/∞`;
        return [
            `🧭 RPG 狀態：${session ? '啟用中' : '未啟用'}`,
            `👤 你的等級：${conf.label} (${tier})`,
            `🎯 你的行動次數：${limitText}`,
            '',
            '指令：`/rpg start` ` /rpg stop` ` /rpg status`',
            '綁定：`/rpg bind`（讓手機會員等級連動 Dashboard）',
            '管理員：`/rpg tier <userId> <visitor|general|sponsor>`',
        ].join('\n');
    }

    _tickState(session) {
        if (!session || !session.state) return;
        const s = session.state;
        const hpDelta = Math.floor(Math.random() * 11) - 4;
        const mpDelta = Math.floor(Math.random() * 7) - 2;
        const goldDelta = Math.floor(Math.random() * 9);
        s.hp = Math.max(1, Math.min(s.maxHp, s.hp + hpDelta));
        s.mp = Math.max(0, Math.min(s.maxMp, s.mp + mpDelta));
        s.gold = Math.max(0, s.gold + goldDelta);
        s.exp += 6 + Math.floor(Math.random() * 8);
        if (s.exp >= s.level * 60) {
            s.exp = 0;
            s.level += 1;
            s.maxHp += 8;
            s.maxMp += 4;
            s.hp = s.maxHp;
            s.mp = s.maxMp;
        }
    }

    async _beginAdventure(ctx, brain, session) {
        const world = session.setup && session.setup.world ? session.setup.world : '奇幻';
        const character = session.setup && session.setup.character
            ? session.setup.character
            : '一位剛踏上旅途的冒險者';

        const prompt = [
            '你是 Project Golem 原生文字 RPG 的 GM，請建立「開局回合」。',
            '輸出要求：',
            '1) 只輸出 RPG 劇情內容，且包在 [GOLEM_REPLY]。',
            '2) 先描述 4~6 句開場。',
            '3) 再給三個可行動選項，格式一定是 1./2./3.。',
            '',
            `【世界觀】${world}`,
            `【角色設定】${character}`,
            '請給這個角色一個合理的第一個場景與第一個目標。',
        ].join('\n');

        let raw = '';
        if (typeof brain.sendMessage === 'function') {
            const result = await brain.sendMessage(prompt, false, {
                responseTimeoutMs: 240000,
                allowPartialOnTimeout: true,
                _rpgBypass: true,
                disableToolRouting: true,
                allowActions: false,
            });
            raw = typeof result === 'string' ? result : (result && result.text) || '';
        }
        const replyText = extractReplyText(raw) || '你在陌生的世界甦醒。眼前有三條路等你選擇。';
        const parsedChoices = parseNumberedChoices(replyText);
        session.lastChoices = parsedChoices.length > 0
            ? parsedChoices.slice(0, 3)
            : ['調查附近動靜', '整理裝備前進', '嘗試與路人對話'];
        session.setup.phase = 'active';
        session.history.push({ role: 'gm', text: replyText, ts: Date.now() });
        return {
            handled: true,
            text: replyText,
            replyOptions: { reply_markup: buildReplyMarkup(session.lastChoices) },
        };
    }

    _renderStatus(ctx, session) {
        const tier = this._getTier(ctx);
        const conf = TIER_CONFIG[tier];
        const used = session && session.usage && session.usage[this._memberKey(ctx)] ? session.usage[this._memberKey(ctx)] : 0;
        const s = session && session.state ? session.state : { hp: 0, maxHp: 0, mp: 0, maxMp: 0, level: 1, exp: 0, gold: 0 };
        const actionText = Number.isFinite(conf.maxActions) ? `${used}/${conf.maxActions}` : `${used}/∞`;
        return [
            '📊 角色狀態',
            `- 等級: Lv.${s.level}`,
            `- HP: ${s.hp}/${s.maxHp}`,
            `- MP: ${s.mp}/${s.maxMp}`,
            `- EXP: ${s.exp}`,
            `- Gold: ${s.gold}`,
            `- 會員: ${conf.label}`,
            `- 行動次數: ${actionText}`,
        ].join('\n');
    }

    async handleTurn(ctx, brain) {
        const chatId = String(ctx.chatId);
        const session = this.getSession(chatId);
        if (!session || !session.active) return { handled: false };

        const userInput = String(ctx.text || '').trim();
        if (!userInput || userInput.startsWith('/')) return { handled: false };

        if (session.setup && session.setup.phase === 'choose_world') {
            session.setup.world = userInput;
            session.setup.phase = 'choose_character';
            return {
                handled: true,
                text: `🌍 已設定世界觀：${userInput}\n第二步：請描述你的角色（一句到三句）。\n也可直接按下方職業範本。`,
                replyOptions: { reply_markup: buildArchetypeMarkup() },
            };
        }

        if (session.setup && session.setup.phase === 'choose_character') {
            session.setup.character = userInput;
            return await this._beginAdventure(ctx, brain, session);
        }

        const tier = this._getTier(ctx);
        const tierConfig = TIER_CONFIG[tier];
        const memberKey = this._memberKey(ctx);
        const used = Number(session.usage[memberKey] || 0);

        if (Number.isFinite(tierConfig.maxActions) && used >= tierConfig.maxActions) {
            return {
                handled: true,
                text: `🚫 你的行動次數已達上限 (${tierConfig.maxActions})。目前等級：${tierConfig.label}。`,
            };
        }

        session.usage[memberKey] = used + 1;

        const historyText = session.history
            .slice(-12)
            .map((entry) => `${entry.role === 'user' ? '玩家' : 'GM'}:${entry.text}`)
            .join('\n');
        const storyTimeline = session.story && Array.isArray(session.story.timeline)
            ? session.story.timeline.slice(-6).join('\n')
            : '';
        const choiceContext = String(ctx._rpgChoiceMeta || '').trim();

        const prompt = [
            '你是 Project Golem 原生文字 RPG 的 GM。',
            '規則：',
            '1) 只輸出 RPG 劇情內容，不要執行工具，不要輸出 GOLEM_ACTION。',
            '2) 回覆必須按照固定格式：',
            '   🎬 劇情推進：4~7 句，先描述玩家本回合行動造成的直接後果，再推進局勢。',
            '   📌 狀態摘要：2~3 句，點出目標進度、風險、當前障礙。',
            '   🎯 行動選項：必須列出三個，且只能用 1️⃣ 2️⃣ 3️⃣ 開頭。',
            '3) 必須嚴格延續上一回合的場景、人物、事件因果，不可重開新故事。',
            '4) 若玩家行動承接上一回合選項，先描述該行動造成的直接結果，再推進新局勢。',
            '5) 不可忽略【近期劇情】最後一段，也不可把角色重置到未知開局。',
            '',
            `【世界觀】${session.setup && session.setup.world ? session.setup.world : '奇幻'}`,
            `【角色設定】${session.setup && session.setup.character ? session.setup.character : '冒險者'}`,
            historyText ? `【近期劇情】\n${historyText}` : '【近期劇情】（新冒險）',
            storyTimeline ? `【關鍵時間線】\n${storyTimeline}` : '【關鍵時間線】（目前無）',
            choiceContext ? `【本回合承接選項】${choiceContext}` : '【本回合承接選項】（玩家自由輸入）',
            `【玩家輸入】${userInput}`,
            '',
            '請把最終結果放在 [GOLEM_REPLY] 內。',
        ].join('\n');

        let raw = '';
        if (typeof brain.sendMessage === 'function') {
            const result = await brain.sendMessage(prompt, false, {
                responseTimeoutMs: 240000,
                allowPartialOnTimeout: true,
                _rpgBypass: true,
                disableToolRouting: true,
                allowActions: false,
            });
            raw = typeof result === 'string' ? result : (result && result.text) || '';
        }

        const replyText = extractReplyText(raw) || '（GM 暫時失去靈感，請再試一次）';
        this._tickState(session);
        const parsedChoices = parseNumberedChoices(replyText);
        session.lastChoices = parsedChoices.length > 0
            ? parsedChoices.slice(0, 3)
            : ['觀察四周環境', '謹慎前進探索', '嘗試與目標互動'];
        const cleanStoryText = stripChoiceLines(replyText);
        const finalText = `${cleanStoryText}\n\n${buildEmojiChoiceBlock(session.lastChoices)}`;
        session.history.push({ role: 'user', text: userInput, ts: Date.now() });
        session.history.push({ role: 'gm', text: finalText, ts: Date.now() });
        if (session.history.length > 80) session.history = session.history.slice(-80);
        if (!session.story) session.story = { turn: 0, timeline: [] };
        session.story.turn += 1;
        session.story.timeline.push(`Turn ${session.story.turn} | 玩家:${userInput} | 結果:${cleanStoryText.slice(0, 120)}`);
        if (session.story.timeline.length > 20) session.story.timeline = session.story.timeline.slice(-20);

        const actionFoot = Number.isFinite(tierConfig.maxActions)
            ? `\n\n[行動次數 ${session.usage[memberKey]}/${tierConfig.maxActions} | ${tierConfig.label}]`
            : `\n\n[行動次數 ${session.usage[memberKey]}/∞ | ${tierConfig.label}]`;

        return {
            handled: true,
            text: `${finalText}${actionFoot}`,
            replyOptions: { reply_markup: buildReplyMarkup(session.lastChoices) },
        };
    }

    async handleCallback(ctx, actionData, brain) {
        const data = String(actionData || '').trim();
        if (!/^RPG_(CHOICE_[1-3]|STATUS|WORLD_[A-Z0-9_]+|ARCH_[A-Z0-9_]+|MENU_[A-Z0-9_]+)$/i.test(data)) return { handled: false };

        if (/^RPG_MENU_/i.test(data)) {
            if (/^RPG_MENU_BEGIN$/i.test(data)) {
                this.startSession(String(ctx.chatId), 'Golem');
                return {
                    handled: true,
                    text: '🧭 已進入建立流程。\n第一步：請選擇世界觀。',
                    replyOptions: { reply_markup: buildWorldMarkup() },
                };
            }
            if (/^RPG_MENU_BIND$/i.test(data)) {
                return {
                    handled: true,
                    text: await this._buildBindMessage(ctx),
                    replyOptions: { reply_markup: buildStartMenuMarkup() },
                };
            }
            if (/^RPG_MENU_MEMBER$/i.test(data)) {
                return {
                    handled: true,
                    text: [
                        '👑 會員福利說明',
                        '- 訪客 visitor：5 次行動',
                        '- 一般會員 general：20 次行動',
                        '- 贊助會員 sponsor：不限次數',
                        '',
                        '手機可用 `/rpg bind` 綁定 Dashboard 會員，',
                        '綁定後手機端等級會跟網站會員等級同步。',
                    ].join('\n'),
                    replyOptions: { reply_markup: buildStartMenuMarkup() },
                };
            }
            if (/^RPG_MENU_SUPPORT$/i.test(data)) {
                return {
                    handled: true,
                    text: [
                        '☕ 贊助方式',
                        '請使用以下連結贊助：',
                        'https://buymeacoffee.com/arvincreator',
                        '',
                        '贊助後可由管理員將你設定為 sponsor 等級。',
                    ].join('\n'),
                    replyOptions: { reply_markup: buildStartMenuMarkup() },
                };
            }
            if (/^RPG_MENU_REGISTER$/i.test(data)) {
                return {
                    handled: true,
                    text: [
                        '🧩 註冊 / 登入',
                        '請到電腦版或網站完成註冊與登入：',
                        'https://text-rpg-generator.pages.dev',
                    ].join('\n'),
                    replyOptions: { reply_markup: buildStartMenuMarkup() },
                };
            }
            return { handled: true, text: '⚠️ 未知的選單動作。' };
        }

        const session = this.getSession(ctx.chatId);
        if (!session || !session.active) {
            return { handled: true, text: 'ℹ️ 目前沒有啟用中的 RPG 模式。請先輸入 `/rpg start`。' };
        }

        if (/^RPG_WORLD_/i.test(data)) {
            const worldKey = data.replace(/^RPG_WORLD_/i, '').toLowerCase();
            const worldText = resolveWorldText(worldKey);
            session.setup.phase = 'choose_character';
            session.setup.world = worldText;
            return {
                handled: true,
                text: `🌍 已設定世界觀：${worldText}\n第二步：請描述你的角色（一句到三句）。\n也可直接按下方職業範本。`,
                replyOptions: { reply_markup: buildArchetypeMarkup() },
            };
        }

        if (/^RPG_ARCH_/i.test(data)) {
            if (!session.setup || session.setup.phase !== 'choose_character') {
                return { handled: true, text: '⚠️ 目前不在角色建立流程。可輸入 `/rpg status` 查看狀態。' };
            }
            const archKey = data.replace(/^RPG_ARCH_/i, '').toLowerCase();
            if (archKey === 'custom') {
                return { handled: true, text: '✍️ 請直接輸入你的角色描述（例如：流浪劍士，擅長反擊）。' };
            }
            const desc = resolveArchetypeText(archKey);
            if (!desc) return { handled: true, text: '⚠️ 無效職業選項，請重新選擇。' };
            session.setup.character = desc;
            return await this._beginAdventure(ctx, brain, session);
        }

        if (/^RPG_STATUS$/i.test(data)) {
            return {
                handled: true,
                text: this._renderStatus(ctx, session),
                replyOptions: session.setup && session.setup.phase === 'active'
                    ? { reply_markup: buildReplyMarkup(session.lastChoices) }
                    : {},
            };
        }

        const choiceNum = Number((data.match(/^RPG_CHOICE_([1-3])$/i) || [])[1] || 0);
        if (!choiceNum || !session.lastChoices[choiceNum - 1]) {
            return { handled: true, text: '⚠️ 這個選項已失效，請重新輸入一則訊息取得新選項。' };
        }

        const originalOverride = typeof ctx._textOverride === 'string' ? ctx._textOverride : null;
        const originalChoiceMeta = typeof ctx._rpgChoiceMeta === 'string' ? ctx._rpgChoiceMeta : null;
        const chosen = session.lastChoices[choiceNum - 1];
        ctx._textOverride = chosen;
        ctx._rpgChoiceMeta = `選項${choiceNum}: ${chosen}`;

        try {
            const result = await this.handleTurn(ctx, brain);
            return result && result.handled
                ? result
                : { handled: true, text: '⚠️ 選項處理失敗，請再試一次。' };
        } finally {
            ctx._textOverride = originalOverride;
            ctx._rpgChoiceMeta = originalChoiceMeta;
        }
    }
}

module.exports = new NativeRpgService();
