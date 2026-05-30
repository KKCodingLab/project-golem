# 協作日曆 (Collab Calendar)

使用者與 Golem 共用同一份行事曆。Golem 可以主動讀取行程、幫使用者新增/修改/刪除事件，也可以在自主行動時把自己的計畫寫入日曆。

## 使用時機

- 使用者詢問「今天/明天/這週有什麼行程？」
- 使用者說「幫我記一下…」、「新增一個行程」、「排個會議」
- 使用者說「刪掉那個行程」、「把時間改成…」
- Golem 自主行動時想記錄自己的計畫或提醒

## Action 格式

```json
{"action": "collab-calendar", "args": {"action": "<操作>", ...}}
```

或使用 `parameters`（兩種格式都支援）：

```json
{"action": "collab-calendar", "parameters": {"action": "<操作>", ...}}
```

### 支援的操作

#### list — 列出所有事件
```json
{"action": "collab-calendar", "args": {"action": "list"}}
```
可選過濾：`start`（ISO 8601）、`end`（ISO 8601）、`owner`（"user" 或 "golem"）

#### today — 今日行程
```json
{"action": "collab-calendar", "args": {"action": "today"}}
```

#### upcoming — 未來 N 天行程
```json
{"action": "collab-calendar", "args": {"action": "upcoming", "days": 7}}
```

#### add — 新增事件
```json
{
  "action": "collab-calendar",
  "args": {
    "action": "add",
    "title": "與主人開會",
    "start": "2025-05-15T14:00:00+08:00",
    "end": "2025-05-15T15:00:00+08:00",
    "description": "討論專案進度",
    "location": "線上",
    "owner": "golem",
    "reminderMinutes": 10
  }
}
```
- `owner` 填 `"golem"` 表示這是 Golem 建立的行程，填 `"user"` 表示代替使用者建立
- 時間必須是 ISO 8601 格式，**務必帶時區**（台灣用 `+08:00`）
- `reminderMinutes`：提前幾分鐘提醒（預設 10）。設為 `0` 表示準時提醒，設為 `null` 表示不提醒

#### update — 更新事件
```json
{
  "action": "collab-calendar",
  "args": {
    "action": "update",
    "id": "evt_1234567890_abcd1234",
    "start": "2025-05-15T15:00:00+08:00",
    "end": "2025-05-15T16:00:00+08:00"
  }
}
```
只需傳入要修改的欄位，其他欄位保持不變。

#### delete — 刪除事件
```json
{"action": "collab-calendar", "args": {"action": "delete", "id": "evt_1234567890_abcd1234"}}
```

#### search — 關鍵字搜尋
```json
{"action": "collab-calendar", "args": {"action": "search", "keyword": "開會"}}
```

## 注意事項

- 刪除或修改事件前，先用 `list` 或 `search` 確認 ID，不要猜測
- 新增事件時 `owner` 預設為 `"golem"`，若是代替使用者建立請明確設為 `"user"`
- 時間格式錯誤會導致失敗，台灣時區請用 `+08:00` 結尾
