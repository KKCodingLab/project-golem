# Stock Dashboard

讀取並刷新 Dashboard「股市分析」看板快照，提供台股、美股、自選股、技術指標、市場廣度與新聞脈絡，讓 Golem 可以根據結構化資料回答行情與個股分析問題。

## 使用時機

- 使用者要求分析 Dashboard 股市分析頁、股市看板、股票看板或 `/stockboard` 資料。
- 使用者詢問台股、美股、個股股價、技術指標、新聞脈絡、漲跌強弱或自選股概況。
- 使用者提到股票代號，例如 `2330`、`2454`、`AAPL`、`NVDA`、`TSM`。

## Action 格式

```json
{
  "action": "stock-dashboard",
  "parameters": {
    "symbols": ["2330.TW", "AAPL"],
    "selectedSymbol": "2330.TW",
    "marketFilter": "all",
    "selectedRange": "1D",
    "includeNews": true
  }
}
```

`symbols` 可以省略，系統會使用 Dashboard 預設自選股。台股純數字代號會自動轉成 Yahoo Finance 格式，例如 `2330` 會轉成 `2330.TW`。

## 回覆要求

- 明確說明資料來源是 Dashboard 股市分析快照，以及資料時間與限制。
- 優先整理市場概況、強弱標的、技術指標、新聞脈絡、風險提醒。
- 不要做保證式投資建議，不要承諾報酬，不要把資料不足的推測說成事實。
