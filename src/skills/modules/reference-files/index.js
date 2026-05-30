const ReferenceFileService = require('../../../services/ReferenceFileService');

const PROMPT = `【已載入技能：REFERENCE_FILES】
用途：查詢全域「代理人參考文件」庫。當使用者提到參考文件、指定檔名/路徑，或你需要更多背景資料時，請主動使用此技能。
Action 格式：
- 列出文件：{"action":"reference-files","args":{"task":"list"}}
- 搜尋文件：{"action":"reference-files","args":{"task":"search","query":"關鍵字或問題","limit":5}}
- 讀取文件：{"action":"reference-files","args":{"task":"read","id":"ref_xxx","maxChars":12000}}
- 重新索引：{"action":"reference-files","args":{"task":"reindex","id":"ref_xxx"}}
原則：若自動注入的【相關參考文件】不足以回答，請先 search 或 read，再根據技能回報回答使用者。`;

function formatFile(file) {
    return [
        `- ${file.name} (${file.id})`,
        `  路徑：${file.path}`,
        `  狀態：${file.status}${file.chunkCount !== undefined ? ` / chunks: ${file.chunkCount}` : ''}`,
        file.description ? `  描述：${file.description}` : null,
        file.error ? `  錯誤：${file.error}` : null,
    ].filter(Boolean).join('\n');
}

async function run(ctx) {
    const args = ctx.args || ctx.parameters || {};
    const task = String(args.task || args.action || 'search').toLowerCase();

    if (task === 'list') {
        const files = ReferenceFileService.list();
        if (files.length === 0) return '目前沒有已登記的代理人參考文件。';
        return `代理人參考文件清單：\n${files.map(formatFile).join('\n\n')}`;
    }

    if (task === 'search') {
        const query = String(args.query || args.q || '').trim();
        if (!query) return '請提供 query 參數，例如 {"action":"reference-files","args":{"task":"search","query":"合約條款"}}';
        const results = ReferenceFileService.search(query, { limit: Number(args.limit || 5) });
        if (results.length === 0) return `找不到與「${query}」相關的參考文件片段。`;
        return results.map((result, index) => [
            `#${index + 1} ${result.name} (${result.fileId})`,
            `路徑：${result.path}`,
            `分數：${result.score.toFixed(2)} / chunk ${result.chunkIndex}`,
            result.description ? `描述：${result.description}` : null,
            `內容：\n${result.text}`,
        ].filter(Boolean).join('\n')).join('\n\n---\n\n');
    }

    if (task === 'read') {
        const id = String(args.id || args.fileId || args.file_id || '').trim();
        if (!id) return '請提供 id 參數，例如 {"action":"reference-files","args":{"task":"read","id":"ref_xxx"}}';
        const file = ReferenceFileService.read(id, { maxChars: Number(args.maxChars || args.max_chars || 12000) });
        if (!file) return `找不到參考文件：${id}`;
        return [
            `文件：${file.name}`,
            `ID：${file.id}`,
            `路徑：${file.path}`,
            file.description ? `描述：${file.description}` : null,
            `內容：\n${file.text}`,
        ].filter(Boolean).join('\n');
    }

    if (task === 'reindex') {
        const id = String(args.id || args.fileId || args.file_id || '').trim();
        if (!id) return '請提供 id 參數。';
        const file = ReferenceFileService.indexFile(id);
        return `已重新索引：\n${formatFile(file)}`;
    }

    return '未知 task。可用：list / search / read / reindex。';
}

module.exports = {
    name: 'reference_files',
    PROMPT,
    description: '列出、搜尋、讀取代理人參考文件庫中的全域文件',
    paramsSchema: {
        task: { type: 'string', enum: ['list', 'search', 'read', 'reindex'], description: '操作類型' },
        query: { type: 'string', description: 'search 使用的查詢文字' },
        id: { type: 'string', description: 'read/reindex 使用的參考文件 ID' },
        limit: { type: 'number', description: 'search 回傳筆數' },
    },
    run,
};

if (require.main === module) {
    const rawArgs = process.argv[2] || '{}';
    try {
        const parsed = JSON.parse(rawArgs);
        run({ args: parsed }).then(console.log).catch((error) => {
            console.error(`❌ [ReferenceFiles] ${error.message}`);
        });
    } catch (error) {
        console.error(`❌ CLI Parse Error: ${error.message}`);
    }
}
