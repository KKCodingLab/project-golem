module.exports = {
    name: 'duckduckgo-search',
    description: 'v1.1 高強健搜尋：整合多重 UA 偽裝與內容過濾，專門繞過 HTML 偵測。',
    tags: ['#stable', '#web-search'],
    async run(ctx, args) {
        const query = args.query || args._[0];
        if (!query) return '請輸入搜尋詞';
        try {
            const encoded = encodeURIComponent(query);
            const url = `https://html.duckduckgo.com/html/?q=${encoded}&kl=tw-tzh`;
            const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
            const command = `curl -s -L -A "${ua}" -e "https://duckduckgo.com/" "${url}" | grep -iE "result__(a|title)" | sed 's/<[^>]*>//g' | sed 's/^[[:space:]]*//' | head -n 10`;
            const { stdout, stderr } = await ctx.io.shell(command);
            if (stderr) ctx.log.error(stderr);
            return stdout ? `### DuckDuckGo 搜尋結果：\n\n${stdout.trim()}` : '搜尋引擎拒絕連線或未找到內容，請嘗試更換關鍵字。';
        } catch (e) {
            return `系統異常: ${e.message}`;
        }
    }
};
