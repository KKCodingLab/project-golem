const skillManager = require('../../managers/SkillManager');
const MCPManager   = require('../../mcp/MCPManager');
const MCPCallValidator = require('../../mcp/MCPCallValidator');
const MCPToolCatalog = require('../../mcp/MCPToolCatalog');

class SkillHandler {
    static _buildSkillActionExample(skillName, args = {}) {
        const safeName = String(skillName || '').trim() || 'wiki';
        const payload = { action: safeName, args: {} };
        const input = args && typeof args === 'object' ? args : {};
        for (const key of Object.keys(input)) {
            if (['action', 'action_type', 'type'].includes(key)) continue;
            payload.args[key] = input[key];
        }
        if (Object.keys(payload.args).length === 0) {
            payload.args = { input: '...' };
        }
        return JSON.stringify(payload, null, 2);
    }

    static _buildPostCheckHint(exampleText) {
        const exampleBlock = exampleText
            ? `\n正確指令範例：\n${exampleText}`
            : '';
        return `\n\n[Execution Check Reminder]\n請檢查是否成功執行；若未成功，請勿直接 reply 使用者，請先改用正確指令重試一次。${exampleBlock}`;
    }

    static async _buildNavigateFollowupHint(mcpManager, serverName) {
        let charCountText = '未知';
        try {
            const metric = await mcpManager.callTool(serverName, 'evaluate_script', {
                function: `() => {
                    const text = (document && document.body && document.body.innerText) ? document.body.innerText : '';
                    return {
                        charCount: text.length,
                        title: document && document.title ? document.title : ''
                    };
                }`
            });
            const metricText = metric && Array.isArray(metric.content)
                ? metric.content.map(c => c.type === 'text' ? c.text : JSON.stringify(c)).join('\n')
                : JSON.stringify(metric || {});
            const match = String(metricText).match(/"charCount"\s*:\s*(\d+)/);
            if (match) charCountText = Number(match[1]).toLocaleString('zh-TW');
        } catch (err) {
            console.warn(`[MCP] navigate followup metric failed: ${err.message}`);
        }

        return [
            '',
            '---',
            `頁面文字字數估計：約 ${charCountText} 字元`,
            '建議先詢問使用者是否要讀取網頁內容，再選擇工具。',
            '詢問範例：要我直接讀取整頁重點，還是只抓特定區塊（例如標題、內文、留言）？',
            '指令範例（讀整頁文字）：',
            '{"action":"mcp_call","server":"chrome-devtools","tool":"evaluate_script","parameters":{"function":"() => document.body ? document.body.innerText : \\"\\""}}',
            '指令範例（先抓可互動結構）：',
            '{"action":"mcp_call","server":"chrome-devtools","tool":"take_snapshot","parameters":{}}'
        ].join('\n');
    }

    static _buildSkillNotFoundHelp(skillName) {
        const all = Array.isArray(skillManager.listSkills()) ? skillManager.listSkills() : [];
        const normalized = String(skillName || '').trim().toLowerCase();
        const top = all
            .map(s => String((s && s.name) || '').trim())
            .filter(Boolean)
            .slice(0, 8);
        const similar = all
            .map(s => String((s && s.name) || '').trim())
            .filter(Boolean)
            .filter(name => name.toLowerCase().includes(normalized) || normalized.includes(name.toLowerCase()))
            .slice(0, 3);
        const suggestionPool = similar.length > 0 ? similar : top.slice(0, 3);
        const exampleSkill = suggestionPool[0] || top[0] || 'wiki';

        return [
            `❌ 找不到技能 action: "${skillName}"`,
            `請使用以下格式之一：`,
            `1) 技能呼叫：{"action":"${exampleSkill}","args":{"input":"..."}}`,
            `2) MCP 工具：{"action":"mcp_call","server":"chrome-devtools","tool":"navigate_page","parameters":{"url":"https://example.com"}}`,
            `3) Shell 指令：{"action":"command","parameter":"ls -la"}`,
            `可先輸入 /skills 查看目前可用技能。`,
        ].join('\n');
    }

    static async execute(ctx, act, brain, controller, dispatchOptions = {}) {
        // ✨ [v9.1] 整合行動產線：將 Observation 放入對話產線
        let convoManager = null;
        if (controller && controller.golemId) {
            try {
                const getOrCreate =
                    (typeof global.getOrCreateGolem === 'function' && global.getOrCreateGolem) ||
                    require('../../../index').getOrCreateGolem;
                const instance = getOrCreate(controller.golemId);
                convoManager = instance.convoManager;
            } catch (e) {
                console.warn('[SkillHandler] 無法取得產線系統', e.message);
            }
        }

        const sendFeedback = async (message, hintMeta = {}) => {
            const reminder = SkillHandler._buildPostCheckHint(hintMeta.exampleText || '');
            const fullMessage = `${message}${reminder}`;
            const feedbackPrompt = `[System Observation]\n` +
                `以下是上一個工具、技能或 MCP 呼叫的執行結果。\n\n` +
                `限制：\n` +
                `- 你現在處於 observation_summary 模式。\n` +
                `- 請只使用 [GOLEM_REPLY] 整理結果給使用者。\n` +
                `- 禁止輸出 [GOLEM_ACTION]。\n` +
                `- 如果你認為必須繼續使用工具，請先說明原因並等待使用者確認。\n\n` +
                `工具結果：\n${fullMessage}`;
            if (convoManager) {
                const isAuto = process.env.GOLEM_AUTO_APPROVE_ALL === 'true';
                const isSilent = process.env.GOLEM_SILENT_AUTO_APPROVE === 'true';
                const feedbackOptions = { 
                    isPriority: true, 
                    bypassDebounce: true,
                    isSystemFeedback: true,
                    allowActions: false,
                    actionDepth: Number(dispatchOptions.actionDepth || 0) + 1,
                    maxActionDepth: Number(dispatchOptions.maxActionDepth || process.env.GOLEM_MAX_AUTO_TURNS || 5),
                    suppressReply: isAuto && isSilent
                };
                await convoManager.enqueue(ctx, feedbackPrompt, feedbackOptions);
            } else if (brain && typeof brain.sendMessage === 'function') {
                brain.sendMessage(feedbackPrompt).catch(err => console.warn('[SkillHandler] Fallback sendFeedback error:', err));
            }
        };

        // ─── MCP Tool Call ─────────────────────────────────────────────
        if (act.action === 'mcp_call') {
            const { server, tool, parameters = {} } = act;
            if (!server || !tool) {
                await ctx.reply(`❌ mcp_call 缺少必要欄位 server 或 tool`);
                return true;
            }
            // 🔇 MCP 調用過程只寫到 server log，不發到 chat/Telegram
            console.log(`[MCP] ⏳ 調用 ${server} → ${tool}`, JSON.stringify(parameters).slice(0, 200));
            try {
                const mcpManager = MCPManager.getInstance();
                await mcpManager.load();   // 確保 servers 已連線（load 內部有冪等保護）
                const validation = MCPCallValidator.validateMcpCall({
                    server,
                    tool,
                    parameters,
                }, {
                    servers: mcpManager.getServers(),
                });
                if (!validation.ok) {
                    const message = MCPCallValidator.formatValidationError(validation);
                    const inlineExample = validation.example ? `\n範例：\n${JSON.stringify(validation.example, null, 2)}` : '';
                    await ctx.reply(`❌ [MCP] 呼叫格式錯誤：${validation.errors.join('; ')}${inlineExample}`);
                    await sendFeedback(message);
                    return true;
                }
                const normalizedCall = validation.normalizedCall || { server, tool, parameters };
                const normServer = normalizedCall.server || server;
                const normTool = normalizedCall.tool || tool;
                const normParams = normalizedCall.parameters || parameters;
                if (normalizedCall.aliasedFrom || (Array.isArray(normalizedCall.paramFixes) && normalizedCall.paramFixes.length > 0)) {
                    console.log(
                        `[MCP] 🔧 正規化: ${server}/${tool} -> ${normServer}/${normTool}` +
                        `${normalizedCall.paramFixes?.length ? ` | fixes=${normalizedCall.paramFixes.join(',')}` : ''}`
                    );
                }
                const result = await mcpManager.callTool(normServer, normTool, normParams);

                // 格式化結果。完整內容只送回 LLM，避免工具輸出被截斷後影響後續分析。
                let feedbackResult = '';
                if (result && result.content && Array.isArray(result.content)) {
                    feedbackResult = result.content
                        .map(c => c.type === 'text' ? c.text : JSON.stringify(c))
                        .join('\n');
                } else {
                    feedbackResult = JSON.stringify(result, null, 2);
                }

                // 🔇 結果只寫 log + 送給 LLM (sendFeedback)，不 ctx.reply
                console.log(`[MCP] ✅ ${normServer}/${normTool} 完成 (${feedbackResult.length} chars)`);
                if (normServer === 'chrome-devtools' && normTool === 'navigate_page') {
                    const followupHint = await SkillHandler._buildNavigateFollowupHint(mcpManager, normServer);
                    feedbackResult = `${feedbackResult}${followupHint}`;
                }
                const mcpExample = MCPToolCatalog.buildActionExample(normServer, normTool, validation.schema || {});
                await sendFeedback(`[MCP Result - ${normServer}/${normTool}]\n${feedbackResult}`, {
                    exampleText: mcpExample ? JSON.stringify(mcpExample, null, 2) : ''
                });
            } catch (e) {
                // ⚠️ 錯誤仍然通知用戶（靜默失敗比用戶困惑更糟）
                console.error(`[MCP] ❌ ${server}/${tool} 執行錯誤:`, e.message);
                await ctx.reply(`❌ [MCP] ${server}/${tool} 執行錯誤: ${e.message}`);
                const mcpErrExample = MCPToolCatalog.buildActionExample(server, tool, {});
                await sendFeedback(`[MCP Error - ${server}/${tool}]\n${e.message}`, {
                    exampleText: mcpErrExample ? JSON.stringify(mcpErrExample, null, 2) : ''
                });
            }
            return true;
        }


        // ─── Dynamic Skills ────────────────────────────────────────────
        const skillName = act.action;
        const normalizedSkillName = String(skillName || '').toLowerCase().replace(/_/g, '-');
        if (normalizedSkillName === 'sys-admin') {
            return false;
        }
        const dynamicSkill = skillManager.getSkill(skillName);

        if (dynamicSkill) {
            await ctx.reply(`🔌 執行技能: **${dynamicSkill.name}**...`);
            try {
                // act.args 是技能的實際參數（內層），act 本身是 action 物件（外層）
                // 優先使用 act.args，若無則 fallback 到 act.parameters，最後才是整個 act
                const skillArgs = act.args || act.parameters || act;
                const result = await dynamicSkill.run({
                    page: brain.page,
                    browser: brain.browser,
                    brain: brain,
                    log: console,
                    io: { ask: (q) => ctx.reply(q) },
                    args: skillArgs
                });
                if (result) {
                    console.log(`[Skill] ✅ ${dynamicSkill.name} 完成 (${String(result).length} chars)`);
                    await ctx.reply(`✅ 技能「${dynamicSkill.name}」已完成，正在整理結果...`);
                    await sendFeedback(`[Skill Result - ${dynamicSkill.name}]\n${String(result)}`, {
                        exampleText: SkillHandler._buildSkillActionExample(dynamicSkill.name, act.args || act.parameters || {})
                    });
                } else {
                    console.log(`[Skill] ✅ ${dynamicSkill.name} 完成 (無回傳值)`);
                    await sendFeedback(`[Skill Result - ${dynamicSkill.name}]\n(無回傳值)`, {
                        exampleText: SkillHandler._buildSkillActionExample(dynamicSkill.name, act.args || act.parameters || {})
                    });
                }
            } catch (e) {
                await ctx.reply(`❌ 技能執行錯誤: ${e.message}`);
                await sendFeedback(`[Skill Error - ${dynamicSkill.name}]\n${e.message}`, {
                    exampleText: SkillHandler._buildSkillActionExample(dynamicSkill.name, act.args || act.parameters || {})
                });
            }
            return true; // Indicates the skill was handled
        }
        const notFoundHelp = SkillHandler._buildSkillNotFoundHelp(skillName);
        await ctx.reply(notFoundHelp);
        await sendFeedback(`[Skill Error]\n${notFoundHelp}`, {
            exampleText: SkillHandler._buildSkillActionExample(skillName, act.args || act.parameters || {})
        });
        return true;
    }
}

module.exports = SkillHandler;
