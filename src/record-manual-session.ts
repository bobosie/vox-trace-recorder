/**
 * Record Manual Session
 *
 * Opens a Playwright-controlled browser for manual operation.
 * Captures trace, network requests, screenshots, and video.
 *
 * Usage:
 *   npx tsx src/record-manual-session.ts [options]
 *
 * Options:
 *   --load-storage <path>   Load existing storage state (cookies/localStorage)
 *   --name <session-name>   Custom session name (default: ISO timestamp)
 *   --base-url <url>        Override base URL
 *   --codegen               Hint to use codegen in Playwright Inspector
 *   --extension <path>      載入指定的 Chrome 擴充目錄（可重複）
 *   --no-extensions         一律不載擴充（即使設了 VOX_EXTENSIONS）
 *   --open <url>            額外開一個分頁到該網址（可重複，如前台+後台對照）
 *
 * 擴充：**預設不載**。要載就設 VOX_EXTENSIONS（冒號分隔的目錄清單）或用
 * --extension。載擴充需要 persistent context，所以本檔用
 * chromium.launchPersistentContext（不是 launch + newContext）。
 */

import { chromium, Request, Response } from 'playwright';
import { execSync, spawn, spawnSync, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { transcribe } from './transcribe';
import { DomRecorder } from './dom-recorder';
import { parseScreenshotConfig, parsePmMode, shouldRunPostProcessing, parseRecorder, sanitizeSessionName, parseExtensionConfig, buildStorageInitScripts, parseExtraUrls, shouldAutoUpload } from './shared/record-config';
import { waitForStopFile } from './shared/stop-signal';
import { hasCommand, isWindows } from './shared/platform';
import { autoUploadSession, resolveUploadConfig, readNlEnvFile } from './shared/nl-upload';

// ─── CLI Argument Parsing ──────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

const LOAD_STORAGE = getArg('--load-storage');
const SESSION_NAME_RAW = getArg('--name') || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const SESSION_NAME = sanitizeSessionName(SESSION_NAME_RAW);
const BASE_URL = getArg('--base-url') || process.env.BASE_URL || '';
const USE_CODEGEN = hasFlag('--codegen');
const AUTO_TEST = hasFlag('--auto-test');
const AUTO_SCRIPT = getArg('--script');
const NO_AUDIO = hasFlag('--no-audio');
const EXTRA_URLS = parseExtraUrls(args);
const SCREENSHOT_CFG = parseScreenshotConfig(args);
const SCREENSHOTS_ENABLED = SCREENSHOT_CFG.enabled;
const PERIODIC_SCREENSHOTS = SCREENSHOT_CFG.periodicEnabled;
const SCREENSHOT_INTERVAL_SEC = SCREENSHOT_CFG.intervalSec;
const SCREENSHOT_FULL_PAGE = SCREENSHOT_CFG.fullPage;
const PM_MODE = parsePmMode(args, process.env);
const RUN_POST_PROCESSING = shouldRunPostProcessing(PM_MODE);
const AUTO_UPLOAD = shouldAutoUpload(args, PM_MODE);

// 錄製者名字：讀 repo 根的 .pm-config.json（VOX_PM_CONFIG 可覆蓋路徑），
// 有值就寫進 metadata.recorder；缺檔／壞 JSON 靜默省略。
function readRecorder(): string | undefined {
  const configPath = process.env.VOX_PM_CONFIG || path.resolve(process.cwd(), '.pm-config.json');
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch {
    raw = null;
  }
  return parseRecorder(raw);
}
const RECORDER = readRecorder();


// ─── Process cleanup (orphan rec protection) ──────────────

let recProc: ChildProcess | null = null;
let periodicInterval: ReturnType<typeof setInterval> | null = null;
process.on('exit', () => { if (periodicInterval) clearInterval(periodicInterval); recProc?.kill('SIGINT'); });
process.on('SIGINT', () => { if (periodicInterval) clearInterval(periodicInterval); recProc?.kill('SIGINT'); process.exit(130); });
process.on('SIGTERM', () => { if (periodicInterval) clearInterval(periodicInterval); recProc?.kill('SIGINT'); process.exit(143); });

// ─── Directory Setup ───────────────────────────────────────

// 輸出根目錄：預設 repo 內 recordings/；VOX_OUTPUT_DIR 可覆蓋（PM 模式錄到
// ~/vox-pm-recordings，供 queue worker ship）。
const RECORDINGS_DIR = process.env.VOX_OUTPUT_DIR
  ? path.resolve(process.env.VOX_OUTPUT_DIR)
  : path.resolve(process.cwd(), 'recordings');
const SESSION_DIR = path.join(RECORDINGS_DIR, SESSION_NAME);
const SCREENSHOTS_DIR = path.join(SESSION_DIR, 'screenshots');
// graceful-stop：agent/人放這個檔 = 等同按 Resume 收尾（見 shared/stop-signal.ts）。
const STOP_FILE = path.join(SESSION_DIR, '.stop-recording');
// 讓 `start.sh stop`（不帶 session 名）能找到當前錄製中的 session。
const ACTIVE_POINTER = path.join(RECORDINGS_DIR, '.active-session');
// 旁路 pid 檔：供 PM 佇列 worker 辨識「殘留指標」——錄製被 SIGKILL/斷電中止時，
// 下方 exit handler 不會執行、.active-session 殘留，worker 靠這個 pid 是否存活
// 判斷該 crash session 是否還在錄（見 pipeline-pm vox_is_active_recording）。
// 內容只放 PID，不動 .active-session 的格式（start.sh / 本檔的讀取端維持原樣）。
const ACTIVE_PID_FILE = ACTIVE_POINTER + '.pid';

// ─── Types ─────────────────────────────────────────────────

interface NetworkEntry {
  timestamp: string;
  method: string;
  url: string;
  status: number;
  statusText: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  responseHeaders: Record<string, string>;
  responseBody?: string;
  duration?: number;
  resourceType: string;
  tabIndex: number;
}

/**
 * WebSocket 不會出現在 network.json —— `page.on('response')` 只看得到 HTTP。
 * 走 STOMP/socket 的產品（下注結果、餘額變動、聊天都在 topic 上）少了這份就等於沒錄到
 * 業務主幹，而且畫面看起來一切正常，不會有任何缺漏的跡象。
 */
interface WsSocket {
  url: string;
  tabIndex: number;
  openedAt: string;
  closedAt?: string;
  sent: number;
  received: number;
}

interface WsFrame {
  timestamp: string;
  socketIndex: number;
  dir: 'sent' | 'received';
  /** STOMP 的命令與 destination，方便不解析全文就能看出訂了哪些 topic。 */
  op?: string;
  destination?: string;
  payload: string;
}

interface SessionMetadata {
  sessionId: string;
  startTime: string;
  endTime?: string;
  /**
   * audio.wav 起始時間相對於影片起始（context 建立）的偏移，毫秒。
   * sox `rec` 在頁面載入後才啟動，晚於影片開始；reconstruct --with-audio
   * 用此值當 mux offset 的預設推估。
   */
  audioStartOffsetMs?: number;
  baseUrl: string;
  loadedStorage?: string;
  urls: Array<{ timestamp: string; url: string; title: string; tabIndex: number }>;
  screenshotCount: number;
  networkEntryCount: number;
  wsSocketCount?: number;
  wsFrameCount?: number;
  tabCount: number;
  periodicScreenshotCount: number;
  codegenEnabled: boolean;
  /** PM 模式：本機不做重處理，raw 錄製 ship 給 Studio。 */
  pmMode: boolean;
  /** 錄製者名字（來自 .pm-config.json），未設定時省略。 */
  recorder?: string;
  /** 收尾時量到的 audio.wav 峰值振幅（0~1）。量不到時省略。 */
  audioMaxAmplitude?: number;
  /** audio.wav 是否為數位靜音（見 measureAudioPeak 的說明）。 */
  audioSilent?: boolean;
  errors: Array<{ timestamp: string; message: string; tabIndex?: number }>;
}

/** 低於此峰值視為數位靜音：16-bit 的 1 LSB 是 0.0000305，人聲錄音至少 0.01 量級。 */
const AUDIO_SILENT_THRESHOLD = 0.001;
/** 低於此峰值雖非全零但過小，轉寫品質會很差，值得提醒。 */
const AUDIO_QUIET_THRESHOLD = 0.01;

/**
 * 量 audio.wav 的峰值振幅。
 *
 * 麥克風沒有 TCC 授權時 CoreAudio **不會報錯**，而是照常 StartIO 並送出全零
 * buffer——檔案長度、取樣率、WAV header 全都正常，只有內容是靜音。從 sshd 或
 * 無 responsible app 的背景進程啟動 sox 就會踩到（2026-08-27 實例：整場 6 分鐘
 * 口述錄成 -91 dB，直到 Studio 端解析才發現）。收尾量一次才擋得住。
 *
 * @returns 峰值振幅 0~1；sox 不在或解析失敗回 null。
 */
function measureAudioPeak(wavPath: string): number | null {
  const r = spawnSync('sox', [wavPath, '-n', 'stat'], { encoding: 'utf-8' });
  // sox stat 把統計寫到 stderr，且即使成功 status 也可能非 0，一律以能否解析為準
  const m = /Maximum amplitude:\s*([0-9.eE+-]+)/.exec(r.stderr || '');
  if (!m) return null;
  const peak = parseFloat(m[1]);
  return Number.isFinite(peak) ? peak : null;
}

// ─── Main ──────────────────────────────────────────────────

async function main() {
  console.log('🎬 vox-trace — Manual Session Recorder\n');
  console.log(`📁 Session: ${SESSION_NAME}`);
  console.log(`📍 Base URL: ${BASE_URL || '(none — will open about:blank)'}`);
  console.log(`💾 Output: ${SESSION_DIR}`);
  if (LOAD_STORAGE) console.log(`🔐 Storage State: ${LOAD_STORAGE}`);
  if (USE_CODEGEN) console.log(`📝 Codegen: enabled`);
  if (PM_MODE) console.log(`🏭 PM mode: enabled (local post-processing skipped — Studio handles it)`);

  // 上傳目的地在**開錄前**就講清楚，不要等收尾才說。錄影會拍到畫面上的所有
  // 東西，「這一場會不會被送出去」是使用者在按下錄製前就該知道的事——收尾才
  // 告知，等於資料已經產生了才給選擇。
  if (AUTO_UPLOAD) {
    const cfg = resolveUploadConfig({ env: process.env, envFileText: readNlEnvFile() });
    if (cfg.enabled) {
      console.log(`📤 收尾後自動上傳到 NL server：${cfg.server}`);
      console.log(`   這一場的畫面、網路請求都會送出去。不要上傳的話現在中止，改用 --no-upload 重錄。`);
    }
  }

  // Check if rec (sox) is available for microphone recording
  // sox 的 rec。Windows 上 sox 也有 port（rec.exe），所以用跨平台的查法而不是 POSIX which，
  // 裝了就能用；沒裝就降級成無語音錄製（畫面/trace/操作紀錄都不受影響）。
  const hasRec = !NO_AUDIO && hasCommand('rec');
  if (NO_AUDIO) {
    console.log('🎤 Microphone: disabled (--no-audio)');
  } else if (hasRec) {
    console.log('🎤 Microphone: recording');
  } else {
    const hint = isWindows
      ? 'install sox for Windows and make sure rec.exe is in PATH'
      : process.platform === 'linux'
        ? 'install: apt install sox'
        : 'install: brew install sox';
    console.warn(`🎤 Microphone: disabled (rec not found — ${hint})`);
  }
  console.log('');

  // Create directories. 截圖全關時連 screenshots/ 都不建（省 mkdir），
  // 但 session 目錄仍需存在給 video/trace/metadata 落地。
  if (SCREENSHOTS_ENABLED) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  } else {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }

  // 清掉可能殘留的 stop sentinel（同名 session 重錄時），並寫下 active 指標，
  // 讓 `start.sh stop`（不帶名）能定位到這次錄製。指標在收尾時清除。
  try { fs.rmSync(STOP_FILE, { force: true }); } catch {}
  // 已有別的 session 在錄 → 提醒使用者「不帶名的 stop」會停到最後啟動的這個。
  try {
    const existing = fs.readFileSync(ACTIVE_POINTER, 'utf-8').trim();
    if (existing && existing !== SESSION_NAME) {
      console.warn(isWindows
        ? `⚠️  另一個錄製 session 進行中：${existing}。要停哪一個就對它建停止檔：New-Item -ItemType File -Force "recordings\\<session>\\.stop-recording"（Windows 沒有 start.sh）。`
        : `⚠️  另一個錄製 session 進行中：${existing}。'start.sh stop'（不帶名）將停到最後啟動的 ${SESSION_NAME}；要停前者請 'start.sh stop ${existing}'。`);
    }
  } catch {}
  try { fs.writeFileSync(ACTIVE_POINTER, SESSION_NAME); } catch {}
  try { fs.writeFileSync(ACTIVE_PID_FILE, String(process.pid)); } catch {}
  process.on('exit', () => { try { if (fs.readFileSync(ACTIVE_POINTER, 'utf-8') === SESSION_NAME) { fs.rmSync(ACTIVE_POINTER, { force: true }); fs.rmSync(ACTIVE_PID_FILE, { force: true }); } } catch {} });

  // ─── Validate storage state ────────────────────────────

  let storageStatePath: string | undefined;
  if (LOAD_STORAGE) {
    const resolved = path.resolve(LOAD_STORAGE);
    if (fs.existsSync(resolved)) {
      storageStatePath = resolved;
      console.log(`✅ Storage state found: ${resolved}`);
    } else {
      console.warn(`⚠️  Storage state not found: ${resolved}`);
      console.warn(`   Starting with empty session`);
    }
  }

  // ─── Launch browser ────────────────────────────────────

  // 用 persistent context（而非 launch + newContext）：載入 Chrome 擴充只有這條路。
  // 擴充預設不載，由 VOX_EXTENSIONS / --extension 指定（見 parseExtensionConfig）。
  // userDataDir 每次用臨時目錄 → profile 仍是乾淨的，與舊行為一致。
  const extPlan = parseExtensionConfig(args, process.env, fs.existsSync, os.homedir());
  for (const missing of extPlan.missing) {
    console.warn(`⚠️  擴充目錄不存在，略過：${missing}`);
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vox-trace-profile-'));
  const launchArgs = ['--start-maximized'];
  if (extPlan.paths.length > 0) {
    // 兩個旗標都要給：--disable-extensions-except 是白名單，少了它 Chromium
    // 會忽略 --load-extension。
    launchArgs.push(`--disable-extensions-except=${extPlan.paths.join(',')}`);
    launchArgs.push(`--load-extension=${extPlan.paths.join(',')}`);
    launchArgs.push('--no-first-run', '--no-default-browser-check');
  }

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: null as any, // Use actual window size
    args: launchArgs,
    recordVideo: {
      dir: SESSION_DIR,
      size: { width: 1280, height: 720 },
    },
  });

  if (extPlan.disabled) {
    console.log('🧩 擴充：已用 --no-extensions 關閉');
  } else if (extPlan.paths.length > 0) {
    console.log(`🧩 擴充已載入：${extPlan.paths.map(p => path.basename(p)).join(', ')}`);
  }

  // persistent context 沒有 storageState 選項——cookies 直接灌，localStorage 走
  // init script（見 buildStorageInitScripts）。
  if (storageStatePath) {
    try {
      const state = JSON.parse(fs.readFileSync(storageStatePath, 'utf-8'));
      if (Array.isArray(state.cookies) && state.cookies.length > 0) {
        await context.addCookies(state.cookies);
      }
      for (const script of buildStorageInitScripts(state)) {
        await context.addInitScript({ content: script });
      }
      const originCount = Array.isArray(state.origins) ? state.origins.length : 0;
      console.log(`🔐 Storage state 已套用：${state.cookies?.length ?? 0} cookies / ${originCount} origins`);
    } catch (err: any) {
      console.warn(`⚠️  Storage state 套用失敗（將以空 session 開始）：${err.message}`);
    }
  }

  // ─── Start trace recording ────────────────────────────

  await context.tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true,
  });

  // ─── Shared state for multi-tab recording ─────────────

  const networkEntries: NetworkEntry[] = [];
  const wsSockets: WsSocket[] = [];
  const wsFrames: WsFrame[] = [];
  /** 一場實測 85 秒就收 1249 個 frame；設上限免得長時間走查把檔案撐爆。計數不受此限。 */
  const WS_FRAME_CAP = 20_000;
  const requestTimings = new Map<string, number>();

  const STATIC_EXTENSIONS = [
    '.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg',
    '.woff', '.woff2', '.ttf', '.eot', '.ico', '.map', '.webp',
  ];

  function isStaticResource(url: string): boolean {
    const urlLower = url.toLowerCase();
    return STATIC_EXTENSIONS.some(ext => urlLower.includes(ext));
  }

  // 影片起始基準（context 已於上方建立並開始 recordVideo）
  const videoStartMs = Date.now();

  const metadata: SessionMetadata = {
    sessionId: SESSION_NAME,
    startTime: new Date(videoStartMs).toISOString(),
    baseUrl: BASE_URL || 'about:blank',
    loadedStorage: LOAD_STORAGE || undefined,
    urls: [],
    screenshotCount: 0,
    networkEntryCount: 0,
    tabCount: 0,
    periodicScreenshotCount: 0,
    codegenEnabled: USE_CODEGEN,
    pmMode: PM_MODE,
    ...(RECORDER ? { recorder: RECORDER } : {}),
    errors: [],
  };

  let screenshotCounter = 0;
  let periodicScreenshotCount = 0;
  const pages: import('playwright').Page[] = [];
  const activePages: Array<{ page: import('playwright').Page; tabIndex: number }> = [];
  let nextTabIndex = 0;

  // ─── DOM Event Recorder ──────────────────────────────
  const domRecorder = new DomRecorder();

  // ─── Per-page tracking setup ──────────────────────────

  function setupPageTracking(pg: import('playwright').Page, tabIndex: number) {
    pg.on('request', (request: Request) => {
      requestTimings.set(`${tabIndex}:${request.url()}`, Date.now());
    });

    pg.on('websocket', (ws) => {
      const socketIndex = wsSockets.length;
      const rec: WsSocket = {
        url: ws.url(),
        tabIndex,
        openedAt: new Date().toISOString(),
        sent: 0,
        received: 0,
      };
      wsSockets.push(rec);

      const push = (dir: 'sent' | 'received', raw: string | Buffer) => {
        if (dir === 'sent') rec.sent++;
        else rec.received++;
        if (wsFrames.length >= WS_FRAME_CAP) return;
        const payload = typeof raw === 'string' ? raw : `<binary ${raw.length} bytes>`;
        const stomp = payload.match(/^([A-Z]+)\n/);
        const dest = payload.match(/^destination:(.+)$/m);
        wsFrames.push({
          timestamp: new Date().toISOString(),
          socketIndex,
          dir,
          op: stomp?.[1],
          destination: dest?.[1],
          payload: payload.length > 2000 ? `${payload.slice(0, 2000)}...(truncated)` : payload,
        });
      };

      ws.on('framesent', (f) => push('sent', f.payload));
      ws.on('framereceived', (f) => push('received', f.payload));
      ws.on('close', () => { rec.closedAt = new Date().toISOString(); });
    });

    pg.on('response', async (response: Response) => {
      const url = response.url();
      if (isStaticResource(url)) return;

      const timingKey = `${tabIndex}:${url}`;
      const startTime = requestTimings.get(timingKey);
      const duration = startTime ? Date.now() - startTime : undefined;
      requestTimings.delete(timingKey);

      let requestBody: string | undefined;
      try {
        requestBody = response.request().postData() || undefined;
      } catch {}

      let responseBody: string | undefined;
      try {
        const text = await response.text();
        responseBody = text.length > 5000 ? text.slice(0, 5000) + '...(truncated)' : text;
      } catch {}

      const reqHeaders = response.request().headers();
      const resHeaders = response.headers();

      networkEntries.push({
        timestamp: new Date().toISOString(),
        method: response.request().method(),
        url,
        status: response.status(),
        statusText: response.statusText(),
        requestHeaders: filterHeaders(reqHeaders),
        requestBody,
        responseHeaders: filterHeaders(resHeaders),
        responseBody,
        duration,
        resourceType: response.request().resourceType(),
        tabIndex,
      });
    });

    pg.on('load', async () => {
      try {
        const title = await pg.title().catch(() => '');
        const url = pg.url();

        metadata.urls.push({
          timestamp: new Date().toISOString(),
          url,
          title,
          tabIndex,
        });

        // 截圖全關時只記 URL，不拍 load 截圖。
        if (!SCREENSHOTS_ENABLED) return;

        screenshotCounter++;
        const idx = String(screenshotCounter).padStart(3, '0');
        // Wait for page to stabilize before screenshot
        await pg.waitForTimeout(1000);
        await pg.screenshot({
          path: path.join(SCREENSHOTS_DIR, `${idx}_tab${tabIndex}_${sanitizeFilename(title || 'page')}.png`),
          fullPage: SCREENSHOT_FULL_PAGE,
        });
      } catch {
        // Screenshot failure should not block operation
      }
    });

    pg.on('pageerror', (error) => {
      metadata.errors.push({
        timestamp: new Date().toISOString(),
        message: error.message,
        tabIndex,
      });
    });

    pg.on('close', () => {
      const idx = pages.indexOf(pg);
      if (idx !== -1) pages.splice(idx, 1);
      const apIdx = activePages.findIndex(ap => ap.page === pg);
      if (apIdx !== -1) activePages.splice(apIdx, 1);
    });
  }

  // ─── Listen for new tabs ──────────────────────────────

  context.on('page', async (newPage) => {
    const tabIndex = nextTabIndex++;
    pages.push(newPage);
    activePages.push({ page: newPage, tabIndex });
    setupPageTracking(newPage, tabIndex);
    // Inject DOM recorder into new tab
    await domRecorder.injectIntoPage(newPage, tabIndex).catch(() => {});
    console.log(`📑 New tab opened (tab ${tabIndex}): ${newPage.url()}`);
  });

  // ─── Create first page ───────────────────────────────

  // persistent context 啟動時自帶一個 about:blank 分頁——一定要重用它，不能再
  // newPage()：多開的話那張空白頁也會錄一支影片，且它排在 readdir 前面，收尾
  // 的 rename 會把**空白畫面**變成 video.webm（ship 清單認的主影片名）。
  //
  // 但自帶的分頁早在上面 context.on('page') 註冊前就存在、不會觸發該事件，
  // 所以它的 network/DOM 追蹤要在這裡自己掛上——漏掉的話 network.json 會少掉
  // 主分頁的每一筆請求。
  const existingPage = context.pages()[0];
  let page: import('playwright').Page;
  if (existingPage) {
    const tabIndex = nextTabIndex++;
    pages.push(existingPage);
    activePages.push({ page: existingPage, tabIndex });
    setupPageTracking(existingPage, tabIndex);
    page = existingPage;
  } else {
    page = await context.newPage();  // 走 'page' 事件，追蹤由 listener 掛上
  }

  // ─── Inject DOM recorder into first page ──────────────

  await domRecorder.injectIntoPage(page, 0).catch(() => {});

  // ─── Navigate to base URL ─────────────────────────────

  console.log('🌐 Opening browser...');
  if (BASE_URL) {
    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});
    } catch (err: any) {
      console.warn(`\n⚠️  Could not navigate to ${BASE_URL}: ${err.message?.split('\n')[0]}`);
      console.warn('   Browser remains open — navigate manually.\n');
    }
  } else {
    await page.goto('about:blank');
  }

  // ─── Open extra tabs (--open, 可重複) ─────────────────
  // 例如前台 + 後台一起開做對照測試。新分頁走 context 的 'page' 事件，
  // 追蹤與錄影自動接上；某一頁開不起來不影響其他頁與整場錄製。
  for (const url of EXTRA_URLS) {
    try {
      const extra = await context.newPage();
      await extra.goto(url, { waitUntil: 'domcontentloaded' });
      await extra.waitForLoadState('networkidle').catch(() => {});
      console.log(`🗂️  已另開分頁：${url}`);
    } catch (err: any) {
      console.warn(`⚠️  另開分頁失敗 ${url}: ${err.message?.split('\n')[0]}`);
    }
  }
  // 焦點回到第一個分頁，讓使用者從 --base-url 那頁開始操作
  if (EXTRA_URLS.length > 0) {
    await page.bringToFront().catch(() => {});
  }

  // ─── Start microphone recording ──────────────────────

  if (hasRec) {
    const audioPath = path.join(SESSION_DIR, 'audio.wav');
    recProc = spawn('rec', ['-r', '16000', '-c', '1', '-b', '16', audioPath], {
      stdio: 'ignore',
    });
    // 記錄 audio 相對影片起始的偏移，供 reconstruct --with-audio 校正
    metadata.audioStartOffsetMs = Date.now() - videoStartMs;
    recProc.on('error', () => {
      // Non-fatal — recording just won't be available
      recProc = null;
    });
  }

  // ─── Start periodic screenshots ─────────────────────

  if (PERIODIC_SCREENSHOTS) {
    const intervalMs = SCREENSHOT_INTERVAL_SEC * 1000;
    console.log(`📸 Periodic screenshots: every ${SCREENSHOT_INTERVAL_SEC}s`);
    periodicInterval = setInterval(async () => {
      for (const { page: pg, tabIndex } of activePages) {
        try {
          screenshotCounter++;
          periodicScreenshotCount++;
          const idx = String(screenshotCounter).padStart(3, '0');
          const ts = new Date().toISOString().slice(11, 19).replace(/:/g, '');
          await pg.screenshot({
            path: path.join(SCREENSHOTS_DIR, `${idx}_tab${tabIndex}_periodic_${ts}.png`),
            fullPage: SCREENSHOT_FULL_PAGE,
          });
        } catch {} // 截圖失敗靜默跳過
      }
    }, intervalMs);
  }

  // ─── page.pause() or auto-test ───────────────────────

  if (AUTO_TEST && AUTO_SCRIPT) {
    // ─── External script mode ─────────────────────────────
    const scriptPath = path.resolve(AUTO_SCRIPT);
    console.log(`\n🤖 Auto-test mode: loading external script: ${scriptPath}\n`);
    try {
      const mod = await import(scriptPath);
      // Handle both ESM named export and CJS default export
      const runFn = mod.run || mod.default?.run;
      if (typeof runFn === 'function') {
        await runFn(page, context, SESSION_DIR);
      } else {
        console.error('❌ Script must export a "run(page, context, outputDir)" function');
        console.error('   Found exports:', Object.keys(mod));
      }
    } catch (err: any) {
      console.error(`❌ Script execution error: ${err.message}`);
    }
    console.log('🤖 External script complete.\n');
  } else if (AUTO_TEST) {
    console.log('\n🤖 Auto-test mode: running default smoke test...\n');
    // Navigate to a few pages and interact
    if (BASE_URL) {
      try {
        await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 10_000 });
        await page.waitForLoadState('networkidle').catch(() => {});
        await page.waitForTimeout(2000);
      } catch {
        // Already warned above if needed
      }
    }
    // Fill any visible input fields
    const inputs = page.locator('input[type="text"], input[type="email"], input[type="password"], input:not([type])');
    const inputCount = await inputs.count().catch(() => 0);
    for (let i = 0; i < Math.min(inputCount, 3); i++) {
      try {
        await inputs.nth(i).fill(`test-value-${i + 1}`);
      } catch {}
    }
    // Click any visible buttons
    const buttons = page.locator('button:visible');
    const buttonCount = await buttons.count().catch(() => 0);
    if (buttonCount > 0) {
      try {
        await buttons.first().click({ timeout: 3000 }).catch(() => {});
      } catch {}
    }
    await page.waitForTimeout(2000);

    // ─── Multi-tab auto-test: open second tab ───────────
    console.log('🤖 Multi-tab test: opening second tab...');
    const secondPage = await context.newPage();
    await secondPage.goto('about:blank');
    await secondPage.waitForTimeout(1000);
    if (SCREENSHOTS_ENABLED) {
      screenshotCounter++;
      try {
        await secondPage.screenshot({
          path: path.join(SCREENSHOTS_DIR, `${String(screenshotCounter).padStart(3, '0')}_tab1_about_blank.png`),
          fullPage: SCREENSHOT_FULL_PAGE,
        });
      } catch {}
    }
    await secondPage.close();

    console.log('🤖 Default smoke test complete.\n');
  } else {
    console.log('\n' + '═'.repeat(60));
    console.log('🎯 Browser is open. Operate manually now.');
    console.log('');
    if (!BASE_URL) {
      console.log('   📍 No URL specified — type a URL in the address bar');
      console.log('');
    }
    console.log('   Playwright Inspector will appear:');
    console.log('   - Click "Record" to record actions (codegen)');
    console.log('   - Click "Resume" to finish recording');
    console.log('   - Close Inspector or click "Resume" when done');
    console.log('');
    console.log(isWindows
      ? `   🤖 或建立停止檔安全收尾：New-Item -ItemType File -Force "recordings\\${SESSION_NAME}\\.stop-recording"`
      : `   🤖 Or run 'start.sh stop' (agent 收尾) to finalize safely`);
    if (SCREENSHOTS_ENABLED) {
      console.log('   💡 Screenshots are auto-captured on each page load');
    }
    console.log('   💡 New tabs are automatically tracked');
    console.log('═'.repeat(60) + '\n');

    // 收尾兩條路都通往同一段存檔邏輯（下方無條件執行）：
    //   1. 人在 Inspector 按 Resume → page.pause() resolve
    //   2. agent/人放 .stop-recording sentinel → waitForStopFile resolve（不丟資料）
    const stopWatcher = waitForStopFile(STOP_FILE);
    try {
      await Promise.race([page.pause(), stopWatcher.promise]);
    } finally {
      // 即使 page.pause() 因使用者直接關瀏覽器而拋錯，也要收掉 watcher timer 並清 sentinel。
      stopWatcher.cancel();
      try { fs.rmSync(STOP_FILE, { force: true }); } catch {}
    }
  }

  // ─── Stop periodic screenshots ─────────────────────

  if (periodicInterval) {
    clearInterval(periodicInterval);
  }

  // ─── Stop microphone recording ──────────────────────

  if (recProc) {
    recProc.kill('SIGINT'); // SIGINT lets sox write proper WAV header
    // Wait briefly for sox to flush
    await new Promise(resolve => setTimeout(resolve, 500));

    // 量峰值：全零代表這場口述根本沒錄到，必須當場講，不能等 Studio 解析才發現
    const wavPath = path.join(SESSION_DIR, 'audio.wav');
    if (fs.existsSync(wavPath)) {
      const peak = measureAudioPeak(wavPath);
      if (peak === null) {
        console.warn('⚠️  無法量測 audio.wav 音量（sox 不在？），未能確認錄音是否有聲');
      } else {
        metadata.audioMaxAmplitude = peak;
        metadata.audioSilent = peak < AUDIO_SILENT_THRESHOLD;
        if (metadata.audioSilent) {
          console.error('');
          console.error('🔇 ' + '━'.repeat(58));
          console.error(`🔇 audio.wav 是數位靜音（峰值 ${peak.toFixed(6)}）——這場口述沒有錄到任何聲音`);
          console.error('🔇 常見原因：啟動錄製的進程沒有麥克風權限（TCC）。CoreAudio 在這種');
          console.error('🔇 情況不會報錯，而是餵全零 buffer，所以檔案大小看起來完全正常。');
          console.error('🔇 對策：改從有麥克風授權的終端機 session 啟動錄製；或先跑');
          console.error('🔇       sox -t coreaudio "<裝置名>" -n stat trim 0 3 確認峰值 > 0.01。');
          console.error('🔇 影片與 trace 不受影響，仍可使用。');
          console.error('🔇 ' + '━'.repeat(58));
          console.error('');
        } else if (peak < AUDIO_QUIET_THRESHOLD) {
          console.warn(`⚠️  audio.wav 音量偏低（峰值 ${peak.toFixed(6)}），轉寫品質可能不佳`);
        }
      }
    }
  }

  // ─── User finished — collect final screenshot ─────────
  // 截圖全關時不拍 final。

  if (SCREENSHOTS_ENABLED) {
    console.log('\n📸 Capturing final screenshot...');
    screenshotCounter++;
    try {
      await page.screenshot({
        path: path.join(SCREENSHOTS_DIR, `${String(screenshotCounter).padStart(3, '0')}_tab0_final.png`),
        fullPage: SCREENSHOT_FULL_PAGE,
      });
    } catch {}
  }

  // ─── Stop trace ───────────────────────────────────────

  console.log('📦 Saving trace...');
  await context.tracing.stop({
    path: path.join(SESSION_DIR, 'trace.zip'),
  });

  // ─── Save network.json ────────────────────────────────

  console.log('📡 Saving network log...');
  fs.writeFileSync(
    path.join(SESSION_DIR, 'network.json'),
    JSON.stringify(networkEntries, null, 2),
  );

  // ─── Save websocket.json ──────────────────────────────

  if (wsSockets.length > 0) {
    const truncated = wsFrames.length >= WS_FRAME_CAP;
    console.log('🔌 Saving websocket log...');
    fs.writeFileSync(
      path.join(SESSION_DIR, 'websocket.json'),
      JSON.stringify({ sockets: wsSockets, frames: wsFrames, frameCapReached: truncated }, null, 2),
    );
    for (const s of wsSockets) {
      console.log(`   ${s.url} — sent ${s.sent} / received ${s.received}`);
    }
    if (truncated) console.log(`   ⚠️ frame 記錄達上限 ${WS_FRAME_CAP}，後續 frame 只計數未存內容`);
  }

  // ─── Save user-actions.json (DOM recorder) ──────────

  console.log('🎯 Saving user actions...');
  domRecorder.correlateWithApi(networkEntries);
  const userActions = domRecorder.getActions();
  fs.writeFileSync(
    path.join(SESSION_DIR, 'user-actions.json'),
    JSON.stringify(userActions, null, 2),
  );
  console.log(`   ✅ ${userActions.length} actions recorded`);

  // ─── Save metadata.json ───────────────────────────────

  metadata.endTime = new Date().toISOString();
  metadata.screenshotCount = screenshotCounter;
  metadata.periodicScreenshotCount = periodicScreenshotCount;
  metadata.networkEntryCount = networkEntries.length;
  metadata.wsSocketCount = wsSockets.length;
  metadata.wsFrameCount = wsSockets.reduce((n, s) => n + s.sent + s.received, 0);
  metadata.tabCount = nextTabIndex;

  fs.writeFileSync(
    path.join(SESSION_DIR, 'metadata.json'),
    JSON.stringify(metadata, null, 2),
  );

  // ─── Generate codegen summary ─────────────────────────

  console.log('📝 Generating operation summary...');
  const summaryLines: string[] = [
    `// vox-trace session: ${SESSION_NAME}`,
    `// Base URL: ${BASE_URL || 'about:blank'}`,
    `// Start: ${metadata.startTime}`,
    `// End: ${metadata.endTime}`,
    `// Screenshots: ${screenshotCounter}`,
    `// API requests: ${networkEntries.length}`,
    `// Tabs: ${metadata.tabCount}`,
    '',
    '// === Page Navigation Log ===',
    ...metadata.urls.map((u, i) =>
      `// ${i + 1}. [Tab ${u.tabIndex}] [${u.timestamp.slice(11, 19)}] ${u.title} — ${u.url}`
    ),
    '',
    '// === API Summary (XHR/Fetch only) ===',
    ...networkEntries
      .filter(e => e.resourceType === 'xhr' || e.resourceType === 'fetch')
      .map(e => `// [Tab ${e.tabIndex}] ${e.method} ${e.status} ${BASE_URL ? e.url.replace(BASE_URL, '') : e.url}`),
    '',
    '// === How to generate specs from this recording ===',
    '// 1. Read this file to understand operation sequence',
    '// 2. Read network.json for API behavior',
    '// 3. Read screenshots/ for UI state (max 20 images per AI request)',
    '// 4. Run: npx playwright show-trace trace.zip',
  ];

  fs.writeFileSync(
    path.join(SESSION_DIR, 'codegen.ts'),
    summaryLines.join('\n'),
  );

  // ─── Generate API summary report ──────────────────────

  const apiSummary = generateApiSummary(networkEntries, BASE_URL);
  fs.writeFileSync(
    path.join(SESSION_DIR, 'api-summary.md'),
    apiSummary,
  );

  // ─── Close browser ────────────────────────────────────

  await page.close();
  await context.close();  // persistent context：關掉 context 就等於關掉瀏覽器
  // 臨時 profile 目錄清掉（擴充是從原始路徑載入的，不受影響）
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}

  // ─── Rename video file ────────────────────────────────

  const videoFiles = fs.readdirSync(SESSION_DIR).filter(f => f.endsWith('.webm'));
  let videoPath: string | undefined;
  if (videoFiles.length > 0) {
    const oldPath = path.join(SESSION_DIR, videoFiles[0]);
    videoPath = path.join(SESSION_DIR, 'video.webm');
    if (oldPath !== videoPath) {
      fs.renameSync(oldPath, videoPath);
    }
  }

  // ─── Post-processing (keyframes / transcribe / correlate) ──
  // PM 模式跳過：raw 錄製會 ship 給 Studio，由 Studio 統一重處理。

  if (!RUN_POST_PROCESSING) {
    console.log('\n📦 PM mode: skipping local post-processing (keyframes / transcribe / correlate).');
    console.log('   Raw recording will be shipped to Studio for processing.');
  }

  // ─── Extract keyframes from video (Route A+B combo) ───

  const keyframesDir = path.join(SESSION_DIR, 'keyframes');
  if (RUN_POST_PROCESSING && videoPath && fs.existsSync(videoPath)) {
    console.log('🎞️  Extracting keyframes from video...');
    const extractScript = path.join(__dirname, 'extract-keyframes.sh');

    if (fs.existsSync(extractScript)) {
      // extract-keyframes.sh 是 bash 腳本。Windows 原生沒有 bash（WSL / Git Bash 才有），
      // 舊版直接 execSync('bash …') 失敗後把原因寫成「ffmpeg installed?」——理由是錯的，
      // 會讓 Windows 使用者跑去裝 ffmpeg，裝完發現還是不行（2026-08-28 在真 Windows 實測）。
      if (!hasCommand('bash')) {
        console.warn(
          `   ⚠️  略過 keyframes：extract-keyframes.sh 需要 bash，這台機器沒有${
            isWindows ? '（Windows 原生沒有 bash）' : ''
          }。影片、trace、操作紀錄都不受影響。`,
        );
      } else {
        try {
          execSync(`bash "${extractScript}" "${videoPath}" "${keyframesDir}" 0.3`, {
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 60_000,
          });
          const kfCount = fs.readdirSync(keyframesDir).filter(f => f.endsWith('.png')).length;
          console.log(`   ✅ ${kfCount} keyframes extracted`);
        } catch (err: any) {
          // 有 bash 卻仍失敗——這時 ffmpeg 才是最可能的原因
          console.warn(`   ⚠️  Keyframe extraction failed (ffmpeg installed?): ${err.message?.split('\n')[0]}`);
        }
      }
    } else {
      console.warn('   ⚠️  extract-keyframes.sh not found, skipping keyframe extraction');
    }
  } else if (RUN_POST_PROCESSING) {
    console.log('🎞️  No video recorded, skipping keyframe extraction.');
  }

  // ─── Transcribe audio ────────────────────────────────

  const audioWavPath = path.join(SESSION_DIR, 'audio.wav');
  if (RUN_POST_PROCESSING && fs.existsSync(audioWavPath)) {
    try {
      await transcribe(audioWavPath, SESSION_DIR, SESSION_NAME);
    } catch (err: any) {
      console.warn(`⚠️  Transcription failed: ${err.message?.split('\n')[0]}`);
    }
  }

  // ─── Correlate user actions with transcript ──────────

  const transcriptPath = path.join(SESSION_DIR, 'transcript.md');
  if (RUN_POST_PROCESSING && fs.existsSync(transcriptPath) && userActions.length > 0) {
    const transcriptText = fs.readFileSync(transcriptPath, 'utf-8');
    domRecorder.correlateWithTranscript(transcriptText);
    // Re-save with transcript correlation
    fs.writeFileSync(
      path.join(SESSION_DIR, 'user-actions.json'),
      JSON.stringify(domRecorder.getActions(), null, 2),
    );
  }

  // ─── Print summary ────────────────────────────────────

  console.log('\n' + '═'.repeat(60));
  console.log('✅ Recording complete!');
  console.log('');
  console.log(`📁 Output: ${SESSION_DIR}`);
  // 靜音警告在收尾早期就印過，但後面還有 trace/keyframe 一堆輸出，這裡再講一次
  if (metadata.audioSilent) {
    console.log('');
    console.log(`🔇 注意：audio.wav 全靜音（峰值 ${metadata.audioMaxAmplitude?.toFixed(6)}），語音未錄到`);
  }
  console.log('');

  const files = fs.readdirSync(SESSION_DIR);
  const dirs = files.filter(f => fs.statSync(path.join(SESSION_DIR, f)).isDirectory());
  const regularFiles = files.filter(f => !fs.statSync(path.join(SESSION_DIR, f)).isDirectory());

  console.log('📄 Files:');
  for (const f of regularFiles) {
    const size = fs.statSync(path.join(SESSION_DIR, f)).size;
    console.log(`   ${f} (${formatSize(size)})`);
  }
  for (const d of dirs) {
    const count = fs.readdirSync(path.join(SESSION_DIR, d)).length;
    console.log(`   ${d}/ (${count} files)`);
  }

  console.log('');
  console.log('🔍 View trace:');
  console.log(`   npx playwright show-trace ${path.join(SESSION_DIR, 'trace.zip')}`);
  console.log('');
  console.log('📋 Data for AI:');
  console.log('   1. user-actions.json — DOM event sequence (selectors + coordinates)');
  console.log('   2. codegen.ts        — operation summary');
  console.log('   3. api-summary.md    — API overview');
  console.log('   4. network.json      — full API request/response (HTTP only)');
  if (wsSockets.length > 0) {
    console.log('   5. websocket.json    — STOMP/WS frames — 即時資料多半在這，network.json 看不到');
  }
  console.log('   6. screenshots/      — UI state per page load (Playwright)');
  console.log('   7. keyframes/        — scene-change frames from video (ffmpeg)');
  console.log('   8. transcript.md     — voice transcript (Whisper)');
  console.log('   9. metadata.json     — session metadata');
  console.log('');
  console.log('🎯 Generate Playwright test:');
  // Windows 沒有 start.sh（bash）。給等效的直接呼叫，否則使用者照著打會說「找不到指令」。
  // 用 npx.cmd 不是 npx：PowerShell 會優先解析到 npx.ps1，而 Windows 用戶端的
  // ExecutionPolicy 預設是 Restricted → 直接被安全性錯誤擋掉（2026-08-28 實測）。
  console.log(isWindows
    ? `   npx.cmd tsx src/generate-playwright.ts recordings\\${SESSION_NAME}`
    : `   ./start.sh generate ${SESSION_NAME}`);
  console.log('');
  console.log('💡 screenshots/ = Playwright DOM-aware captures (on page load)');
  console.log('   keyframes/   = ffmpeg pixel-level scene detection (fallback)');
  console.log('═'.repeat(60));

  // ─── 自動上傳回 NL server ─────────────────────────────
  // 放在最後：所有產出（trace / metadata / codegen / keyframes / 轉錄）都寫完
  // 才打包，否則送上去的是缺件的包。這支永遠不拋錯，上傳失敗只是印訊息——
  // 錄製產出已經在磁碟上了，不該因為傳不出去就讓錄製器以非零結束。
  if (AUTO_UPLOAD) {
    await autoUploadSession({
      sessionDir: SESSION_DIR,
      sessionName: SESSION_NAME,
      startedAt: new Date(metadata.startTime),
    });
  }
}

// ─── Helpers ───────────────────────────────────────────────

const KEEP_HEADERS = new Set([
  'content-type', 'accept', 'accept-language', 'cache-control',
  'x-requested-with', 'origin', 'referer', 'user-agent',
]);
const REDACT_HEADERS = new Set([
  'authorization', 'cookie', 'set-cookie', 'x-api-key',
]);

function filterHeaders(headers: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (KEEP_HEADERS.has(lower)) {
      filtered[key] = value;
    } else if (REDACT_HEADERS.has(lower)) {
      filtered[key] = '[REDACTED]';
    }
    // Skip all other headers (e.g. large cookies, custom tokens)
  }
  return filtered;
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_')
    .slice(0, 50);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function generateApiSummary(entries: NetworkEntry[], baseUrl: string): string {
  const apiEntries = entries.filter(
    e => e.resourceType === 'xhr' || e.resourceType === 'fetch'
  );

  const lines: string[] = [
    '# API Request Summary',
    '',
    `> ${apiEntries.length} API requests during session`,
    '',
  ];

  // Group by status code
  const byStatus: Record<string, NetworkEntry[]> = {};
  for (const e of apiEntries) {
    const group = e.status >= 400 ? `${e.status} ❌` : `${e.status} ✅`;
    (byStatus[group] ||= []).push(e);
  }

  // Errors first
  const groups = Object.keys(byStatus).sort((a, b) => {
    const aCode = parseInt(a);
    const bCode = parseInt(b);
    if (aCode >= 400 && bCode < 400) return -1;
    if (aCode < 400 && bCode >= 400) return 1;
    return aCode - bCode;
  });

  for (const group of groups) {
    const groupEntries = byStatus[group];
    lines.push(`## ${group} (${groupEntries.length})`);
    lines.push('');
    lines.push('| Method | URL | Duration |');
    lines.push('|--------|-----|----------|');
    for (const e of groupEntries) {
      const shortUrl = e.url.replace(baseUrl, '');
      const displayUrl = shortUrl.length > 80 ? shortUrl.slice(0, 80) + '...' : shortUrl;
      const duration = e.duration ? `${e.duration}ms` : '-';
      lines.push(`| ${e.method} | \`${displayUrl}\` | ${duration} |`);
    }
    lines.push('');
  }

  // Endpoint frequency
  const endpointCounts: Record<string, number> = {};
  for (const e of apiEntries) {
    try {
      const url = new URL(e.url);
      const endpoint = `${e.method} ${url.pathname}`;
      endpointCounts[endpoint] = (endpointCounts[endpoint] || 0) + 1;
    } catch {}
  }

  const sorted = Object.entries(endpointCounts).sort((a, b) => b[1] - a[1]);
  if (sorted.length > 0) {
    lines.push('## Endpoint Frequency');
    lines.push('');
    lines.push('| Count | Endpoint |');
    lines.push('|-------|----------|');
    for (const [endpoint, count] of sorted.slice(0, 20)) {
      lines.push(`| ${count} | \`${endpoint}\` |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Run ───────────────────────────────────────────────────

main().catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});
