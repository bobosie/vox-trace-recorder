#!/bin/bash
# vox-pm-queue-worker.sh — PM 端離線佇列 worker（launchd 每 120s 跑一次）。
# 掃描 ~/vox-pm-recordings/*，目錄靜止 >= VOX_STABLE_SECS 才入列，
# 呼叫 vox-pm-ship 上傳 Google Drive：
#   exit 0  → done    成功（已上傳）
#   exit 75 → 留 pending，下次重試（網路離線）
#   其他    → failed
#
# 狀態機語意與 vox-pipeline/air/vox-queue-worker.sh 一致，改用 GDrive 上傳、
# 本機 lib（PM 機沒有 vox-pipeline repo）。
export PATH=/opt/homebrew/bin:$HOME/.local/bin:$HOME/bin:$PATH

# 帶入 Shared Drive 設定（VOX_PM_DRIVE_ID 等），存在才 source。
VOX_PM_ENV="${VOX_PM_ENV:-$HOME/.config/vox-pm/env}"
# shellcheck source=/dev/null
[ -f "$VOX_PM_ENV" ] && source "$VOX_PM_ENV"

REC_ROOT="${VOX_REC_ROOT:-$HOME/vox-pm-recordings}"
QUEUE="${VOX_QUEUE_DIR:-$HOME/vox-pm-queue}"
STABLE_SECS="${VOX_STABLE_SECS:-60}"
LOG="$QUEUE/worker.log"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHIP="$SELF_DIR/vox-pm-ship"
# 佇列狀態機純函式（與單元測試共用同一份實作，避免 drift）
# shellcheck source=vox-queue-lib.sh
source "$SELF_DIR/vox-queue-lib.sh"

mkdir -p "$QUEUE/pending" "$QUEUE/done" "$QUEUE/failed"
log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

# 鎖：mkdir 原子性（macOS 無 flock），避免 launchd 與手動執行重入
LOCK="$QUEUE/.worker.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
    exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

[ -d "$REC_ROOT" ] || exit 0

now=$(date +%s)
for SRC in "$REC_ROOT"/*/; do
    [ -d "$SRC" ] || continue
    NAME="$(basename "$SRC")"
    vox_valid_session_name "$NAME" || { log "$NAME 名稱非法，略過"; continue; }
    [ -e "$QUEUE/done/$NAME" ]   && continue
    [ -e "$QUEUE/failed/$NAME" ] && continue

    # 進行中的錄製不上傳：.active-session 指標指向本 session = 錄製尚未收尾
    # （record-manual-session.ts 啟動時寫入、收尾才移除）。這是「錄製結束」的
    # 權威訊號；只靠下面的 mtime 穩定閘不夠——錄製剛啟動、檔案 mid-write 時
    # find 可能撈空使 mtime 判定失準，導致 ship 半成品（HTTP 400）。
    # 併傳 .active-session.pid：若指標殘留但該 pid 已死（錄製被 SIGKILL/斷電，
    # 收尾 exit handler 沒跑）→ vox_is_active_recording 判為「非進行中」，交回
    # 穩定閘處理，避免 crash 的部分錄製被此檢查永久擋住不上傳。
    if vox_is_active_recording "$NAME" "$REC_ROOT/.active-session" "$REC_ROOT/.active-session.pid"; then
        log "$NAME 錄製進行中（.active-session 指向它），略過"
        continue
    fi

    # 穩定性檢查：目錄內最新檔案 mtime 距今 >= STABLE_SECS（避免錄到一半就傳）
    newest=$(find "$SRC" -type f -exec stat -f %m {} \; 2>/dev/null | sort -n | tail -1)
    newest="${newest:-0}"
    if ! vox_is_stable "$newest" "$now" "$STABLE_SECS"; then
        if [ "$newest" -le 0 ]; then
            log "$NAME 尚無可判定檔案（目錄空/檔案未 flush），略過"
        else
            log "$NAME 仍在變動（age=$(( now - newest ))s < ${STABLE_SECS}s），略過"
        fi
        continue
    fi

    # 錄製端量到的靜音旗標：照樣上傳（影片/trace 仍有價值），但不能不出聲——
    # 這條 log 是 Studio 端解析前唯一會看到「語音是空的」的地方。
    if [ -f "$SRC/metadata.json" ] && \
       /usr/bin/python3 -c "import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get('audioSilent') else 1)" \
         "$SRC/metadata.json" 2>/dev/null; then
        log "⚠️  $NAME audio.wav 為數位靜音（語音未錄到），仍照常上傳影片與 trace"
    fi

    touch "$QUEUE/pending/$NAME"
    log "$NAME 上傳中..."
    set +e
    "$SHIP" "$SRC" >> "$LOG" 2>&1
    rc=$?
    set -e 2>/dev/null || true
    rm -f "$QUEUE/pending/$NAME"
    case "$(vox_classify_ship_result "$rc")" in
        done)
            touch "$QUEUE/done/$NAME"
            log "$NAME 完成 ✓" ;;
        pending)
            log "$NAME 網路離線，留待下次重試" ;;
        failed)
            touch "$QUEUE/failed/$NAME"
            log "$NAME 失敗（rc=${rc}）→ failed" ;;
    esac
done
