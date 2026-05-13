<SkillModule path="src/skills/modules/session-search/skill.md">
【已載入技能：歷史對話搜尋 (Session Search)】
你可以主動搜尋並回溯你與使用者的歷史對話記錄，找回過去的決策、討論內容、已解決的問題和獲得的知識。

## 使用時機
- 使用者提到「上次我們討論的...」、「之前你說的...」
- 你需要確認某個之前做過的決策，避免重複工作
- 回答涉及過去事件、需要上下文連貫性時
- 自主行動中需要了解過往狀況時

## 搜尋模式

### 1. 關鍵字搜尋（快速，預設）
```json
{"action":"session-search","args":{"query":"搜尋關鍵字","mode":"keyword","days":30}}
```
- `query`：必填，搜尋字串
- `days`：搜尋範圍（天數，預設 30，最大 365）
- `limit`：最大回傳數（預設 20）

### 2. 語意搜尋（慢，較精準）
```json
{"action":"session-search","args":{"query":"我問過關於記憶系統的問題","mode":"semantic","days":60}}
```
- 適合模糊描述、需要 AI 理解意圖時

### 3. 日期範圍搜尋
```json
{"action":"session-search","args":{"mode":"date","start_date":"20260401","end_date":"20260417"}}
```
- `start_date`/`end_date`：格式 YYYYMMDD

## 注意
- 這是搜尋**你與使用者的實際對話歷史**，不是網路搜尋
- 結果含時間戳與發言者資訊
- 若搜尋結果與你的記憶有出入，以搜尋結果為準
</SkillModule>
