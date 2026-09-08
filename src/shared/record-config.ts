/**
 * record-config — record-manual-session.ts 的純參數解析邏輯。
 *
 * 抽成獨立模組是為了讓 CLI 旗標解析與 PM-mode 判斷可被單元測試，
 * 不必真的啟動瀏覽器。record-manual-session.ts 直接消費這裡的函式。
 */

export interface ScreenshotConfig {
  /**
   * 截圖總開關。預設 false（無旗標＝全關：load / periodic / final 都不拍，
   * screenshots/ 目錄根本不建）。--screenshots 才開。
   * PM 反映：定時截圖會干擾操作，所以預設一張都不拍。
   */
  enabled: boolean;
  /**
   * 是否啟用定時截圖。enabled 為前提，且未被 --no-periodic-screenshots 關掉。
   * （--no-periodic-screenshots 是向後相容旗標：--screenshots 開了 load+final，
   * 但想關掉會頻繁打斷的定時截圖時使用。）
   */
  periodicEnabled: boolean;
  /** 定時截圖間隔（秒），--screenshot-interval 覆蓋，預設 3。 */
  intervalSec: number;
  /** 截圖是否 fullPage。預設 false（只截可視區），--full-page 才開。 */
  fullPage: boolean;
}

import * as path from 'path';

const DEFAULT_INTERVAL_SEC = 3;

/** session 名被剝到空或全非法時的安全預設。 */
const SAFE_SESSION_DEFAULT = 'session';

/**
 * 把使用者提供的 session 名（--name）淨化成單一安全路徑片段。
 * --name 會進 path.join(RECORDINGS_DIR, name)，未淨化時 `../../.ssh/authorized_keys`
 * 之類可逸出錄製目錄寫任意檔。
 *
 * 步驟：取 basename（去掉目錄分隔）、剝掉開頭的 `.`（避免 dotfile / `.` /
 * bare `..`）、再把殘留的 `..` 換成 `_`。空字串或全被剝光時回退安全預設。
 */
export function sanitizeSessionName(raw: string): string {
  // basename 去掉任何目錄成分（含 ../）；path.basename('..') 仍是 '..'。
  let name = path.basename(raw);
  // 剝掉開頭所有的 '.'，避免 dotfile / '.' / '..'（bare '..' 於此被剝光）。
  name = name.replace(/^\.+/, '');
  // 剝完後殘留的 `..`（如 'a..b'）換成 '_'，杜絕內嵌上跳片段。
  name = name.replace(/\.\./g, '_');
  return name === '' ? SAFE_SESSION_DEFAULT : name;
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

export function parseScreenshotConfig(args: string[]): ScreenshotConfig {
  const raw = getArg(args, '--screenshot-interval');
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
  const intervalSec = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_SEC;

  const enabled = hasFlag(args, '--screenshots');
  const periodicEnabled = enabled && !hasFlag(args, '--no-periodic-screenshots');

  return {
    enabled,
    periodicEnabled,
    intervalSec,
    fullPage: hasFlag(args, '--full-page'),
  };
}

/**
 * PM 模式：本機只錄製 + ship raw 給 Studio，錄後重處理交給 Studio。
 * 來源：--pm-mode 旗標，或環境變數 VOX_PM_MODE（值非 '0'/'' 即啟用）。
 */
export function parsePmMode(args: string[], env: Record<string, string | undefined>): boolean {
  if (hasFlag(args, '--pm-mode')) return true;
  const v = env.VOX_PM_MODE;
  return v !== undefined && v !== '' && v !== '0';
}

/** PM 模式跳過本機錄後重處理（keyframes / transcribe / correlate）。 */
export function shouldRunPostProcessing(pmMode: boolean): boolean {
  return !pmMode;
}

/**
 * 錄製收尾要不要自動把證據包送回 NL server。
 *
 * 這裡只管「呼叫端要不要試」；真正決定會不會送出去的是機器上有沒有 NL 設定
 * （見 shared/nl-upload.ts 的 resolveUploadConfig）——沒有 NL_RECALL_SERVER 的
 * 機器即使這裡回 true 也是靜默略過。
 *
 * **PM 模式一律關閉**：AX 那條線是錄製 → Studio → GDrive，跟 NL server 是不同
 * 組織的落點。而同一台機器可能兩套都裝了（我自己的三台就是），少了這道判斷，
 * AX 的 PM 錄製會被送進 NL 的證據庫——那是跨組織外洩，不只是走錯路。
 */
export function shouldAutoUpload(args: string[], pmMode: boolean): boolean {
  if (pmMode) return false;
  return !hasFlag(args, '--no-upload');
}

/**
 * 從 .pm-config.json 內容解析錄製者名字（寫進 metadata.recorder）。
 * configJson 為 null（缺檔）、壞 JSON、缺 recorder key、或空字串一律回 undefined，
 * 讓呼叫端靜默省略欄位不噴錯。回傳前 trim 兩側空白。
 */
export function parseRecorder(configJson: string | null): string | undefined {
  if (configJson === null) return undefined;
  try {
    const obj = JSON.parse(configJson);
    const recorder = obj?.recorder;
    if (typeof recorder !== 'string') return undefined;
    const trimmed = recorder.trim();
    return trimmed === '' ? undefined : trimmed;
  } catch {
    return undefined;
  }
}

// ─── Chrome extensions ─────────────────────────────────────

export interface ExtensionPlan {
  /** 確認存在、要交給 Chromium 載入的擴充目錄（去重、保序）。 */
  paths: string[];
  /** 有指定但目錄不存在的（呼叫端印警告，不中斷錄製）。 */
  missing: string[];
  /** --no-extensions：完全不載擴充，也不回報 missing。 */
  disabled: boolean;
}

/**
 * 決定這次錄製要載入哪些 Chrome 擴充。
 *
 * **預設不載任何擴充。** vox-trace 是分發給團隊的工具，預設值不能指向任何特定
 * 個人機器上才有的擴充路徑——否則其他人每次錄製都會看到一則找不到擴充的警告，
 * 而那個擴充他們根本沒有（同類問題見 ax-marketplace 的 org-portability 教訓）。
 *
 * 要載入一律明說：
 * - `VOX_EXTENSIONS`：冒號分隔的目錄清單（個人化的建議落點，設一次長期有效）。
 * - `--extension <path>`：可重複，接在 env 清單之後。
 * - `--no-extensions`：一律不載（即使設了 env），用於複現「沒有擴充時的行為」。
 *
 * `exists` 由呼叫端注入（正式碼傳 fs.existsSync），純函式才能被單元測試。
 * 指定的目錄不存在不是錯誤——記進 `missing` 讓呼叫端印警告，錄製照常進行。
 *
 * `homeDir` 目前未用到，保留參數是為了讓呼叫端維持一致的注入形式（未來若支援
 * `~` 展開會用到）。
 */
export function parseExtensionConfig(
  args: string[],
  env: Record<string, string | undefined>,
  exists: (p: string) => boolean,
  homeDir: string,
): ExtensionPlan {
  if (hasFlag(args, '--no-extensions')) {
    return { paths: [], missing: [], disabled: true };
  }

  const fromEnv = (env.VOX_EXTENSIONS || '').split(':').filter(Boolean);

  // --extension 可重複，逐一掃 args（getArg 只取第一個）
  const fromFlags: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--extension') fromFlags.push(args[i + 1]);
  }

  const paths: string[] = [];
  const missing: string[] = [];
  for (const p of [...fromEnv, ...fromFlags]) {
    if (paths.includes(p) || missing.includes(p)) continue;
    (exists(p) ? paths : missing).push(p);
  }
  return { paths, missing, disabled: false };
}

/**
 * `--open <url>`（可重複）：除了 --base-url 的第一個分頁，再各開一個分頁。
 *
 * 用於「前台 + 後台一起開」這種對照測試——新分頁走 context 的 'page' 事件，
 * 追蹤與錄影都自動接上。值以 `--` 開頭時視為使用者漏帶 URL，忽略不當成網址。
 */
export function parseExtraUrls(args: string[]): string[] {
  const urls: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== '--open') continue;
    const value = args[i + 1];
    if (value.startsWith('--') || urls.includes(value)) continue;
    urls.push(value);
  }
  return urls;
}

interface StorageStateOrigin {
  origin: string;
  localStorage?: { name: string; value: string }[];
}
interface StorageStateLike {
  cookies?: unknown[];
  origins?: StorageStateOrigin[];
}

/**
 * 把 storageState 的 localStorage 轉成 addInitScript 用的 script 字串（每個 origin 一段）。
 *
 * `launchPersistentContext` 沒有 `storageState` 選項（那是 `newContext` 才有的），
 * 但載入擴充**必須**用 persistent context——所以 `--load-storage` 的 localStorage
 * 部分改由 init script 灌回去（cookies 那半走 context.addCookies()）。
 *
 * 值一律走 JSON.stringify 編碼再由頁面 JSON.parse 還原，避免引號/換行破壞注入的
 * 程式碼；`<` 另外逸成 `<`（JSON.stringify 不碰它），這樣 script 字串即使被
 * 塞進 HTML `<script>` 也不會被 `</script>` 提前截斷。
 */
export function buildStorageInitScripts(state: StorageStateLike): string[] {
  const scripts: string[] = [];
  for (const o of state.origins ?? []) {
    const items = o.localStorage ?? [];
    if (items.length === 0) continue;
    const payload = JSON.stringify(JSON.stringify(items)).replace(/</g, '\\u003c');
    scripts.push(
      `if (location.origin === ${JSON.stringify(o.origin)}) {\n` +
      `  try {\n` +
      `    for (const it of JSON.parse(${payload})) localStorage.setItem(it.name, it.value);\n` +
      `  } catch (e) {}\n` +
      `}`,
    );
  }
  return scripts;
}
