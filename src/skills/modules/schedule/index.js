// src/skills/core/schedule.js
// 負責將 Golem 吐出的排程指令，真實寫入到 logs/schedules.json 檔案中，並自動清理過期排程

const fs = require('fs');
const path = require('path');
const ConfigManager = require('../../../config');

async function run(ctx) {
    const args = ctx.args || {};
    try {
        let { task, time } = args;

        if (!task || !time) {
            return "❌ 排程失敗：缺少任務內容或時間。";
        }

        // --- ✨ 時區正規化 (Timezone Normalization) ---
        // 確保存入的 time 帶有正確時區偏移，避免 AutonomyManager 誤判
        let dateObj = new Date(time);

        // 檢查輸入是否缺少時區標記 (不含 'Z' 也不含 '+/-' 偏移且不是 timestamp)
        const isNaive = typeof time === 'string' && !time.includes('Z') && !/[+-]\d{2}(:?\d{2})?$/.test(time);

        if (isNaive && !isNaN(dateObj.getTime())) {
            // 如果是純時間字串，假設為 CONFIG.TZ
            console.log(`🕒 [排程] 原始輸入不含時區: "${time}"，將套用預設時區: ${ConfigManager.CONFIG.TZ}`);

            // 使用 Intl 定位目標時區的當前偏移量，並補全 ISO 字串
            // 這裡簡單處理：直接用 Date 生成帶時區的格式
            const localizedTime = new Date(time).toLocaleString('en-US', { timeZone: ConfigManager.CONFIG.TZ });
            dateObj = new Date(localizedTime);
        }

        // 最終存儲統一使用 ISO 格式或帶有明確偏移的字串
        const finalTime = dateObj.toISOString();

        // --- ✨ 路徑隔離 (Path Isolation) ---
        // 根據 golemId 決定儲存路徑 (純 SINGLE 模式)
        const logDir = ConfigManager.LOG_BASE_DIR;

        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        const scheduleFile = path.join(logDir, 'schedules.json');
        let schedules = [];

        // 如果檔案存在，先讀取舊的排程
        if (fs.existsSync(scheduleFile)) {
            const rawData = fs.readFileSync(scheduleFile, 'utf-8');
            if (rawData.trim()) {
                try {
                    schedules = JSON.parse(rawData);
                } catch (e) {
                    console.warn("⚠️ [排程] 舊檔案格式錯誤，將重新初始化。");
                    schedules = [];
                }
            }
        }

        // --- ✨ 自動清理過期排程 (Expiration Cleanup) ---
        const now = new Date().getTime();
        schedules = schedules.filter(item => {
            const itemTime = new Date(item.time).getTime();
            return itemTime > now; // 只保留未來的任務
        });

        // 加入新排程
        schedules.push({
            task: task,
            time: finalTime,
            createdAt: new Date().toISOString()
        });

        // 排序：按時間由近到遠
        schedules.sort((a, b) => new Date(a.time) - new Date(b.time));

        // 寫回檔案
        fs.writeFileSync(scheduleFile, JSON.stringify(schedules, null, 2));

        console.log(`📝 [排程紀錄] 已將任務寫入資料庫: ${task} at ${finalTime} (目前剩餘 ${schedules.length} 筆)`);

        // --- ✨ 同步至 Bot 記憶驅動 (如果存在) ---
        // 確保 Bot 的定時器或 Cron 邏輯能被觸發
        if (ctx.brain && ctx.brain.memoryDriver && typeof ctx.brain.memoryDriver.addSchedule === 'function') {
            console.log("🧠 [排程] 正在橋接至 Bot 記憶驅動...");
            await ctx.brain.memoryDriver.addSchedule(task, finalTime);
        }

        // 回報給 Golem 知道寫入成功了
        return `✅ 排程已成功建立！將於 ${finalTime} 提醒主人：「${task}」。`;

    } catch (e) {
        console.error("❌ [排程紀錄錯誤]:", e);
        return `❌ 排程寫入失敗: ${e.message}`;
    }
}

module.exports = {
    name: "schedule",
    description: "時間排程器",
    run: run
};

// --- ✨ CLI Entry Point ---
if (require.main === module) {
    const rawArgs = process.argv[2];
    if (!rawArgs) process.exit(1);
    try {
        const parsed = JSON.parse(rawArgs);
        // 支援 TaskController 的兩種格式: {args: {...}} 或直接 {...}
        const finalArgs = parsed.args || parsed;
        run({ args: finalArgs }).then(console.log).catch(console.error);
    } catch (e) {
        console.error(`❌ CLI Parse Error: ${e.message}`);
    }
}
