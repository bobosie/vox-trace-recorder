/**
 * reconstruct — storyboard.yml → 重錄還原影片（reconstructed.webm / .mp4）
 *
 * 用 vox-trace 既有的 Playwright recordVideo context（與 record-manual-session
 * 相同機制）依 storyboard 的 scenes[].do[] 逐步 replay，重新錄出一支乾淨影片。
 *
 * 動詞解讀：
 *   navigate  → page.goto(url, {waitUntil:'domcontentloaded'})
 *   click     → 一般用 selector 點擊；sidecar meta.isCanvasKit → page.mouse.click(coords)（best-effort）
 *   type      → page.fill(into, text)（password 已在 storyboard 遮罩為 ****）
 *   select    → page.selectOption(selector, value)
 *   press     → page.press(selector, key)
 *   scroll    → window.scrollTo(0, y)
 *   pause     → 等待 N 秒（還原自然節奏）
 *   screenshot→ 截圖（best-effort，reconstruct 不落地，跳過）
 *   upload    → best-effort，跳過（無來源檔）
 *
 * 音訊（--with-audio）：把原始 audio.wav 用 offset 校正後 mux 進 mp4。
 * offset 由 --audio-offset <秒> 指定；未指定時嘗試從 metadata.json 的
 * audioStartOffsetMs 推估，否則預設 0。詳見 README 的 offset 校正流程。
 *
 * Usage:
 *   npx tsx src/reconstruct.ts <session-dir> [--storyboard <path>] [--headed]
 *                                            [--with-audio] [--audio-offset <sec>]
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { chromium } from 'playwright';
import yaml from 'js-yaml';
import type { Storyboard, StoryboardStep, StoryboardSidecar, VoxStepMeta } from './generate-storyboard';
import { sidecarPathFor } from './generate-storyboard';

// ─── Replay ─────────────────────────────────────────────────

export interface ReplayOptions {
  outputDir: string;
  headed?: boolean;
  webmName?: string; // default reconstructed.webm
  /** vox sidecar：與攤平後 do[] 同序同長；用於 canvas 座標點擊等原生還原。 */
  sidecar?: StoryboardSidecar | null;
}

/**
 * 依 storyboard replay 並用 recordVideo 錄出影片。回傳 webm 檔完整路徑。
 */
export async function replayStoryboard(
  storyboard: Storyboard,
  opts: ReplayOptions,
): Promise<string> {
  const { outputDir } = opts;
  const webmName = opts.webmName || 'reconstructed.webm';
  const viewport = storyboard.viewport || { width: 1280, height: 720 };

  fs.mkdirSync(outputDir, { recursive: true });

  const browser = await chromium.launch({
    headless: !opts.headed,
    args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });

  const context = await browser.newContext({
    viewport,
    recordVideo: { dir: outputDir, size: viewport },
  });

  const page = await context.newPage();

  // sidecar.steps 與「跨 scenes 攤平的 do[]」同序同長；用全域 index 對齊。
  const metaList = opts.sidecar?.steps ?? [];

  try {
    // Initial navigation
    await page.goto(storyboard.url, { waitUntil: 'domcontentloaded' }).catch(() => {});

    let idx = 0;
    for (const scene of storyboard.scenes) {
      for (const step of scene.do) {
        await execStep(page, step, metaList[idx] ?? null);
        idx++;
      }
    }
  } finally {
    // Video is flushed on context.close()
    await page.close();
    await context.close();
    await browser.close();
  }

  // Playwright writes a random-named .webm; rename to reconstructed.webm.
  const webmFiles = fs
    .readdirSync(outputDir)
    .filter((f: string) => f.endsWith('.webm') && f !== webmName);
  const webmPath = path.join(outputDir, webmName);
  if (webmFiles.length > 0) {
    const src = path.join(outputDir, webmFiles[0]);
    if (src !== webmPath) fs.renameSync(src, webmPath);
  }
  if (!fs.existsSync(webmPath)) {
    throw new Error('❌ Playwright 未產出影片檔（webm）');
  }
  return webmPath;
}

async function execStep(
  page: import('playwright').Page,
  step: StoryboardStep,
  meta: VoxStepMeta | null,
): Promise<void> {
  // pause
  if ('pause' in step && typeof step.pause === 'number') {
    await page.waitForTimeout(Math.max(0, step.pause * 1000));
    return;
  }

  // in-flow navigation
  if ('navigate' in step && typeof step.navigate === 'string') {
    await page.goto(step.navigate, { waitUntil: 'domcontentloaded' }).catch(() => {});
    return;
  }

  // click
  if ('click' in step) {
    if (meta?.isCanvasKit && meta.coordinates) {
      // best-effort 座標點擊（CanvasKit 無 DOM selector）
      await page.mouse.click(meta.coordinates.x, meta.coordinates.y).catch(() => {});
    } else {
      const sel = String(step.click);
      await page.click(sel, { timeout: 8000 }).catch((e) => {
        console.warn(`⚠️  click 失敗（略過）: ${sel} — ${String(e).split('\n')[0]}`);
      });
    }
    return;
  }

  // type / fill —— shot-scraper schema {into, text}（向後相容舊的 {selector, value}）
  if ('type' in step && step.type && typeof step.type === 'object') {
    const selector = step.type.into ?? step.type.selector;
    const value = step.type.text ?? step.type.value;
    await page.fill(selector, value ?? '', { timeout: 8000 }).catch((e) => {
      console.warn(`⚠️  type 失敗（略過）: ${selector} — ${String(e).split('\n')[0]}`);
    });
    return;
  }

  // select
  if ('select' in step && step.select && typeof step.select === 'object') {
    const { selector, value } = step.select;
    await page.selectOption(selector, value ?? '', { timeout: 8000 }).catch((e) => {
      console.warn(`⚠️  select 失敗（略過）: ${selector} — ${String(e).split('\n')[0]}`);
    });
    return;
  }

  // press
  if ('press' in step && step.press && typeof step.press === 'object') {
    const { selector, key } = step.press;
    await page.press(selector, key ?? '', { timeout: 8000 }).catch((e) => {
      console.warn(`⚠️  press 失敗（略過）: ${selector} — ${String(e).split('\n')[0]}`);
    });
    return;
  }

  // scroll
  if ('scroll' in step && step.scroll && typeof step.scroll === 'object') {
    const y = step.scroll.y ?? 0;
    await page.evaluate((yy) => window.scrollTo(0, yy), y).catch(() => {});
    return;
  }

  // upload / screenshot → best-effort skip
}

// ─── ffmpeg helpers ─────────────────────────────────────────

export function webmToMp4(webmPath: string, mp4Path: string): void {
  execFileSync(
    'ffmpeg',
    ['-y', '-i', webmPath, '-c:v', 'libx264', '-crf', '23', '-pix_fmt', 'yuv420p', mp4Path],
    { stdio: 'ignore' },
  );
}

/**
 * 把 audio.wav 依 offset 校正後 mux 進影片，輸出 mp4。
 * offsetSec > 0：audio 往後延（video 先開始）。< 0：audio 提前（截掉開頭）。
 */
export function muxAudio(
  videoPath: string,
  audioPath: string,
  offsetSec: number,
  outMp4Path: string,
): void {
  const args = ['-y'];
  // video input
  args.push('-i', videoPath);
  // audio input with offset
  if (offsetSec >= 0) {
    // delay audio: itsoffset on audio input
    args.push('-itsoffset', String(offsetSec), '-i', audioPath);
  } else {
    // audio starts earlier than video → seek into audio
    args.push('-ss', String(Math.abs(offsetSec)), '-i', audioPath);
  }
  args.push(
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'libx264', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-shortest',
    outMp4Path,
  );
  execFileSync('ffmpeg', args, { stdio: 'ignore' });
}

// ─── Audio offset estimation ────────────────────────────────

export function estimateAudioOffsetSec(sessionDir: string): number {
  const metaPath = path.join(sessionDir, 'metadata.json');
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      if (typeof meta.audioStartOffsetMs === 'number') {
        return meta.audioStartOffsetMs / 1000;
      }
    } catch {
      /* ignore */
    }
  }
  return 0;
}

// ─── CLI ────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const sessionDir = args[0];

  if (!sessionDir) {
    console.error(
      '❌ 用法: npx tsx src/reconstruct.ts <session-dir> [--storyboard <path>] [--headed] [--with-audio] [--audio-offset <sec>]',
    );
    process.exit(1);
  }

  const resolvedDir = path.resolve(sessionDir);
  if (!fs.existsSync(resolvedDir)) {
    console.error(`❌ Session 目錄不存在: ${resolvedDir}`);
    process.exit(1);
  }

  const sbIdx = args.indexOf('--storyboard');
  const storyboardPath =
    sbIdx !== -1 && args[sbIdx + 1]
      ? path.resolve(args[sbIdx + 1])
      : path.join(resolvedDir, 'storyboard.yml');

  if (!fs.existsSync(storyboardPath)) {
    console.error(`❌ storyboard.yml 不存在: ${storyboardPath}`);
    console.error('   請先執行: ./start.sh storyboard ' + path.basename(resolvedDir));
    process.exit(1);
  }

  const headed = args.includes('--headed');
  const withAudio = args.includes('--with-audio');
  const offIdx = args.indexOf('--audio-offset');
  const audioOffsetOverride =
    offIdx !== -1 && args[offIdx + 1] !== undefined ? parseFloat(args[offIdx + 1]) : undefined;

  const storyboard = yaml.load(fs.readFileSync(storyboardPath, 'utf-8')) as Storyboard;
  const stepCount = storyboard.scenes.reduce((n, s) => n + s.do.length, 0);
  console.log(`🎬 還原影片：${stepCount} 步驟（含 pause），起始 URL ${storyboard.url}`);

  // 讀 vox sidecar（canvas 座標等原生還原用；不存在則純 DOM 還原）
  let sidecar: StoryboardSidecar | null = null;
  const sidecarPath = sidecarPathFor(storyboardPath);
  if (fs.existsSync(sidecarPath)) {
    try {
      sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8')) as StoryboardSidecar;
    } catch {
      console.warn('⚠️  sidecar 解析失敗，改純 DOM 還原');
    }
  }

  const webmPath = await replayStoryboard(storyboard, { outputDir: resolvedDir, headed, sidecar });
  console.log(`✅ 已錄製: ${webmPath}`);

  const mp4Path = path.join(resolvedDir, 'reconstructed.mp4');

  if (withAudio) {
    const audioPath = path.join(resolvedDir, 'audio.wav');
    if (!fs.existsSync(audioPath)) {
      console.warn('⚠️  找不到 audio.wav，改輸出無聲 mp4');
      webmToMp4(webmPath, mp4Path);
    } else {
      const offset =
        audioOffsetOverride !== undefined
          ? audioOffsetOverride
          : estimateAudioOffsetSec(resolvedDir);
      console.log(`🔊 mux audio.wav（offset ${offset}s）...`);
      muxAudio(webmPath, audioPath, offset, mp4Path);
    }
  } else {
    webmToMp4(webmPath, mp4Path);
  }

  console.log(`✅ 已輸出: ${mp4Path}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ reconstruct 失敗:', err);
    process.exit(1);
  });
}
