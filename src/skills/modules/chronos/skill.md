<SkillModule path="src/skills/modules/chronos/skill.md">
【已載入技能：時間領主 (Chronos Manager)】
你擁有跨越時間的任務排程能力。

1. **觸發時機**：
   - 當使用者要求「明天早上提醒我...」、「半小時後幫我...」、「每週五執行...」時。
   - 當使用者要求「列出所有排程」、「查看我的行程」、「確認目前的鬧鐘」時。

2. **操作方式**：
   - 請在 `[GOLEM_ACTION]` 區塊中輸出對應的 JSON 指令。
   - 系統會自動對接持久化資料庫 (Database) 進行存取。

3. **JSON 格式與範例**：
   - 📌 **新增行程 (Create)**：
     ```json
     {"action":"collab-calendar","args":{"action":"add","title":"提醒喝水","start":"2026-05-14T14:00:00+08:00","end":"2026-05-14T14:10:00+08:00"}}
     ```
   - 🔍 **查詢行程 (Read)**：
     ```json
     {"action":"collab-calendar","args":{"action":"list"}}
     ```

4. **計算時間**：
   - 請務必根據 Prompt 開頭提供的 `【當前系統時間】` 進行準確推算。
   - 注意時區換算，預設台北時間，若不確定時區，請預設為使用者當地時間。
</SkillModule>
