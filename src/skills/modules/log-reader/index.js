// src/skills/core/log-reader.js
// 負責讀取與檢索每日日誌摘要

async function run(ctx) {
    const args = ctx.args || ctx.parameters || {};

    let logManager;
    if (ctx.brain && ctx.brain.chatLogManager) {
        logManager = ctx.brain.chatLogManager;
    } else {
        const ChatLogManager = require('../../../managers/ChatLogManager');
        const ConfigManager = require('../../../config');
        logManager = new ChatLogManager({
            logDir: ConfigManager.LOG_BASE_DIR,
            isSingleMode: true
        });
        await logManager.init();
    }

    try {
        const task = args.task || 'list';

        if (task === 'list') {
            console.log(`📂 [LogReader] 正在檢索已存在的摘要列表...`);
            if (!logManager.allAsync) return "ℹ️ 日誌系統尚未準備就緒。";
            
            const summaries = await logManager.allAsync("SELECT DISTINCT date_string FROM summaries WHERE tier = 'daily' ORDER BY date_string DESC");

            if (!summaries || summaries.length === 0) {
                return "ℹ️ 目前系統中尚無產生的每日摘要。";
            }

            const list = summaries.map(s => s.date_string).join(', ');
            return `📅 現有摘要日期列表：\n${list}\n\n你可以使用 {"action":"log-reader","args":{"task":"get","date":"日期"}} 來讀取內容。`;
        }

        if (task === 'get') {
            if (!args.date) return "❌ 缺少 date 參數。";

            console.log(`📄 [LogReader] 正在讀取 ${args.date} 的摘要內容...`);
            if (!logManager.allAsync) return "❌ 日誌系統尚未準備就緒。";

            const summaries = await logManager.allAsync("SELECT content, timestamp FROM summaries WHERE tier = 'daily' AND date_string = ? ORDER BY id ASC", [args.date]);
            
            if (!summaries || summaries.length === 0) {
                return `❌ 找不到 ${args.date} 的摘要。`;
            }

            let output = `📜 [${args.date} 每日摘要]\n`;
            summaries.forEach((entry, index) => {
                const ts = new Date(entry.timestamp).toLocaleTimeString();
                output += `\n--- 摘要 #${index + 1} (${ts}) ---\n${entry.content}\n`;
            });
            return output;
        }

        return "❌ 未知的任務類型 (list/get)。";
    } catch (e) {
        return `❌ 讀取失敗: ${e.message}`;
    }
}

module.exports = {
    name: "log_read",
    description: "檢索並閱讀每日對話摘要",
    run: run
};
