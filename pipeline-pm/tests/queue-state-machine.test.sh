#!/bin/bash
# queue-state-machine.test.sh — PM 端 vox-queue 狀態機 + session 名稱驗證單元測試。
# 純 bash 無外部依賴。執行： bash pipeline-pm/tests/queue-state-machine.test.sh
# 全綠 exit 0；任一失敗 exit 1。

set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../vox-queue-lib.sh
source "$DIR/../vox-queue-lib.sh"

PASS=0
FAIL=0

expect_eq() {
    local desc="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        echo "  ✓ $desc"; PASS=$((PASS + 1))
    else
        echo "  ✗ $desc  (expected='$expected' actual='$actual')"; FAIL=$((FAIL + 1))
    fi
}

expect_true() {
    local desc="$1"; shift
    if "$@"; then echo "  ✓ $desc"; PASS=$((PASS + 1))
    else echo "  ✗ $desc  (expected success, got failure)"; FAIL=$((FAIL + 1)); fi
}

expect_false() {
    local desc="$1"; shift
    if "$@"; then echo "  ✗ $desc  (expected failure, got success)"; FAIL=$((FAIL + 1))
    else echo "  ✓ $desc"; PASS=$((PASS + 1)); fi
}

echo "── vox_classify_ship_result ──"
expect_eq "exit 0 → done"     "done"    "$(vox_classify_ship_result 0)"
expect_eq "exit 75 → pending" "pending" "$(vox_classify_ship_result 75)"
expect_eq "exit 1 → failed"   "failed"  "$(vox_classify_ship_result 1)"
expect_eq "exit 255 → failed" "failed"  "$(vox_classify_ship_result 255)"

echo "── vox_is_stable ──"
expect_true  "靜止 60s 恰好穩定"       vox_is_stable 940 1000 60
expect_true  "靜止 120s 穩定"          vox_is_stable 880 1000 60
expect_false "靜止 59s 仍在變動"       vox_is_stable 941 1000 60
expect_false "剛寫入（age=0）不穩定"   vox_is_stable 1000 1000 60
# 迴歸：find 撈空 → newest=0 代表「還沒有可判定的檔案」，不是「很舊」。
# 舊版誤判為穩定 → 錄製剛啟動就 ship 半成品 → GDrive HTTP 400。應視為未穩定。
expect_false "空目錄 newest=0 視為未穩定（不上傳半成品）" vox_is_stable 0 1000 60
expect_false "newest 為空字串（預設 0）不穩定"           vox_is_stable "" 1000 60

echo "── vox_is_active_recording ──"
_AR_TMP="$(mktemp -d)"
_AR_PTR="$_AR_TMP/.active-session"
expect_false "無指標檔 → 非進行中"        vox_is_active_recording "sess-a" "$_AR_PTR"
printf 'sess-a' > "$_AR_PTR"
expect_true  "指標指向本 session → 進行中" vox_is_active_recording "sess-a" "$_AR_PTR"
expect_false "指標指向別的 session → 非本 session 的進行中" vox_is_active_recording "sess-b" "$_AR_PTR"
printf 'sess-a\n' > "$_AR_PTR"
expect_true  "指標含尾端換行仍匹配"        vox_is_active_recording "sess-a" "$_AR_PTR"
: > "$_AR_PTR"
expect_false "指標為空（收尾殘留空檔）→ 非進行中" vox_is_active_recording "sess-a" "$_AR_PTR"
rm -rf "$_AR_TMP"

echo "── vox_is_active_recording（pid 存活防殘留指標）──"
_AR_TMP2="$(mktemp -d)"
_AR_PTR2="$_AR_TMP2/.active-session"; _AR_PID2="$_AR_TMP2/.active-session.pid"
printf 'sess-a' > "$_AR_PTR2"
printf '%s' "$$" > "$_AR_PID2"
expect_true  "指標匹配 + pid 存活 → 進行中"          vox_is_active_recording "sess-a" "$_AR_PTR2" "$_AR_PID2"
printf '2147483647' > "$_AR_PID2"
expect_false "指標匹配 + pid 已死（SIGKILL 殘留）→ 非進行中" vox_is_active_recording "sess-a" "$_AR_PTR2" "$_AR_PID2"
: > "$_AR_PID2"
expect_true  "pid 檔空 → 無法判存活，保守當進行中"    vox_is_active_recording "sess-a" "$_AR_PTR2" "$_AR_PID2"
printf 'abc' > "$_AR_PID2"
expect_true  "pid 非數字 → 保守當進行中"              vox_is_active_recording "sess-a" "$_AR_PTR2" "$_AR_PID2"
rm -f "$_AR_PID2"
expect_true  "無 pid 檔 → 退回內容比對（向後相容）"    vox_is_active_recording "sess-a" "$_AR_PTR2" "$_AR_PID2"
rm -rf "$_AR_TMP2"

echo "── vox_valid_session_name ──"
expect_true  "一般名稱合法"            vox_valid_session_name "2026-07-11T14-30-00"
expect_true  "含底線與連字號合法"      vox_valid_session_name "my_feature-01"
expect_true  "含點與版號合法"          vox_valid_session_name "good-name_1.2"
expect_false "含斜線非法（路徑穿越）"  vox_valid_session_name "a/b"
expect_false "含 .. 非法（路徑穿越）"  vox_valid_session_name "..evil"
expect_false "夾帶 ../ 非法"           vox_valid_session_name "x/../y"
expect_false "含空白非法（白名單外）"  vox_valid_session_name "a b"
expect_false "含分號非法（注入）"      vox_valid_session_name "n;rm"
expect_false "空字串非法"              vox_valid_session_name ""

echo ""
echo "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
