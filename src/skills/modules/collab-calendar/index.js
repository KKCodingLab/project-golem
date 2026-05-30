// src/skills/modules/collab-calendar/index.js
// 協作日曆技能 — 讓 Golem 能主動讀取、新增、更新、刪除共用行事曆事件

'use strict';

const CalendarCollabService = require('../../../services/CalendarCollabService');

/**
 * 格式化單一事件為可讀字串
 */
function formatEvent(event) {
    const start = new Date(event.start).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
    const end = new Date(event.end).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
    const owner = event.owner === 'golem' ? '🤖 Golem' : '👤 使用者';
    const source = event.source && event.source !== 'local' ? ` [來源: ${event.source}]` : '';
    let line = `• **${event.title}**\n  ID：\`${event.id || 'N/A'}\`\n  時間：${start} → ${end}\n  建立者：${owner}${source}`;
    if (event.location) line += `\n  地點：${event.location}`;
    if (event.description) line += `\n  備註：${event.description}`;
    return line;
}

async function run(ctx) {
    // 相容兩種呼叫格式：
    //   1. {"action": "collab-calendar", "args": {"action": "today"}}      ← 新格式
    //   2. {"action": "collab-calendar", "parameters": {"action": "today"}} ← 舊格式
    const args = ctx.args || ctx.parameters || {};
    const hasMutationShape =
        (args.title !== undefined || args.summary !== undefined || args.name !== undefined) &&
        (args.start !== undefined || args.start_time !== undefined || args.startTime !== undefined) &&
        (args.end !== undefined || args.end_time !== undefined || args.endTime !== undefined);
    const hasExplicitAction = Boolean(args.action || args.action_type || args.type);
    if (!hasExplicitAction && hasMutationShape) {
        return `❌ 偵測到你在建立行程（有 title/start/end），但缺少 args.action。\n` +
            `請改用：{"action":"collab-calendar","args":{"action":"add","title":"...","start":"2026-05-13T20:44:00+08:00","end":"2026-05-13T20:50:00+08:00"}}`;
    }
    const rawAction = String(args.action || args.action_type || args.type || 'list').toLowerCase();
    const actionMap = {
        create: 'add',
        new: 'add',
        add: 'add',
        edit: 'update',
        update: 'update',
        remove: 'delete',
        delete: 'delete',
        list: 'list',
        today: 'today',
        upcoming: 'upcoming',
        search: 'search',
    };
    const action = actionMap[rawAction] || rawAction;

    try {
        // ── list ──────────────────────────────────────────────────────────────
        if (action === 'list') {
            const { start, end, owner } = args;
            const result = CalendarCollabService.listEvents({ start, end, owner });
            const events = result.events || [];

            if (events.length === 0) {
                return '📭 協作日曆目前沒有任何事件。';
            }

            const lines = [`📅 **協作日曆** (共 ${events.length} 個事件)\n`];
            for (const event of events) {
                lines.push(formatEvent(event));
            }
            return lines.join('\n\n');
        }

        // ── today ─────────────────────────────────────────────────────────────
        if (action === 'today') {
            const now = new Date();
            const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
            const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).toISOString();
            const result = CalendarCollabService.listEvents({ start: todayStart, end: todayEnd });
            const events = result.events || [];

            if (events.length === 0) {
                return '📭 今天沒有任何行程。';
            }

            const lines = [`📅 **今日行程** (${now.toLocaleDateString('zh-TW')})\n`];
            for (const event of events) {
                lines.push(formatEvent(event));
            }
            return lines.join('\n\n');
        }

        // ── upcoming ──────────────────────────────────────────────────────────
        if (action === 'upcoming') {
            const days = Math.max(1, Math.min(30, Number(args.days) || 7));
            const now = new Date();
            const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
            const result = CalendarCollabService.listEvents({ start: now.toISOString(), end: future.toISOString() });
            const events = result.events || [];

            if (events.length === 0) {
                return `📭 未來 ${days} 天內沒有任何行程。`;
            }

            const lines = [`📅 **未來 ${days} 天行程** (共 ${events.length} 個)\n`];
            for (const event of events) {
                lines.push(formatEvent(event));
            }
            return lines.join('\n\n');
        }

        // ── add ───────────────────────────────────────────────────────────────
        if (action === 'add' || action === 'create') {
            const title = args.title ?? args.summary ?? args.name;
            const start = args.start ?? args.start_time ?? args.startTime;
            const end = args.end ?? args.end_time ?? args.endTime;
            const description = args.description ?? args.note ?? args.notes;
            const location = args.location ?? args.place;
            const owner = args.owner;
            const reminderMinutes = args.reminderMinutes ?? args.reminder_minutes;

            const createExample = `{
  "action": "collab-calendar",
  "args": {
    "action": "add",
    "title": "收退貨",
    "start": "2026-05-14T14:00:00+08:00",
    "end": "2026-05-14T15:00:00+08:00",
    "owner": "golem"
  }
}`;

            if (!title) return `❌ 新增失敗：缺少事件標題 (title)。\n範例：\n${createExample}`;
            if (!start) return `❌ 新增失敗：缺少開始時間 (start)，格式：ISO 8601。\n範例：\n${createExample}`;
            if (!end) return `❌ 新增失敗：缺少結束時間 (end)。\n範例：\n${createExample}`;

            const result = CalendarCollabService.createEvent({
                title: String(title),
                start: String(start),
                end: String(end),
                description: description ? String(description) : '',
                location: location ? String(location) : '',
                owner: owner === 'user' ? 'user' : 'golem',
                reminderMinutes: reminderMinutes !== undefined ? Number(reminderMinutes) : 10,
                editableBy: { user: true, golem: true },
            });

            const reminderNote = result.event.reminderMinutes > 0
                ? `\n⏰ 提醒：開始前 ${result.event.reminderMinutes} 分鐘`
                : '\n⏰ 提醒：準時（無提前提醒）';
            return `✅ 已新增事件到協作日曆！${reminderNote}\n\n${formatEvent(result.event)}`;
        }

        // ── update ────────────────────────────────────────────────────────────
        if (action === 'update' || action === 'edit') {
            const { id, title, start, end, description, location } = args;

            if (!id) return '❌ 更新失敗：缺少事件 ID (id)。請先用 list 查詢事件 ID。';

            const patch = {};
            if (title !== undefined) patch.title = String(title);
            if (start !== undefined) patch.start = String(start);
            if (end !== undefined) patch.end = String(end);
            if (description !== undefined) patch.description = String(description);
            if (location !== undefined) patch.location = String(location);

            const result = CalendarCollabService.updateEvent(id, patch);
            if (!result) return `❌ 找不到 ID 為 "${id}" 的事件。`;

            return `✅ 已更新事件！\n\n${formatEvent(result.event)}`;
        }

        // ── delete ────────────────────────────────────────────────────────────
        if (action === 'delete' || action === 'remove') {
            const { id } = args;
            if (!id) return '❌ 刪除失敗：缺少事件 ID (id)。';

            const removed = CalendarCollabService.removeEvent(id);
            if (!removed) return `❌ 找不到 ID 為 "${id}" 的事件，可能已被刪除。`;

            return `✅ 已從協作日曆刪除事件 (ID: ${id})。`;
        }

        // ── search ────────────────────────────────────────────────────────────
        if (action === 'search') {
            const keyword = String(args.keyword || args.query || '').toLowerCase();
            if (!keyword) return '❌ 搜尋失敗：請提供關鍵字 (keyword)。';

            const result = CalendarCollabService.listEvents({});
            const matched = (result.events || []).filter((e) =>
                e.title.toLowerCase().includes(keyword) ||
                (e.description || '').toLowerCase().includes(keyword) ||
                (e.location || '').toLowerCase().includes(keyword)
            );

            if (matched.length === 0) return `🔍 找不到包含「${keyword}」的事件。`;

            const lines = [`🔍 **搜尋結果**：「${keyword}」(共 ${matched.length} 筆)\n`];
            for (const event of matched) {
                lines.push(formatEvent(event));
            }
            return lines.join('\n\n');
        }

        return `❌ 不支援的操作：${action}。支援的操作：list、today、upcoming、add、update、delete、search。\n` +
            `範例：{"action":"collab-calendar","args":{"action":"add","title":"收退貨","start":"2026-05-14T14:00:00+08:00","end":"2026-05-14T15:00:00+08:00"}}`;

    } catch (e) {
        console.error('❌ [collab-calendar skill]', e);
        return `❌ 協作日曆操作失敗：${e.message}`;
    }
}

module.exports = {
    name: 'collab-calendar',
    description: '協作日曆：讀取、新增、更新、刪除使用者與 Golem 共用的行事曆事件。支援查詢今日/未來行程、關鍵字搜尋。',
    tags: ['#productivity', '#calendar', '#schedule', '#user-generated'],
    run,
};

// ── CLI Entry Point ────────────────────────────────────────────────────────────
if (require.main === module) {
    const rawArgs = process.argv[2];
    if (!rawArgs) {
        console.log('Usage: node index.js \'{"action":"today"}\'');
        process.exit(1);
    }
    try {
        const parsed = JSON.parse(rawArgs);
        const finalArgs = parsed.args || parsed;
        run({ args: finalArgs }).then(console.log).catch(console.error);
    } catch (e) {
        console.error(`❌ CLI Parse Error: ${e.message}`);
    }
}
