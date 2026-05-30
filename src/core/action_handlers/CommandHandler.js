const { v4: uuidv4 } = require('uuid');

class CommandHandler {
    static async execute(ctx, normalActions, controller, brain, dispatchFn, dispatchOptions = {}) {
        if (!normalActions || normalActions.length === 0) return;

        // ✨ [v9.1] 整合行動產線：將一般任務執行丟入 ActionQueue
        // 注意：這裡假設我們從某處能取得與本回合指令對應的 actionQueue 和 convoManager
        // 為了最小侵入性，我們透過 brain 物件往上追溯，或在 Golem 架構中取得
        let actionQueue = null;
        let convoManager = null;

        try {
            const getOrCreate =
                (typeof global.getOrCreateGolem === 'function' && global.getOrCreateGolem) ||
                require('../../../index').getOrCreateGolem;
            const instance = getOrCreate(controller.golemId);
            actionQueue = instance.actionQueue;
            convoManager = instance.convoManager;
        } catch (e) {
            console.warn('[CommandHandler] 無法取得雙產線系統，退回單產線模式', e.message);
        }

        const runLogic = async () => {
            let result;
            try {
                result = await controller.runSequence(ctx, normalActions, 0, brain);
            } catch (err) {
                console.error('[CommandHandler] runSequence 拋出例外:', err);
                await ctx.reply(`❌ **指令執行失敗**\n\`\`\`\n${err.message}\n\`\`\``, { parse_mode: 'Markdown' });
                return;
            }

            if (!result) return;

            // 1. 處理需要外部審批的情況
            if (typeof result === 'object') {
                if (result.status === 'PENDING_APPROVAL') {
                    const cmdBlock = result.cmd ? `\n\`\`\`shell\n${result.cmd}\n\`\`\`` : "";
                    await ctx.reply(
                        `⚠️ ${result.riskLevel === 'DANGER' ? '🔴 危險指令' : '🟡 警告'}${cmdBlock}\n\n${result.reason}`,
                        {
                            parse_mode: 'Markdown',
                            disable_web_page_preview: true,
                            reply_markup: {
                                inline_keyboard: [[
                                    { text: '✅ 批准', callback_data: `APPROVE_${result.approvalId}` },
                                    { text: '❌ 拒絕', callback_data: `DENY_${result.approvalId}` }
                                ]]
                            }
                        }
                    );
                    return;
                } else {
                    console.warn('[CommandHandler] 未知的 Object 回傳狀態:', result);
                    return;
                }
            }

            // 2. 處理正常的執行回報 (String Observation)
            if (typeof result === 'string') {
                const failedSteps = result
                    .split('\n\n----------------\n\n')
                    .filter(block => block.includes('[Step') && block.includes(' Failed]'));
                const currentCorrectionAttempt = Number(dispatchOptions.correctionAttempt || 0);
                const maxAutoCorrectionAttempts = Number(process.env.GOLEM_MAX_AUTO_CORRECTION_ATTEMPTS || 1);

                if (failedSteps.length > 0) {
                    const errorSummary = failedSteps.map(block => {
                        const cmdMatch = block.match(/cmd:\s*(.+)/);
                        const errMatch = block.match(/Error:\n([\s\S]+)/);
                        const cmd = cmdMatch ? cmdMatch[1].trim() : '（未知指令）';
                        const errMsg = errMatch ? errMatch[1].trim().slice(0, 300) : block.trim().slice(0, 300);
                        return `🔴 \`${cmd}\`\n\`\`\`\n${errMsg}\n\`\`\``;
                    }).join('\n\n');

                    await ctx.reply(
                        `❌ **指令執行失敗 (${failedSteps.length} 個步驟)**\n\n${errorSummary}`,
                        { parse_mode: 'Markdown' }
                    );
                }

                // 無論成功或失敗，都將完整觀察結果送給大腦分析（讓 AI 知道發生什麼事並作出回應）
                if (ctx.sendTyping) await ctx.sendTyping();
                const hasFailure = failedSteps.length > 0;
                const shouldAutoCorrect = hasFailure && currentCorrectionAttempt < maxAutoCorrectionAttempts;
                const needsUserRetryApproval = hasFailure && !shouldAutoCorrect;
                const correctionExamples = [
                    '{"action":"command","parameter":"ls -la"}',
                    '{"action":"mcp_call","server":"chrome-devtools","tool":"navigate_page","parameters":{"url":"https://example.com","timeout":60000}}',
                    '{"action":"collab-calendar","args":{"action":"add","title":"驗車","start":"2026-05-23T08:00:00+08:00","end":"2026-05-23T10:30:00+08:00"}}'
                ].join('\n');
                const feedbackPrompt = shouldAutoCorrect
                    ? `[System Observation]\n` +
                    `上一輪指令執行失敗，請你立即修正並重新輸出 [GOLEM_ACTION]。\n\n` +
                    `修正規則：\n` +
                    `- 只輸出一個最小必要的修正 action。\n` +
                    `- 優先修正 action 名稱、server/tool、必要參數。\n` +
                    `- 若使用 command，避免高風險串接語法。\n` +
                    `- 失敗重點：\n${failedSteps.join('\n\n---\n\n')}\n\n` +
                    `可用範例：\n${correctionExamples}\n\n` +
                    `原始結果：\n${result}`
                    : `[System Observation]\n` +
                    `以下是上一個指令序列的執行結果。\n\n` +
                    `限制：\n` +
                    `- 你現在處於 observation_summary 模式。\n` +
                    `- 請只使用 [GOLEM_REPLY] 整理結果給使用者。\n` +
                    `- 若回覆涉及查詢結果/事實資訊，請在結尾附「參考來源」清單並提供可點擊 https 連結；若無公開來源，明確寫「參考來源：本次操作無可公開連結來源（僅本地資料/工具輸出）。」。\n` +
                    `- 禁止輸出 [GOLEM_ACTION]。\n` +
                    `- 如果你認為必須繼續使用工具或指令，請先說明原因並等待使用者確認。\n\n` +
                    `指令結果：\n${result}`;

                if (needsUserRetryApproval && controller && controller.pendingTasks) {
                    const approvalId = uuidv4();
                    controller.pendingTasks.set(approvalId, {
                        type: 'CORRECTION_APPROVAL',
                        ctx,
                        timestamp: Date.now(),
                        feedbackPrompt: `[System Observation]\n` +
                            `使用者已批准再次矯正執行。請根據下列錯誤，重新輸出一個修正後的 [GOLEM_ACTION]。\n\n` +
                            `修正規則：\n` +
                            `- 僅輸出一個 action。\n` +
                            `- 必須使用有效 action 名稱（command / mcp_call / 已安裝技能）。\n` +
                            `- mcp_call 必須包含 server + tool。\n` +
                            `- 若是 collab-calendar，請使用 {"action":"collab-calendar","args":{"action":"add",...}}。\n\n` +
                            `可用範例：\n${correctionExamples}\n\n` +
                            `錯誤結果：\n${result}`,
                        actionDepth: Number(dispatchOptions.actionDepth || 0) + 1,
                        maxActionDepth: Number(dispatchOptions.maxActionDepth || process.env.GOLEM_MAX_AUTO_TURNS || 5),
                        nextCorrectionAttempt: currentCorrectionAttempt + 1,
                    });

                    await ctx.reply(
                        `⚠️ 指令已連續矯正失敗 ${currentCorrectionAttempt + 1} 次。\n是否要我要求 Golem 再次修正後重試？`,
                        {
                            reply_markup: {
                                inline_keyboard: [[
                                    { text: '✅ 是，要求再矯正一次', callback_data: `RETRYFIX_${approvalId}` },
                                    { text: '🛑 否，停止本輪 action', callback_data: `STOPFIX_${approvalId}` }
                                ]]
                            }
                        }
                    );
                    return;
                }

                // ✨ [v9.1] 產線串接：將 Observation 放入對話產線
                if (convoManager) {
                    const isAuto = process.env.GOLEM_AUTO_APPROVE_ALL === 'true';
                    const isSilent = process.env.GOLEM_SILENT_AUTO_APPROVE === 'true';
                    const feedbackOptions = { 
                        isPriority: true, 
                        bypassDebounce: true,
                        isSystemFeedback: true, // 🎯 [v9.1.15] Mark as system feedback for turn tracking
                        allowActions: shouldAutoCorrect,
                        correctionAttempt: shouldAutoCorrect ? (currentCorrectionAttempt + 1) : currentCorrectionAttempt,
                        actionDepth: Number(dispatchOptions.actionDepth || 0) + 1,
                        maxActionDepth: Number(dispatchOptions.maxActionDepth || process.env.GOLEM_MAX_AUTO_TURNS || 5),
                        suppressReply: isAuto && isSilent // 🎯 [v9.1.13] 全自動且靜默時，隱藏中間過程
                    };
                    await convoManager.enqueue(ctx, feedbackPrompt, feedbackOptions);
                } else {
                    // Fallback 對話發送
                    const finalRes = await brain.sendMessage(feedbackPrompt, false, {
                        isSystemFeedback: true,
                        allowActions: shouldAutoCorrect,
                        correctionAttempt: shouldAutoCorrect ? (currentCorrectionAttempt + 1) : currentCorrectionAttempt,
                        actionDepth: Number(dispatchOptions.actionDepth || 0) + 1,
                        maxActionDepth: Number(dispatchOptions.maxActionDepth || process.env.GOLEM_MAX_AUTO_TURNS || 5),
                    });
                    await dispatchFn(ctx, finalRes, brain, controller);
                }
            }
        };

        if (actionQueue) {
            // ✨ [v9.1] 由於 DialogueQueue 已建立插隊防護，直接正常排隊即可
            await actionQueue.enqueue(ctx, runLogic, { isPriority: false });
        } else {
            // 退火單產線執行
            await runLogic();
        }
    }
}

module.exports = CommandHandler;
