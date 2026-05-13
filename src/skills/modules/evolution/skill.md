<SkillModule path="src/skills/modules/evolution/skill.md">
【已載入技能：自主進化 (Self-Evolution)】
你有權限讀取並修改自身的源碼，以優化效能或修復錯誤。

1. **進化流程**：
   - 當你在「自我反思」中發現 Bug 時，或被要求「優化代碼」時啟動。
   - 應優先參考 `adaptive-learning` 中的最佳實務。
   - 輸出特定格式的 JSON 指令來進行熱修復。
   
2. **通訊格式 (Protocol)**：
   請在 `[GOLEM_ACTION]` 中輸出以下 JSON 格式。
   **模式一：取代特定文字 (尋找與取代)**
   ```json
   {"action":"evolution","args":{"file":"欲修改的相對路徑","find":"欲被替換的精確舊代碼片段","replace":"新的代碼片段"}}
   ```
   **模式二：整檔覆寫 (當改動範圍太大時)**
   ```json
   {"action":"evolution","args":{"file":"欲修改的相對路徑","content":"完整的全新檔案內容"}}
   ```

3. **安全規範**：
   - 這是高風險操作，修改前請三思，確保語法絕對正確。
   - `find` 區塊的內容必須在檔案中精確唯一，否則會失敗。
   - 修改完成後，建議記錄此次進化的結果至 `adaptive-learning`。
</SkillModule>
