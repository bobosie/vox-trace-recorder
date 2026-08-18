#!/usr/bin/env python3
"""vox-pm-gdrive — PM 端 Google Drive helper（Service Account + 共用雲端硬碟）。

認證改用 service account 金鑰（PM 零登入）：一把公司金鑰共用發給所有 PM，
全部錄製上傳到同一個 Shared Drive 資料夾，Studio 用同一把金鑰下載。

執行方式（帶依賴，不綁 venv）：
    uv run --with google-api-python-client --with google-auth \\
        python3 vox-pm-gdrive.py <subcommand> ...

Subcommands:
    auth
        驗證 service account 金鑰可用（不需使用者登入 / 不開瀏覽器）：
        載入金鑰、build service、對 Shared Drive 做一次 list 確認可存取。
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
    VOX_PM_GDRIVE_PARENT Shared Drive 內父資料夾 ID（可選，未給則以 driveId 為根）
    VOX_PM_GDRIVE_FOLDER intake 資料夾名（預設 VoiceTrace-PM-Intake）
"""
import argparse
import io
import json
import os
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
    return Path(os.environ.get("VOX_PM_CONFIG_DIR", str(Path.home() / ".config" / "vox-pm")))


def sa_key_path() -> Path:
    return Path(os.environ.get("VOX_PM_SA_KEY", str(_config_dir() / "service-account.json")))


def drive_id() -> str:
    """Shared Drive 的 driveId（必填）。"""
    return os.environ.get("VOX_PM_DRIVE_ID", "").strip()


def root_parent() -> str:
    """intake 資料夾要建/找的位置：優先用 VOX_PM_GDRIVE_PARENT，
    否則以 Shared Drive 根（driveId）為父。"""
    parent = os.environ.get("VOX_PM_GDRIVE_PARENT", "").strip()
    return parent if parent else drive_id()


def select_ship_files(dir_path: Path) -> list:
    """從 SHIP_FILES 挑出目錄裡實際存在的檔案（純邏輯，可測）。"""
    return [name for name in SHIP_FILES if (dir_path / name).is_file()]


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


def run_auth() -> int:
    """驗證憑證可用：載入憑證（使用者授權優先、SA 金鑰後備）、build service、
    對 Shared Drive 做一次 list 確認能存取。不開瀏覽器。"""
    if not drive_id():
        print("缺少 VOX_PM_DRIVE_ID（Shared Drive 的 driveId），無法驗證。", file=sys.stderr)
        return 1
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
        print(f"無法存取 Shared Drive（憑證：{_identity_label()}）：{e}", file=sys.stderr)
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
        q += f" and '{parent}' in parents"
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
        print(f"上傳失敗：{e}", file=sys.stderr)
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
        print(f"list 失敗：{e}", file=sys.stderr)
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
        print(f"download 失敗：{e}", file=sys.stderr)
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
        print(f"ship-analysis 失敗：{e}", file=sys.stderr)
        return 1


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

    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
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
    return 2


if __name__ == "__main__":
    sys.exit(main())
