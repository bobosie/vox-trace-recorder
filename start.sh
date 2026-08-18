#!/bin/bash
# ============================================
# vox-trace — 啟動腳本
#
# 用法: ./start.sh <command> [options]
# ============================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 顏色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
DIM='\033[2m'
NC='\033[0m'

# ─── Help ───────────────────────────────────────────────────

show_help() {
    echo ""
    echo -e "${CYAN}╔══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║${NC}  ${GREEN}vox-trace${NC} — 錄製瀏覽器操作，產出 AI 可消費的結構化資料  ${CYAN}║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${YELLOW}Commands:${NC}"
    echo ""
    echo -e "  ${GREEN}record${NC}              錄製手動操作（Playwright Inspector）"
    echo -e "  ${GREEN}stop${NC} [session]     安全收尾進行中的錄製（等同按 Resume，不丟資料）"
    echo -e "  ${GREEN}keyframes${NC} <video>   從螢幕錄影擷取關鍵幀（ffmpeg）"
    echo -e "  ${GREEN}list${NC}                列出所有錄製 session"
    echo -e "  ${GREEN}trace${NC} <session>     用 Playwright Trace Viewer 開啟 session"
    echo -e "  ${GREEN}clean${NC}               清除所有錄製資料"
    echo -e "  ${GREEN}glossary${NC}            編輯領域詞彙校正表"
    echo -e "  ${GREEN}glossary add${NC} W C    快速新增校正（W→C）"
    echo -e "  ${GREEN}analyze${NC} [session]   從錄製資料自動產生 spec.yaml 骨架"
    echo -e "  ${GREEN}generate${NC} [session]  從 user-actions.json 產生可執行的 .spec.ts"
    echo -e "  ${GREEN}parameterize${NC} [ses] 偵測可參數化值，產生參數化 .spec.ts + data.yaml"
    echo -e "  ${GREEN}replay${NC} [session]    產生 .spec.ts 並立即執行回放"
    echo -e "  ${GREEN}storyboard${NC} [ses]   從 user-actions.json 產生 storyboard.yml（shot-scraper 相容）"
    echo -e "  ${GREEN}reconstruct${NC} [ses]  依 storyboard 用 Playwright 重錄還原影片（reconstructed.mp4）"
    echo -e "  ${GREEN}help${NC}                顯示此說明"
    echo ""
    echo -e "${YELLOW}Record 選項:${NC}"
    echo ""
    echo -e "  --load-storage <path>   載入已有的 cookies/session（免重新登入）"
    echo -e "  --name <name>           自訂 session 名稱（預設：時間戳）"
    echo -e "  --base-url <url>        覆蓋 Base URL（預設：\$BASE_URL，未設定則開 about:blank）"
    echo -e "  --codegen               提示 Playwright Inspector 啟用 codegen"
    echo -e "  --auto-test             跳過 Inspector，自動操作後結束（CI 測試用）"
    echo -e "  --script <path>         搭配 --auto-test 使用，載入外部自動化腳本"
    echo -e "  --no-audio              不錄麥克風音訊"
    echo -e "  --screenshots                開啟截圖（預設全關：load / 定時 / final 都不拍）"
    echo -e "  --no-periodic-screenshots    搭配 --screenshots：保留 load+final，只關定時截圖"
    echo -e "  --screenshot-interval <sec>  定時截圖間隔秒數（預設：3，需搭配 --screenshots）"
    echo -e "  --full-page                  截圖整頁（預設只截可視區）"
    echo -e "  --pm-mode                    PM 模式：只錄製，錄後重處理交給 Studio（可用 VOX_PM_MODE=1）"
    echo ""
    echo -e "${YELLOW}Keyframes 選項:${NC}"
    echo ""
    echo -e "  <video>                 影片檔案（mov/mp4/webm）"
    echo -e "  [output-dir]            輸出目錄（預設：影片旁的 keyframes-{name}/）"
    echo -e "  [threshold]             場景變化閾值 0.0~1.0（預設 0.3，越低越多截圖）"
    echo ""
    echo -e "${YELLOW}常用範例:${NC}"
    echo ""
    echo -e "  ${DIM}# 基本錄製${NC}"
    echo -e "  ./start.sh record"
    echo ""
    echo -e "  ${DIM}# 載入既有 session 錄製（免登入）${NC}"
    echo -e "  ./start.sh record --load-storage ~/my-project/.auth/session.json"
    echo ""
    echo -e "  ${DIM}# 指定 URL + 自訂名稱${NC}"
    echo -e "  ./start.sh record --base-url https://example.com --name my-feature"
    echo ""
    echo -e "  ${DIM}# 從螢幕錄影擷取關鍵幀${NC}"
    echo -e "  ./start.sh keyframes ~/Desktop/recording.mov"
    echo ""
    echo -e "  ${DIM}# 查看某次錄製的 trace${NC}"
    echo -e "  ./start.sh trace 2026-03-22T14-30-00"
    echo ""
    echo -e "${YELLOW}錄製產出:${NC}"
    echo ""
    echo -e "  recordings/{session}/"
    echo -e "  ├── trace.zip          ${DIM}Playwright 結構化（DOM + 網路 + 截圖）${NC}"
    echo -e "  ├── codegen.ts         ${DIM}操作順序摘要${NC}"
    echo -e "  ├── network.json       ${DIM}API 請求/回應${NC}"
    echo -e "  ├── api-summary.md     ${DIM}API 人類可讀摘要${NC}"
    echo -e "  ├── screenshots/       ${DIM}Playwright 截圖（page load 觸發）${NC}"
    echo -e "  ├── keyframes/         ${DIM}ffmpeg 關鍵幀（場景變化觸發）${NC}"
    echo -e "  ├── video.webm         ${DIM}完整影片${NC}"
    echo -e "  ├── user-actions.json  ${DIM}DOM 事件序列（selector + 座標）${NC}"
    echo -e "  ├── audio.wav          ${DIM}麥克風錄音${NC}"
    echo -e "  ├── transcript.md      ${DIM}語音逐字稿（Whisper）${NC}"
    echo -e "  └── metadata.json      ${DIM}Session 元資料${NC}"
    echo ""
    echo -e "${YELLOW}給 AI 讀取的優先順序:${NC}"
    echo ""
    echo -e "  1. codegen.ts      → 了解操作順序"
    echo -e "  2. api-summary.md  → 了解 API 行為"
    echo -e "  3. screenshots/    → 了解 UI 狀態（Playwright，每次最多讀 20 張）"
    echo -e "  4. keyframes/      → 補充截圖（ffmpeg fallback）"
    echo -e "  5. transcript.md   → 語音逐字稿（Whisper）"
    echo -e "  6. network.json    → 深入查看特定 API"
    echo -e "  7. trace.zip       → npx playwright show-trace 互動檢視"
    echo ""
}

# ─── 檢查依賴 ──────────────────────────────────────────────

check_deps() {
    local missing=0

    if [ ! -d "node_modules" ]; then
        echo -e "${YELLOW}⚠️  尚未安裝依賴，執行 npm install...${NC}"
        npm install
        echo ""
    fi

    if ! command -v ffmpeg &> /dev/null; then
        echo -e "${YELLOW}⚠️  ffmpeg 未安裝（keyframes 功能需要）${NC}"
        echo -e "   安裝: ${DIM}brew install ffmpeg${NC}"
        missing=1
    fi

    return 0
}

# Playwright Chromium 未安裝時自動裝，讓 record 在乾淨機器也能直接跑（不依賴呼叫端記得裝）。
# 先查 browser cache 目錄；已存在就跳過，避免每次 record 都發網路版本探測。
ensure_browser() {
    local cache_dir="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/Library/Caches/ms-playwright}"
    if ! ls -d "$cache_dir"/chromium-* &> /dev/null; then
        echo -e "${YELLOW}⚠️  Playwright Chromium 未安裝，執行 npx playwright install chromium...${NC}"
        npx playwright install chromium
        echo ""
    fi
}

# ─── Commands ───────────────────────────────────────────────

cmd_record() {
    check_deps
    ensure_browser
    echo -e "${GREEN}▶ 啟動 Playwright 錄製...${NC}"
    echo ""
    npx tsx src/record-manual-session.ts "$@"
}

cmd_keyframes() {
    if [ -z "$1" ]; then
        echo -e "${RED}❌ 請指定影片檔案${NC}"
        echo -e "   用法: ./start.sh keyframes <video-file> [output-dir] [threshold]"
        exit 1
    fi
    bash src/extract-keyframes.sh "$@"
}

# graceful-stop：放 .stop-recording sentinel 讓錄製端安全收尾（等同按 Resume），
# 不 kill 進程、不丟產出。agent 收到「done/好了」時呼叫這個。
# 用法：./start.sh stop [session]   不帶 session → 讀 .active-session 指標
cmd_stop() {
    # 與 record 的 RECORDINGS_DIR 對齊：PM 模式用 VOX_OUTPUT_DIR，否則 repo 內 recordings/。
    local recordings_dir="${VOX_OUTPUT_DIR:-$SCRIPT_DIR/recordings}"
    local session="$1"

    if [ -z "$session" ]; then
        local pointer="$recordings_dir/.active-session"
        if [ ! -f "$pointer" ]; then
            echo -e "${RED}找不到進行中的錄製（無 .active-session 指標）${NC}"
            echo -e "${DIM}如有多個 session，請指定：./start.sh stop <session>${NC}"
            exit 1
        fi
        session=$(cat "$pointer")
    fi

    local session_dir="$recordings_dir/$session"
    if [ ! -d "$session_dir" ]; then
        echo -e "${RED}session 不存在: $session${NC}"
        exit 1
    fi

    # 路徑圍堵：解析真實路徑（含 symlink）後必須仍在 recordings_dir 底下的子目錄，
    # 擋 ../ 逃逸與 symlink 逸出。real_dir 等於 root 本身（空 session）也擋。
    local real_root real_dir
    real_root=$(cd "$recordings_dir" 2>/dev/null && pwd -P)
    real_dir=$(cd "$session_dir" 2>/dev/null && pwd -P)
    case "$real_dir/" in
        "$real_root"/?*/) : ;;  # 合法：root 底下的子目錄
        *)
            echo -e "${RED}安全錯誤：session 路徑逸出錄製目錄（$session）${NC}"
            exit 1
            ;;
    esac

    touch "$real_dir/.stop-recording"
    echo -e "${GREEN}🛑 已送出停止訊號 → $session${NC}"
    echo -e "${DIM}錄製端會在數百毫秒內收尾存檔（trace/network/user-actions/metadata）${NC}"
}

cmd_list() {
    local recordings_dir="$SCRIPT_DIR/recordings"
    if [ ! -d "$recordings_dir" ] || [ -z "$(ls -A "$recordings_dir" 2>/dev/null)" ]; then
        echo -e "${YELLOW}目前沒有任何錄製 session${NC}"
        return
    fi

    echo -e "${BLUE}📁 錄製 Sessions:${NC}"
    echo ""

    for dir in "$recordings_dir"/*/; do
        [ ! -d "$dir" ] && continue
        local name=$(basename "$dir")
        local meta="$dir/metadata.json"

        # 基本資訊
        local info=""
        if [ -f "$meta" ]; then
            local screenshots=$(python3 -c "import json; d=json.load(open('$meta')); print(d.get('screenshotCount', '?'))" 2>/dev/null || echo "?")
            local api_count=$(python3 -c "import json; d=json.load(open('$meta')); print(d.get('networkEntryCount', '?'))" 2>/dev/null || echo "?")
            local base_url=$(python3 -c "import json; d=json.load(open('$meta')); print(d.get('baseUrl', '?'))" 2>/dev/null || echo "?")
            info="${DIM}${screenshots} screenshots, ${api_count} API calls — ${base_url}${NC}"
        fi

        # 目錄大小
        local size=$(du -sh "$dir" 2>/dev/null | cut -f1 | tr -d ' ')

        echo -e "  ${GREEN}${name}${NC}  ${DIM}(${size})${NC}"
        [ -n "$info" ] && echo -e "    $info"
    done
    echo ""
}

cmd_trace() {
    if [ -z "$1" ]; then
        echo -e "${RED}❌ 請指定 session 名稱${NC}"
        echo -e "   用法: ./start.sh trace <session-name>"
        echo ""
        cmd_list
        exit 1
    fi

    local trace_file="$SCRIPT_DIR/recordings/$1/trace.zip"
    if [ ! -f "$trace_file" ]; then
        echo -e "${RED}❌ 找不到 trace: $trace_file${NC}"
        echo ""
        cmd_list
        exit 1
    fi

    echo -e "${GREEN}▶ 開啟 Trace Viewer...${NC}"
    npx playwright show-trace "$trace_file"
}

cmd_clean() {
    local recordings_dir="$SCRIPT_DIR/recordings"
    if [ ! -d "$recordings_dir" ] || [ -z "$(ls -A "$recordings_dir" 2>/dev/null)" ]; then
        echo -e "${YELLOW}沒有錄製資料需要清除${NC}"
        return
    fi

    local count=$(ls -1d "$recordings_dir"/*/ 2>/dev/null | wc -l | tr -d ' ')
    local size=$(du -sh "$recordings_dir" 2>/dev/null | cut -f1 | tr -d ' ')

    echo -e "${YELLOW}⚠️  即將刪除 ${count} 個 session（${size}）${NC}"
    read -p "確認刪除？(y/N) " -n 1 -r
    echo ""

    if [[ $REPLY =~ ^[Yy]$ ]]; then
        rm -rf "$recordings_dir"/*
        echo -e "${GREEN}✅ 已清除所有錄製資料${NC}"
    else
        echo -e "${DIM}取消${NC}"
    fi
}

cmd_glossary() {
    local glossary_file="$SCRIPT_DIR/spec-schema/domain-glossary.yaml"

    if [ "$1" = "add" ]; then
        if [ -z "$2" ] || [ -z "$3" ]; then
            echo -e "${RED}❌ 用法: ./start.sh glossary add \"錯誤詞\" \"正確詞\"${NC}"
            exit 1
        fi

        # Ensure file exists
        if [ ! -f "$glossary_file" ]; then
            echo -e "${YELLOW}建立新的 glossary...${NC}"
            cat > "$glossary_file" << 'YAML'
# 領域詞彙校正表 — Whisper 轉錄後自動替換
# 使用者可自行擴充

corrections: {}

proper_nouns: []
YAML
        fi

        # Append correction before proper_nouns line
        local wrong="$2"
        local correct="$3"
        local tmpfile
        tmpfile=$(mktemp)
        while IFS= read -r line; do
            if [[ "$line" == "proper_nouns:"* ]]; then
                printf '  "%s": "%s"\n' "$wrong" "$correct" >> "$tmpfile"
            fi
            printf '%s\n' "$line" >> "$tmpfile"
        done < "$glossary_file"
        mv "$tmpfile" "$glossary_file"

        echo -e "${GREEN}✅ 已新增校正：「${wrong}」→「${correct}」${NC}"
    else
        # Open glossary in editor
        if [ ! -f "$glossary_file" ]; then
            echo -e "${YELLOW}Glossary 不存在，建立預設檔案...${NC}"
            cat > "$glossary_file" << 'YAML'
# 領域詞彙校正表 — Whisper 轉錄後自動替換
# 使用者可自行擴充

corrections: {}

proper_nouns: []
YAML
        fi

        local editor="${EDITOR:-vi}"
        echo -e "${GREEN}▶ 開啟 glossary（${editor}）...${NC}"
        $editor "$glossary_file"
    fi
}

cmd_generate() {
    check_deps
    local session="$1"
    shift 2>/dev/null || true

    if [ -z "$session" ]; then
        # 找最新的 session
        local recordings_dir="$SCRIPT_DIR/recordings"
        if [ ! -d "$recordings_dir" ] || [ -z "$(ls -A "$recordings_dir" 2>/dev/null)" ]; then
            echo -e "${RED}❌ 沒有錄製 session 可供生成${NC}"
            exit 1
        fi
        session=$(ls -t "$recordings_dir" | head -1)
        echo -e "${GREEN}▶ 從最新 session 生成: ${session}${NC}"
    fi

    local session_dir="$SCRIPT_DIR/recordings/$session"
    if [ ! -d "$session_dir" ]; then
        echo -e "${RED}❌ Session 目錄不存在: $session_dir${NC}"
        exit 1
    fi

    if [ ! -f "$session_dir/user-actions.json" ]; then
        echo -e "${RED}❌ user-actions.json 不存在${NC}"
        echo -e "   此 session 可能是在 DOM 錄製器加入前錄製的"
        echo -e "   請重新錄製: ./start.sh record --name $session"
        exit 1
    fi

    echo -e "${GREEN}▶ 生成 Playwright 測試...${NC}"
    npx tsx src/generate-playwright.ts "$session_dir" "$@"
}

cmd_replay() {
    check_deps
    local session="$1"
    local extra_args=""

    # Check for --headed flag
    for arg in "$@"; do
        if [ "$arg" = "--headed" ]; then
            extra_args="--headed"
        fi
    done

    if [ -z "$session" ]; then
        local recordings_dir="$SCRIPT_DIR/recordings"
        if [ ! -d "$recordings_dir" ] || [ -z "$(ls -A "$recordings_dir" 2>/dev/null)" ]; then
            echo -e "${RED}❌ 沒有錄製 session 可供回放${NC}"
            exit 1
        fi
        session=$(ls -t "$recordings_dir" | head -1)
        echo -e "${GREEN}▶ 回放最新 session: ${session}${NC}"
    fi

    local session_dir="$SCRIPT_DIR/recordings/$session"
    if [ ! -d "$session_dir" ]; then
        echo -e "${RED}❌ Session 目錄不存在: $session_dir${NC}"
        exit 1
    fi

    echo -e "${GREEN}▶ 生成並執行回放...${NC}"
    npx tsx src/generate-playwright.ts "$session_dir" --run $extra_args
}

cmd_parameterize() {
    check_deps
    local session="$1"
    shift 2>/dev/null || true

    if [ -z "$session" ]; then
        local recordings_dir="$SCRIPT_DIR/recordings"
        if [ ! -d "$recordings_dir" ] || [ -z "$(ls -A "$recordings_dir" 2>/dev/null)" ]; then
            echo -e "${RED}❌ 沒有錄製 session 可供參數化${NC}"
            exit 1
        fi
        session=$(ls -t "$recordings_dir" | head -1)
        echo -e "${GREEN}▶ 參數化最新 session: ${session}${NC}"
    fi

    local session_dir="$SCRIPT_DIR/recordings/$session"
    if [ ! -d "$session_dir" ]; then
        echo -e "${RED}❌ Session 目錄不存在: $session_dir${NC}"
        exit 1
    fi

    # Ensure raw spec exists first
    if [ ! -f "$session_dir/${session}.raw.spec.ts" ]; then
        echo -e "${YELLOW}⚠️  尚未生成 raw spec，先執行 generate...${NC}"
        cmd_generate "$session"
    fi

    echo -e "${GREEN}▶ 偵測可參數化值...${NC}"
    npx tsx src/parameterize.ts "$session_dir" "$@"
}

cmd_storyboard() {
    check_deps
    local session="$1"
    shift 2>/dev/null || true

    if [ -z "$session" ]; then
        local recordings_dir="$SCRIPT_DIR/recordings"
        if [ ! -d "$recordings_dir" ] || [ -z "$(ls -A "$recordings_dir" 2>/dev/null)" ]; then
            echo -e "${RED}❌ 沒有錄製 session 可供產生 storyboard${NC}"
            exit 1
        fi
        session=$(ls -t "$recordings_dir" | head -1)
        echo -e "${GREEN}▶ 從最新 session 產生 storyboard: ${session}${NC}"
    fi

    local session_dir="$SCRIPT_DIR/recordings/$session"
    if [ ! -d "$session_dir" ]; then
        echo -e "${RED}❌ Session 目錄不存在: $session_dir${NC}"
        exit 1
    fi

    if [ ! -f "$session_dir/user-actions.json" ]; then
        echo -e "${RED}❌ user-actions.json 不存在${NC}"
        echo -e "   此 session 可能是在 DOM 錄製器加入前錄製的"
        echo -e "   請重新錄製: ./start.sh record --name $session"
        exit 1
    fi

    echo -e "${GREEN}▶ 產生 storyboard.yml（shot-scraper 相容）...${NC}"
    npx tsx src/generate-storyboard.ts "$session_dir" "$@"
}

cmd_reconstruct() {
    check_deps
    local session="$1"
    shift 2>/dev/null || true

    if [ -z "$session" ]; then
        local recordings_dir="$SCRIPT_DIR/recordings"
        if [ ! -d "$recordings_dir" ] || [ -z "$(ls -A "$recordings_dir" 2>/dev/null)" ]; then
            echo -e "${RED}❌ 沒有錄製 session 可供還原${NC}"
            exit 1
        fi
        session=$(ls -t "$recordings_dir" | head -1)
        echo -e "${GREEN}▶ 還原最新 session: ${session}${NC}"
    fi

    local session_dir="$SCRIPT_DIR/recordings/$session"
    if [ ! -d "$session_dir" ]; then
        echo -e "${RED}❌ Session 目錄不存在: $session_dir${NC}"
        exit 1
    fi

    # storyboard.yml 不存在則先自動產生（比照 parameterize 的自動前置步驟）
    if [ ! -f "$session_dir/storyboard.yml" ]; then
        if [ ! -f "$session_dir/user-actions.json" ]; then
            echo -e "${RED}❌ 缺少 user-actions.json，無法產生 storyboard${NC}"
            echo -e "   請重新錄製: ./start.sh record --name $session"
            exit 1
        fi
        echo -e "${YELLOW}⚠️  尚未產生 storyboard.yml，先執行 storyboard...${NC}"
        cmd_storyboard "$session"
    fi

    echo -e "${GREEN}▶ 用 Playwright 重錄還原影片...${NC}"
    # 透傳 --with-audio / --headed / --audio-offset 等旗標
    npx tsx src/reconstruct.ts "$session_dir" "$@"
}

cmd_analyze() {
    check_deps
    if [ -z "$1" ]; then
        # 找最新的 session
        local recordings_dir="$SCRIPT_DIR/recordings"
        if [ ! -d "$recordings_dir" ] || [ -z "$(ls -A "$recordings_dir" 2>/dev/null)" ]; then
            echo -e "${RED}❌ 沒有錄製 session 可供分析${NC}"
            exit 1
        fi
        LATEST=$(ls -t "$recordings_dir" | head -1)
        echo -e "${GREEN}▶ 分析最新 session: ${LATEST}${NC}"
        npx tsx src/generate-spec.ts "recordings/$LATEST"
    else
        echo -e "${GREEN}▶ 分析 session: $1${NC}"
        npx tsx src/generate-spec.ts "recordings/$1"
    fi
}

# ─── Main ───────────────────────────────────────────────────

COMMAND="${1:-help}"
shift 2>/dev/null || true

case "$COMMAND" in
    record)     cmd_record "$@" ;;
    stop)       cmd_stop "$@" ;;
    keyframes)  cmd_keyframes "$@" ;;
    list|ls)    cmd_list ;;
    trace|view) cmd_trace "$@" ;;
    clean)      cmd_clean ;;
    glossary)   cmd_glossary "$@" ;;
    analyze)    cmd_analyze "$@" ;;
    generate)       cmd_generate "$@" ;;
    parameterize)   cmd_parameterize "$@" ;;
    replay)         cmd_replay "$@" ;;
    storyboard)     cmd_storyboard "$@" ;;
    reconstruct)    cmd_reconstruct "$@" ;;
    help|-h|--help) show_help ;;
    *)
        echo -e "${RED}未知指令: $COMMAND${NC}"
        show_help
        exit 1
        ;;
esac
