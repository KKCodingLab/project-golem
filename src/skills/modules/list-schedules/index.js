// src/skills/core/list-schedules.js
// 負責讀取並列出 logs/schedules.json 中的所有排程，並在此過濾掉過期內容

const fs = require('fs');
const path = require('path');
const ConfigManager = require('../../../config');

/**
 * 執行排程查詢
 * @param {Object} ctx - 執行上下文，包含 args: { action: "list_schedules" }
 * @returns {Promise<string>} - 回傳給使用者的格式化字串
 */
async function run(ctx) {
    try {
        // --- ✨ 路徑隔離 (Path Isolation) ---
        const logDir = ConfigManager.LOG_BASE_DIR;

        const scheduleFile = path.join(logDir, 'schedules.json');

        if (!fs.existsSync(scheduleFile)) {
            return "📭 目前沒有任何排程紀錄。";
        }

        const rawData = fs.readFileSync(scheduleFile, 'utf-8');
        if (!rawData.trim()) {
            return "📭 目前沒有任何排程紀錄。";
        }

        let schedules = [];
        try {
            schedules = JSON.parse(rawData);
        } catch (e) {
            return "❌ 資料格式錯誤，無法讀取排程。";
        }

        // --- ✨ 二次過濾：確保不顯示已過期的排程 ---
        const now = new Date().getTime();
        schedules = schedules.filter(item => {
            const itemTime = new Date(item.time).getTime();
            return itemTime > now;
        });

        if (schedules.length === 0) {
            return "📭 目前沒有任何未來的排程紀錄。";
        }

        // 排序：按時間由近到遠
        schedules.sort((a, b) => new Date(a.time) - new Date(b.time));

        // 格式化輸出
        let output = "📋 **目前排程清單：**\n\n";
        schedules.forEach((item, index) => {
            const timeStr = new Date(item.time).toLocaleString('zh-TW', {
                timeZone: ConfigManager.CONFIG.TZ || 'Asia/Taipei',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            });
            output += `${index + 1}. ⏰ **${timeStr}**\n   📌 任務：${item.task}\n`;
        });

        output += `\n目前共有 ${schedules.length} 個有效的排程。`;

        console.log(`🔍 [查詢排程] 成功讀取 ${schedules.length} 筆有效資料 (時區: ${ConfigManager.CONFIG.TZ})`);
        return output;

    } catch (e) {
        console.error("❌ [查詢排程錯誤]:", e);
        return `❌ 無法讀取排程清單: ${e.message}`;
    }
}

module.exports = {
    name: "list_schedules",
    description: "列出所有有效排程任務",
    run: run
};

// --- ✨ CLI Entry Point ---
if (require.main === module) {
    const rawArgs = process.argv[2];
    if (!rawArgs) process.exit(1);
    try {
        const parsed = JSON.parse(rawArgs);
        const finalArgs = parsed.args || parsed;
        run({ args: finalArgs }).then(console.log).catch(console.error);
    } catch (e) {
        console.error(`❌ CLI Parse Error: ${e.message}`);
    }
}
