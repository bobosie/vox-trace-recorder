/**
 * nl-upload — 錄製收尾時自動把證據包送回 NL server。
 *
 * ## 為什麼要有這支（不是「方便一點」而已）
 *
 * 原本 NL 這條線的上傳是人工的：錄完之後要另外跑 `vox-nl-ship <session_dir>`。
 * 那條路在 NL 同仁的實際環境是斷的，斷在兩個地方：
 *
 *   1. **錄製與上傳在不同的作業系統環境**。recorder-bootstrap.ps1 刻意擋 WSL
 *      （錄製要 GUI），所以錄製跑在 Windows 原生 PowerShell；而 vox-nl-ship 是
 *      bash 腳本，Windows 原生沒有 bash。同仁錄完，手上只有一包檔案。
 *   2. **中文 session 名一律被 server 退**。sanitizeSessionName() 刻意保留中文
 *      （目錄名要給人看），但 server 的 X-Vox-Session 只收
 *      `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`。用中文議題名錄的那些，連手動補跑
 *      vox-nl-ship 都會被自己的名稱檢查擋下來。
 *
 * 這支把上傳搬進錄製器本體（Node，跨平台），兩個斷點一起消掉。
 *
 * ## 實作上刻意不依賴外部工具
 *
 * tar.gz 是純 Node 產生的（USTAR + zlib），沒有 spawn 系統 `tar`。理由是這支
 * 主要跑在我手上沒有的平台（Windows 原生）——`tar.exe` 的存在、版本、對
 * `C:\...` 路徑冒號的處理都是我驗證不到的變因，而失敗形態是「打包出壞掉的包
 * 或整個跳過」。純 Node 的行為在三個平台完全一致，而且可以單元測試。
 *
 * ## 開關語意
 *
 * - 找得到 NL 設定（NL_RECALL_SERVER / NL_DEBUG_SERVER）才會啟用。AX 那條線
 *   走 Google Drive，機器上沒有這個設定 → 這支自動靜默停用，不會誤傳。
 * - `NL_AUTO_UPLOAD=0`（環境變數或 ~/.config/nl-workflow/env）關掉。
 * - 上傳失敗一律不影響錄製產出，只印出補跑指令。
 *
 * ⚠️ 錄影會拍到畫面上的所有資料，這支會把整包送到 NL server。含客戶資料的
 *    畫面開錄前先確認可不可以往外傳——錄製器啟動時會把這件事印在橫幅上。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import * as http from 'http';
import * as https from 'https';
import { homeDir } from './platform';

/** server 端 X-Vox-Session 的驗證規則，與 server.py / vox-nl-ship 三處必須一致。 */
export const UPLOAD_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** NL workflow 安裝時寫的設定檔（install-hooks.sh 寫 server/token 進這裡）。 */
export function nlEnvFilePath(): string {
  return path.join(homeDir(), '.config', 'nl-workflow', 'env');
}

export interface UploadConfig {
  enabled: boolean;
  server: string;
  token: string;
  /** 沒啟用時的原因，給呼叫端決定要印什麼。 */
  reason?: 'no-nl-config' | 'opt-out';
}

/**
 * 解析 KEY=VALUE 形式的設定檔。
 *
 * 刻意自己寫而不用 dotenv：這個檔是 install-hooks.sh 用固定格式寫出來的，
 * 不需要引號展開／變數插值那些語意，少一層行為差異。
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue; // 沒有 =，或 = 在開頭（空鍵）——都不是設定
    const key = line.slice(0, eq).trim();
    // 只 trim 不切：token 本身可能含 '='（見測試）
    const value = line.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/**
 * 決定這次錄製要不要自動上傳、傳去哪。
 *
 * 優先序與 vox-nl-ship 對齊：專用的 NL_DEBUG_* 蓋過通用的 NL_RECALL_*，
 * 而環境變數蓋過設定檔（臨時改目的地不必動檔案）。
 */
export function resolveUploadConfig(opts: {
  env: Record<string, string | undefined>;
  envFileText: string | null;
}): UploadConfig {
  const file = opts.envFileText ? parseEnvFile(opts.envFileText) : {};
  // 空字串＝沒設，要 fallback 回設定檔。不能用 `env[key] ?? file[key]`：
  // shell/launchd 裡 `export NL_RECALL_SERVER="$SOMETHING"` 而 SOMETHING 未設時，
  // 環境變數是**空字串**而不是 undefined，`??` 不會 fallback → 設定檔裡的有效值
  // 被空字串蓋掉 → 自動上傳靜默停用。那個失敗形態跟「根本沒做這個功能」
  // 一模一樣（連啟動橫幅都不會印），是最難發現的一種。
  const pick = (key: string): string => {
    const fromEnv = (opts.env[key] ?? '').trim();
    return fromEnv || (file[key] ?? '').trim();
  };

  const server = (pick('NL_DEBUG_SERVER') || pick('NL_RECALL_SERVER')).replace(/\/+$/, '');
  const token = pick('NL_DEBUG_TOKEN') || pick('NL_RECALL_TOKEN');

  if (!server) return { enabled: false, server: '', token: '', reason: 'no-nl-config' };

  const auto = pick('NL_AUTO_UPLOAD');
  if (auto === '0' || auto.toLowerCase() === 'false') {
    return { enabled: false, server, token, reason: 'opt-out' };
  }
  return { enabled: true, server, token };
}

/** 讀 NL 設定檔，不存在／讀不到都回 null（不是錯誤，代表這台不是 NL 環境）。 */
export function readNlEnvFile(p = nlEnvFilePath()): string | null {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

const MAX_UPLOAD_NAME = 64;

/**
 * 把 session 名轉成 server 收得下的名字。
 *
 * 目標不只是「合法」，還要**人在 /data/nl-debug 底下看得出這是哪一場**：
 * 保留原名裡的 ASCII 片段，非 ASCII 的部分用時間戳補位。
 */
export function toUploadName(sessionName: string, startedAt: Date): string {
  if (UPLOAD_NAME_RE.test(sessionName)) return sessionName;

  const stamp = [
    startedAt.getUTCFullYear(),
    String(startedAt.getUTCMonth() + 1).padStart(2, '0'),
    String(startedAt.getUTCDate()).padStart(2, '0'),
    '-',
    String(startedAt.getUTCHours()).padStart(2, '0'),
    String(startedAt.getUTCMinutes()).padStart(2, '0'),
    String(startedAt.getUTCSeconds()).padStart(2, '0'),
  ].join('');

  // 非法字元換成 '-'，再把連續的 '-' 收合，兩端修掉
  const kept = sessionName
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');

  const base = kept ? `${kept}-${stamp}` : `rec-${stamp}`;
  // 首字元必須是英數
  const headFixed = /^[A-Za-z0-9]/.test(base) ? base : `r${base}`;
  const clipped = headFixed.slice(0, MAX_UPLOAD_NAME).replace(/[-._]+$/, '');
  // 極端情況（截完只剩非英數開頭）再兜一次底
  return UPLOAD_NAME_RE.test(clipped) ? clipped : `rec-${stamp}`;
}

// ─── tar.gz（USTAR，純 Node）────────────────────────────────

export interface TarEntry {
  /** 包內路徑，用 '/' 分隔，第一段是 session 目錄名。 */
  path: string;
  body: Buffer;
  mtimeMs?: number;
}

const BLOCK = 512;

function writeOctal(buf: Buffer, value: number, offset: number, len: number): void {
  // USTAR 數值欄位：八進位、右靠、前面補 0、最後一個 byte 是 NUL
  buf.write(value.toString(8).padStart(len - 1, '0'), offset, len - 1, 'ascii');
  buf[offset + len - 1] = 0;
}

/**
 * 切 ustar 的 name(100) / prefix(155)。
 * 兩個欄位都塞不下就拋錯——靜默截斷會產出解開後檔名不對的包，
 * 那種壞法要到 server 上才看得出來。
 */
function splitPath(p: string): { name: string; prefix: string } {
  if (Buffer.byteLength(p) <= 100) return { name: p, prefix: '' };
  const parts = p.split('/');
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join('/');
    const name = parts.slice(i).join('/');
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) {
      return { name, prefix };
    }
  }
  throw new Error(`路徑太長，ustar 的 name+prefix 放不下：${p}`);
}

function tarHeader(entry: TarEntry): Buffer {
  const h = Buffer.alloc(BLOCK);
  const { name, prefix } = splitPath(entry.path);

  h.write(name, 0, 100, 'utf-8');
  writeOctal(h, 0o644, 100, 8);           // mode
  writeOctal(h, 0, 108, 8);               // uid
  writeOctal(h, 0, 116, 8);               // gid
  writeOctal(h, entry.body.length, 124, 12);
  writeOctal(h, Math.floor((entry.mtimeMs ?? Date.now()) / 1000), 136, 12);
  h.fill(0x20, 148, 156);                 // checksum 欄位先填空白再算
  h[156] = 0x30;                          // typeflag '0' = 一般檔
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  if (prefix) h.write(prefix, 345, 155, 'utf-8');

  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  // 校驗和格式：6 位八進位 + NUL + 空白
  h.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  h[154] = 0;
  h[155] = 0x20;
  return h;
}

/** 把一組檔案打成 tar.gz。 */
export function buildTarGz(entries: TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const e of entries) {
    chunks.push(tarHeader(e), e.body);
    const pad = (BLOCK - (e.body.length % BLOCK)) % BLOCK;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(BLOCK * 2)); // 結尾兩個空區塊
  return zlib.gzipSync(Buffer.concat(chunks));
}

// ─── 收集 session 目錄 ──────────────────────────────────────

/**
 * 遞迴收集 session 目錄下所有檔案，包內路徑以 <包內根目錄名>/ 開頭
 * （與 vox-nl-ship 的 `tar -C 父層 <name>` 解開後結構一致）。
 */
export function collectSessionFiles(sessionDir: string, rootName: string): TarEntry[] {
  const out: TarEntry[] = [];
  const walk = (dir: string, rel: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      // 包內路徑一律用 '/'：Windows 的 path.join 會給 '\'，那在 tar 裡是檔名的一部分
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(abs, relPath);
      } else if (ent.isFile()) {
        // 停止檔是收尾用的旁路訊號，不是證據
        if (ent.name === '.stop-recording') continue;
        const st = fs.statSync(abs);
        out.push({ path: `${rootName}/${relPath}`, body: fs.readFileSync(abs), mtimeMs: st.mtimeMs });
      }
    }
  };
  walk(sessionDir, '');
  return out;
}

// ─── 上傳 ───────────────────────────────────────────────────

export interface UploadResult {
  ok: boolean;
  status: number;
  /** server 回的 JSON（成功時含 stored / files / bytes）。 */
  body: string;
  /** true 代表值得稍後重試（網路或 5xx），對應 vox-nl-ship 的 exit 75。 */
  retryable: boolean;
  error?: string;
}

/**
 * POST 證據包到 <server>/debug/upload。
 *
 * 用 node:http/https 而不是 fetch：錄影器支援 Node 18，fetch 在 18 還是
 * 實驗性的（會噴 ExperimentalWarning 到 stderr）。這支的輸出是同仁會看到的，
 * 不要混進看起來像壞掉的警告。
 */
export function uploadTarGz(opts: {
  server: string;
  token: string;
  uploadName: string;
  tgz: Buffer;
  timeoutMs?: number;
}): Promise<UploadResult> {
  return new Promise(resolve => {
    let url: URL;
    try {
      url = new URL(`${opts.server}/debug/upload`);
    } catch (e: any) {
      return resolve({ ok: false, status: 0, body: '', retryable: false, error: `NL server 位址無法解析：${opts.server}` });
    }
    const mod = url.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = {
      'X-Vox-Session': opts.uploadName,
      'Content-Type': 'application/gzip',
      'Content-Length': String(opts.tgz.length),
    };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

    const req = mod.request(
      { method: 'POST', hostname: url.hostname, port: url.port, path: url.pathname, headers },
      res => {
        const bufs: Buffer[] = [];
        res.on('data', c => bufs.push(c));
        res.on('end', () => {
          const status = res.statusCode || 0;
          resolve({
            ok: status === 200,
            status,
            body: Buffer.concat(bufs).toString('utf-8').trim(),
            // 429/5xx 是「稍後再試」。422 也算——server 回 422 代表它收到的
            // 位元組數對得上 Content-Length、但解不開 gzip，那是傳輸過程壞掉
            // （2026-09-04 實測：248MB 的包在 server 落地成 90MiB 整、解包 EOFError，
            //  同一包重傳就成功）。這種「送錯了」不是內容錯，重試有意義。
            retryable: status === 429 || status === 422 || status >= 500,
          });
        });
      },
    );
    req.setTimeout(opts.timeoutMs ?? 600_000, () => {
      req.destroy(new Error('上傳逾時'));
    });
    req.on('error', err => {
      resolve({ ok: false, status: 0, body: '', retryable: true, error: err.message });
    });
    req.end(opts.tgz);
  });
}

// ─── 對外主流程 ─────────────────────────────────────────────

/**
 * 錄製收尾時呼叫：判斷該不該傳、打包、上傳，全程把狀況印給使用者看。
 *
 * 永遠不拋錯——錄製產出已經在磁碟上了，上傳失敗不該讓錄製器以非零結束，
 * 那會讓同仁以為整場錄製壞了。
 */
export async function autoUploadSession(opts: {
  sessionDir: string;
  sessionName: string;
  startedAt: Date;
  env?: Record<string, string | undefined>;
  envFileText?: string | null;
  log?: (msg: string) => void;
}): Promise<UploadResult | null> {
  const log = opts.log ?? console.log;
  const cfg = resolveUploadConfig({
    env: opts.env ?? process.env,
    envFileText: opts.envFileText !== undefined ? opts.envFileText : readNlEnvFile(),
  });

  if (!cfg.enabled) {
    if (cfg.reason === 'opt-out') {
      log('\n📤 自動上傳已關閉（NL_AUTO_UPLOAD=0）。要手動送：');
      log(`   NL_AUTO_UPLOAD=1 npx tsx src/upload-session.ts ${opts.sessionName}`);
    }
    // no-nl-config：這台不是 NL 環境（例如 AX 版），靜默略過才對
    return null;
  }

  const uploadName = toUploadName(opts.sessionName, opts.startedAt);
  log('\n📤 上傳證據包到 NL server…');
  if (uploadName !== opts.sessionName) {
    // 名字被改過一定要講。server 上的落點跟本機目錄名不一樣，
    // 不講的話同仁回報「我錄的那支叫 XXX」而沒有人找得到。
    log(`   ℹ️  session 名含 server 不收的字元，這次以「${uploadName}」上傳（本機目錄名不變）`);
  }

  let tgz: Buffer;
  try {
    const files = collectSessionFiles(opts.sessionDir, uploadName);
    if (files.length === 0) {
      log('   ⚠️  session 目錄裡沒有檔案，略過上傳');
      return null;
    }
    tgz = buildTarGz(files);
    log(`   ${files.length} 個檔案 → ${formatBytes(tgz.length)}（壓縮後）`);
  } catch (e: any) {
    log(`   ⚠️  打包失敗，略過上傳：${e.message}`);
    log(`   證據包還在本機：${opts.sessionDir}`);
    return null;
  }

  let res = await uploadTarGz({ server: cfg.server, token: cfg.token, uploadName, tgz });

  // 大包會被中途截斷而 server 仍回 200 是不可能的（它會 400 truncated），
  // 但 422 會發生。可重試的失敗自動再送一次——這種包動輒幾百 MB，
  // 讓使用者自己去看訊息、自己重跑，等於預設會漏掉。
  if (!res.ok && res.retryable) {
    log(`   ⚠️  第一次沒成功（${res.status || res.error}），重試一次…`);
    res = await uploadTarGz({ server: cfg.server, token: cfg.token, uploadName, tgz });
  }

  if (res.ok) {
    // 不只看 200——比對 server 回報的位元組數與本地送出的是否一致。
    // 「回 200」和「存下來的東西是完整的」是兩件事。
    let mismatch = '';
    try {
      const j = JSON.parse(res.body);
      if (typeof j.bytes === 'number' && j.bytes !== tgz.length) {
        mismatch = `server 收到 ${j.bytes} bytes，本地送出 ${tgz.length} bytes`;
      }
    } catch { /* 回應不是 JSON 就不做這層檢查 */ }
    if (mismatch) {
      log(`   ⚠️  上傳回報成功，但大小對不上：${mismatch}`);
      log(`   證據包還在本機：${opts.sessionDir}`);
      log(`   請補送：npx tsx src/upload-session.ts ${opts.sessionName}`);
      return { ...res, ok: false, retryable: true, error: mismatch };
    }
    log(`   ✅ 已上傳：${res.body}`);
    return res;
  }

  if (res.status === 401) {
    log('   ⚠️  上傳被拒（401）：NL token 不對或過期。重跑一次 NL workflow 安裝可換新的。');
  } else if (res.status === 0) {
    log(`   ⚠️  連不到 ${cfg.server}（沒連 NL VPN？）：${res.error ?? ''}`);
  } else {
    log(`   ⚠️  上傳失敗（HTTP ${res.status}）：${res.body || res.error || ''}`);
  }
  log(`   證據包還在本機：${opts.sessionDir}`);
  log(`   連上 VPN 後補送：npx tsx src/upload-session.ts ${opts.sessionName}`);
  return res;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}
