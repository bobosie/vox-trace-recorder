# pm-dist — 產出每位 PM 的一鍵安裝檔（開發者專用）

> 這份是**給 lead / 開發者**看的，不是給 PM。
> 目的：把 `vox-setup.command.template` 的兩個佔位符換成實際憑證，
> 產出每位 PM 雙擊即裝的 `vox-setup.command`。

---

## 產物概念

- `vox-setup.command.template`：**版控在 repo 的模板**，含三個佔位符，**不含真實憑證**。
- `vox-setup.command`：**每次由開發者本機產出的成品**，含真實憑證，**絕不進 git**，只透過安全管道（1Password / 加密附件等）交給 PM。

兩個佔位符（repo 本身是 public，不需要 deploy key）：

| 佔位符 | 對應環境變數 | 內容 |
|--------|-------------|------|
| `__SA_KEY_B64__` | `VOX_PM_SA_KEY_B64` | Google service account JSON 的 base64 |
| `__DRIVE_ID__` | `VOX_PM_DRIVE_ID` | 共用雲端硬碟的 driveId |

---

## 憑證來源

- **service account 金鑰 + driveId**：由管理者在 Google Cloud 建 service account、
  並把它加進目標 Shared Drive 的成員（Content manager 以上）後交付兩樣：
  - service account JSON → 一般放在本機 `~/.config/vox-pm/service-account.json`
  - driveId（Part A 的 Shared Drive ID）

烤製前把要用到的 base64 憑證各存成一個檔，慣例放 `~/.config/vox-pm/`：

| 檔案 | 內容 |
|------|------|
| `~/.config/vox-pm/sa-key.b64` | service account JSON 的 base64 |
| （driveId 為短字串，直接貼即可，不必存 .b64） | |

產生 base64（macOS）：

```bash
# service account JSON → base64（單行）
base64 -i ~/.config/vox-pm/service-account.json > ~/.config/vox-pm/sa-key.b64
```

> macOS 的 `base64 -i` 預設就是單行輸出；install-pm.sh 與 bootstrap 都用 `base64 -d` 還原，能吃含換行的多行 base64，但單行最保險。

---

## 烤製步驟（產出 vox-setup.command）

```bash
cd "$(dirname "$0")"   # 進到 pm-dist/（或用絕對路徑）

SA_B64="$(cat ~/.config/vox-pm/sa-key.b64)"
DRIVE_ID="0AxxxxxxxxxxxxxUk9PVA"   # ← 換成實際 driveId

# 用 perl 逐一取代佔位符（避免 sed 對 base64 內特殊字元誤判分隔符）
perl -pe "
  s{__SA_KEY_B64__}{$SA_B64}g;
  s{__DRIVE_ID__}{$DRIVE_ID}g;
" vox-setup.command.template > vox-setup.command

chmod +x vox-setup.command
```

> 若 base64 或 driveId 內可能含 `/`、`@`、`&` 等字元，**別用 `sed s/.../.../`**（會撞分隔符）；
> 上面用 `perl` 的 `s{}{}` 花括號分隔較安全。或用一份小的 `python3` 腳本做字串 replace。

驗證成品**沒有殘留佔位符**、且**確實填了憑證**：

```bash
grep -c '__SA_KEY_B64__\|__DRIVE_ID__' vox-setup.command   # 應為 0
bash -n vox-setup.command                                                       # 語法檢查應通過
```

---

## 交付給 PM

- 把產出的 `vox-setup.command`（**含憑證**）透過安全管道交給該 PM。
- PM 端流程見 `docs/pm-guide.md`：雙擊 → 等「安裝完成」→ 桌面出現 vox-record 捷徑。
- **不要把 `vox-setup.command` commit 進 git**（`pm-dist/.gitignore` 或 repo 根 `.gitignore` 應排除 `vox-setup.command`）。

---

## 安全備註

- 只有 `vox-setup.command.template`（佔位符版）進版控。
- 憑證 `.b64` 檔與產出的 `.command` 都不進 git，權限建議 600。
- service account 只被授權該一個 Shared Drive，不要給更大的權限範圍。
