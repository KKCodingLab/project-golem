const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// ============================================================
// 📨 Message Manager (雙模版訊息切片器)
// ============================================================
class MessageManager {
    static async send(ctx, text, options = {}) {
        if (!text) return;
        const MAX_LENGTH = ctx.platform === 'telegram' ? 4000 : 1900;
        const chunks = [];
        let remaining = text;
        while (remaining.length > 0) {
            if (remaining.length <= MAX_LENGTH) { chunks.push(remaining); break; }
            let splitIndex = remaining.lastIndexOf('\n', MAX_LENGTH);
            if (splitIndex === -1) splitIndex = MAX_LENGTH;
            chunks.push(remaining.substring(0, splitIndex));
            remaining = remaining.substring(splitIndex).trim();
        }

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const isLastChunk = i === chunks.length - 1;

            // ✅ [Fix] 同步廣播到 Web Dashboard
            try {
                const dashboard = require('../../dashboard');
                if (dashboard && dashboard.webServer) {
                    const golemId = (ctx.instance && ctx.instance.golemConfig) ? ctx.instance.golemConfig.id : 'golem_A';
                    
                    const payload = {
                        time: new Date().toLocaleTimeString('zh-TW', { hour12: false }),
                        msg: `[${golemId}] ${chunk}`,
                        type: 'agent',
                        golemId
                    };
                    if (options && options.reply_markup && options.reply_markup.inline_keyboard) {
                        payload.type = 'approval';
                        payload.actionData = options.reply_markup.inline_keyboard[0];
                    }

                    // 📸 [v9.1.10] 僅在最後一個 Chunk 附帶圖片，避免重複顯示
                    if (isLastChunk && options.attachments && options.attachments.length > 0) {
                        payload.attachments = options.attachments;
                    }

                    dashboard.webServer.broadcastLog(payload);
                }
            } catch (e) { }

            try {
                if (ctx.platform === 'telegram') {
                    // Telegram 處理附件 (僅在最後一個 Chunk 發送)
                    if (isLastChunk && options.attachments && options.attachments.length > 0) {
                        for (const att of options.attachments) {
                            const isImage = att.mimeType?.startsWith('image');
                            const isSvg = att.mimeType?.includes('svg') || (att.path && att.path.toLowerCase().endsWith('.svg')) || (att.url && att.url.toLowerCase().endsWith('.svg'));
                            
                            // Telegram 的 sendPhoto 不支援 SVG 等向量格式，必須退回使用 sendDocument
                            if (isImage && !isSvg) {
                                await ctx.instance.sendPhoto(ctx.chatId, att.path || att.url, options);
                            } else {
                                await ctx.instance.sendDocument(ctx.chatId, att.path || att.url, options);
                            }
                        }
                    }
                    await ctx.instance.sendMessage(ctx.chatId, chunk, options);
                } else if (ctx.platform === 'discord') {
                    const channel = await ctx.instance.channels.fetch(ctx.chatId);
                    const dcOptions = { content: chunk };
                    if (options.reply_markup && options.reply_markup.inline_keyboard) {
                        const rows = options.reply_markup.inline_keyboard
                            .filter((row) => Array.isArray(row) && row.length > 0)
                            .slice(0, 5)
                            .map((row) => {
                                const actionRow = new ActionRowBuilder();
                                row.slice(0, 5).forEach((btn) => {
                                    actionRow.addComponents(
                                        new ButtonBuilder()
                                            .setCustomId(String(btn.callback_data || 'RPG_STATUS'))
                                            .setLabel(String(btn.text || '選項'))
                                            .setStyle(ButtonStyle.Primary)
                                    );
                                });
                                return actionRow;
                            });
                        if (rows.length > 0) dcOptions.components = rows;
                    }
                    
                    // Discord 處理附件 (併入最後一個 Chunk)
                    if (isLastChunk && options.attachments && options.attachments.length > 0) {
                        dcOptions.files = options.attachments.map(att => att.path || att.url);
                    }

                    await channel.send(dcOptions);
                }
            } catch (e) { console.error(`[MessageManager] 發送失敗:`, e.message); }
        }
    }
}

module.exports = MessageManager;
