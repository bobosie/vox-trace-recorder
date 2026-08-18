#!/bin/bash
# ============================================
# vox-trace — PM 一鍵安裝腳本（遠端 git clone 版）
#
# 用法（遠端一鍵，public repo 免金鑰）:
#   金鑰用 read -rs 互動貼入，避免寫進 shell history：
#   printf "請貼上金鑰後按 Enter（輸入不會顯示）：\n"; read -rs VOX_DEPLOY_KEY_B64; export VOX_DEPLOY_KEY_B64
#   bash <(curl -fsSL https://raw.githubusercontent.com/bobosie/vox-trace-recorder/main/install-pm.sh)
#
# 用法（本地）:
#   printf "金鑰："; read -rs VOX_DEPLOY_KEY_B64; export VOX_DEPLOY_KEY_B64; bash install-pm.sh
# ============================================

# ─── 設定 ───────────────────────────────────────────────────

VOXTRACE_GIT_URL="${VOXTRACE_GIT_URL:-https://github.com/bobosie/vox-trace-recorder.git}"
VOXTRACE_DEST="${VOXTRACE_DEST:-$HOME/vox-trace-pm}"
DEFAULT_REC_DIR="${VOX_PM_RECORDINGS:-$HOME/vox-pm-recordings}"
DEPLOY_KEY="$HOME/.ssh/vox-trace-deploy"

# 顏色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
DIM='\033[2m'
NC='\033[0m'
BOLD='\033[1m'

# 計數器
STEP=0
TOTAL=14

step() {
    STEP=$((STEP + 1))
    echo ""
    echo -e "${BLUE}[$STEP/$TOTAL]${NC} $1"
}

ok() {
    echo -e "  ${GREEN}✅ $1${NC}"
}

skip() {
    echo -e "  ${DIM}⏭️  $1（已安裝）${NC}"
}

fail() {
    echo -e "  ${RED}❌ $1${NC}"
    echo -e "  ${DIM}$2${NC}"
    exit 1
}

warn() {
    echo -e "  ${YELLOW}⚠️  $1${NC}"
}

# ─── 開始 ───────────────────────────────────────────────────

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${NC}  ${BOLD}vox-trace${NC} — PM 一鍵安裝                        ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  ${DIM}錄製瀏覽器操作 → AI 結構化測試資料${NC}              ${CYAN}║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# ─── Step 1: 偵測 macOS ────────────────────────────────────

step "🖥️  檢查作業系統..."

if [[ "$(uname)" != "Darwin" ]]; then
    fail "目前只支援 macOS" "偵測到: $(uname)"
fi
ok "macOS $(sw_vers -productVersion)"

# ─── Step 2: Xcode CLI Tools ──────────────────────────────

step "🔧 檢查 Xcode Command Line Tools..."

if xcode-select -p &>/dev/null; then
    skip "Xcode CLI Tools"
else
    echo -e "  ${YELLOW}安裝 Xcode Command Line Tools...${NC}"
    echo -e "  ${DIM}（會跳出系統對話框，請點「安裝」）${NC}"
    xcode-select --install

    # 等待安裝完成
    echo -e "  ${DIM}等待安裝完成...${NC}"
    until xcode-select -p &>/dev/null; do
        sleep 5
    done
    ok "Xcode CLI Tools 安裝完成"
fi

# ─── Step 3: Homebrew ──────────────────────────────────────

step "🍺 檢查 Homebrew..."

if command -v brew &>/dev/null; then
    skip "Homebrew $(brew --version | head -1 | awk '{print $2}')"
else
    echo -e "  ${YELLOW}安裝 Homebrew...${NC}"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

    # Apple Silicon 路徑
    if [[ -f /opt/homebrew/bin/brew ]]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
    fi

    if command -v brew &>/dev/null; then
        ok "Homebrew 安裝完成"
    else
        fail "Homebrew 安裝失敗" "請手動安裝：https://brew.sh"
    fi
fi

# ─── Step 4: Node.js ──────────────────────────────────────

step "📦 檢查 Node.js..."

if command -v node &>/dev/null; then
    NODE_VER=$(node -v)
    NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f1)
    if [[ "$NODE_MAJOR" -ge 18 ]]; then
        skip "Node.js $NODE_VER"
    else
        warn "Node.js $NODE_VER 版本太舊（需要 >= 18）"
        echo -e "  ${YELLOW}升級 Node.js...${NC}"
        brew install node
        ok "Node.js $(node -v)"
    fi
else
    echo -e "  ${YELLOW}安裝 Node.js...${NC}"
    brew install node
    if command -v node &>/dev/null; then
        ok "Node.js $(node -v)"
    else
        fail "Node.js 安裝失敗" "請手動安裝：brew install node"
    fi
fi

# ─── Step 5: sox ───────────────────────────────────────────

step "🎙️  檢查 sox（麥克風錄音）..."

if command -v sox &>/dev/null; then
    skip "sox $(sox --version 2>/dev/null | head -1 | awk '{print $NF}' || echo '')"
else
    echo -e "  ${YELLOW}安裝 sox...${NC}"
    brew install sox
    if command -v sox &>/dev/null; then
        ok "sox 安裝完成"
    else
        fail "sox 安裝失敗" "請手動安裝：brew install sox"
    fi
fi

# ─── Step 6: deploy key + SSH config ──────────────────────

if [[ "$VOXTRACE_GIT_URL" == https://* ]]; then
    skip "GitHub deploy key（public repo，免金鑰）"
else
    step "🔑 設定 GitHub deploy key..."

    mkdir -p "$HOME/.ssh"
    chmod 700 "$HOME/.ssh"

    if [[ -f "$DEPLOY_KEY" ]]; then
        skip "deploy key（$DEPLOY_KEY）"
    else
        if [[ -z "${VOX_DEPLOY_KEY_B64:-}" ]]; then
            fail "缺少 deploy key" "請帶環境變數 VOX_DEPLOY_KEY_B64（base64 編碼的私鑰）再執行安裝"
        fi
        # 從環境變數解 base64 寫入（不把私鑰寫死在腳本內）
        if ! echo "$VOX_DEPLOY_KEY_B64" | base64 -d > "$DEPLOY_KEY" 2>/dev/null; then
            rm -f "$DEPLOY_KEY"
            fail "deploy key 解碼失敗" "VOX_DEPLOY_KEY_B64 內容不是有效 base64"
        fi
        chmod 600 "$DEPLOY_KEY"
        ok "deploy key 已寫入 $DEPLOY_KEY"
    fi

    # 冪等追加 SSH config 的 Host github-voxtrace 區塊
    SSH_CONFIG="$HOME/.ssh/config"
    touch "$SSH_CONFIG"
    chmod 600 "$SSH_CONFIG"
    if grep -q "^Host github-voxtrace$" "$SSH_CONFIG" 2>/dev/null; then
        skip "SSH config Host github-voxtrace"
    else
        {
            echo ""
            echo "Host github-voxtrace"
            echo "    HostName github.com"
            echo "    User git"
            echo "    IdentityFile $DEPLOY_KEY"
            echo "    IdentitiesOnly yes"
        } >> "$SSH_CONFIG"
        ok "已追加 SSH config Host github-voxtrace"
    fi
fi

# ─── Step 7: clone or pull vox-trace ──────────────────────

step "📂 取得 vox-trace 專案..."

if [[ -d "$VOXTRACE_DEST/.git" ]]; then
    echo -e "  ${DIM}更新既有安裝（git pull --ff-only）...${NC}"
    if git -C "$VOXTRACE_DEST" pull --ff-only; then
        ok "vox-trace 已更新"
    else
        warn "git pull 失敗，沿用現有版本"
    fi
else
    echo -e "  ${YELLOW}git clone 到 $VOXTRACE_DEST...${NC}"
    if git clone "$VOXTRACE_GIT_URL" "$VOXTRACE_DEST"; then
        ok "vox-trace 已 clone 到 $VOXTRACE_DEST"
    else
        fail "git clone 失敗" "確認 deploy key 有該 repo 讀取權限，URL: $VOXTRACE_GIT_URL"
    fi
fi

# ─── Step 8: npm install ──────────────────────────────────

step "📥 安裝 npm 依賴..."

cd "$VOXTRACE_DEST" || fail "無法進入 $VOXTRACE_DEST" ""
npm install --no-fund --no-audit
if [[ $? -eq 0 ]]; then
    ok "npm install 完成"
else
    fail "npm install 失敗" "請到 $VOXTRACE_DEST 手動執行 npm install"
fi

# ─── Step 9: Playwright Chromium ──────────────────────────

step "🌐 安裝 Playwright Chromium..."

if npx playwright install chromium; then
    ok "Chromium 安裝完成"
else
    fail "Playwright Chromium 安裝失敗" "請手動執行：npx playwright install chromium"
fi

# ─── Step 10: PM 名字 + .pm-config.json + .pm-mode ────────

step "🙋 設定錄製者名字..."

PM_CONFIG="$VOXTRACE_DEST/.pm-config.json"
CURRENT_RECORDER=""
if [[ -f "$PM_CONFIG" ]]; then
    CURRENT_RECORDER="$(python3 -c "import json; print(json.load(open('$PM_CONFIG')).get('recorder',''))" 2>/dev/null || echo "")"
    echo -e "  ${DIM}目前設定：$CURRENT_RECORDER${NC}"
    echo -e "  ${DIM}按 Enter 保留，或輸入新名字${NC}"
else
    echo -e "  ${DIM}請輸入你的名字（會標記在錄製資料上，方便開發團隊辨識）：${NC}"
fi

read -r -p "  > " RECORDER_NAME
RECORDER_NAME="${RECORDER_NAME:-$CURRENT_RECORDER}"

# 用 python 安全寫 JSON（避免名字含特殊字元破壞格式）
RECORDER_NAME="$RECORDER_NAME" python3 -c "
import json, os
json.dump({'recorder': os.environ.get('RECORDER_NAME','')}, open('$PM_CONFIG','w'), ensure_ascii=False, indent=2)
"
ok ".pm-config.json 已寫入（recorder: ${RECORDER_NAME:-（空）}）"

# .pm-mode 空標記檔（存在即代表這台是 PM 機）
touch "$VOXTRACE_DEST/.pm-mode"
ok ".pm-mode 標記已建立"

# ─── Step 11: vox-record wrapper（自動更新 + --pm-mode）──

step "🔗 建立 vox-record 指令..."

# 挑一個「在 PATH 上、優先免 sudo」的目錄放 wrapper。
# Apple Silicon 的 /opt/homebrew/bin 使用者可寫且已在 PATH（免 sudo）；
# /usr/local/bin 在 Intel Mac 較常用但常需 sudo 或根本不存在。
SYMLINK_DIR=""
for d in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
    if [[ -d "$d" && -w "$d" ]]; then SYMLINK_DIR="$d"; break; fi
done
# 都沒有可寫的 → 用 /usr/local/bin（稍後 sudo 建）
[[ -z "$SYMLINK_DIR" ]] && SYMLINK_DIR="/usr/local/bin"
SYMLINK_PATH="$SYMLINK_DIR/vox-record"

# wrapper：先自動更新（fail-soft），record 子命令自動附 --pm-mode，錄到 PM 目錄
WRAPPER_CONTENT="#!/bin/bash
# vox-record — PM wrapper（自動更新 + PM 模式）
DEST=\"$VOXTRACE_DEST\"
REC_DIR=\"\${VOX_OUTPUT_DIR:-$DEFAULT_REC_DIR}\"

# (a) 自動更新（任一步失敗只印警告，照常錄）
(
  cd \"\$DEST\" || exit 0
  before=\$(git rev-parse HEAD 2>/dev/null)
  # stock macOS 無 timeout 指令，改用 SSH ConnectTimeout 界定連線逾時（免 coreutils）
  GIT_SSH_COMMAND='ssh -o ConnectTimeout=10' git fetch --quiet 2>/dev/null || echo '[vox-record] 更新檢查逾時，沿用現有版本' >&2
  if git status -uno 2>/dev/null | grep -q 'behind'; then
    if git pull --ff-only --quiet 2>/dev/null; then
      after=\$(git rev-parse HEAD 2>/dev/null)
      if [ \"\$before\" != \"\$after\" ] && ! git diff --quiet \"\$before\" \"\$after\" -- package.json 2>/dev/null; then
        npm install --no-fund --no-audit >/dev/null 2>&1 || echo '[vox-record] npm install 失敗，沿用現有依賴' >&2
      fi
    else
      echo '[vox-record] 自動更新失敗，沿用現有版本' >&2
    fi
  fi
) || true

mkdir -p \"\$REC_DIR\"
export VOX_OUTPUT_DIR=\"\$REC_DIR\"

# (b) record 子命令自動附 --pm-mode
if [ \"\$1\" = \"record\" ]; then
  shift
  cd \"\$DEST\" && exec bash start.sh record --pm-mode \"\$@\"
else
  cd \"\$DEST\" && exec bash start.sh \"\$@\"
fi
"

# Apple Silicon Mac 常無 /usr/local/bin（Homebrew 在 /opt/homebrew）；先確保目錄存在
SYMLINK_DIR="$(dirname "$SYMLINK_PATH")"
if [[ ! -d "$SYMLINK_DIR" ]]; then
    mkdir -p "$SYMLINK_DIR" 2>/dev/null || sudo mkdir -p "$SYMLINK_DIR"
fi

if [[ -w "$SYMLINK_DIR" ]]; then
    echo "$WRAPPER_CONTENT" > "$SYMLINK_PATH"
    chmod +x "$SYMLINK_PATH"
else
    echo -e "  ${YELLOW}需要管理員權限建立指令...${NC}"
    echo "$WRAPPER_CONTENT" | sudo tee "$SYMLINK_PATH" > /dev/null
    sudo chmod +x "$SYMLINK_PATH"
fi

# 真檢查是否建成（不謊報）
if [[ -x "$SYMLINK_PATH" ]]; then
    ok "已建立 vox-record 指令（$SYMLINK_PATH）"
else
    warn "vox-record 指令建立失敗，改用桌面「vox-record.command」或跟 Claude 說「幫我錄一段測試」"
fi

# ─── Step 12: 桌面捷徑 + PM uploader launchd + 錄製目錄 ──

step "🖱️  建立桌面捷徑、上傳服務、錄製目錄..."

DESKTOP_FILE="$HOME/Desktop/vox-record.command"
cat > "$DESKTOP_FILE" << 'CMDEOF'
#!/bin/bash
# vox-trace — 雙擊開始錄製
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  vox-trace — 錄製模式                   ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "輸入要測試的網址（直接 Enter 開啟空白頁）："
read -r url

if [[ -n "$url" ]]; then
    vox-record record --base-url "$url"
else
    vox-record record
fi

echo ""
echo "錄製結束。按任意鍵關閉..."
read -n 1
CMDEOF
chmod +x "$DESKTOP_FILE"
ok "已建立 ~/Desktop/vox-record.command"

# 移除捷徑（雙擊即乾淨解除）
UNINSTALL_FILE="$HOME/Desktop/vox-uninstall.command"
cat > "$UNINSTALL_FILE" <<CMDEOF
#!/bin/bash
# vox-trace — 雙擊移除
if [ -f "$VOXTRACE_DEST/uninstall-pm.sh" ]; then
    bash "$VOXTRACE_DEST/uninstall-pm.sh"
else
    echo "找不到移除腳本（可能已移除）。"
fi
echo ""
echo "按任意鍵關閉..."
read -n 1
CMDEOF
chmod +x "$UNINSTALL_FILE"
ok "已建立 ~/Desktop/vox-uninstall.command"

# 錄製目錄
mkdir -p "$DEFAULT_REC_DIR"
echo "$DEFAULT_REC_DIR" > "$VOXTRACE_DEST/.shared-dir"
ok "錄製檔案將存放在：$DEFAULT_REC_DIR"

# PM uploader launchd（把 repo 內 plist 套 $VOXTRACE_DEST 後 cp 並 load）
PLIST_SRC="$VOXTRACE_DEST/pipeline-pm/com.voxtrace.vox-pm-uploader.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.voxtrace.vox-pm-uploader.plist"
if [[ -f "$PLIST_SRC" ]]; then
    mkdir -p "$HOME/Library/LaunchAgents"
    sed -e "s|__VOXTRACE_DEST__|$VOXTRACE_DEST|g" "$PLIST_SRC" > "$PLIST_DEST"
    # 冪等：已 load 先 unload
    launchctl unload "$PLIST_DEST" 2>/dev/null || true
    if launchctl load -w "$PLIST_DEST" 2>/dev/null; then
        ok "PM 上傳服務已啟動（com.voxtrace.vox-pm-uploader）"
    else
        warn "PM 上傳服務載入失敗，請手動 launchctl load $PLIST_DEST"
    fi
else
    warn "找不到 uploader plist（$PLIST_SRC），略過上傳服務"
fi

# ─── Step 13: Service Account 金鑰 + Shared Drive 設定 ────

step "☁️  設定共用雲端硬碟（Service Account，不需登入）..."

VOX_PM_CONFIG_DIR="$HOME/.config/vox-pm"
SA_KEY_PATH="$VOX_PM_CONFIG_DIR/service-account.json"
VOX_PM_ENV_FILE="$VOX_PM_CONFIG_DIR/env"
mkdir -p "$VOX_PM_CONFIG_DIR"
chmod 700 "$VOX_PM_CONFIG_DIR"

# (a) service account 金鑰就位：從環境變數 VOX_PM_SA_KEY_B64（base64）解碼寫入。
if [[ -f "$SA_KEY_PATH" ]]; then
    skip "service account 金鑰（$SA_KEY_PATH）"
elif [[ -n "${VOX_PM_SA_KEY_B64:-}" ]]; then
    if echo "$VOX_PM_SA_KEY_B64" | base64 -d > "$SA_KEY_PATH" 2>/dev/null; then
        chmod 600 "$SA_KEY_PATH"
        ok "service account 金鑰已寫入 $SA_KEY_PATH"
    else
        rm -f "$SA_KEY_PATH"
        warn "service account 金鑰解碼失敗（VOX_PM_SA_KEY_B64 不是有效 base64）"
    fi
else
    warn "尚未提供 service account 金鑰"
    echo -e "  ${DIM}請向開發團隊索取 service account 金鑰放到 $SA_KEY_PATH${NC}"
fi

# (b) Shared Drive 設定寫進 env 檔（worker / gdrive / intake 會 source）。
if [[ -n "${VOX_PM_DRIVE_ID:-}" ]]; then
    printf 'export VOX_PM_DRIVE_ID=%q\n' "$VOX_PM_DRIVE_ID" > "$VOX_PM_ENV_FILE"
    chmod 600 "$VOX_PM_ENV_FILE"
    ok "Shared Drive 設定已寫入 $VOX_PM_ENV_FILE"
else
    warn "未提供 VOX_PM_DRIVE_ID（Shared Drive 的 driveId）"
    echo -e "  ${DIM}請向開發團隊索取 Shared Drive ID，寫入 $VOX_PM_ENV_FILE：export VOX_PM_DRIVE_ID=<id>${NC}"
fi

# (c) preflight：金鑰在就驗、不在就跳過。
GDRIVE_SH="$VOXTRACE_DEST/pipeline-pm/vox-pm-gdrive.sh"
if [[ -f "$SA_KEY_PATH" && -f "$GDRIVE_SH" ]]; then
    if bash "$GDRIVE_SH" auth; then
        ok "共用雲端硬碟連線驗證通過"
    else
        warn "共用雲端硬碟驗證未通過，之後可重跑：bash $GDRIVE_SH auth"
    fi
else
    echo -e "  ${DIM}（金鑰或設定尚未就位，略過連線驗證）${NC}"
fi

# ─── Step 14: PM Claude skill ─────────────────────────────

step "🤖 安裝 Claude skill（vox-record）..."

SKILL_SRC="$VOXTRACE_DEST/pm-claude-skill/vox-record"
SKILL_DEST="$HOME/.claude/skills/vox-record"
if [[ -f "$SKILL_SRC/SKILL.md" ]]; then
    mkdir -p "$HOME/.claude/skills"
    rm -rf "$SKILL_DEST"
    cp -R "$SKILL_SRC" "$SKILL_DEST"
    ok "Claude skill 已安裝（$SKILL_DEST）"
else
    warn "找不到 skill 來源（$SKILL_SRC/SKILL.md），略過 Claude skill 安裝"
fi

# ─── Step 15: AX 工作流 plugin（選配，有 claude CLI 才裝）──

step "🧩 安裝 AX 工作流 plugin（選配）..."

if command -v claude >/dev/null 2>&1; then
    if claude plugin marketplace add bobosie/ax-workflow >/dev/null 2>&1 || true; then :; fi
    if claude plugin install ax@ax-workflow --scope user >/dev/null 2>&1; then
        ok "AX plugin 已安裝（下次開 Claude Code 生效）"
    else
        warn "AX plugin 安裝未成功（不影響錄製功能），可稍後手動執行：claude plugin install ax@ax-workflow --scope user"
    fi
else
    skip "AX plugin（此機器沒有 claude CLI）"
fi

# ─── 完成 ───────────────────────────────────────────────────

echo ""
echo -e "${GREEN}════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  🎉 安裝完成！${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${BOLD}使用方式：${NC}"
echo ""
echo -e "  ${CYAN}方式 1${NC} — 終端機指令："
echo -e "    ${GREEN}vox-record record${NC}                    ${DIM}# 開始錄製（自動 PM 模式）${NC}"
echo -e "    ${GREEN}vox-record record --base-url URL${NC}     ${DIM}# 指定網址錄製${NC}"
echo -e "    ${GREEN}vox-record list${NC}                      ${DIM}# 列出所有錄製${NC}"
echo -e "    ${GREEN}vox-record help${NC}                      ${DIM}# 查看完整說明${NC}"
echo ""
echo -e "  ${CYAN}方式 2${NC} — 雙擊桌面的 ${GREEN}vox-record.command${NC}"
echo ""
echo -e "${BOLD}錄製檔案位置：${NC} $DEFAULT_REC_DIR"
echo -e "${BOLD}專案目錄：${NC}     $VOXTRACE_DEST"
echo -e "${DIM}錄完後檔案會自動上傳雲端，成功後開發團隊會收到 Slack 通知。${NC}"
echo ""
