#!/bin/bash
# vox-queue-lib.sh — vox-pm-queue-worker 的純函式庫（可被單元測試 source）。
#
# ⚠️ 正本在 vox-pipeline/air/vox-queue-lib.sh，這裡是複製一份給 PM 機器用
#    （PM 機沒有 vox-pipeline repo）。兩份需同步——改一邊記得改另一邊。
#
# 抽出「佇列狀態機」的判斷邏輯，讓 worker 與測試共用同一份實作，
# 避免測試複製一份平行邏輯而與正本 drift。

# vox_classify_ship_result <exit_code>
#   依 vox-pm-ship 的 exit code 回傳下一個佇列狀態：
#     0   → done     成功處理（已上傳 GDrive）
#     75  → pending  網路離線／可重試，留待下次
#     其他 → failed   真正失敗
#   回傳字串走 stdout，函式本身一律 return 0。
vox_classify_ship_result() {
    local rc="$1"
    case "$rc" in
        0)  echo "done" ;;
        75) echo "pending" ;;
        *)  echo "failed" ;;
    esac
    return 0
}

# vox_is_stable <newest_mtime_epoch> <now_epoch> <stable_secs>
#   目錄內最新檔案靜止 >= stable_secs 才算穩定（可入列 ship）。
#   穩定回傳 0（true），仍在變動回傳 1（false）。
#
#   ⚠️ newest <= 0 的退化情形：find 沒抓到任何檔案（session 目錄剛建立、檔案
#      還沒 flush、或檔案 mid-write 讓 stat race 撈空）→ caller 傳進來的是
#      "${newest:-0}" 的 0。這代表「還沒有可判定的檔案」，不是「一個 epoch 0
#      的很舊檔案」；若把它當「age 巨大 = 很穩定」就會在錄製剛開始時上傳半成品
#      （實際踩過：worker 於錄製啟動後數秒 ship，抓到 114KB 的半截 audio.wav →
#      Google Drive 回 HTTP 400）。故 newest<=0 一律視為「未穩定」，等有真正的
#      檔案 mtime 再判。
vox_is_stable() {
    local newest="${1:-0}"
    local now="$2"
    local stable="$3"
    [ "$newest" -gt 0 ] || return 1
    local age=$(( now - newest ))
    [ "$age" -ge "$stable" ]
}

# vox_is_active_recording <session_name> <active_pointer_path> [pid_file_path]
#   判斷該 session 是否為「正在錄製中」的 session：record-manual-session.ts 啟動
#   時把 SESSION_NAME 寫入 RECORDINGS_DIR/.active-session、把自身 PID 寫入
#   RECORDINGS_DIR/.active-session.pid，收尾（process exit）才移除。worker 不得
#   上傳正在錄製的 session（否則抓到半截檔案 → 上傳失敗）。
#   指標存在且內容 == session_name → 視為進行中，回 0（true）；否則回 1（false）。
#
#   殘留指標防護：錄製被 SIGKILL / OOM / 斷電中止時，收尾 exit handler 不會執行，
#   .active-session 會殘留 → 若只比對內容，該 crash 的部分錄製會被永久擋住不上傳。
#   故第三參數傳入 pid 檔時，額外檢查該 pid 是否存活（kill -0）：pid 已死 = 殘留
#   指標 → 回 1（非進行中），把這份部分錄製交回穩定閘處理。未傳 pid 檔（或檔不存在）
#   時退回純內容比對，向後相容。純函式（只讀傳入路徑 + kill -0 探測），可單元測試。
vox_is_active_recording() {
    local name="$1"
    local pointer="$2"
    local pidfile="${3:-}"
    [ -f "$pointer" ] || return 1
    local active
    active="$(cat "$pointer" 2>/dev/null)"
    [ "$active" = "$name" ] || return 1
    # 有 pid 檔且該 pid 已死 → 殘留指標（crash），非進行中。
    if [ -n "$pidfile" ] && [ -f "$pidfile" ]; then
        local pid
        pid="$(cat "$pidfile" 2>/dev/null)"
        case "$pid" in
            ''|*[!0-9]*) : ;;                      # pid 檔空/非數字 → 無法判存活，保守當進行中
            *) kill -0 "$pid" 2>/dev/null || return 1 ;;
        esac
    fi
    return 0
}

# vox_valid_session_name <name>
#   只允許 [A-Za-z0-9._-]（白名單），杜絕路徑穿越（'/' '..'）與 shell 注入
#   （空白 ';' '$()' backtick 等一律 reject）；空字串也拒。
#   合法回傳 0（true），非法回傳 1（false）。
#   （與 vox-pipeline/air/vox-queue-lib.sh 同步，兩份需一致。）
vox_valid_session_name() {
    local name="$1"
    [ -n "$name" ] || return 1
    case "$name" in
        *[!A-Za-z0-9._-]*) return 1 ;;
    esac
    case "$name" in
        *..*) return 1 ;;
    esac
    return 0
}
