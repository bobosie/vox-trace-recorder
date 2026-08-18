/**
 * generate-storyboard — user-actions.json → storyboard.yml (+ storyboard.vox.json)
 *
 * 產出兩個檔：
 *   1. storyboard.yml —— **純 shot-scraper 格式**：頂層 output/url/viewport/cursor/
 *      scenes[].do[]，且每個 do step 是「單鍵 mapping」（shot-scraper v1.10 用
 *      strict pydantic 驗證：step 只能有一個 key、頂層不許額外 key）。動詞用
 *      shot-scraper 認得的 schema：pause / click / type{into,text,delay_ms} /
 *      press{selector,key} / scroll{y,duration}。可直接 `shot-scraper video storyboard.yml`。
 *   2. storyboard.vox.json —— vox-trace 原生 reconstruct 用的 sidecar：與 do[] 同序
 *      同長的擴充中繼陣列（座標 / isCanvasKit / API 關聯 / seq / bestEffort），pause
 *      步驟對應 null。shot-scraper 不讀它，reconstruct 讀它精準還原（尤其 canvas 座標）。
 *
 * ⚠️ 相容邊界（實測 shot-scraper v1.10）：
 *   - `select` 與 in-flow `navigate` 不是 shot-scraper 動詞（Unknown storyboard action）。
 *     含這兩者的 storyboard 只能用 `./start.sh reconstruct`（原生）跑，shot-scraper 會拒。
 *   - CanvasKit（Flutter）click 無 DOM selector，以座標點擊表示（座標在 sidecar），
 *     shot-scraper 無座標點擊、也跑不動 canvas；這類請用原生 reconstruct（best-effort）。
 *
 * selector 挑選：placeholder > dataTest > id > ariaLabel > textContent > role > cssPath
 * （人類可讀 + 執行穩定折衷；password 值遮罩為 ****）。相鄰 action 的 timestamp 差 →
 * 自然 pause（maxPauseSec 上限預設 2 秒，clamp 避免枯等）。
 *
 * Usage:
 *   npx tsx src/generate-storyboard.ts <session-dir> [--output <path>] [--max-pause <sec>]
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import type { RecordedAction } from './dom-recorder';
import { extractApiPathPattern } from './shared/action-to-playwright';

// ─── Types ──────────────────────────────────────────────────

export interface VoxStepMeta {
  seq: number;
  actionType: RecordedAction['type'];
  isCanvasKit?: boolean;
  bestEffort?: boolean;
  coordinates?: { x: number; y: number };
  selectorStrategies?: RecordedAction['selectorStrategies'];
  api?: { endpoint: string; method: string; status: number; pathPattern: string };
  sensitive?: boolean;
}

// A single step in scenes[].do[]. Pure shot-scraper single-key mapping.
export type StoryboardStep = Record<string, any>;

export interface StoryboardScene {
  name: string;
  do: StoryboardStep[];
}

export interface Storyboard {
  output: string;
  url: string;
  viewport: { width: number; height: number };
  cursor?: boolean;
  wait_for?: string;
  scenes: StoryboardScene[];
}

// vox-trace sidecar：與所有 scenes 攤平後的 do[] 同序同長。
export interface StoryboardSidecar {
  version: 1;
  session: string;
  generatedAt: string;
  actionCount: number;
  /** 與 do[]（跨 scenes 攤平）逐一對應；pause 等無動作步驟為 null。 */
  steps: (VoxStepMeta | null)[];
}

export interface BuildOptions {
  maxPauseSec?: number;
  output?: string;
}

const DEFAULT_MAX_PAUSE_SEC = 2;

// ─── Selector selection ─────────────────────────────────────

/**
 * 挑最穩健且人類可讀的 selector。placeholder / dataTest 最佳，cssPath 墊底。
 */
export function pickSelector(action: RecordedAction): string {
  const s = action.selectorStrategies;
  return (
    s.placeholder ||
    s.dataTest ||
    s.id ||
    s.ariaLabel ||
    s.textContent ||
    s.role ||
    s.cssPath ||
    action.selector ||
    'unknown'
  );
}

// ─── Pause computation ──────────────────────────────────────

function clampPause(deltaMs: number, maxPauseSec: number): number {
  if (deltaMs <= 0) return 0;
  const sec = deltaMs / 1000;
  const clamped = Math.min(sec, maxPauseSec);
  // round to 1 decimal, floor tiny gaps to 0
  return Math.round(clamped * 10) / 10;
}

// ─── Core builder ───────────────────────────────────────────

/**
 * 從 actions 建出「純 shot-scraper storyboard + vox sidecar」。兩者 do[] 同序同長。
 */
export function buildAll(
  session: string,
  actions: RecordedAction[],
  opts: BuildOptions = {},
): { storyboard: Storyboard; sidecar: StoryboardSidecar } {
  const maxPauseSec = opts.maxPauseSec ?? DEFAULT_MAX_PAUSE_SEC;

  // Sort by timestamp (matches generate-playwright ordering)
  const sorted = [...actions].sort((a, b) => a.timestamp - b.timestamp);

  // Collapse consecutive duplicate navigate events (same URL).
  const filtered = sorted.filter((a, i) => {
    if (a.type === 'navigate' && i > 0) {
      const prev = sorted[i - 1];
      if (prev.type === 'navigate' && prev.value === a.value) return false;
    }
    return true;
  });

  // Initial URL = first navigate value (fallback to first action url)
  const firstNav = filtered.find((a) => a.type === 'navigate' && a.value);
  const initialUrl = firstNav?.value || filtered[0]?.url || 'about:blank';
  const viewport = filtered[0]?.viewportSize || { width: 1280, height: 720 };

  const steps: StoryboardStep[] = [];
  const voxSteps: (VoxStepMeta | null)[] = [];
  let prevTs: number | null = null;

  // 同步 push 純 step 與其 meta，保證 do[] 與 sidecar.steps 同序同長。
  const push = (step: StoryboardStep, meta: VoxStepMeta | null) => {
    steps.push(step);
    voxSteps.push(meta);
  };

  for (const action of filtered) {
    // pause derived from inter-action gap（pause 步驟無 meta）
    if (prevTs !== null) {
      const pause = clampPause(action.timestamp - prevTs, maxPauseSec);
      if (pause > 0) push({ pause }, null);
    }
    prevTs = action.timestamp;

    const meta: VoxStepMeta = {
      seq: action.seq,
      actionType: action.type,
      selectorStrategies: action.selectorStrategies,
    };
    if (action.isCanvasKit) meta.isCanvasKit = true;
    if (action.correlatedApi) {
      meta.api = {
        endpoint: action.correlatedApi.endpoint,
        method: action.correlatedApi.method,
        status: action.correlatedApi.status,
        pathPattern: extractApiPathPattern(action.correlatedApi.endpoint),
      };
    }

    switch (action.type) {
      case 'navigate': {
        // 只有「建立 initialUrl 的那個第一個 navigate」變頂層 url、不進 do[]。
        // 其餘一律照發——含中途導航回起始頁（A→B→A），否則 reconstruct 會漏那步。
        // 註：navigate 非 shot-scraper 動詞，含它的 storyboard 只能用原生 reconstruct。
        if (action !== firstNav && action.value) {
          push({ navigate: action.value }, meta);
        }
        break;
      }
      case 'click': {
        if (action.isCanvasKit) {
          meta.bestEffort = true;
          // coordinates 理論上必填，防呆缺失退回 (0,0)，避免整支 storyboard 崩潰。
          const cx = action.coordinates?.x ?? 0;
          const cy = action.coordinates?.y ?? 0;
          meta.coordinates = { x: cx, y: cy };
          // 純 step 用人類可讀 marker（shot-scraper 無座標點擊，跑不動 canvas）；
          // reconstruct 讀 sidecar 的 coordinates 做真正的座標點擊。
          push({ click: `canvas @ (${cx}, ${cy})` }, meta);
        } else {
          push({ click: pickSelector(action) }, meta);
        }
        break;
      }
      case 'fill': {
        const sensitive = action.inputType === 'password';
        meta.sensitive = sensitive;
        // shot-scraper 的 type 動詞 schema = {into, text, delay_ms}（實測 v1.10）。
        push(
          {
            type: {
              into: pickSelector(action),
              text: sensitive ? '****' : action.value ?? '',
              delay_ms: 40,
            },
          },
          meta,
        );
        break;
      }
      case 'select': {
        // select 非 shot-scraper 動詞（vox 專屬）；含它的 storyboard 只能原生 reconstruct。
        push({ select: { selector: pickSelector(action), value: action.value ?? '' } }, meta);
        break;
      }
      case 'press_key': {
        // shot-scraper press 動詞 schema = {selector, key}（實測 v1.10）。
        push({ press: { selector: pickSelector(action), key: action.key ?? '' } }, meta);
        break;
      }
      case 'upload': {
        // shot-scraper 無 upload；vox 專屬，best-effort（reconstruct 亦跳過，無來源檔）。
        meta.bestEffort = true;
        push({ upload: { selector: pickSelector(action), value: action.value ?? '' } }, meta);
        break;
      }
      case 'scroll': {
        // shot-scraper scroll 動詞 schema = {y, duration}（實測 v1.10）。
        push({ scroll: { y: action.coordinates?.y ?? 0, duration: 0.4 } }, meta);
        break;
      }
    }
  }

  const storyboard: Storyboard = {
    output: opts.output || `${session}.reconstructed.mp4`,
    url: initialUrl,
    viewport: { width: viewport.width, height: viewport.height },
    cursor: true,
    scenes: [{ name: 'main', do: steps }],
  };

  const sidecar: StoryboardSidecar = {
    version: 1,
    session,
    generatedAt: new Date().toISOString(),
    actionCount: filtered.length,
    steps: voxSteps,
  };

  return { storyboard, sidecar };
}

/**
 * 只要純 shot-scraper storyboard（向後相容既有呼叫）。sidecar 請用 buildAll。
 */
export function buildStoryboard(
  session: string,
  actions: RecordedAction[],
  opts: BuildOptions = {},
): Storyboard {
  return buildAll(session, actions, opts).storyboard;
}

// ─── IO ─────────────────────────────────────────────────────

export function writeStoryboard(sb: Storyboard, outputPath: string): void {
  const doc = yaml.dump(sb, { lineWidth: 120, noRefs: true });
  fs.writeFileSync(outputPath, doc, 'utf-8');
}

export function writeSidecar(sidecar: StoryboardSidecar, outputPath: string): void {
  fs.writeFileSync(outputPath, JSON.stringify(sidecar, null, 2), 'utf-8');
}

/** storyboard.yml → 同目錄同 basename 的 .vox.json sidecar 路徑。 */
export function sidecarPathFor(storyboardPath: string): string {
  const dir = path.dirname(storyboardPath);
  const base = path.basename(storyboardPath).replace(/\.ya?ml$/i, '');
  return path.join(dir, `${base}.vox.json`);
}

export function loadActions(sessionDir: string): RecordedAction[] {
  const actionsPath = path.join(sessionDir, 'user-actions.json');
  if (!fs.existsSync(actionsPath)) {
    throw new Error(`user-actions.json 不存在: ${actionsPath}`);
  }
  return JSON.parse(fs.readFileSync(actionsPath, 'utf-8'));
}

// ─── CLI ────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const sessionDir = args[0];

  if (!sessionDir) {
    console.error('❌ 用法: npx tsx src/generate-storyboard.ts <session-dir> [--output <path>] [--max-pause <sec>]');
    process.exit(1);
  }

  const resolvedDir = path.resolve(sessionDir);
  if (!fs.existsSync(resolvedDir)) {
    console.error(`❌ Session 目錄不存在: ${resolvedDir}`);
    process.exit(1);
  }

  const outputIdx = args.indexOf('--output');
  const outputPath =
    outputIdx !== -1 && args[outputIdx + 1]
      ? path.resolve(args[outputIdx + 1])
      : path.join(resolvedDir, 'storyboard.yml');

  const maxPauseIdx = args.indexOf('--max-pause');
  const maxPauseSec =
    maxPauseIdx !== -1 && args[maxPauseIdx + 1]
      ? parseFloat(args[maxPauseIdx + 1])
      : DEFAULT_MAX_PAUSE_SEC;

  const session = path.basename(resolvedDir);
  const actions = loadActions(resolvedDir);
  console.log(`📥 載入 ${actions.length} 個 user actions`);

  if (actions.length === 0) {
    console.warn('⚠️  user-actions.json 為空，沒有可轉換的操作');
    process.exit(0);
  }

  const { storyboard, sidecar } = buildAll(session, actions, {
    maxPauseSec,
    output: `${session}.reconstructed.mp4`,
  });
  writeStoryboard(storyboard, outputPath);
  const sidecarPath = sidecarPathFor(outputPath);
  writeSidecar(sidecar, sidecarPath);

  const stepCount = storyboard.scenes.reduce((n, s) => n + s.do.length, 0);
  const hasVoxOnly = sidecar.steps.some(
    (m) => m && (m.actionType === 'select' || m.actionType === 'navigate' || m.isCanvasKit),
  );
  console.log(`\n✅ 已生成 storyboard: ${outputPath}`);
  console.log(`   sidecar: ${sidecarPath}`);
  console.log(`   ${storyboard.scenes.length} 場景 / ${stepCount} 步驟（含 pause）`);
  if (hasVoxOnly) {
    console.log('   ⚠️  含 select / in-flow navigate / canvas 座標點擊 → 這些非 shot-scraper 動詞，');
    console.log('       此 storyboard 請用原生還原：./start.sh reconstruct ' + session);
  } else {
    console.log('   shot-scraper 相容：shot-scraper video ' + path.basename(outputPath));
    console.log('   或原生還原：./start.sh reconstruct ' + session);
  }
}

// Only run CLI when invoked directly (not when imported by tests).
if (require.main === module) {
  main();
}
