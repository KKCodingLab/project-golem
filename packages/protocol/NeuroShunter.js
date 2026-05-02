const ResponseParser = require('../../src/utils/ResponseParser');
const MultiAgentHandler = require('../../src/core/action_handlers/MultiAgentHandler');
const SkillHandler = require('../../src/core/action_handlers/SkillHandler');
const CommandHandler = require('../../src/core/action_handlers/CommandHandler');
const { CONFIG } = require('../../src/config');

function sanitizeReply(text) {
    if (!text) return "";
    if (typeof ResponseParser.sanitizeProtocolTags === 'function' && !ResponseParser.sanitizeProtocolTags._isMockFunction) {
        return ResponseParser.sanitizeProtocolTags(text);
    }
    return String(text)
        .replace(/\[{1,2}\s*(?:BEGIN|END)\s*:[^\]\n\r]+?\]{1,2}/gi, '')
        .replace(/\[\s*(?:BEGIN|END)\s*:[^\]\n\r]+?\]\]/gi, '')
        .replace(/\[\[?\s*(?:BEGIN|END)\s*:[^\]\n\r]+?\]?\]?/gi, '')
        .replace(/\[\/?GOLEM_(?:MEMORY|ACTION|REPLY)\]/gi, '')
        .trim();
}

// ============================================================
// 🧬 NeuroShunter (神經分流中樞 - 核心路由器)
// ============================================================
class NeuroShunter {
    static async dispatch(ctx, rawResponse, brain, controller, options = {}) {
        let textToParse = rawResponse;
        let attachments = options.attachments || [];

        // 📥 [v9.1.10] 支援結構化回應物件 { text, attachments }
        if (rawResponse && typeof rawResponse === 'object' && !Array.isArray(rawResponse)) {
            textToParse = rawResponse.text || "";
            attachments = [...attachments, ...(rawResponse.attachments || [])];
        }

        const parsed = ResponseParser.parse(textToParse);
        let shouldSuppressReply = options.suppressReply === true;
        const isSystemFeedback = options.isSystemFeedback === true;
        const allowActions = options.allowActions === true;
        const actionDepth = Number(options.actionDepth || 0);
        const maxActionDepth = Math.max(1, Number(options.maxActionDepth || CONFIG.MAX_AUTO_TURNS || 5));

        // 🎯 [v9.1.13] 靜默模式自癒：如果沒有後續動作 (Action)，代表任務結束，強制解除靜默以顯示最終回覆
        if (shouldSuppressReply && parsed.actions.length === 0) {
            console.log(`📢 [NeuroShunter] 偵測到任務結束或無後續動作，自動解除靜默模式。`);
            shouldSuppressReply = false;
        }

        // 核心：偵測 [INTERVENE] 標籤以實現觀察者模式自主介入
        if (textToParse.includes('[INTERVENE]')) {
            console.log(`🚀 [NeuroShunter] 偵測到 AI 自主介入請求 [INTERVENE]！`);
            shouldSuppressReply = false;
        }

        if (parsed.reply && parsed.reply.includes('[INTERVENE]')) {
            parsed.reply = parsed.reply.replace(/\[INTERVENE\]/g, '').trim();
        }
        if (parsed.reply) {
            parsed.reply = sanitizeReply(parsed.reply);
        }

        // 1. 處理長期記憶寫入
        if (parsed.memory) {
            console.log(`[GOLEM_MEMORY]\n${parsed.memory}`);
            await brain.memorize(parsed.memory, { type: 'fact', timestamp: Date.now() });
        }

        // 1. 處理直接回覆 (讓 AI 的解說文字在行動之前出現)
        if (parsed.reply && !shouldSuppressReply) {
            let finalReply = parsed.reply;
            if (ctx.platform === 'telegram' && ctx.shouldMentionSender) {
                finalReply = `${ctx.senderMention} ${parsed.reply}`;
            }
            console.log(`[TERMINAL] 🤖 [Golem] 說: ${finalReply}${attachments.length > 0 ? ' 📎 含有附件' : ''}`);

            // ✨ [Log] 記錄 AI 回應
            if (brain && typeof brain._appendChatLog === 'function') {
                brain._appendChatLog({
                    sender: 'Golem',
                    content: finalReply,
                    type: 'ai',
                    role: 'Assistant',
                    isSystem: false,
                    attachments: attachments
                });
            }

            // 附件處理：若無附件則維持單參數呼叫，相容既有上下文與測試
            if (attachments.length > 0) {
                await ctx.reply(finalReply, { attachments: attachments });
            } else {
                await ctx.reply(finalReply);
            }
        } else if (parsed.reply && shouldSuppressReply) {
            console.log(`🤫 [NeuroShunter] 檢測到靜默模式，已攔截回覆內容。`);
        }

        const blockedObservationActions = isSystemFeedback
            && parsed.actions.length > 0
            && (!allowActions || actionDepth >= maxActionDepth);

        if (blockedObservationActions) {
            console.warn(
                `[NeuroShunter] System Observation 產生 ${parsed.actions.length} 個 action，已阻擋。` +
                ` allowActions=${allowActions}, depth=${actionDepth}/${maxActionDepth}`
            );

            if (!parsed.reply && !shouldSuppressReply) {
                await ctx.reply(
                    `⚠️ 工具結果已收到，但後續自動行動已暫停。\n` +
                    `若需要繼續，請明確回覆「繼續」或重新下達下一步指令。`
                );
            }
            parsed.actions = [];
        }

        // 2. 處理結構化 Action 分配 (讓批准視窗在回覆之後彈出)
        if (parsed.actions.length > 0) {
            console.log(`[GOLEM_ACTION] (${shouldSuppressReply ? 'Silent' : 'Normal'})\n${JSON.stringify(parsed.actions, null, 2)}`);
            const normalActions = [];

            for (const act of parsed.actions) {
                switch (act.action) {
                    case 'multi_agent':
                        await MultiAgentHandler.execute(ctx, act, controller, brain);
                        break;
                    default:
                        // 檢查是否為動態擴充技能
                        const isSkillHandled = await SkillHandler.execute(ctx, act, brain, controller, {
                            actionDepth,
                            maxActionDepth,
                            allowActions
                        });
                        if (!isSkillHandled) {
                            // 若不是已知框架 Action 和非動態技能，則視為底層 Shell 指令
                            normalActions.push(act);
                        }
                        break;
                }
            }

            // 處理剩餘的終端指令序列並自動啟動回饋循環 (Feedback Loop)
            if (normalActions.length > 0) {
                await CommandHandler.execute(ctx, normalActions, controller, brain, (c, r, b, ctrl) => this.dispatch(c, r, b, ctrl, options), {
                    actionDepth,
                    maxActionDepth,
                    allowActions
                });
            }
        }
    }
}

module.exports = NeuroShunter;
