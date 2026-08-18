#!/bin/bash
# 🎬 雙擊此檔案開始錄製測試
clear
echo ""
echo "🎬 vox-trace 測試錄製工具"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
read -p "📍 請輸入測試網址（直接按 Enter 跳過）: " URL

if [ -n "$URL" ]; then
    exec vox-record "$URL"
else
    exec vox-record
fi
