// src/skills/core/log-archiver.js
// 負責調用 ChatLogManager 進行日誌壓縮與摘要

const ConfigManager = require('../../../config');

async function run(ctx) {
    const args = ctx.args || ctx.parameters || {};
    const brain = ctx.brain || ctx;
    const actualBrain = ctx.brain || brain;

    // 優先使用 brain 已初始化的 chatLogManager (路徑已正確設定)
    if (actualBrain.chatLogManager) {
        try {
            let targetDate = args.date || actualBrain.chatLogManager._getYesterdayDateString();
            console.log(`🗄️ [LogArchiver] 正在為 ${targetDate} 執行手動存檔程序...`);
            await actualBrain.chatLogManager.compressLogsForDate(targetDate, actualBrain, true);
            return `✅ ${targetDate} 的日誌歸檔程序已執行完畢。原始檔案已清理，摘要已寫入存檔。`;
        } catch (e) {
            return `❌ 歸檔失敗: ${e.message}`;
        }
    }

    // Fallback：手動建構 ChatLogManager (確保 mode-aware 路徑)
    const ChatLogManager = require('../../../managers/ChatLogManager');
    const logManager = new ChatLogManager({
        golemId: actualBrain.golemId || args.golemId || 'default',
        logDir: ConfigManager.LOG_BASE_DIR,
        isSingleMode: true
    });

    try {
        await logManager.init();
        let targetDate = args.date || logManager._getYesterdayDateString();
        console.log(`🗄️ [LogArchiver] 正在為 ${targetDate} 執行手動存檔程序...`);
        await logManager.compressLogsForDate(targetDate, actualBrain, true);
        return `✅ ${targetDate} 的日誌歸檔程序已執行完畢。原始檔案已清理，摘要已寫入存檔。`;
    } catch (e) {
        return `❌ 歸檔失敗: ${e.message}`;
    }
}

module.exports = {
    name: "log_archive",
    description: "手動壓縮與摘要指定日期的日誌",
    paramsSchema: {
        date: { type: 'string', description: '要壓縮的日期 (YYYYMMDD)，不填則預設昨日' }
    },
    run: run
};
