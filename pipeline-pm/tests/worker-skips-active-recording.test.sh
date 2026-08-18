#!/bin/bash
# worker-skips-active-recording.test.sh — 整合測試：vox-pm-queue-worker.sh 不得
# 上傳「正在錄製中」的 session（.active-session 指向它）。
#
# 迴歸來源：worker 曾於錄製啟動後數秒就 ship，抓到半截 audio.wav → GDrive HTTP
# 400。修法是在穩定閘之前加 .active-session 檢查。本測試用假 REC_ROOT / QUEUE，
# 讓 session 檔案 mtime 刻意「已靜止」（否則就會被 ship），驗證 worker 因 active
# 指標而跳過、完全不進入上傳流程（不打 GDrive）。
#
# 執行： bash pipeline-pm/tests/worker-skips-active-recording.test.sh
# 全綠 exit 0；任一失敗 exit 1。
set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
WORKER="$DIR/../vox-pm-queue-worker.sh"

PASS=0; FAIL=0
ok()  { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
REC="$TMP/rec"; QUEUE="$TMP/queue"
mkdir -p "$REC" "$QUEUE"

SESS="test-active-sess"
mkdir -p "$REC/$SESS"
# 放一個 mtime 已靜止（2 小時前）的檔案 → 若沒有 active 檢查，穩定閘會放行 ship。
echo "partial" > "$REC/$SESS/audio.wav"
touch -t "$(date -v-2H '+%Y%m%d%H%M' 2>/dev/null || date -d '2 hours ago' '+%Y%m%d%H%M')" "$REC/$SESS/audio.wav"
# 錄製進行中：指標指向本 session。
printf '%s' "$SESS" > "$REC/.active-session"

# 跑真正的 worker（用假 REC_ROOT / QUEUE，不碰真實錄製與 GDrive）。
VOX_REC_ROOT="$REC" VOX_QUEUE_DIR="$QUEUE" bash "$WORKER"

LOG="$QUEUE/worker.log"

echo "── worker 對進行中錄製的行為 ──"
if grep -q "$SESS 錄製進行中" "$LOG" 2>/dev/null; then
    ok "log 記錄「錄製進行中，略過」"
else
    bad "log 應記錄「錄製進行中」，實際 log：$(cat "$LOG" 2>/dev/null)"
fi

if grep -q "$SESS 上傳中" "$LOG" 2>/dev/null; then
    bad "worker 不該對進行中錄製進入「上傳中」（會打 GDrive）"
else
    ok "worker 未進入上傳流程（沒打 GDrive）"
fi

for m in done failed pending; do
    if [ -e "$QUEUE/$m/$SESS" ]; then
        bad "不該建立 $m 標記（session 尚在錄製）"
    else
        ok "未建立 $m 標記"
    fi
done

# 對照：移除 active 指標後，同一 session（檔案仍靜止）就會被正常 ship 流程接手。
# 為免真的打 GDrive，把檔案 mtime 改「剛寫入」→ 應落在穩定閘（仍在變動）而非 active。
rm -f "$REC/.active-session"
: > "$QUEUE/worker.log"
touch "$REC/$SESS/audio.wav"   # mtime = now → 未達 STABLE_SECS
VOX_REC_ROOT="$REC" VOX_QUEUE_DIR="$QUEUE" bash "$WORKER"
echo "── 移除 active 指標後（改由穩定閘把關）──"
if grep -q "$SESS 仍在變動" "$LOG" 2>/dev/null; then
    ok "active 移除後改由穩定閘接手（剛寫入 → 仍在變動）"
elif grep -q "$SESS 錄製進行中" "$LOG" 2>/dev/null; then
    bad "active 已移除卻仍判進行中"
else
    bad "預期落在穩定閘，實際 log：$(cat "$LOG" 2>/dev/null)"
fi

# ── 指標 + pid 存活（錄製真的在跑）→ 仍略過，即使檔案 mtime 已靜止 ──
: > "$QUEUE/worker.log"
printf '%s' "$SESS" > "$REC/.active-session"
printf '%s' "$$" > "$REC/.active-session.pid"   # 本測試 shell 的 pid = 存活
touch -t "$(date -v-2H '+%Y%m%d%H%M' 2>/dev/null || date -d '2 hours ago' '+%Y%m%d%H%M')" "$REC/$SESS/audio.wav"
VOX_REC_ROOT="$REC" VOX_QUEUE_DIR="$QUEUE" bash "$WORKER"
echo "── 指標 + pid 存活 ──"
if grep -q "$SESS 錄製進行中" "$LOG" 2>/dev/null && ! grep -q "$SESS 上傳中" "$LOG" 2>/dev/null; then
    ok "pid 存活 → 判進行中、略過、不上傳"
else
    bad "pid 存活應略過不上傳，實際 log：$(cat "$LOG" 2>/dev/null)"
fi

# ── 指標殘留但 pid 已死（SIGKILL/斷電，收尾沒跑）→ 不判進行中，交回穩定閘 ──
# 避免永久擋住 crash 的部分錄製。用剛寫入的 mtime 讓它落在穩定閘（不真打 GDrive）。
: > "$QUEUE/worker.log"
printf '%s' "$SESS" > "$REC/.active-session"
printf '2147483647' > "$REC/.active-session.pid"   # 近乎不可能存在的 pid = 已死
touch "$REC/$SESS/audio.wav"   # mtime = now → 穩定閘擋下，避免真上傳
VOX_REC_ROOT="$REC" VOX_QUEUE_DIR="$QUEUE" bash "$WORKER"
echo "── 殘留指標 + pid 已死（crash）──"
if grep -q "$SESS 錄製進行中" "$LOG" 2>/dev/null; then
    bad "pid 已死不該仍判進行中（會永久擋住 crash 錄製不上傳）"
else
    ok "pid 已死 → 不判進行中（未被 active 檢查永久擋住）"
fi
if grep -q "$SESS 仍在變動" "$LOG" 2>/dev/null; then
    ok "交回穩定閘處理（剛寫入 → 仍在變動）"
else
    bad "應落到穩定閘，實際 log：$(cat "$LOG" 2>/dev/null)"
fi

echo ""
echo "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
