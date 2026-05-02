// src/skills/core/wiki.js
// 📖 Wiki 知識庫技能 — 讓 Golem 維護結構化 Markdown 知識頁面
//
// 支援指令：
//   /wiki save <主題>      — 將當前對話整理為 wiki 頁面
//   /wiki list             — 列出所有 wiki 頁面
//   /wiki read <頁面路徑>  — 讀取特定頁面
//   /wiki search <關鍵字>  — 關鍵字搜尋
//   /wiki lint             — 健康檢查
//   /wiki log              — 查看更新日誌

const WikiManager = require('../../../managers/WikiManager');
const ResponseParser = require('../../../utils/ResponseParser');

// ── 輔助：多策略提取並清洗 LLM 回應 ─────────────────────────
//
// Golem 的系統 Prompt 會強制 LLM 輸出完整的協議回應格式：
//   [GOLEM_MEMORY] ... [GOLEM_REPLY] ... [GOLEM_ACTION] ...
//
// 真正的 Markdown 頁面內容可能藏在以下任何位置，依優先序提取：
//   策略1: [GOLEM_ACTION] 的 heredoc (cat > file <<EOF...EOF)
//   策略2: ```markdown ... ``` 程式碼區塊
//   策略3: [GOLEM_REPLY] 後、[GOLEM_ACTION] 前的文字（剝除引導語）
//   策略4: 全文中第一個 # 標題開始的段落
//   策略5: 剝除所有協議塊後剩餘的文字

function _cleanLLMResponse(raw, topicHint = '') {
    if (!raw) return '';

    // ── 策略0：直接提取 [GOLEM_ACTION] parameter，手動解碼轉義字元 ──────
    // ⚠️ 不使用 JSON.parse：Gemini 常在 JSON 字串裡夾帶 \` \$ 等非法 JSON 轉義
    //    (e.g. \`backtick\` 在 JSON 裡是非法的，合法的是 ` 或 \\` )
    // 改用 regex `((?:[^"\\]|\\[\s\S])*?)` 直接提取 parameter 的字串內容，
    // 再用寬鬆手動解碼：\n→換行, \"→", \\→\, 其餘 \X 直接取 X（容錯）。
    {
        const actionParamMatch = raw.match(
            /\[GOLEM_ACTION\][\s\S]*?"(?:parameter|cmd|command)"\s*:\s*"((?:[^"\\]|\\[\s\S])*?)"\s*[\n,}\]]/
        );
        if (actionParamMatch) {
            // 手動寬鬆解碼：所有 \X 序列，合法的照規格處理，非法的直接取 X
            const param = actionParamMatch[1].replace(/\\([\s\S])/g, (_, c) => {
                switch (c) {
                    case 'n':  return '\n';
                    case 't':  return '\t';
                    case 'r':  return '\r';
                    case '"':  return '"';
                    case '\\': return '\\';
                    default:   return c; // \` → `   \$ → $   \! → !  等
                }
            });
            console.log(`📖 [Wiki/S0] param 前 80 字: ${param.slice(0, 80).replace(/\n/g, '↵')}`);

            // 模式A：cat <<EOF > file\n...content...\nEOF
            const heredocMatch = param.match(
                /<<\s*['"]?EOF['"]?(?:\s*>?\s*[^\n]*)?\n([\s\S]*?)\nEOF\s*$/
            );
            if (heredocMatch) {
                const candidate = heredocMatch[1].trim();
                console.log(`📖 [Wiki/S0] heredoc 提取成功，長度=${candidate.length}`);
                if (candidate.length > 30 && candidate.includes('#')) {
                    return _finalClean(candidate, topicHint);
                }
            }

            // 模式B：echo "...content..." > file  (Gemini 有時用 echo 代替 cat <<EOF)
            const echoMatch = param.match(/echo\s+"([\s\S]+?)"\s*(?:>>?\s*\S)/);
            if (echoMatch) {
                const candidate = echoMatch[1].trim();
                console.log(`📖 [Wiki/S0] echo 提取成功，長度=${candidate.length}`);
                if (candidate.length > 30 && candidate.includes('#')) {
                    return _finalClean(candidate, topicHint);
                }
            }

            // 模式C：param 本身就是 Markdown（直接輸出，不走 shell 指令）
            if (param.includes('# ') && param.length > 100) {
                return _finalClean(param, topicHint);
            }
        }
    }




    // ── 策略1：從原始文字 heredoc 提取（LLM 不在 JSON 裡輸出時的備用）
    const heredocMatch = raw.match(/<<\s*['"]?EOF['"]?\s*\n([\s\S]*?)\n\s*EOF/);
    if (heredocMatch) {
        const candidate = heredocMatch[1].trim();
        if (candidate.length > 30 && candidate.includes('#')) {
            return _finalClean(candidate, topicHint);
        }
    }

    // ── 策略2：從 ```markdown 或 ``` 區塊提取
    const mdFenced = raw.match(/```(?:markdown)?\s*\n([\s\S]+?)\n```/);
    if (mdFenced) {
        const candidate = mdFenced[1].trim();
        if (candidate.length > 30) {
            return _finalClean(candidate, topicHint);
        }
    }

    // ── 策略3：[GOLEM_REPLY] 後、[GOLEM_ACTION] 前的回覆文字
    // ⚠️ 必須包含 # 標題才採用，否則可能是暖場語（「正在為您生成...」）
    const replyMatch = raw.match(/\[GOLEM_REPLY\]([\s\S]*?)(?:\[GOLEM_ACTION\]|$)/);
    if (replyMatch) {
        let candidate = replyMatch[1]
            .replace(/^正在執行.*$/m, '')
            .replace(/^正在為您.*$/m, '')
            .replace(/，請稍候\.\.\.$/m, '')
            .trim();
        // 只有含 # 標題的才算真正的 Markdown 頁面內容
        if (candidate.length > 30 && candidate.includes('#')) {
            return _finalClean(candidate, topicHint);
        }
    }

    // ── 策略4：從第一個 # 標題開始取段落 ─────────────────────────
    const h1Idx = raw.search(/(?:^|\n)# /);
    if (h1Idx !== -1) {
        const fromH1    = raw.slice(h1Idx).trim();
        // 截止於下一個 [GOLEM...] 塊
        const endIdx    = fromH1.search(/\n\[GOLEM_/);
        const candidate = endIdx !== -1 ? fromH1.slice(0, endIdx).trim() : fromH1;
        if (candidate.length > 30) {
            return _finalClean(candidate, topicHint);
        }
    }

    // ── 策略5：移除所有已知協議塊，取剩餘文字 ───────────────────
    let stripped = raw
        .replace(/\[GOLEM_MEMORY\][\s\S]*?(?=\[GOLEM_REPLY\]|\[GOLEM_ACTION\]|$)/g, '')
        .replace(/\[GOLEM_REPLY\]/g, '')
        .replace(/\[GOLEM_ACTION\][\s\S]*/g, '')
        .replace(/^(HIPPOCAMPUS|WIKI_STATE|CONTEXT):.*$/gm, '')
        .replace(/\[BEGIN:[^\]]+\]/g, '')
        .replace(/\[END:[^\]]+\]/g, '')
        .replace(/WIKI_INGEST_DONE/g, '')
        .trim();

    return _finalClean(stripped, topicHint);
}

// 最終清洗：移除 AI 引導語 / 暖場語、補標題
function _finalClean(text, topicHint = '') {
    if (!text) return '';
    text = text
        // AI 常見引導語
        .replace(/^(好的[，,。！!]?|當然[！!]?|沒問題[！!]?|以下是[^：:\n]*[：:])\s*/i, '')
        // Golem 協議：OS 狀態注入行
        .replace(/^正在執行\s*\[OS:.*?\].*$/m, '')
        // Golem 暖場語（不限字元長度）
        .replace(/^正在為您.*$/m, '')
        .replace(/^請稍候.*$/m, '')
        .replace(/，內容即將呈現.*$/m, '')
        .replace(/，內容將在接下來呈現.*$/m, '')
        .trim();

    // 若仍缺 H1 標題，自動補上
    if (text.length > 0 && !text.startsWith('#')) {
        text = `# ${topicHint || 'Wiki 頁面'}\n\n${text}`;
    }
    return text.trim();
}

// ── 根據主題關鍵字推斷目錄分類 ────────────────────────────────
function _inferCategory(input) {
    const t = input.toLowerCase();
    if (/用戶|用户|使用者|偏好|習慣|喜歡|討厭|個人|設定|自我/.test(t)) return 'user';
    if (/專案|项目|project|golem|系統|架構/.test(t)) return 'projects';
    if (/決策|決定|設計|選型|架構決|為什麼|adr/.test(t)) return 'decisions';
    return 'general';
}

// ── 根據主題產生安全的檔名 ────────────────────────────────────
function _toSafeFilename(input) {
    return input
        .replace(/[^\w\u4e00-\u9fff\-_ ]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .slice(0, 60) || 'page';
}

// ══════════════════════════════════════════════════════════════
async function run(ctx) {
    const args   = ctx.args || {};
    const brain  = ctx.brain;
    const action = (args.action || '').toLowerCase().trim();
    const input  = (args.input  || '').trim();

    if (!brain || !brain.userDataDir) {
        return '❌ Wiki 技能需要 Brain 實體才能運作。';
    }

    const wiki = new WikiManager(brain.userDataDir);
    wiki.init();

    // ── /wiki list ──────────────────────────────────────────
    if (action === 'list' || action === '列表') {
        const pages = wiki.listPages();
        if (pages.length === 0) {
            return '📭 Wiki 目前沒有任何知識頁面。\n使用 `/wiki save <主題>` 開始建立第一個頁面。';
        }
        const lines = pages.map(p => {
            const days = Math.floor((Date.now() - p.mtime) / (24 * 60 * 60 * 1000));
            const age  = days === 0 ? '今天' : `${days} 天前`;
            const size = (p.size / 1024).toFixed(1);
            return `• \`${p.path}\` _(${size}KB, 更新於 ${age})_`;
        });
        return `📖 **Wiki 知識頁面清單** (共 ${pages.length} 頁):\n\n${lines.join('\n')}`;
    }

    // ── /wiki read <path> ────────────────────────────────────
    if (action === 'read' || action === '讀取') {
        if (!input) return '❌ 請指定頁面路徑。例如：`/wiki read user/profile.md`';
        const content = wiki.readPage(input);
        if (!content) return `❌ 找不到 wiki 頁面：\`${input}\``;
        return `📄 **wiki/${input}**\n\n${content}`;
    }

    // ── /wiki search <query> ─────────────────────────────────
    if (action === 'search' || action === '搜尋') {
        if (!input) return '❌ 請輸入搜尋關鍵字。';
        const results = wiki.search(input);
        if (results.length === 0) {
            return `🔍 Wiki 中找不到包含「${input}」的頁面。`;
        }
        const lines = results.map(r => `• \`${r.path}\`\n  _...${r.snippet}..._`);
        return `🔍 **搜尋結果** (關鍵字：${input}，共 ${results.length} 筆):\n\n${lines.join('\n\n')}`;
    }

    // ── /wiki lint ───────────────────────────────────────────
    if (action === 'lint' || action === '健康') {
        const report = wiki.lint();
        let msg = `🩺 **Wiki 健康報告**\n\n${report.summary}\n\n`;
        msg += `📊 總頁數：${report.total}\n`;

        if (report.orphans.length > 0) {
            msg += `\n⚠️ **孤兒頁面** (未在 index.md 中)：\n`;
            msg += report.orphans.map(p => `  • \`${p}\``).join('\n');
        }
        if (report.stale.length > 0) {
            msg += `\n\n🕰️ **過時頁面** (>30 天未更新)：\n`;
            msg += report.stale.map(p => `  • \`${p.path}\` (${p.daysOld} 天)`).join('\n');
        }
        if (report.small.length > 0) {
            msg += `\n\n📄 **空殼頁面** (<50 字元)：\n`;
            msg += report.small.map(p => `  • \`${p}\``).join('\n');
        }
        return msg;
    }

    // ── /wiki log ────────────────────────────────────────────
    if (action === 'log' || action === '日誌') {
        const logContent = wiki.readLog(50);
        if (!logContent || logContent === '（尚無日誌）') {
            return '📋 Wiki 尚無更新紀錄。';
        }
        return `📋 **Wiki 更新日誌** (最近 50 筆):\n\n${logContent}`;
    }

    // ── /wiki save <topic> ───────────────────────────────────
    // ✅ 兩步驟法：直接讓 LLM 輸出 Markdown，不依賴特殊格式標記
    if (action === 'save' || action === '儲存' || action === '保存') {
        if (!input) {
            return '❌ 請指定主題。例如：`/wiki save 用戶偏好TypeScript`';
        }

        // 推斷目錄分類與安全檔名
        const category = _inferCategory(input);
        const safeName = _toSafeFilename(input);
        const pagePath = `${category}/${safeName}.md`;

        // 讀取近期對話作為知識背景（可選）
        let contextBlock = '';
        try {
            if (brain.chatLogManager && brain.chatLogManager._isInitialized) {
                const recent = await brain.chatLogManager.readRecentHourlyAsync(80, 5000);
                if (recent && recent.trim().length > 0) {
                    contextBlock = `\n以下是相關的近期對話背景（供參考）：\n---\n${recent}\n---\n`;
                }
            }
        } catch (e) {
            console.warn('⚠️ [Wiki] 無法讀取近期對話:', e.message);
        }

        // 檢查是否有舊頁面（更新場景）
        const existingContent = wiki.readPage(pagePath);
        const updateBlock = existingContent
            ? `\n現有頁面內容（請在此基礎上更新）：\n---\n${existingContent}\n---\n`
            : '';

        // ── 核心提示詞：只要求輸出純 Markdown，無特殊格式 ──
        const savePrompt =
            `【Wiki 頁面${existingContent ? '更新' : '撰寫'}指令】\n` +
            `請為以下主題${existingContent ? '更新' : '撰寫'}一個結構化的 Markdown wiki 頁面。\n\n` +
            `主題：${input}\n` +
            `${updateBlock}` +
            `${contextBlock}\n` +
            `要求：\n` +
            `1. 第一行必須是 # 標題（Markdown H1）\n` +
            `2. 使用小節（## / ###）組織內容\n` +
            `3. 包含具體、有實際參考價值的資訊，而非空泛描述\n` +
            `4. 長度約 200~600 字（中文）\n` +
            `5. 【重要】只輸出頁面的 Markdown 內容本身，不要任何前言、解釋或結尾語`;

        try {
            // ⚠️ 不用 brain.sendMessage()！那會觸發 NeuroShunter 協議解析，
            // 導致 LLM 回應裡的 [GOLEM_ACTION] 被 CommandHandler 真實執行（cat > 寫檔）。
            // 改用 brain._wikiChat()：繞過協議包裝，直接取得 LLM 的原始回應文字。
            const rawText = await brain._wikiChat(savePrompt);
            const pageContent = _cleanLLMResponse(rawText, input);

            if (!pageContent || pageContent.trim().length < 20) {
                return (
                    `⚠️ Wiki 儲存失敗：回傳內容過短或為空。\n` +
                    `_原始回應前 150 字：${rawText.slice(0, 150)}_`
                );
            }

            wiki.writePage(pagePath, pageContent, `/wiki save: ${input}`);

            const verb = existingContent ? '更新' : '建立';

            // ── 存檔後驗證：偵測協議雜訊殘留 ────────────────────────
            const CONTAMINATION_MARKERS = ['[GOLEM_', 'HIPPOCAMPUS:', 'WIKI_STATE:', '[BEGIN:', '[END:'];
            const isContaminated = CONTAMINATION_MARKERS.some(m => pageContent.includes(m));
            const contaminationWarning = isContaminated
                ? `\n\n⚠️ _注意：頁面可能含有少量協議殘留，建議用 \`/wiki read ${pagePath}\` 確認後再使用。_`
                : '';

            return (
                `✅ **Wiki 頁面已${verb}！**\n\n` +
                `📄 \`wiki/${pagePath}\`\n` +
                `📝 _已儲存 ${pageContent.length} 字元_` +
                `${contaminationWarning}\n\n` +
                `_使用 \`/wiki read ${pagePath}\` 查看內容。下次啟動時將自動注入此知識。_`
            );
        } catch (e) {
            return `❌ Wiki 儲存失敗：${e.message}`;
        }
    }

    // ── /wiki delete <path> ──────────────────────────────────
    if (action === 'delete' || action === '刪除') {
        if (!input) return '❌ 請指定要刪除的頁面路徑。';
        const content = wiki.readPage(input);
        if (!content) return `❌ 找不到頁面：\`${input}\``;
        wiki.deletePage(input);
        return `🗑️ 已刪除 Wiki 頁面：\`${input}\``;
    }

    // ── 無效指令：顯示說明 ────────────────────────────────────
    return `📖 **Wiki 知識庫指令說明**

\`/wiki save <主題>\`      — 將對話/知識整理為 wiki 頁面（複利積累）
\`/wiki list\`             — 列出所有 wiki 頁面
\`/wiki read <路徑>\`      — 讀取特定頁面內容
\`/wiki search <關鍵字>\`  — 搜尋相關頁面
\`/wiki lint\`             — 執行知識庫健康檢查
\`/wiki log\`              — 查看更新日誌
\`/wiki delete <路徑>\`    — 刪除指定頁面

💡 **建議用法**：每次重要對話結束時，用 \`/wiki save\` 讓 Golem 整理知識複利增長。`;
}

module.exports = {
    name:        'wiki',
    description: '結構化知識 Wiki 維護系統',
    paramsSchema: {
        action: { type: 'string', enum: ['save', 'read', 'list', 'search', 'lint', 'log', 'delete'], required: true,
                  description: 'save=儲存知識, read=讀取, list=列表, search=搜尋, lint=健康檢查, log=日誌, delete=刪除' },
        input:  { type: 'string', description: '主題名稱/頁面路徑/搜尋關鍵字（list/lint/log 指令不需要）' }
    },
    run,
    PROMPT: `
【已載入技能：Wiki 知識庫管理員】
你可以維護一個持久化的 Markdown 知識 Wiki，指令包括：
/wiki save <主題>、/wiki list、/wiki read <路徑>、/wiki search <關鍵字>、/wiki lint、/wiki log
當使用者要求「記住」、「儲存」某個知識或偏好時，主動建議使用 /wiki save。
`
};
