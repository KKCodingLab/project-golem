const skillManager = require('../../managers/SkillManager');
const MCPManager   = require('../../mcp/MCPManager');
const MCPCallValidator = require('../../mcp/MCPCallValidator');

class SkillHandler {
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

        const sendFeedback = async (message) => {
            const feedbackPrompt = `[System Observation]\n` +
                `以下是上一個工具、技能或 MCP 呼叫的執行結果。\n\n` +
                `限制：\n` +
                `- 你現在處於 observation_summary 模式。\n` +
                `- 請只使用 [GOLEM_REPLY] 整理結果給使用者。\n` +
                `- 禁止輸出 [GOLEM_ACTION]。\n` +
                `- 如果你認為必須繼續使用工具，請先說明原因並等待使用者確認。\n\n` +
                `工具結果：\n${message}`;
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
                    await ctx.reply(`❌ [MCP] 呼叫格式錯誤：${validation.errors.join('; ')}`);
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
                await sendFeedback(`[MCP Result - ${normServer}/${normTool}]\n${feedbackResult}`);
            } catch (e) {
                // ⚠️ 錯誤仍然通知用戶（靜默失敗比用戶困惑更糟）
                console.error(`[MCP] ❌ ${server}/${tool} 執行錯誤:`, e.message);
                await ctx.reply(`❌ [MCP] ${server}/${tool} 執行錯誤: ${e.message}`);
                await sendFeedback(`[MCP Error - ${server}/${tool}]\n${e.message}`);
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
                const result = await dynamicSkill.run({
                    page: brain.page,
                    browser: brain.browser,
                    brain: brain,
                    log: console,
                    io: { ask: (q) => ctx.reply(q) },
                    args: act
                });
                if (result) {
                    console.log(`[Skill] ✅ ${dynamicSkill.name} 完成 (${String(result).length} chars)`);
                    await ctx.reply(`✅ 技能「${dynamicSkill.name}」已完成，正在整理結果...`);
                    await sendFeedback(`[Skill Result - ${dynamicSkill.name}]\n${String(result)}`);
                } else {
                    console.log(`[Skill] ✅ ${dynamicSkill.name} 完成 (無回傳值)`);
                    await sendFeedback(`[Skill Result - ${dynamicSkill.name}]\n(無回傳值)`);
                }
            } catch (e) {
                await ctx.reply(`❌ 技能執行錯誤: ${e.message}`);
                await sendFeedback(`[Skill Error - ${dynamicSkill.name}]\n${e.message}`);
            }
            return true; // Indicates the skill was handled
        }
        return false; // Not a dynamic skill, indicates pass-through
    }
}

module.exports = SkillHandler;
