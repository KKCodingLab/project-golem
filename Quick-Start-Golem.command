#!/bin/bash

# macOS 雙擊快速啟動：進入專案目錄後，以 sudo 執行 setup.sh --start
# 用法：直接雙擊本檔，輸入一次密碼即可。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -f "./setup.sh" ]; then
  echo "❌ 找不到 setup.sh，請確認檔案位於專案根目錄。"
  read -r -p "按 Enter 關閉..."
  exit 1
fi

chmod +x ./setup.sh

echo "🚀 啟動 Project Golem（sudo ./setup.sh --start）"
echo "📁 目錄：$SCRIPT_DIR"
echo ""

# 若你偏好背景啟動，可改成：sudo ./setup.sh --start --bg
sudo ./setup.sh --start

echo ""
echo "✅ 指令執行完成。"
read -r -p "按 Enter 關閉..."
