#!/bin/bash
# node-version-gate.test.sh — install-pm.sh 的 Node 版本判定測試（純函式，不裝任何東西）。
#
# 執行：bash pipeline-pm/tests/node-version-gate.test.sh
#
# 背景（2026-09-07，Grace 安裝實錄「坑 1」，她花最久的一個）：
# `npx playwright install chromium` 下載完成後在解壓縮階段無限卡住，無錯誤訊息。
#
# ⚠️ 第一版修法把它歸因成「Node 太新」，釘了上界 24 並強迫降版——**那是錯的**。
# 查上游後（microsoft/playwright#40998 / #40724、nodejs/node#63487）真實條件是
# **版本組合**：Node 24.16.0+ / 25.x / 26.x  ×  Playwright < 1.60.0。
# Node 24.15.0 正常，而 24.16.0 中招——舊上界「<= 24」根本擋不住它。
# 根因是 yauzl 串流銷毀迴歸，**Playwright 1.60.0 已修**。
#
# 所以正解是升 Playwright（package.json 已釘 ^1.60.0），不是降 Node。
# vox_node_verdict 因此只管下界；vox_node_hits_extract_bug 單獨負責判斷
# 「這個 Node 落在已知範圍嗎」，僅用於示警與寫錯誤訊息，不強迫任何人降版。
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$(cd "$SELF_DIR/../.." && pwd)/install-pm.sh"

[ -f "$INSTALLER" ] || { echo "FAIL: 找不到 $INSTALLER"; exit 1; }

# 只載入函式定義，不執行安裝流程
VOX_LIB_ONLY=1
export VOX_LIB_ONLY
# shellcheck source=/dev/null
source "$INSTALLER"

if ! declare -f vox_node_verdict >/dev/null; then
    echo "FAIL: install-pm.sh 沒有定義 vox_node_verdict（或 VOX_LIB_ONLY 早退沒生效）"
    exit 1
fi

PASS=0
FAIL=0

expect() {  # expect <期望> <輸入版本字串> <說明>
    local want="$1" input="$2" desc="$3" got
    got="$(vox_node_verdict "$input")"
    if [ "$got" = "$want" ]; then
        PASS=$((PASS + 1))
        # 變數一律加大括號：緊接全形括號時 bash 會把 CJK 位元組併進變數名
        echo "  ok   — ${desc}（${input} → ${got}）"
    else
        FAIL=$((FAIL + 1))
        echo "  FAIL — ${desc}（${input}）：期望 ${want}，實得 ${got}"
    fi
}

echo "vox_node_verdict:"

# 沒裝 node
expect missing "" "沒有 node"

# 太舊
expect too-old "v16.20.2" "Node 16 太舊"
expect too-old "v17.9.1"  "Node 17 太舊"

# 可用（沒有上界——太新不是「不能用」，見下面的組合判定）
expect ok "v18.20.4" "Node 18 可用"
expect ok "v20.11.1" "Node 20 可用"
expect ok "v22.21.1" "Node 22 可用（本機開發版本）"
expect ok "v24.4.0"  "Node 24 可用"
expect ok "v26.8.1"  "Node 26 也算可用——搭 Playwright >=1.60 沒問題，不該強迫降版"

# 格式邊界：不帶 v 前綴、帶額外標籤
expect ok "24.0.0"          "不帶 v 前綴"
expect ok "v26.0.0-nightly" "帶標籤的版本"

# 垃圾輸入不能被誤判成可用
expect missing "not-a-version" "無法解析的版本字串"
expect missing "v"             "只有 v"

# fail-open 防護：解析異常必須判 missing，不可以放行成 ok，
# 而且不能讓 `[` 的 "integer expected" 漏到使用者畫面
expect missing "v99999999999999999999.0.0" "超大版本號不可 fail-open 成 ok"
expect ok      "$(printf 'v26.0.0\nv20.0.0')" "多行輸入只取第一行"

echo ""
echo "vox_node_hits_extract_bug（已知卡死範圍：24.16+ / 25.x / 26.x）:"

expect_bug() {  # expect_bug <yes|no> <版本> <說明>
    local want="$1" input="$2" desc="$3" got
    got="$(vox_node_hits_extract_bug "$input")"
    if [ "$got" = "$want" ]; then
        PASS=$((PASS + 1))
        echo "  ok   — ${desc}（${input} → ${got}）"
    else
        FAIL=$((FAIL + 1))
        echo "  FAIL — ${desc}（${input}）：期望 ${want}，實得 ${got}"
    fi
}

# 這一組是第一版修法漏掉的：24.16 落在舊上界「<=24」之內，卻真的會卡死
expect_bug no  "v24.15.0" "Node 24.15.0 正常（上游明確點名）"
expect_bug yes "v24.16.0" "Node 24.16.0 中招——舊上界 <=24 擋不住它"
expect_bug yes "v24.20.1" "Node 24.20 中招"
expect_bug no  "v24.9.0"  "Node 24.9 正常（minor 個位數不可誤判成 >=16）"
expect_bug no  "v22.21.1" "Node 22 不受影響"
expect_bug no  "v18.20.4" "Node 18 不受影響"
expect_bug yes "v25.0.0"  "Node 25 中招"
expect_bug yes "v26.8.1"  "Node 26 中招（Grace 實遇的版本）"
expect_bug yes "v27.0.0"  "更新的版本先當中招"
expect_bug no  ""         "沒有 node 時不該報告 bug"
expect_bug no  "garbage"  "垃圾輸入不該報告 bug"
expect_bug no  "v24"      "只有 major、沒有 minor → 不臆測"

echo ""
echo "vox_install_node_lts:"

# 這支原本沒有任何測試，於是一次「把 VOX_NODE_MAX 改名成 VOX_NODE_LTS 卻漏改
# 兩處」的重構在 18 項全綠的情況下溜了過去——實際會跑 `brew install node@`
# （空版本號）。腳本沒有 set -u，所以不會提早報錯，要等 brew 失敗才看得到。
# 教訓：綠燈只證明「被測到的部分」是對的。
_brew_calls() {
    brew() { echo "brew $*"; }
    vox_install_node_lts
    unset -f brew
}

out="$(_brew_calls)"
if printf '%s' "$out" | grep -q "brew install node@${VOX_NODE_LTS}"; then
    PASS=$((PASS+1)); echo "  ok   — 帶了具體版本號（node@${VOX_NODE_LTS}）"
else
    FAIL=$((FAIL+1)); echo "  FAIL — 版本號沒展開，實際跑的是：$(printf '%s' "$out" | head -1)"
fi

if printf '%s' "$out" | grep -qE "brew (install|link[^\n]*) node@[[:space:]]*$|node@$"; then
    FAIL=$((FAIL+1)); echo "  FAIL — 出現空版本號的 node@"
else
    PASS=$((PASS+1)); echo "  ok   — 沒有空版本號的 node@"
fi

if printf '%s' "$out" | grep -q "link --overwrite --force node@${VOX_NODE_LTS}"; then
    PASS=$((PASS+1)); echo "  ok   — keg-only 的 node@N 有 link 進 PATH"
else
    FAIL=$((FAIL+1)); echo "  FAIL — 沒有 link，node@N 是 keg-only 不 link 等於沒裝"
fi

echo ""
echo "vox_run_with_timeout:"

# 正常結束：原樣回傳 exit code，不受逾時機制干擾
vox_run_with_timeout 10 true
rc=$?
if [ "$rc" -eq 0 ]; then PASS=$((PASS+1)); echo "  ok   — 成功的指令回 0"
else FAIL=$((FAIL+1)); echo "  FAIL — 成功的指令應回 0，實得 $rc"; fi

vox_run_with_timeout 10 bash -c 'exit 3'
rc=$?
if [ "$rc" -eq 3 ]; then PASS=$((PASS+1)); echo "  ok   — 失敗的指令原樣回 3"
else FAIL=$((FAIL+1)); echo "  FAIL — 應回 3，實得 $rc"; fi

# 掛住的指令：必須被砍掉並回 124，而不是等到天荒地老。
# 這條就是坑 1 的模擬——sleep 30 代表卡在解壓縮的 playwright。
start=$(date +%s)
vox_run_with_timeout 2 sleep 30
rc=$?
elapsed=$(( $(date +%s) - start ))
if [ "$rc" -eq 124 ]; then PASS=$((PASS+1)); echo "  ok   — 掛住的指令回 124"
else FAIL=$((FAIL+1)); echo "  FAIL — 掛住的指令應回 124，實得 $rc"; fi
if [ "$elapsed" -lt 10 ]; then PASS=$((PASS+1)); echo "  ok   — 真的在 ${elapsed}s 就中止（沒有等滿 30s）"
else FAIL=$((FAIL+1)); echo "  FAIL — 逾時沒有生效，等了 ${elapsed}s"; fi

# 非整數秒數：使用者照 GNU timeout 的習慣寫 "10m" 很自然。舊版會讓 `[ -lt ]`
# 報錯、迴圈條件為假 → 0 秒砍掉指令 → 印出「逾時，多半是 yauzl bug」，
# 一個根本沒發生的原因。必須退回預設值而不是誤殺。
start=$(date +%s)
vox_run_with_timeout "10m" sleep 3 2>/dev/null
rc=$?
elapsed=$(( $(date +%s) - start ))
if [ "$rc" -eq 0 ] && [ "$elapsed" -ge 3 ]; then
    PASS=$((PASS+1)); echo "  ok   — 秒數寫成 '10m' 時退回預設，沒有誤殺（rc=${rc}, ${elapsed}s）"
else
    FAIL=$((FAIL+1)); echo "  FAIL — '10m' 造成誤殺：rc=${rc}, elapsed=${elapsed}s"
fi

# GNU mktemp 不接受無 X 的 template（BSD 接受）。踩到的話 marker 拿不到路徑 →
# 逾時偵測失效 → rc 停在 143 而非 124 → 整段診斷訊息拿不到。
if grep -q 'mktemp "${TMPDIR:-/tmp}/voxtimeout.XXXXXX"' "$INSTALLER"; then
    PASS=$((PASS+1)); echo "  ok   — mktemp template 帶 X（BSD/GNU 皆合法）"
else
    FAIL=$((FAIL+1)); echo "  FAIL — mktemp template 沒帶 X，GNU mktemp 會失敗"
fi

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "✅ node-version-gate 全綠"
