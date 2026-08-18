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
 */

import { chromium, Request, Response } from 'playwright';
import { execSync, spawn, spawnSync, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { transcribe } from './transcribe';
import { DomRecorder } from './dom-recorder';
import { parseScreenshotConfig, parsePmMode, shouldRunPostProcessing, parseRecorder, sanitizeSessionName } from './shared/record-config';
import { waitForStopFile } from './shared/stop-signal';

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
const SCREENSHOT_CFG = parseScreenshotConfig(args);
const SCREENSHOTS_ENABLED = SCREENSHOT_CFG.enabled;
const PERIODIC_SCREENSHOTS = SCREENSHOT_CFG.periodicEnabled;
const SCREENSHOT_INTERVAL_SEC = SCREENSHOT_CFG.intervalSec;
const SCREENSHOT_FULL_PAGE = SCREENSHOT_CFG.fullPage;
const PM_MODE = parsePmMode(args, process.env);
const RUN_POST_PROCESSING = shouldRunPostProcessing(PM_MODE);

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
  tabCount: number;
  periodicScreenshotCount: number;
  codegenEnabled: boolean;
  /** PM 模式：本機不做重處理，raw 錄製 ship 給 Studio。 */
  pmMode: boolean;
  /** 錄製者名字（來自 .pm-config.json），未設定時省略。 */
  recorder?: string;
  errors: Array<{ timestamp: string; message: string; tabIndex?: number }>;
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

  // Check if rec (sox) is available for microphone recording
  const hasRec = !NO_AUDIO && spawnSync('which', ['rec'], { encoding: 'utf-8' }).status === 0;
  if (NO_AUDIO) {
    console.log('🎤 Microphone: disabled (--no-audio)');
  } else if (hasRec) {
    console.log('🎤 Microphone: recording');
  } else {
    console.warn('🎤 Microphone: disabled (rec not found — install: brew install sox)');
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
      console.warn(`⚠️  另一個錄製 session 進行中：${existing}。'start.sh stop'（不帶名）將停到最後啟動的 ${SESSION_NAME}；要停前者請 'start.sh stop ${existing}'。`);
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

  const browser = await chromium.launch({
    headless: false,
    args: ['--start-maximized'],
  });

  const contextOptions: Parameters<typeof browser.newContext>[0] = {
    viewport: null as any, // Use actual window size
    recordVideo: {
      dir: SESSION_DIR,
      size: { width: 1280, height: 720 },
    },
  };

  if (storageStatePath) {
    contextOptions.storageState = storageStatePath;
  }

  const context = await browser.newContext(contextOptions);

  // ─── Start trace recording ────────────────────────────

  await context.tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true,
  });

  // ─── Shared state for multi-tab recording ─────────────

  const networkEntries: NetworkEntry[] = [];
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

  const page = await context.newPage();

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
    console.log(`   🤖 Or run 'start.sh stop' (agent 收尾) to finalize safely`);
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
  await context.close();
  await browser.close();

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
      try {
        execSync(`bash "${extractScript}" "${videoPath}" "${keyframesDir}" 0.3`, {
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 60_000,
        });
        const kfCount = fs.readdirSync(keyframesDir).filter(f => f.endsWith('.png')).length;
        console.log(`   ✅ ${kfCount} keyframes extracted`);
      } catch (err: any) {
        // ffmpeg not installed or extraction failed — non-fatal
        console.warn(`   ⚠️  Keyframe extraction failed (ffmpeg installed?): ${err.message?.split('\n')[0]}`);
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
  console.log('   4. network.json      — full API request/response');
  console.log('   5. screenshots/      — UI state per page load (Playwright)');
  console.log('   6. keyframes/        — scene-change frames from video (ffmpeg)');
  console.log('   7. transcript.md     — voice transcript (Whisper)');
  console.log('   8. metadata.json     — session metadata');
  console.log('');
  console.log('🎯 Generate Playwright test:');
  console.log(`   ./start.sh generate ${SESSION_NAME}`);
  console.log('');
  console.log('💡 screenshots/ = Playwright DOM-aware captures (on page load)');
  console.log('   keyframes/   = ffmpeg pixel-level scene detection (fallback)');
  console.log('═'.repeat(60));
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
