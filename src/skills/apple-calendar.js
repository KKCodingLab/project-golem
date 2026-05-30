module.exports = {
    name: 'apple-calendar',
    description: 'macOS 原生行事曆操作技能',
    tags: ['#user-generated', '#macos', '#productivity'],
    async run(ctx, args) {
        const { action = 'list', title, minutesFromNow = 0, duration = 30, days = 1 } = args;
        try {
            if (action === 'list') {
                const script = "set today to (current date)\nset endDate to today + (" + days + " * days)\ntell application \"Calendar\"\nset output to \"\"\nrepeat with aCalendar in calendars\nset allEvents to (every event of aCalendar whose start date is greater than today and start date is less than endDate)\nrepeat with anEvent in allEvents\nset output to output & (summary of anEvent) & \" (\" & (start date of anEvent as string) & \")\\n\"\nend repeat\nend repeat\nreturn output\nend tell";
                const result = await ctx.io.command("osascript -e '" + script + "'");
                return result || '這段時間內沒有行程。';
            }
            if (action === 'add') {
                if (!title) return '錯誤：新增行程需要提供 title。';
                const script = "set now to (current date)\nset startTime to now + (" + minutesFromNow + " * 60)\nset endTime to startTime + (" + duration + " * 60)\ntell application \"Calendar\"\ntell (first calendar)\nmake new event with properties {summary:\"" + title + "\", start date:startTime, end date:endTime}\nend tell\nend tell";
                await ctx.io.command("osascript -e '" + script + "'");
                return "成功！已建立行程：" + title;
            }
            return '不支援的 action。';
        } catch (e) { return '失敗：' + e.message; }
    }
};
