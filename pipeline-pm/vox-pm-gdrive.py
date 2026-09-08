#!/usr/bin/env python3
"""vox-pm-gdrive — PM 端 Google Drive helper（共用雲端硬碟上傳／下載）。

認證順序：**使用者授權優先、service account 金鑰後備**。兩者都是正式做法——手上有哪個檔就用哪個，
兩個都在時會用授權那把。授權用 `vox-pm-auth.py` 產生 ~/.config/vox-pm/user-token.json；
沒拿到金鑰檔的人（新加入者）走授權，因為公司已不再發新的 service account 金鑰。

設定步驟見 repo 根目錄 `INSTALL-FOR-AI.md` Step 5；上傳卡住時的修復見 `FIX-UPLOAD-FOR-AI.md`。
driveId 不是機密（安裝文件裡就有值），不需要向任何人索取。

執行方式（帶依賴，不綁 venv）：
    uv run --python 3.12 --with google-api-python-client --with google-auth \\
        python3 vox-pm-gdrive.py <subcommand> ...

Subcommands:
    auth
        驗證目前憑證可用（不開瀏覽器）：載入使用者授權或金鑰、build service、
        對 Shared Drive 做一次 list 確認可存取，並印出實際用了哪一種憑證。
        成功 exit 0，失敗印原因 exit 1。installer 可拿它當 preflight 檢查。

    upload --session-dir <dir> --folder <name>
        在 <folder> 下建 <session名>/ 子資料夾，上傳 ship 清單裡存在的檔案，
        全部成功後最後上傳 _complete.json 作完成標記。
        exit 0 成功 / 75 網路錯誤（可重試）/ 1 其他錯。

    list --folder <name>
        列出 <folder> 下「含 _complete.json」的 session 子資料夾名稱（stdout 一行一個）。

    download --folder <name> --session <名> --dest <dir>
        下載該 session 子資料夾內全部檔案到 <dest>。

環境變數：
    VOX_PM_USER_TOKEN    使用者授權 token（預設 ~/.config/vox-pm/user-token.json）— 優先使用
    VOX_PM_SA_KEY        service account 金鑰 JSON（預設 ~/.config/vox-pm/service-account.json）— 後備
    VOX_PM_DRIVE_ID      Shared Drive 的 driveId（**必填**）
                         沒設環境變數時會自動讀 ~/.config/vox-pm/env，
                         所以忘了 source 也能跑（註解行不算）
    VOX_PM_GDRIVE_PARENT Shared Drive 內父資料夾 ID（可選，未給則以 driveId 為根）
    VOX_PM_GDRIVE_FOLDER intake 資料夾名（預設 VoiceTrace-PM-Intake）
"""
import argparse
import io
import json
import os
import re
import sys
from pathlib import Path

# Shared Drive 寫入用完整 drive scope（service account 對 Shared Drive 的
# drive.file 有已知限制，drive scope 最穩）。
SCOPES = ["https://www.googleapis.com/auth/drive"]

# ship 清單：存在才傳（順序即上傳順序，_complete.json 由程式最後補）。
SHIP_FILES = [
    "video.webm",
    "audio.wav",
    "trace.zip",
    "network.json",
    "user-actions.json",
    "codegen.ts",
    "metadata.json",
]

COMPLETE_MARKER = "_complete.json"


def _escape_drive_query(s: str) -> str:
    """逸出 Drive query 字串字面值中的 backslash 與單引號，防 query 注入。
    遠端可控的 name（資料夾/檔名）含單引號會改變 Drive query 語意。"""
    return s.replace("\\", "\\\\").replace("'", "\\'")


def _config_dir() -> Path:
    # 空字串會讓 Path("") 變成 "."，於是後備讀檔會去讀「當前目錄的 ./env」——
    # 等同「誰能寫 cwd 誰就能決定上傳目的地」。空值一律退回預設。
    configured = os.environ.get("VOX_PM_CONFIG_DIR", "").strip()
    return Path(configured) if configured else Path.home() / ".config" / "vox-pm"


def sa_key_path() -> Path:
    return Path(os.environ.get("VOX_PM_SA_KEY", str(_config_dir() / "service-account.json")))


def _env_file_value(key: str) -> str:
    """從 ~/.config/vox-pm/env 讀 `[export] KEY=VALUE`（os.environ 沒有時的後備）。

    為什麼需要：使用者 `cat` 那個檔看得到值，但 cat 不會把 export 載進 shell，
    於是手動執行時本腳本說「缺少 VOX_PM_DRIVE_ID」——檔案明明就在。背景 worker
    不受影響（vox-pm-queue-worker.sh 自己有 source），所以這個坑只在手動執行時
    出現，開發端很難看見（2026-09-07 Grace 安裝實錄「坑 4」）。

    刻意只做「單一 KEY=VALUE 的字面讀取」，不展開變數、不執行任何東西——
    這是設定檔不是要跑的 shell。註解必須先剝掉：實際的 env 檔裡留著一行
    「# 舊值（保留備查）：export VOX_PM_DRIVE_ID=<已停用的舊碟>」，子字串比對
    會撈到它，把錄影靜默上傳到沒人看的死碟。同名多次賦值取最後一個（shell 語意）。
    """
    path = _config_dir() / "env"
    try:
        # utf-8-sig 吃掉 BOM（否則第一行永遠配不上，﻿ 不是 whitespace）；
        # errors="replace" 讓一句 cp950 中文註解不會害整個檔被丟掉——真實的
        # env 檔有中文註解，被 Windows/Big5 編輯器存過一次就會踩到，
        # 那等於坑 4 換個皮再來一次。
        text = path.read_text(encoding="utf-8-sig", errors="replace")
    except OSError:
        return ""

    # 解析器看不見 shell 控制流。`if [ -n "$DEV" ]; then export X=<舊碟>; fi`
    # 這種 shell **根本不會執行**的賦值，逐行掃描會當成最後一個生效值 →
    # source 得到正式碟、本程式得到死碟，零徵兆、零錯誤。
    # 形狀驗證擋不住它（死碟 ID 的形狀完全合法），所以只能誠實承認能力邊界：
    # 檔案一旦不是「單純的賦值清單」，就不猜了，回空字串讓上層大聲說缺少。
    if _SHELL_CONTROL_FLOW.search(text):
        return ""

    found = ""
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()          # 先剝註解，再談解析
        if not line:
            continue
        # export 後面可能是空白或 TAB；也接受 declare -x
        line = re.sub(r"^(?:export|declare\s+-x)\s+", "", line)
        name, sep, value = line.partition("=")
        if not sep or name.strip() != key:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        found = value.strip()
    return found


# 這些關鍵字一出現，這個 env 檔就是「一段 shell 程式」而不是「一份設定」。
_SHELL_CONTROL_FLOW = re.compile(
    r"(?m)^\s*(?:if|then|else|elif|fi|case|esac|for|while|until|do|done|function)\b"
    r"|^\s*[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)\s*\{"
)

# driveId 是 base64url 字元集。形狀不合就當沒讀到——把「靜默拿垃圾去打 API」
# 變成「大聲說缺少」。單邊引號、${VAR:-x}、$(cmd)、`a=b c=d` 這類殘缺解析
# 結果全部是非空字串，會通過 `if not drive_id()` 守衛，只有形狀驗證擋得住。
_DRIVE_ID_SHAPE = re.compile(r"^[A-Za-z0-9_-]{10,}$")


def drive_id() -> str:
    """Shared Drive 的 driveId（必填）。環境變數優先，其次讀 config 的 env 檔。

    從 env 檔讀來的值會做形狀驗證；環境變數則原樣信任（那是呼叫端明確給的）。
    """
    value = os.environ.get("VOX_PM_DRIVE_ID", "").strip()
    if value:
        return value
    from_file = _env_file_value("VOX_PM_DRIVE_ID")
    return from_file if _DRIVE_ID_SHAPE.match(from_file) else ""


def root_parent() -> str:
    """intake 資料夾要建/找的位置：優先用 VOX_PM_GDRIVE_PARENT，
    否則以 Shared Drive 根（driveId）為父。"""
    parent = os.environ.get("VOX_PM_GDRIVE_PARENT", "").strip()
    return parent if parent else drive_id()


def select_ship_files(dir_path: Path) -> list:
    """挑出目錄裡要上傳的檔案：SHIP_FILES 固定清單 + 所有 tab 影片（純邏輯，可測）。

    多 tab 錄製時 Playwright 只會把其中一支影片 rename 成 video.webm，其餘各 tab
    保持 page@<hash>.webm 原名。一次錄製的每個 tab 都是證據，全部要上傳——只傳
    video.webm 會讓其他 tab 的畫面永遠留在本機（實際踩過：一場多 tab 錄製
    只上傳到主 tab，另外兩支留在本機才發現）。字典序排列確保上傳順序穩定、可重現。
    """
    fixed = [name for name in SHIP_FILES if (dir_path / name).is_file()]
    tab_videos = sorted(
        p.name for p in dir_path.glob("page@*.webm")
        if p.is_file() and p.name not in SHIP_FILES
    )
    return fixed + tab_videos


class NetworkError(Exception):
    """可重試的網路錯誤 → 呼叫端映射成 exit 75。"""


def _is_network_error(exc: Exception) -> bool:
    import socket
    if isinstance(exc, (socket.timeout, socket.gaierror, ConnectionError, TimeoutError)):
        return True
    # httplib2 DNS 失敗丟 ServerNotFoundError（不 import httplib2 避免硬依賴，
    # 用類名比對）。訊息如 "Unable to find the server at ..."。
    if type(exc).__name__ == "ServerNotFoundError":
        return True
    # httplib2 / urllib 的連線層錯誤名稱多含這些關鍵字
    text = f"{type(exc).__name__}: {exc}".lower()
    return any(k in text for k in ("timed out", "timeout", "connection", "unreachable",
                                   "temporarily", "getaddrinfo", "ssl",
                                   "unable to find the server", "servernotfound"))


# ─── 認證：使用者 OAuth 優先，service account 為後備 ──────────
#
# 為什麼是這個順序：組織常以 org policy（iam.managed.disableServiceAccountKeyCreation）
# 禁止發 SA 金鑰。使用者 OAuth 不需要任何金鑰檔——每個人用自己的公司帳號授權一次，
# 上傳以本人身分寫進共用碟；憑證離職即隨帳號失效，不會有一把長期金鑰在外流動。

def user_token_path() -> Path:
    return Path(os.environ.get("VOX_PM_USER_TOKEN", str(_config_dir() / "user-token.json")))


def _user_creds():
    """有使用者 token 就回 Credentials（過期自動 refresh 並寫回），沒有回 None。"""
    tokf = user_token_path()
    if not tokf.is_file():
        return None
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request
    creds = Credentials.from_authorized_user_file(str(tokf), SCOPES)
    if not creds.valid:
        if not (creds.expired and creds.refresh_token):
            raise RuntimeError(
                f"使用者授權已失效：{tokf}（請重跑 pipeline-pm/vox-pm-auth.py 重新授權）")
        creds.refresh(Request())
        tokf.write_text(creds.to_json())
        tokf.chmod(0o600)
    return creds


def get_service():
    # lazy import：純函式測試（select_ship_files / _is_network_error 等）在無 google
    # 套件環境也要能 import 本模組，故 google 依賴一律延遲到這裡才載入。
    from googleapiclient.discovery import build

    creds = _user_creds()
    if creds is None:
        from google.oauth2 import service_account
        key = sa_key_path()
        if not key.is_file():
            # 設定錯（憑證缺）非網路錯 → 用 FileNotFoundError 讓呼叫端映射成 exit 1（非 75）。
            raise FileNotFoundError(
                f"找不到任何憑證：{user_token_path()}（使用者授權）或 {key}（service account 金鑰）。"
                "請跑 pipeline-pm/vox-pm-auth.py 授權，或放置 SA 金鑰。"
            )
        creds = service_account.Credentials.from_service_account_file(str(key), scopes=SCOPES)
    return build("drive", "v3", credentials=creds)


def _identity_label() -> str:
    return "使用者授權" if user_token_path().is_file() else "service account 金鑰"


def explain_drive_error(err_text: str, drive_id_value: str, email: str = "") -> str:
    """把 Drive 的存取錯誤翻成「該做什麼」，原文一律保留在後面供排查。

    這三種代碼長得像但處置完全不同，混為一談會讓人往錯的方向修
    （2026-09-07 Grace 安裝實錄「坑 5」：403 原文看不出要去找誰）：
      teamDriveMembershipRequired / insufficientFilePermissions → 要請人加成員
      notFound（404）                                            → driveId 打錯，加人沒用
      invalid_grant                                              → 授權過期，重跑授權
    """
    who = email.strip() or "<你的公司信箱>"
    if "invalid_grant" in err_text:
        # 先判這個：「invalid_grant: Account not found」同時含 not found，
        # 特異度高的先贏，否則會被誤判成 driveId 打錯、叫人去改設定。
        return (
            "授權已過期或被撤銷。重跑一次授權即可（會開瀏覽器）：\n"
            "    uv run --python 3.12 --with google-auth --with google-api-python-client \\\n"
            "        python3 pipeline-pm/vox-pm-auth.py"
            f"\n\n  原始錯誤：{err_text}"
        )
    if "teamDriveMembershipRequired" in err_text or "insufficientFilePermissions" in err_text:
        hint = (
            f"這個 Google 帳號（{who}）還不是共用雲端硬碟的成員——本機再怎麼設定都不會過，\n"
            "  必須請開發團隊在 Google Drive 端加人。把下面這段整段貼給他們：\n\n"
            f"    麻煩把 {who} 加入 vox-pm 的共用雲端硬碟（driveId: {drive_id_value}）成員，\n"
            "    權限至少「協作者 / Contributor」（需要上傳檔案）。\n\n"
            "  兩個最常被搞錯的點，順便提醒對方：\n"
            "    1. 要加成「共用雲端硬碟的成員」，不是把某個資料夾「分享」給你——\n"
            "       本程式用 corpora=drive 查詢，單獨的資料夾分享不算數，一樣 403。\n"
            "    2. 權限要 Contributor 以上，「檢視者」不能上傳。\n"
            "  對方加完（通常幾分鐘內生效）不必重新授權，直接重跑這個指令即可。"
        )
    elif "shared drive not found" in err_text.lower():
        # 刻意只認碟級 404 的原句。放寬成 "not found" 會把「File not found（檔案級
        # 404）」「找不到憑證檔」「nginx 的 HTML 404」全判成 driveId 打錯，
        # 然後叫人去改一個根本沒問題的設定。
        hint = (
            f"找不到這個共用雲端硬碟（driveId: {drive_id_value}）——多半是 ID 打錯或碟已停用，\n"
            "  這種情況「請人加你成員」沒有用。檢查 VOX_PM_DRIVE_ID：\n"
            "    grep VOX_PM_DRIVE_ID ~/.config/vox-pm/env\n"
            "  正確值在 INSTALL-FOR-AI.md Step 5(b)（driveId 不是機密，不必向誰索取）。"
        )
    else:
        return err_text
    return f"{hint}\n\n  原始錯誤：{err_text}"


def _current_account_email(service) -> str:
    """問 Drive「我現在是誰」。純粹為了讓錯誤訊息能指名道姓，失敗就算了。"""
    try:
        return (service.about().get(fields="user")
                .execute().get("user", {}).get("emailAddress", "") or "")
    except Exception:
        return ""


def run_auth() -> int:
    """驗證憑證可用：載入憑證（使用者授權優先、SA 金鑰後備）、build service、
    對 Shared Drive 做一次 list 確認能存取。不開瀏覽器。"""
    if not drive_id():
        print(f"缺少 VOX_PM_DRIVE_ID（Shared Drive 的 driveId），無法驗證。\n"
              f"  已找過：環境變數，以及 {_config_dir() / 'env'}。\n"
              "  設定方式見 INSTALL-FOR-AI.md Step 5(b)。", file=sys.stderr)
        return 1
    service = None
    try:
        service = get_service()
        service.files().list(
            pageSize=1,
            fields="files(id)",
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
            corpora="drive",
            driveId=drive_id(),
        ).execute()
    except FileNotFoundError as e:
        print(str(e), file=sys.stderr)
        return 1
    except Exception as e:
        email = _current_account_email(service) if service is not None else ""
        print(f"無法存取 Shared Drive（憑證：{_identity_label()}）：\n  "
              + explain_drive_error(str(e), drive_id(), email), file=sys.stderr)
        return 1
    print(f"可存取 Shared Drive ✓（憑證：{_identity_label()}）")
    return 0


# ─── Drive helpers ─────────────────────────────────────────

def _list_files(service, q, fields="files(id)", page_size=1000):
    """對 Shared Drive 做 files().list（統一帶 Shared Drive 參數）。"""
    return service.files().list(
        q=q,
        fields=fields,
        pageSize=page_size,
        supportsAllDrives=True,
        includeItemsFromAllDrives=True,
        corpora="drive",
        driveId=drive_id(),
    ).execute().get("files", [])


def find_folder(service, name, parent=None):
    q = (
        "mimeType='application/vnd.google-apps.folder' "
        f"and name='{_escape_drive_query(name)}' and trashed=false"
    )
    if parent:
        # name 一直有逸出，parent 沒有——而 root_parent() 會回 drive_id()，
        # 現在 driveId 多了一條「從檔案來」的輸入路徑，這個不對稱變得更可達。
        q += f" and '{_escape_drive_query(parent)}' in parents"
    found = _list_files(service, q, fields="files(id)", page_size=1)
    return found[0]["id"] if found else None


def find_or_create_folder(service, name, parent=None):
    fid = find_folder(service, name, parent=parent)
    if fid:
        return fid
    meta = {"name": name, "mimeType": "application/vnd.google-apps.folder"}
    if parent:
        meta["parents"] = [parent]
    return service.files().create(
        body=meta, fields="id", supportsAllDrives=True
    ).execute()["id"]


def _upload_one(service, folder_id, filepath: Path):
    import mimetypes
    from googleapiclient.http import MediaFileUpload

    mime = mimetypes.guess_type(str(filepath))[0] or "application/octet-stream"
    media = MediaFileUpload(str(filepath), mimetype=mime, resumable=True)
    service.files().create(
        body={"name": filepath.name, "parents": [folder_id]},
        media_body=media,
        fields="id",
        supportsAllDrives=True,
    ).execute()


# ─── Subcommands ───────────────────────────────────────────

def cmd_upload(args) -> int:
    session_dir = Path(args.session_dir).resolve()
    if not session_dir.is_dir():
        print(f"session 目錄不存在：{session_dir}", file=sys.stderr)
        return 1
    session_name = session_dir.name

    files = select_ship_files(session_dir)
    if not files:
        print(f"session {session_name} 無可上傳檔案", file=sys.stderr)
        return 1

    if not drive_id():
        print("缺少 VOX_PM_DRIVE_ID（Shared Drive 的 driveId）", file=sys.stderr)
        return 1

    try:
        service = get_service()
        root_id = find_or_create_folder(service, args.folder, parent=root_parent())
        sub_id = find_or_create_folder(service, session_name, parent=root_id)

        uploaded = []
        for name in files:
            _upload_one(service, sub_id, session_dir / name)
            uploaded.append({"name": name, "bytes": (session_dir / name).stat().st_size})

        # 全部成功後才寫完成標記，內容含檔案清單 + bytes。
        marker = {
            "session": session_name,
            "files": uploaded,
            "total_bytes": sum(u["bytes"] for u in uploaded),
        }
        complete_path = session_dir / COMPLETE_MARKER
        complete_path.write_text(json.dumps(marker, ensure_ascii=False, indent=2))
        _upload_one(service, sub_id, complete_path)

        print(f"上傳完成：{session_name}（{len(uploaded)} 檔）")
        return 0
    except FileNotFoundError as e:
        print(str(e), file=sys.stderr)
        return 1
    except Exception as e:
        if _is_network_error(e):
            print(f"網路錯誤（可重試）：{e}", file=sys.stderr)
            return 75
        print("上傳失敗：" + explain_drive_error(str(e), drive_id()), file=sys.stderr)
        return 1


def cmd_list(args) -> int:
    if not drive_id():
        print("缺少 VOX_PM_DRIVE_ID（Shared Drive 的 driveId）", file=sys.stderr)
        return 1
    try:
        service = get_service()
        root_id = find_folder(service, args.folder, parent=root_parent())
        if not root_id:
            return 0  # 資料夾還不存在 → 沒有任何 session
        # 列出 root 下所有子資料夾
        subs = _list_files(
            service,
            q=(f"'{root_id}' in parents and trashed=false "
               "and mimeType='application/vnd.google-apps.folder'"),
            fields="files(id,name)",
            page_size=1000,
        )
        for sub in subs:
            marker = _list_files(
                service,
                q=(f"'{sub['id']}' in parents and trashed=false "
                   f"and name='{_escape_drive_query(COMPLETE_MARKER)}'"),
                fields="files(id)",
                page_size=1,
            )
            if marker:
                print(sub["name"])
        return 0
    except FileNotFoundError as e:
        print(str(e), file=sys.stderr)
        return 1
    except Exception as e:
        if _is_network_error(e):
            print(f"網路錯誤（可重試）：{e}", file=sys.stderr)
            return 75
        print("list 失敗：" + explain_drive_error(str(e), drive_id()), file=sys.stderr)
        return 1


def cmd_download(args) -> int:
    from googleapiclient.http import MediaIoBaseDownload

    if not args.session:
        print("必須指定 --session", file=sys.stderr)
        return 1
    dest = Path(args.dest)
    dest.mkdir(parents=True, exist_ok=True)
    if not drive_id():
        print("缺少 VOX_PM_DRIVE_ID（Shared Drive 的 driveId）", file=sys.stderr)
        return 1
    try:
        service = get_service()
        root_id = find_folder(service, args.folder, parent=root_parent())
        if not root_id:
            print(f"找不到資料夾：{args.folder}", file=sys.stderr)
            return 1
        sub_id = find_folder(service, args.session, parent=root_id)
        if not sub_id:
            print(f"找不到 session：{args.session}", file=sys.stderr)
            return 1
        items = _list_files(
            service,
            q=f"'{sub_id}' in parents and trashed=false",
            fields="files(id,name,mimeType)",
            page_size=1000,
        )
        for it in items:
            if it["mimeType"] == "application/vnd.google-apps.folder":
                continue
            # it["name"] 是遠端可控檔名，含 .. / 分隔符會逸出 dest；只取 basename。
            safe_name = os.path.basename(it["name"])
            if safe_name in ("", ".", ".."):
                print(f"跳過不安全檔名：{it['name']!r}", file=sys.stderr)
                continue
            req = service.files().get_media(fileId=it["id"], supportsAllDrives=True)
            buf = io.FileIO(str(dest / safe_name), "wb")
            downloader = MediaIoBaseDownload(buf, req)
            done = False
            while not done:
                _, done = downloader.next_chunk()
            buf.close()
            print(safe_name)
        return 0
    except FileNotFoundError as e:
        print(str(e), file=sys.stderr)
        return 1
    except Exception as e:
        if _is_network_error(e):
            print(f"網路錯誤（可重試）：{e}", file=sys.stderr)
            return 75
        print("download 失敗：" + explain_drive_error(str(e), drive_id()), file=sys.stderr)
        return 1


def _delete_in_folder(service, folder_id, name):
    """刪掉資料夾內同名檔（idempotent 補傳：避免重跑產生重複檔）。"""
    for f in _list_files(
        service,
        q=(f"'{folder_id}' in parents and trashed=false "
           f"and name='{_escape_drive_query(name)}'"),
        fields="files(id)", page_size=10,
    ):
        service.files().delete(fileId=f["id"], supportsAllDrives=True).execute()


def cmd_ship_analysis(args) -> int:
    """把 Studio 端解析產物（transcript + keyframes）補傳到該 session 既有
    GDrive 資料夾，stdout 最後一行印資料夾 URL 供 caller 擷取。idempotent。"""
    session_dir = Path(args.session_dir).resolve()
    if not session_dir.is_dir():
        print(f"session 目錄不存在：{session_dir}", file=sys.stderr)
        return 1
    session_name = session_dir.name
    if not drive_id():
        print("缺少 VOX_PM_DRIVE_ID（Shared Drive 的 driveId）", file=sys.stderr)
        return 1
    try:
        service = get_service()
        root_id = find_or_create_folder(service, args.folder, parent=root_parent())
        sub_id = find_or_create_folder(service, session_name, parent=root_id)
        n = 0
        for name in ("transcript.txt", "transcript.srt"):
            fp = session_dir / name
            if fp.is_file():
                _delete_in_folder(service, sub_id, name)
                _upload_one(service, sub_id, fp)
                n += 1
        kf = session_dir / "keyframes"
        if kf.is_dir():
            kf_id = find_or_create_folder(service, "keyframes", parent=sub_id)
            for png in sorted(kf.glob("*.png")):
                _delete_in_folder(service, kf_id, png.name)
                _upload_one(service, kf_id, png)
                n += 1
        print(f"analysis 補傳完成：{session_name}（{n} 檔）", file=sys.stderr)
        print(f"https://drive.google.com/drive/folders/{sub_id}")
        return 0
    except FileNotFoundError as e:
        print(str(e), file=sys.stderr)
        return 1
    except Exception as e:
        if _is_network_error(e):
            print(f"網路錯誤（可重試）：{e}", file=sys.stderr)
            return 75
        print("ship-analysis 失敗：" + explain_drive_error(str(e), drive_id()), file=sys.stderr)
        return 1


def pick_uploader(folder_meta: dict) -> str:
    """從 Drive 資料夾 metadata 取「誰上傳的」顯示名。

    共用雲端硬碟（Shared Drive）的檔案由硬碟本身持有，`owners` 通常是空的
    （2026-09-01 實查 VoxTrace-PM Shared Drive 確認），所以主要靠
    `lastModifyingUser`——PM 端是各自的使用者 OAuth 上傳，這就是上傳者本人。
    """
    for key in ("lastModifyingUser", "sharingUser"):
        u = folder_meta.get(key) or {}
        name = (u.get("displayName") or u.get("emailAddress") or "").strip()
        if name:
            return name
    for u in folder_meta.get("owners") or []:
        name = ((u or {}).get("displayName") or (u or {}).get("emailAddress") or "").strip()
        if name:
            return name
    return ""


def cmd_uploader(args) -> int:
    """印出某個 session 資料夾的上傳者顯示名（查無則印空字串、回 0）。

    通知用的補充資訊，查不到不該讓上游處理流程失敗，所以錯誤一律回 0 + 空輸出。
    """
    if not drive_id():
        return 0
    try:
        service = get_service()
        root_id = find_folder(service, args.folder, parent=root_parent())
        if not root_id:
            return 0
        found = _list_files(
            service,
            q=(f"'{root_id}' in parents and trashed=false "
               f"and name='{_escape_drive_query(args.session)}' "
               "and mimeType='application/vnd.google-apps.folder'"),
            fields=("files(id,name,lastModifyingUser(displayName,emailAddress),"
                    "sharingUser(displayName,emailAddress),"
                    "owners(displayName,emailAddress))"),
            page_size=1,
        )
        if found:
            print(pick_uploader(found[0]))
        return 0
    except Exception as e:
        print(f"uploader 查詢失敗（略過）：{e}", file=sys.stderr)
        return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="vox-pm-gdrive",
        description="PM 端 Google Drive helper（Service Account + 共用雲端硬碟）。"
                    "金鑰路徑 VOX_PM_SA_KEY，Shared Drive 用 VOX_PM_DRIVE_ID。",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("auth", help="驗證憑證（使用者授權優先／SA 金鑰後備）可存取 Shared Drive")

    up = sub.add_parser("upload")
    up.add_argument("--session-dir", required=True)
    up.add_argument("--folder", required=True)

    ls = sub.add_parser("list")
    ls.add_argument("--folder", required=True)

    dl = sub.add_parser("download")
    dl.add_argument("--folder", required=True)
    dl.add_argument("--session", required=True)
    dl.add_argument("--dest", required=True)

    sa = sub.add_parser("ship-analysis")
    sa.add_argument("--session-dir", required=True)
    sa.add_argument("--folder", required=True)

    ul = sub.add_parser("uploader", help="印出某 session 資料夾的上傳者顯示名（查無則空）")
    ul.add_argument("--folder", required=True)
    ul.add_argument("--session", required=True)

    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)

    # 一次執行只解析一次 driveId，之後全部走環境變數快路徑。
    # 沒有這一步的話 drive_id() 每次呼叫都重讀檔（cmd_list 100 個 session ≈ 104 次），
    # 使用者若正好在照錯誤訊息編輯那個檔，同一個邏輯操作會橫跨兩個不同的碟——
    # 部分 session 從清單消失或改打到別的碟，而且不會報錯。
    resolved = drive_id()
    if resolved:
        os.environ["VOX_PM_DRIVE_ID"] = resolved
    if args.cmd == "auth":
        return run_auth()
    if args.cmd == "upload":
        return cmd_upload(args)
    if args.cmd == "list":
        return cmd_list(args)
    if args.cmd == "download":
        return cmd_download(args)
    if args.cmd == "ship-analysis":
        return cmd_ship_analysis(args)
    if args.cmd == "uploader":
        return cmd_uploader(args)
    return 2


if __name__ == "__main__":
    sys.exit(main())
