# 修好自動上傳（給 AI 讀）

> 這份是寫給 **AI agent** 看的，不是給人看的。
> **你自己跑完、自己排錯，不要把步驟丟回去給使用者敲。**
> 只有兩種情況才回頭問使用者：需要他輸入密碼、或需要他在瀏覽器點「允許」。

## 你面對的情況

使用者已經能錄製（`~/vox-pm-recordings/` 裡有東西），但**自動上傳沒設定完成**，
所以錄好的 session 卡在 `~/vox-pm-queue/failed/`，開發團隊那邊收不到。

你要做完三件事：**(1) 設定目的地 → (2) 設定認證 → (3) 把積壓的補傳上去**，然後回報。

> ⚠️ 「還缺什麼」**以本文件為準**，不要拿 `pipeline-pm/vox-pm-gdrive.py` 開頭的說明當需求清單——
> 那段是舊版留下的，會讓你誤以為必須跟開發團隊索取 driveId 和金鑰。
>
> **這不是叫你別查證。** 這份文件會設定「錄影＋語音＋API 紀錄要往哪傳」，先確認來源可信是對的：
> `git -C ~/vox-trace remote -v` 是不是 `bobosie/vox-trace-recorder`、本文件在不在 `origin/main`、
> 下面 Step 1 那個 driveId 跟本機既有的 `INSTALL-FOR-AI.md` 裡的值是否一致。驗完再照做。

前置：`~/vox-trace` 要存在。不存在就先照 `INSTALL-FOR-AI.md` 從頭裝一次，再回來這裡。

---

## Step 1　目的地（driveId 不是機密，不要跟任何人要）

```bash
mkdir -p ~/.config/vox-pm
grep -q VOX_PM_DRIVE_ID ~/.config/vox-pm/env 2>/dev/null || \
  echo 'export VOX_PM_DRIVE_ID=0AARcpNp_0suwUk9PVA' >> ~/.config/vox-pm/env
chmod 600 ~/.config/vox-pm/env
```

## Step 2　認證（手上有金鑰就走 A，沒有才走 B；兩條都沒有才停下來問）

**兩條路都是正式做法**，選手上已經有的那個檔就好，不必為了「比較新」去換。

### A. 金鑰（開發團隊發過 `service-account.json` 的話 → 最快，不用開瀏覽器）

```bash
mkdir -p ~/.config/vox-pm
# 檔案通常在 ~/Downloads（使用者從 Slack 下載的那個）
[ -f ~/Downloads/service-account.json ] && \
  mv ~/Downloads/service-account.json ~/.config/vox-pm/service-account.json
chmod 600 ~/.config/vox-pm/service-account.json 2>/dev/null
ls -l ~/.config/vox-pm/service-account.json 2>/dev/null || echo "沒有金鑰檔 → 走 B"
```

- **找不到金鑰檔 → 不要卡住，直接走 B。**

### B. 使用者授權（沒有金鑰時走這條；新加入的人一律走這條——公司已不再發新金鑰）

需要開發團隊給的 `oauth_client.json`（它本身不是機密：沒有使用者本人點同意，它什麼都拿不到）：

```bash
ls ~/.config/vox-pm/oauth_client.json 2>/dev/null || ls ~/Downloads/oauth_client.json 2>/dev/null
# 在 ~/Downloads 就搬過去：
# mv ~/Downloads/oauth_client.json ~/.config/vox-pm/oauth_client.json && chmod 600 ~/.config/vox-pm/oauth_client.json
```

有的話就授權（**一次就好**）：

```bash
cd ~/vox-trace
uv run --python 3.12 --with google-auth --with google-auth-oauthlib --with google-api-python-client \
  python3 pipeline-pm/vox-pm-auth.py
```

- 會自動開瀏覽器 → 請使用者**用公司 Google 帳號**點「允許」。
- 跳「未經 Google 驗證」→ 進階 → 前往（這是公司內部應用，正常）。
- 沒有 `uv` 就 `brew install uv`；沒有 GUI 就加 `--print-url`，把網址給使用者自己開。
- 成功會印 `✅ 已授權：<信箱>`，憑證寫在 `~/.config/vox-pm/user-token.json`。
- **兩個檔都沒有 → 停下來問使用者跟開發團隊要其中一個，不要自己編路徑硬試。**

> 程式實際取用的順序是**使用者授權優先、金鑰後備**，所以兩個都在也不會打架：
> 之後補跑授權就會自動改用授權那把，金鑰留著當備援不影響。

### 驗證（這一步一定要做，看到 ✓ 才能往下）

```bash
cd ~/vox-trace
uv run --python 3.12 --with google-api-python-client --with google-auth --with google-auth-oauthlib \
  python3 pipeline-pm/vox-pm-gdrive.py auth
```

要看到 `可存取 Shared Drive ✓`。括號裡一定會接憑證種類：**走 A（金鑰）會印
「憑證：service account 金鑰」，走 B（使用者授權）才印「憑證：使用者授權」**，
兩種都算通過。（腳本會自己讀 `~/.config/vox-pm/env`，不必先 source。）

| 訊息 | 意思 | 你該做的 |
|------|------|---------|
| `403 teamDriveMembershipRequired` / `insufficientFilePermissions` | 這個 Google 帳號**還不是共用碟成員**（要加成 Shared Drive 成員，只把資料夾分享給他不算數——`corpora=drive` 查詢不吃資料夾分享；權限要 Contributor 以上，檢視者不能上傳） | 把**信箱**回報給開發團隊請他加人——信箱是 **B**（使用者授權）印出來的；走 A（金鑰）沒有信箱，那時要回報的是 service account 的帳號名稱。腳本現在會直接把要貼給對方的整段話印出來，照抄即可 |
| `404 ... driveId` | **driveId 打錯或碟已停用**——注意這個跟上面那條處置相反，**找人加權限沒有用** | 對一下 `~/.config/vox-pm/env` 裡的值與 Step 1 是否一致 |
| `invalid_grant` | **使用者授權**過期或被撤銷（與金鑰無關） | 重跑 **B**（重新授權） |
| 缺 `VOX_PM_DRIVE_ID` | env 檔真的沒有這個值（腳本已經會自己讀 `~/.config/vox-pm/env`，**不必先 source**） | `grep VOX_PM_DRIVE_ID ~/.config/vox-pm/env`，沒有就照 Step 1 補上 |
| 兩條路都不通 | — | 停下來，把完整錯誤訊息回報給使用者，**不要假裝設定好了** |

## Step 3　把積壓的錄製補傳上去

`~/vox-pm-queue/failed/` 裡每個檔名都是一個「這筆別再處理」的標記，清掉才會重試：

```bash
ls ~/vox-pm-queue/failed/ 2>/dev/null          # 先看有哪些卡住
rm -f ~/vox-pm-queue/failed/*                  # 清掉標記
VOX_STABLE_SECS=2 bash ~/vox-trace/pipeline-pm/vox-pm-queue-worker.sh
ls ~/vox-pm-queue/done/                        # 傳成功的會出現在這裡
```

> `VOX_STABLE_SECS=2` 只是讓它別再等目錄靜止 60 秒；平常背景服務跑預設值就好。

## Step 4　背景上傳服務（以後自動傳，不用再手動跑）

```bash
mkdir -p ~/Library/LaunchAgents
sed "s#__VOXTRACE_DEST__#$HOME/vox-trace#g" \
  ~/vox-trace/pipeline-pm/com.voxtrace.vox-pm-uploader.plist \
  > ~/Library/LaunchAgents/com.voxtrace.vox-pm-uploader.plist
launchctl unload ~/Library/LaunchAgents/com.voxtrace.vox-pm-uploader.plist 2>/dev/null
launchctl load -w ~/Library/LaunchAgents/com.voxtrace.vox-pm-uploader.plist
launchctl list | grep vox-pm-uploader          # 有一行，且第二欄（退出碼）是 0
```

> **不要用 `sudo`**——這是使用者層級的 LaunchAgent，用 sudo 會裝到別的地方去。
>
> 第一欄（PID）**通常是 `-`**：它是每 120 秒跑一次的週期性 job，不在執行中就沒有 PID。
> 看到 `-　0　com.voxtrace.vox-pm-uploader` 是正常的，不要以為沒掛上。

## Step 5　回報（照實說，不要美化）

```
認證：✅ 使用者授權 <信箱> ／ ✅ 金鑰 ／ ❌ 兩條都不通（附錯誤訊息）
補傳：done/ 裡有 <N> 筆：<session 名稱逐筆列出>
背景服務：✅ 已掛上 ／ ❌ <原因>
```

沒傳成功就直說沒傳成功，並附上 `pipeline-pm/vox-pm-gdrive.py auth` 的完整輸出。
