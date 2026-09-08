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

**先確認 Homebrew 在**（下面每一行都靠它，沒有的話這整段會從第一行就失敗）：

```bash
command -v brew || /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
# Apple Silicon 裝完要進 PATH：
[ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
```

```bash
# Xcode CLI tools（缺了 git 不能用）
# `--install` 只是**開一個 GUI 對話框就立刻返回**，不會等安裝完成——
# 沒有下面這個等待迴圈的話，Step 2 的 git clone 會失敗。
if ! xcode-select -p >/dev/null 2>&1; then
  xcode-select --install
  echo "請在跳出的對話框點「安裝」，等它跑完…"
  until xcode-select -p >/dev/null 2>&1; do sleep 5; done
fi

# Node.js 18+
NODE_MAJOR=$(node -v 2>/dev/null | sed -n 's/^v\{0,1\}\([0-9][0-9]*\).*/\1/p')
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 18 ]; then
  brew install node@24            # Active LTS；不用 `brew install node`（那是 Current 版）
  brew unlink node 2>/dev/null
  brew link --overwrite --force node@24
fi
node -v

# sox（錄麥克風語音；缺了只是沒有語音，不致命）
command -v sox || brew install sox

# ffmpeg（抽關鍵影格；缺了只是沒有 keyframes）
command -v ffmpeg || brew install ffmpeg
```

> `brew link --overwrite` 會**刪掉** brew prefix 裡同名的既有檔案（Intel Mac 的 prefix
> 是 `/usr/local`，正好是 nodejs.org 官方 `.pkg` 的落點）。已經有 node 且版本合格時
> 上面的 `if` 不會執行，不必擔心；真的要降版前先跟使用者說一聲。
>
> 另外：**`brew link` 對 nvm / fnm / volta / asdf 無效**——那些工具把自己的 bin 排在
> Homebrew 之前，`node -v` 不會變。`node -v` 沒跟著改就改用該工具切版本
> （例如 `nvm install 24 && nvm use 24`），不要重複跑 brew。

## Step 2　取得專案（**路徑固定 `~/vox-trace`**）

```bash
git clone https://github.com/bobosie/vox-trace-recorder.git ~/vox-trace || git -C ~/vox-trace pull --ff-only
cd ~/vox-trace && npm install && npx playwright install chromium
```

> **`npx playwright install chromium` 下載到 100% 後就不動了、超過 ~10 分鐘沒動靜 = 卡死，不要繼續等。**
>
> 已知 bug：**Node 24.16+/25/26 搭 Playwright < 1.60.0** 會在解壓縮階段無限卡住
> （yauzl 串流銷毀迴歸，[playwright#40998](https://github.com/microsoft/playwright/issues/40998)、
> [nodejs#63487](https://github.com/nodejs/node/issues/63487)）。Node 24.15.0 正常、24.16.0 中招。
>
> **正解是升 Playwright，不是降 Node**：
>
> ```bash
> node -p "require('./node_modules/playwright/package.json').version"   # < 1.60.0 就是這個問題
> npm install playwright@^1.60.0 @playwright/test@^1.60.0
> rm -rf node_modules && npm install && npx playwright install chromium
> ```
>
> 本 repo 的 `package.json` 已經釘 `^1.60.0`，照理不會遇到；會遇到代表 lockfile 沒吃到。
> （這不是防毒、不是 Gatekeeper、不是網路——那三個方向都被排查過了，都不是。）

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

## Step 4　安裝 AX 工作流（**必做**——`/ax:debug` 就是從這裡來的）

兩條路，**先試 A，A 失敗才走 B**。不要問使用者要走哪條，自己試。

**A. 從團隊 server 裝（人在公司網路或已連公司 VPN 才通）**

```bash
curl -fsSL --max-time 15 http://10.2.3.35:7664/install -o /tmp/ax-install.sh \
  && bash /tmp/ax-install.sh
```

最後一行出現 `▸ 安裝完成。` 才算過。這條會一次裝上：

- 9 個 `/ax:` 指令（含 `/ax:debug`）
- 三層 hook：送出訊息時查團隊知識庫、工具失敗時自動查、工作結束自動收割
- 自動收割：session 結束時把「改過哪些檔／撞到哪些錯／跑過哪些指令」整理成草稿，
  送回團隊知識庫（會先過去識別化與人工審核閘）

**B. 連不到 server 的退路（純 GitHub，不需要公司網路）**

```bash
claude plugin marketplace add bobosie/ax-workflow
claude plugin install ax@ax-workflow --scope user
```

B **只有指令，沒有 hook、沒有自動收割**。對「錄影」這件事完全夠用：
`/ax:debug` 在 B 模式下一樣能錄、一樣會自動上傳雲端。之後人到得了公司網路時，
再跑一次 A 就會補上 hook 與收割（可重複執行，不會裝兩份）。

**兩條路都要重開 Claude Code**（skill 在 session start 才載入）。

> ⚠️ **一定要跟使用者講清楚 `/ax:` 指令打在哪裡**——這是實際卡住過人的地方。
> `/ax:` 只在**終端機裡的 Claude Code REPL** 有效，打在網頁版／App 版的 Claude
> 聊天視窗完全不會被認得（看起來就像「裝了但沒用」）。
>
> ⚠️ 下面這段是**唸給使用者聽**的，你自己不要執行——`claude` 會開一個等待輸入的
> 互動 REPL，你用工具跑它只會卡到逾時：
>
> 　「開終端機，輸入 `cd ~/vox-trace`，再輸入 `claude`
> 　（首次會問主題色 + 是否信任此資料夾，選 Yes, I trust this folder）。
> 　進到那個畫面之後，才輸入 `/ax:debug`。
> 　離開用 `/exit`，它會印出 resume ID，之後 `claude --resume <id>` 可接回同一個 session。」

驗證裝好了（A/B 皆適用）：

```bash
ls ~/.claude*/plugins/cache/*/ax/*/commands/debug.md 2>/dev/null \
  || ls ~/.ax-marketplace/plugins/ax/commands/debug.md
```

> ⚠️ 回報時要講清楚落在 A 還是 B——**不要含糊說「AX 裝好了」**。
> 走 B 的話，使用者的收割不會回到知識庫，這件事開發團隊需要知道。

## Step 5　自動上傳雲端（授權 → 設定 → 背景服務）

> 已經裝好、只是上傳卡住（`~/vox-pm-queue/failed/` 有東西）→ 改讀 `FIX-UPLOAD-FOR-AI.md`。

上傳走**使用者授權**（不是金鑰檔）：使用者用自己的公司 Google 帳號授權一次，
之後錄影以他本人身分上傳到團隊共用碟。沒有長期金鑰要保管，離職即自動失效。

> **⚠️ 先做這件事，不要等到 (d) 才發現**：使用者的公司帳號必須**已經是共用碟的成員**，
> 否則 (d) 一定失敗，而且本機怎麼改都沒用。授權完 (a) 拿到信箱後，**立刻**把下面這段
> 丟給開發團隊，然後繼續做 (b)(c)——等權限的同時把其他步驟做完，不要空等：
>
> > 麻煩把 `<使用者的公司信箱>` 加入 vox-pm 的共用雲端硬碟
> > （driveId: `0AARcpNp_0suwUk9PVA`）成員，權限至少「協作者 / Contributor」（需要上傳檔案）。
>
> 對方要加的是**共用碟成員**，不是把某個資料夾「分享」給他——程式用 `corpora=drive` 查詢，
> 單獨的資料夾分享不算數，一樣 403。「檢視者」權限也不能上傳。

**(a) 授權（一次就好）**

```bash
mkdir -p ~/.config/vox-pm
# 把開發團隊給的 oauth_client.json 放進去。從 Finder 拖檔到 Terminal 只會貼上
# 「來源路徑」，**目的地要自己補**，否則會噴 `usage: mv ...`：
#   mv "<拖進來的來源路徑>" ~/.config/vox-pm/oauth_client.json
ls ~/.config/vox-pm/oauth_client.json     # 開發團隊提供，沒有就跟他們要

cd ~/vox-trace
which uv || brew install uv
uv run --python 3.12 --with google-auth --with google-api-python-client python3 pipeline-pm/vox-pm-auth.py
```

- 會自動開瀏覽器 → 請使用者**用公司 Google 帳號**點「允許」→ 畫面出現「授權完成」。
- 跳「未經 Google 驗證」→ 進階 → 前往（這是公司內部應用）。
- 沒有 `uv` 就 `brew install uv`；沒有 GUI 加 `--print-url` 把網址給使用者自己開。
- 成功會印 `✅ 已授權：<他的信箱>`，憑證寫在 `~/.config/vox-pm/user-token.json`。
- **缺 `oauth_client.json` → 整個 Step 5 跳過、不要卡住**：告訴使用者「錄製完全可用，
  只是不會自動上傳，要手動把 `~/vox-pm-recordings/<session>` 交給開發團隊」，直接做 Step 6。

**(b) 目的地（雲端硬碟 ID）**

```bash
grep -q VOX_PM_DRIVE_ID ~/.config/vox-pm/env 2>/dev/null || \
  echo 'export VOX_PM_DRIVE_ID=0AARcpNp_0suwUk9PVA' >> ~/.config/vox-pm/env
```

**(c) 背景上傳服務（launchd，每 120 秒掃一次佇列）**

```bash
mkdir -p ~/Library/LaunchAgents
sed "s#__VOXTRACE_DEST__#$HOME/vox-trace#g" \
  ~/vox-trace/pipeline-pm/com.voxtrace.vox-pm-uploader.plist \
  > ~/Library/LaunchAgents/com.voxtrace.vox-pm-uploader.plist
launchctl unload ~/Library/LaunchAgents/com.voxtrace.vox-pm-uploader.plist 2>/dev/null
launchctl load -w ~/Library/LaunchAgents/com.voxtrace.vox-pm-uploader.plist
launchctl list | grep vox-pm-uploader      # 有一行，且第二欄（退出碼）是 0
```

> **不要用 `sudo`**——這是使用者層級的 LaunchAgent，用 sudo 會裝到別的地方去。

**(d) 驗證整條鏈（必做）**

```bash
cd ~/vox-trace
uv run --python 3.12 --with google-api-python-client --with google-auth-oauthlib --with google-auth \
  python3 pipeline-pm/vox-pm-gdrive.py auth
```

看到 `可存取 Shared Drive ✓` 才算過。括號裡會接「憑證：使用者授權」或
「憑證：service account 金鑰」，**兩種都算通過**——不要因為括號內容不同就判失敗。

> 這支腳本會自己讀 `~/.config/vox-pm/env`，**不必先 `source`**。
> （順帶一提：`cat` 那個檔只是把內容印出來，不會把 `export` 載進當前 shell——
> 以前這裡會出現「明明 cat 看得到 driveId，腳本卻說缺少」的鬼打牆，現在不會了。）

失敗對照——**三種代碼的處置不一樣，不要混為一談**：
- `403 teamDriveMembershipRequired` / `insufficientFilePermissions`
  → **這個帳號還不是共用碟成員**。把 (a) 印出來的信箱回報給開發團隊請他們加成員
  （加完不必重新授權，直接重跑 (d)）。腳本現在會直接把要貼給對方的那段話印出來。
- `404 ... driveId` → **driveId 打錯或碟已停用**，找人加權限沒有用。
  對一下 `~/.config/vox-pm/env` 裡的值與上面 (b) 是否一致。
- `invalid_grant` → 授權過期或被撤銷 → 重跑 (a)。

> **開發團隊直接給你 `service-account.json` 的話，用金鑰也完全可以**——把它放到
> `~/.config/vox-pm/service-account.json`（600）就好，不必開瀏覽器，做法見 `FIX-UPLOAD-FOR-AI.md` Step 2A。
> 上面的使用者授權是給「沒拿到金鑰檔」的人走的（新加入的人一律如此，公司已不再發新金鑰）。
> 程式取用順序是**使用者授權優先、金鑰後備**，兩個都在不會打架，也不必為了換而換。

## Step 6　回報

用這個格式回報，**照實說，不要美化**：

**每一列都要自己選一個變體，不要照抄第一個。** 尤其「已安裝」與「自動上傳」兩列——
上面的步驟並不會產生 `vox-record` 指令（那是 `install-pm.sh` 才有的），照抄 ✅ 就是謊報：

```
已安裝：✅ ~/vox-trace/start.sh 可跑 ／ 錄製煙霧測試 ✅（trace.zip+video.webm 已產出）
        —— 或 ❌ 煙霧測試沒過（附上 ls 輸出與錯誤）
        （註：本文件不會建立 `vox-record` 指令，除非另外跑過 install-pm.sh，
          否則這一列不要寫 vox-record）
AX 工作流：✅ A 模式（從團隊 server，含 hook + 自動收割）
           —— 或 ✅ B 模式（GitHub，只有指令，無 hook／無自動收割）
           —— 或 ❌ 兩條都失敗（附上錯誤訊息）
自動上傳：✅ 已設定並驗證（授權 <信箱>，共用碟 ✓，launchd 已掛）
          —— 或 ⏳ 已授權 <信箱>，**等開發團隊把我加進共用碟成員**（已於 <時間> 通知）
             → 權限開通前錄影會留在本機佇列，開通後自動補傳，不會遺失
          —— 或 ❌ 尚未設定（缺 oauth_client.json，未授權）→ 錄完請手動交檔
```

**最後跟使用者說這一句就好，不要教他其他指令：**

> 之後要錄測試，打開終端機、`cd ~/vox-trace` 後輸入 `claude`，
> 在裡面打 `/ax:debug`（**要在終端機的 Claude Code 裡，不是網頁版**），
> 跟它說要測哪個網址、這次測什麼，它會開瀏覽器讓你像平常一樣操作。
> 錄完說「好了」就收工，檔案會自動上傳。

## 使用者之後要怎麼錄

**使用者只需要記得一件事：打 `/ax:debug`。** 其他都是你（AI）的工作。
他也可以直接說「錄一段測試」「幫我錄 bug 重現」，同樣觸發。接著你會：

1. 問他兩件事：要測的**網址**、這次**測什麼**（一句話，當錄製名稱）
2. 背景啟動錄製——**`VOX_OUTPUT_DIR` 不可省略**：

   ```bash
   cd ~/vox-trace && VOX_OUTPUT_DIR="$HOME/vox-pm-recordings" \
     ./start.sh record --pm-mode --base-url <網址> --name <名稱>
   ```

   > 省略它的話錄影會落在 `~/vox-trace/recordings/`，而上傳 worker 只掃
   > `~/vox-pm-recordings`（`vox-pm-queue-worker.sh:18`）——檔案會**靜靜留在本機、
   > 佇列全空、沒有任何錯誤**，看起來像傳成功了。`/ax:debug` 這個 skill 自己有帶，
   > 手動下指令時才會漏。
3. 提醒他：跳出的瀏覽器像平常一樣操作，**邊做邊講話**（麥克風會錄下他的說明）
4. 他說「好了」→ 你執行
   `cd ~/vox-trace && VOX_OUTPUT_DIR="$HOME/vox-pm-recordings" ./start.sh stop`
   （**`stop` 要帶與 `record` 相同的 `VOX_OUTPUT_DIR`**——`.active-session` 指標寫在該目錄下，
   漏了會報「找不到進行中的錄製」。每次指令都是新 shell，env 不留存，務必同一行帶上。）
   **只能用 `stop` 或按控制視窗的 Resume 收尾——直接關視窗／kill 進程會丟掉全部產出**（trace/network/user-actions 還沒 flush）
5. 確認 session 目錄有檔案後再回報完成
