const fs = require('fs');
const path = require('path');

/**
 * Reincarnate Execution Layer
 * 負責將記憶摘要寫入信號檔，並觸發系統重啟。
 */
async function run(ctx) {
    const args = ctx.args || ctx.parameters || {};
    const summary = args.summary || args.args || "";

    if (!summary || summary.trim() === '') {
        return "❌ 轉生失敗：沒有提供記憶摘要！";
    }

    const signalData = {
        timestamp: Date.now(),
        summary: summary.trim()
    };

    const signalPath = path.join(process.cwd(), '.reincarnate_signal.json');

    try {
        fs.writeFileSync(signalPath, JSON.stringify(signalData, null, 2), 'utf-8');
        return "✅ 記憶摘要已成功封裝！🚀 轉生信號已發射！主腦即將接手並重啟 Web 會話...";
    } catch (error) {
        throw new Error(`發射轉生信號失敗: ${error.message}`);
    }
}

module.exports = {
    name: "REINCARNATE",
    description: "開啟新會話，遺忘舊歷史",
    run: run
};

if (require.main === module) {
    const rawArgs = process.argv[2];
    if (!rawArgs) process.exit(1);
    try {
        const parsed = JSON.parse(rawArgs);
        run({ args: parsed }).then(console.log).catch(e => console.error(e.message));
    } catch (e) {
        // Fallback for raw string summary if not JSON
        run({ args: { summary: rawArgs } }).then(console.log).catch(e => console.error(e.message));
    }
}
