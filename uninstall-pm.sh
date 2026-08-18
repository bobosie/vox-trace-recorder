#!/bin/bash
# ============================================================
# uninstall-pm — 移除 VoiceTrace PM 安裝（乾淨解除）
#
# 用法：
#   bash ~/vox-trace-pm/uninstall-pm.sh
#   或雙擊桌面的「vox-uninstall.command」
#
# 移除：launchd 上傳服務、vox-record 指令、Claude skill、
#       deploy key + SSH config、service account 金鑰、專案目錄、桌面捷徑。
# 預設「保留」你的錄製檔（~/vox-pm-recordings）以免誤刪未上傳的資料；
# 加 --purge 一併刪除錄製檔與佇列。
# ============================================================

set -uo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; DIM='\033[2m'; NC='\033[0m'; BOLD='\033[1m'
ok()   { echo -e "  ${GREEN}✅ $1${NC}"; }
skip() { echo -e "  ${DIM}⏭️  $1${NC}"; }
info() { echo -e "  ${DIM}$1${NC}"; }

PURGE=0
[[ "${1:-}" == "--purge" ]] && PURGE=1

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${NC}  ${BOLD}vox-trace${NC} — PM 移除                            ${CYAN}║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# ─── 1. launchd 上傳服務 ───────────────────────────────────
echo -e "${BOLD}[1/8]${NC} 停止上傳服務..."
LABEL="com.voxtrace.vox-pm-uploader"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
if launchctl list 2>/dev/null | grep -q "$LABEL" || [[ -f "$PLIST" ]]; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
    launchctl remove "$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    ok "上傳服務已停止並移除"
else
    skip "上傳服務（未安裝）"
fi

# ─── 2. vox-record 指令（找可能的安裝位置，只刪我們自己的）──
echo -e "${BOLD}[2/8]${NC} 移除 vox-record 指令..."
REMOVED_WRAPPER=0
for d in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
    W="$d/vox-record"
    if [[ -f "$W" ]] && grep -q "vox-record — PM wrapper" "$W" 2>/dev/null; then
        rm -f "$W" 2>/dev/null || sudo rm -f "$W" 2>/dev/null
        ok "已移除 $W"
        REMOVED_WRAPPER=1
    fi
done
[[ "$REMOVED_WRAPPER" -eq 0 ]] && skip "vox-record 指令（未找到或非本工具）"

# ─── 3. Claude skill ───────────────────────────────────────
echo -e "${BOLD}[3/8]${NC} 移除 Claude skill..."
if [[ -d "$HOME/.claude/skills/vox-record" ]]; then
    rm -rf "$HOME/.claude/skills/vox-record"
    ok "Claude skill 已移除"
else
    skip "Claude skill（未安裝）"
fi

# ─── 4. deploy key + SSH config 區塊 ───────────────────────
echo -e "${BOLD}[4/8]${NC} 移除 deploy key 與 SSH 設定..."
rm -f "$HOME/.ssh/vox-trace-deploy"
SSH_CONFIG="$HOME/.ssh/config"
if [[ -f "$SSH_CONFIG" ]] && grep -q "^Host github-voxtrace$" "$SSH_CONFIG" 2>/dev/null; then
    python3 - "$SSH_CONFIG" <<'PYEOF'
import sys, re
p = sys.argv[1]
t = open(p).read()
t2 = re.sub(r"\n?Host github-voxtrace\n(?:[ \t]+.*\n?)*", "\n", t)
open(p, "w").write(t2)
PYEOF
    ok "deploy key 與 SSH config 區塊已移除"
else
    skip "SSH config（無 github-voxtrace 區塊）"
fi

# ─── 5. service account 金鑰 + env ─────────────────────────
echo -e "${BOLD}[5/8]${NC} 移除雲端憑證..."
if [[ -d "$HOME/.config/vox-pm" ]]; then
    rm -rf "$HOME/.config/vox-pm"
    ok "service account 金鑰與設定已移除"
else
    skip "雲端憑證（未安裝）"
fi

# ─── 6. 桌面捷徑 ───────────────────────────────────────────
echo -e "${BOLD}[6/8]${NC} 移除桌面捷徑..."
rm -f "$HOME/Desktop/vox-record.command"
ok "vox-record 捷徑已移除（vox-setup.command 保留，供重裝）"

# ─── 7. 錄製檔與佇列（預設保留）──────────────────────────────
echo -e "${BOLD}[7/8]${NC} 錄製檔與佇列..."
if [[ "$PURGE" -eq 1 ]]; then
    rm -rf "$HOME/vox-pm-recordings" "$HOME/vox-pm-queue"
    ok "錄製檔與佇列已刪除（--purge）"
else
    if [[ -d "$HOME/vox-pm-recordings" ]]; then
        info "保留錄製檔：$HOME/vox-pm-recordings（如要一併刪除，重跑並加 --purge）"
    fi
    rm -rf "$HOME/vox-pm-queue" 2>/dev/null
    skip "保留錄製檔（佇列狀態已清）"
fi

# ─── 8. 專案目錄 ───────────────────────────────────────────
echo -e "${BOLD}[8/8]${NC} 移除專案目錄..."
if [[ -d "$HOME/vox-trace-pm" ]]; then
    # 注意：本腳本可能就在此目錄內執行；已載入記憶體，刪除當前目錄安全。
    rm -rf "$HOME/vox-trace-pm"
    ok "~/vox-trace-pm 已移除"
else
    skip "專案目錄（不存在）"
fi

echo ""
echo -e "${GREEN}════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✅ 移除完成${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${DIM}若要重新安裝，雙擊「vox-setup.command」即可。${NC}"
echo ""
