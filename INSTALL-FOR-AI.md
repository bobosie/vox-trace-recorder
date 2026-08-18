# 給 AI 助理：在使用者的 Mac 上安裝 vox-trace-recorder

> **這份文件是寫給 AI coding agent（Claude Code 等）看的，不是給人讀的操作手冊。**
> 使用者（多半是 PM／測試人員，不熟終端機）會叫你「照這份文件裝好」。
> 你的工作：**自己把指令跑完、遇到問題自己排除、最後親自驗證一次**，
> 不要把步驟清單丟回去要使用者自己敲。

## 你要達成的最終狀態

1. `vox-record` 指令可用（或 `~/vox-trace/start.sh` 可跑）
2. 使用者說「錄一段測試」時，你能開瀏覽器讓他手動操作並自動收尾
3. 錄完的檔案會自動上傳到團隊雲端（**需要金鑰，見 Step 5——沒有就跳過，不要卡住**）

## 環境前提

- **僅支援 macOS**（Playwright + launchd + sox）。若是 Linux/Windows → 明確告訴使用者不支援，停止。
- 需要網路。Homebrew 安裝可能要求使用者輸入密碼——**那一步請他自己敲**，你不要嘗試代打密碼。

## Step 1　依賴

```bash
# Xcode CLI tools（缺了 git 不能用）
xcode-select -p >/dev/null 2>&1 || xcode-select --install

# Node.js 18+
node -v || brew install node

# sox（錄麥克風語音；缺了只是沒有語音，不致命）
command -v sox || brew install sox

# ffmpeg（抽關鍵影格；缺了只是沒有 keyframes）
command -v ffmpeg || brew install ffmpeg
```

沒有 Homebrew 就先裝：`/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`。

## Step 2　取得專案（**路徑固定 `~/vox-trace`**）

```bash
git clone https://github.com/bobosie/vox-trace-recorder.git ~/vox-trace || git -C ~/vox-trace pull --ff-only
cd ~/vox-trace && npm install && npx playwright install chromium
```

> 路徑必須是 `~/vox-trace`——`ax:debug` 這類 skill 預設就找這裡。
> 真的要放別處，就在使用者的 `~/.claude/settings.json` 的 `env` 加 `"VOX_TRACE_DIR": "<實際路徑>"`，並提醒他重開 session。

## Step 3　驗證錄製鏈真的會動（**必做，不可略過**）

```bash
cd ~/vox-trace
VOX_OUTPUT_DIR=/tmp/vox-smoke ./start.sh record --name smoke --base-url https://example.com --auto-test --no-audio
ls /tmp/vox-smoke/smoke/
```

看到 `trace.zip`、`video.webm`、`user-actions.json`、`network.json` 才算通過。
**沒跑這步就不要說「裝好了」**——只能說「已安裝、尚未驗證」。

## Step 4　安裝工作流 skill（選配但建議）

```bash
claude plugin marketplace add bobosie/ax-workflow
claude plugin install ax@ax-workflow --scope user
```

裝完要**重開 Claude Code**（skill 在 session start 載入）。之後 `/ax:debug` 可用。

## Step 5　自動上傳雲端（授權 → 設定 → 背景服務）

上傳走**使用者授權**（不是金鑰檔）：使用者用自己的公司 Google 帳號授權一次，
之後錄影以他本人身分上傳到團隊共用碟。沒有長期金鑰要保管，離職即自動失效。

**(a) 授權（一次就好）**

```bash
ls ~/.config/vox-pm/oauth_client.json     # 開發團隊提供，沒有就跟他們要
cd ~/vox-trace
uv run --with google-auth --with google-api-python-client python3 pipeline-pm/vox-pm-auth.py
```

- 會自動開瀏覽器 → 請使用者**用公司 Google 帳號**點「允許」→ 畫面出現「授權完成」。
- 跳「未經 Google 驗證」→ 進階 → 前往（這是公司內部應用）。
- 沒有 `uv` 就 `brew install uv`；沒有 GUI 加 `--print-url` 把網址給使用者自己開。
- 成功會印 `✅ 已授權：<他的信箱>`，憑證寫在 `~/.config/vox-pm/user-token.json`。
- **缺 `oauth_client.json` → 整個 Step 5 跳過、不要卡住**：告訴使用者「錄製完全可用，
  只是不會自動上傳，要手動把 `~/vox-pm-recordings/<session>` 交給開發團隊」，直接做 Step 6。

**(b) 目的地（雲端硬碟 ID）**

```bash
mkdir -p ~/.config/vox-pm
grep -q VOX_PM_DRIVE_ID ~/.config/vox-pm/env 2>/dev/null || \
  echo 'export VOX_PM_DRIVE_ID=0AARcpNp_0suwUk9PVA' >> ~/.config/vox-pm/env
```

**(c) 背景上傳服務（launchd，每 120 秒掃一次佇列）**

```bash
sed "s#__VOXTRACE_DEST__#$HOME/vox-trace#g" \
  ~/vox-trace/pipeline-pm/com.voxtrace.vox-pm-uploader.plist \
  > ~/Library/LaunchAgents/com.voxtrace.vox-pm-uploader.plist
launchctl unload ~/Library/LaunchAgents/com.voxtrace.vox-pm-uploader.plist 2>/dev/null
launchctl load -w ~/Library/LaunchAgents/com.voxtrace.vox-pm-uploader.plist
launchctl list | grep vox-pm-uploader      # 有一行才算掛上
```

**(d) 驗證整條鏈（必做）**

```bash
cd ~/vox-trace
set -a; . ~/.config/vox-pm/env; set +a
uv run --with google-api-python-client --with google-auth-oauthlib --with google-auth \
  python3 pipeline-pm/vox-pm-gdrive.py auth
```

看到 `可存取 Shared Drive ✓（憑證：使用者授權）` 才算過。

失敗對照：
- `404 ... driveId` 或 `insufficientFilePermissions` → **這個帳號還沒被加進共用碟**。
  把 (a) 印出來的信箱回報給開發團隊，請他們加成員，加完重跑 (d)。
- `invalid_grant` → 授權過期或被撤銷 → 重跑 (a)。

> 舊版是發一把 service account 金鑰檔給每個人；程式仍支援
> （`~/.config/vox-pm/service-account.json`，只在沒有使用者授權時才會用到），
> 但**新安裝一律走上面的使用者授權**。若機器上還留著舊金鑰檔，授權完成後可以刪掉。

## Step 6　回報

用這個格式回報，**照實說，不要美化**：

```
已安裝：vox-record ✅ / 錄製煙霧測試 ✅（trace.zip+video.webm 已產出）
AX skill：✅（要重開 Claude Code 才看得到）
自動上傳：❌ 尚未設定（缺 service-account.json）→ 錄完請手動交檔
```

## 使用者之後要怎麼錄

告訴他：在 Claude Code 說「**錄一段測試**」或「**幫我錄 bug 重現**」即可，你（AI）會：

1. 問他兩件事：要測的**網址**、這次**測什麼**（一句話，當錄製名稱）
2. 背景啟動 `~/vox-trace/start.sh record --base-url <網址> --name <名稱> --pm-mode`
3. 提醒他：跳出的瀏覽器像平常一樣操作，**邊做邊講話**（麥克風會錄下他的說明）
4. 他說「好了」→ 你執行 `cd ~/vox-trace && ./start.sh stop`
   **只能用 `stop` 或按控制視窗的 Resume 收尾——直接關視窗／kill 進程會丟掉全部產出**（trace/network/user-actions 還沒 flush）
5. 確認 session 目錄有檔案後再回報完成
