# Wiki

維護 Golem 的 Markdown Wiki 知識庫，支援保存、搜尋、讀取、列出與檢查知識頁面，適合沉澱專案決策、使用者偏好與長期知識。

## 使用時機

- 使用者要求把內容保存成 Wiki、知識庫或文件頁。
- 使用者想搜尋或讀取既有 Wiki 頁面。
- 使用者想檢查 Wiki 健康狀態、整理頁面或查看更新紀錄。

## Action 格式

```json
{
  "action": "wiki",
  "parameters": {
    "task": "search",
    "query": "關鍵字"
  }
}
```

常見 `task` 包含 `save`、`list`、`read`、`search`、`lint`、`log`。

## 注意事項

- 寫入 Wiki 前應確認內容適合長期保存。
- 搜尋或讀取結果不足時，要明確說明限制，不要補造不存在的頁面內容。
