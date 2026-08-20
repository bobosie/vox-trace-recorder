#!/usr/bin/env python3
"""vox-pm-auth — 用你自己的公司 Google 帳號授權一次，之後錄影就會自動上傳。

為什麼不用 service account 金鑰：多數組織用 org policy
（`constraints/iam.managed.disableServiceAccountKeyCreation`）禁止發 SA 金鑰，
而且長期金鑰檔在多台電腦間流動本來就不安全。改成每個人授權自己的帳號：
權限跟著人走、離職即失效、沒有任何金鑰檔要傳遞。

用法：
    uv run --python 3.12 --with google-auth --with google-api-python-client python3 vox-pm-auth.py
    # 加 --print-url：只印網址不開瀏覽器（遠端 / 無 GUI 時用）

前置：`~/.config/vox-pm/oauth_client.json`（開發團隊提供的 OAuth client 設定；
它本身不是機密——沒有你本人點同意，它什麼都拿不到）。
產出：`~/.config/vox-pm/user-token.json`（600），過期會自動 refresh。
"""
import base64, hashlib, http.server, json, os, secrets, socket, subprocess, sys, threading
import urllib.parse, urllib.request

CFG_DIR = os.path.expanduser(os.environ.get("VOX_PM_CONFIG_DIR", "~/.config/vox-pm"))
CLIENT = os.path.join(CFG_DIR, "oauth_client.json")
OUT = os.environ.get("VOX_PM_USER_TOKEN", os.path.join(CFG_DIR, "user-token.json"))
SCOPES = "https://www.googleapis.com/auth/drive"

if not os.path.isfile(CLIENT):
    sys.exit(f"❌ 找不到 {CLIENT}\n   請向開發團隊索取 oauth_client.json 放到這個路徑後重跑。")

cfg = json.load(open(CLIENT))
cfg = cfg.get("installed") or cfg.get("web") or cfg
CID, CSECRET = cfg["client_id"], cfg["client_secret"]

s = socket.socket(); s.bind(("127.0.0.1", 0)); PORT = s.getsockname()[1]; s.close()
REDIRECT = f"http://localhost:{PORT}/"
STATE = secrets.token_urlsafe(24)
VERIFIER = secrets.token_urlsafe(64)
CHALLENGE = base64.urlsafe_b64encode(hashlib.sha256(VERIFIER.encode()).digest()).decode().rstrip("=")

auth_url = "https://accounts.google.com/o/oauth2/auth?" + urllib.parse.urlencode({
    "response_type": "code", "client_id": CID, "redirect_uri": REDIRECT, "scope": SCOPES,
    "state": STATE, "code_challenge": CHALLENGE, "code_challenge_method": "S256",
    "access_type": "offline", "prompt": "consent",
})

got, done = {}, threading.Event()


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _reply(self, msg):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(f"<html><body style='font:16px system-ui;padding:3em'>{msg}</body></html>".encode())

    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        state, code, err = (q.get(k, [None])[0] for k in ("state", "code", "error"))
        if err:
            self._reply(f"授權被拒：{err}")
            print(f"❌ 授權被拒：{err}", flush=True)
            return
        # 舊分頁殘留的 callback：忽略就好，別讓它炸掉整個流程
        if state != STATE:
            self._reply("這是舊分頁的回呼，已忽略；請用最新開啟的授權頁。")
            return
        got["code"] = code
        self._reply("✅ 授權完成，可以關掉這個分頁了。")
        done.set()


srv = http.server.HTTPServer(("127.0.0.1", PORT), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()

print("請在瀏覽器完成授權（用你的公司 Google 帳號）：\n" + auth_url + "\n", flush=True)
if "--print-url" not in sys.argv:
    subprocess.run(["open", auth_url], check=False)

if not done.wait(timeout=600):
    sys.exit("❌ 10 分鐘內沒有完成授權。")

body = urllib.parse.urlencode({
    "code": got["code"], "client_id": CID, "client_secret": CSECRET,
    "redirect_uri": REDIRECT, "grant_type": "authorization_code", "code_verifier": VERIFIER,
}).encode()
tok = json.load(urllib.request.urlopen(urllib.request.Request(
    "https://oauth2.googleapis.com/token", data=body,
    headers={"Content-Type": "application/x-www-form-urlencoded"})))

if not tok.get("refresh_token"):
    sys.exit("❌ 這次授權沒有拿到 refresh_token（通常是先前已授權過）。"
             "請到 https://myaccount.google.com/permissions 移除本應用後重跑。")

os.makedirs(CFG_DIR, exist_ok=True)
with open(OUT, "w") as f:
    json.dump({
        "token": tok["access_token"], "refresh_token": tok["refresh_token"],
        "token_uri": "https://oauth2.googleapis.com/token",
        "client_id": CID, "client_secret": CSECRET,
        "scopes": [SCOPES], "universe_domain": "googleapis.com",
    }, f)
os.chmod(OUT, 0o600)

who = json.load(urllib.request.urlopen(urllib.request.Request(
    "https://www.googleapis.com/drive/v3/about?fields=user",
    headers={"Authorization": "Bearer " + tok["access_token"]})))["user"]
print(f"✅ 已授權：{who.get('emailAddress')}\n   憑證存於 {OUT}", flush=True)
print("   接著驗證能不能存取共用碟：vox-pm-gdrive.py auth", flush=True)
