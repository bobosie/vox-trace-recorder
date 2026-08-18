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
