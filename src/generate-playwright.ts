/**
 * Generate Playwright Test — 多源融合程式碼生成器
 *
 * 讀取 user-actions.json + network.json + transcript.md，
 * 產生可直接執行的 Playwright .spec.ts 測試檔。
 *
 * Usage:
 *   npx tsx src/generate-playwright.ts <session-dir> [--output <path>] [--headed]
 */

import * as fs from 'fs';
import * as path from 'path';
import type { RecordedAction } from './dom-recorder';
import {
  generateSteps,
  type ProcessedStep,
} from './shared/action-to-playwright';

// ─── CLI ────────────────────────────────────────────────────

const args = process.argv.slice(2);
const sessionDir = args[0];

if (!sessionDir) {
  console.error('❌ 用法: npx tsx src/generate-playwright.ts <session-dir> [--output <path>]');
  process.exit(1);
}

const resolvedDir = path.resolve(sessionDir);
if (!fs.existsSync(resolvedDir)) {
  console.error(`❌ Session 目錄不存在: ${resolvedDir}`);
  process.exit(1);
}

const outputIdx = args.indexOf('--output');
const outputPath = outputIdx !== -1 && args[outputIdx + 1]
  ? path.resolve(args[outputIdx + 1])
  : path.join(resolvedDir, `${path.basename(resolvedDir)}.raw.spec.ts`);

const runAfter = args.includes('--run');
const headed = args.includes('--headed');

// ─── Load Data Sources ──────────────────────────────────────

interface NetworkEntry {
  timestamp: string;
  method: string;
  url: string;
  status: number;
  statusText: string;
  requestBody?: string;
  responseBody?: string;
  duration?: number;
  resourceType: string;
  tabIndex: number;
}

const actionsPath = path.join(resolvedDir, 'user-actions.json');
if (!fs.existsSync(actionsPath)) {
  console.error(`❌ user-actions.json 不存在: ${actionsPath}`);
  console.error('   請先用 ./start.sh record 錄製操作');
  process.exit(1);
}

const actions: RecordedAction[] = JSON.parse(fs.readFileSync(actionsPath, 'utf-8'));
console.log(`📥 載入 ${actions.length} 個 user actions`);

let networkEntries: NetworkEntry[] = [];
const networkPath = path.join(resolvedDir, 'network.json');
if (fs.existsSync(networkPath)) {
  networkEntries = JSON.parse(fs.readFileSync(networkPath, 'utf-8'));
  console.log(`📥 載入 ${networkEntries.length} 個 network entries`);
}

let transcriptText = '';
const transcriptPath = path.join(resolvedDir, 'transcript.md');
if (fs.existsSync(transcriptPath)) {
  transcriptText = fs.readFileSync(transcriptPath, 'utf-8');
  console.log(`📥 載入 transcript`);
}

// ─── Action Processing ──────────────────────────────────────
// generateSteps / selectorComment / escapeString / extractApiPathPattern
// 已抽到 src/shared/action-to-playwright.ts（單一真相來源），此處直接複用。

// ─── Code Generation ────────────────────────────────────────

function generateTestCode(sessionName: string, steps: ProcessedStep[]): string {
  const lines: string[] = [];

  lines.push(`import { test, expect } from '@playwright/test';`);
  lines.push('');
  lines.push(`/**`);
  lines.push(` * 自動生成自 vox-trace 錄製 session: ${sessionName}`);
  lines.push(` * 生成時間: ${new Date().toISOString()}`);
  lines.push(` *`);
  lines.push(` * 此測試為「所錄即所得」的原始回放。`);
  lines.push(` * 如需參數化，請使用 ./start.sh parameterize ${sessionName}`);
  lines.push(` */`);
  lines.push('');
  lines.push(`test.describe('recorded: ${sessionName}', () => {`);
  lines.push('');

  // Extract first transcript as describe comment
  const firstTranscript = steps.find(s => s.transcriptNote);
  if (firstTranscript?.transcriptNote) {
    lines.push(`  ${firstTranscript.transcriptNote}`);
    lines.push('');
  }

  lines.push(`  test('回放錄製操作', async ({ page, context }) => {`);
  lines.push(`    test.setTimeout(120_000); // 2 分鐘超時`);
  lines.push('');

  let stepNum = 0;
  for (const step of steps) {
    stepNum++;

    // Transcript note
    if (step.transcriptNote) {
      lines.push(`    ${step.transcriptNote}`);
    }

    // Step comment
    lines.push(`    // --- Step ${stepNum}: ${step.comment} ---`);

    // Selector strategies comment
    if (step.selectorComment) {
      lines.push(`    ${step.selectorComment}`);
    }

    // Code
    lines.push(step.code);
    lines.push('');
  }

  lines.push('  });');
  lines.push('});');
  lines.push('');

  return lines.join('\n');
}

// ─── Main ───────────────────────────────────────────────────

function main() {
  if (actions.length === 0) {
    console.warn('⚠️  user-actions.json 為空，沒有錄製到任何操作');
    console.warn('   可能原因：頁面的 JavaScript 未成功注入，或操作時間太短');
    process.exit(0);
  }

  // Sort actions by timestamp (more accurate than seq for debounced events)
  const sorted = [...actions].sort((a, b) => a.timestamp - b.timestamp);

  // Filter out noise: remove consecutive navigate events with same URL
  const filtered = sorted.filter((action, i) => {
    if (action.type === 'navigate' && i > 0) {
      const prev = sorted[i - 1];
      if (prev.type === 'navigate' && prev.value === action.value) return false;
    }
    return true;
  });

  console.log(`\n🔧 處理 ${filtered.length} 個有效動作（原始 ${sorted.length} 個）`);

  // Generate steps
  const steps = generateSteps(filtered);

  // Generate test code
  const sessionName = path.basename(resolvedDir);
  const code = generateTestCode(sessionName, steps);

  // Write output
  fs.writeFileSync(outputPath, code, 'utf-8');
  console.log(`\n✅ 已生成: ${outputPath}`);
  console.log(`   ${steps.length} 個測試步驟`);

  // Count API assertions
  const apiAssertions = steps.filter(s => s.apiInfo).length;
  console.log(`   ${apiAssertions} 個 API 斷言`);

  // Run if requested
  if (runAfter) {
    console.log('\n▶ 執行回放...\n');
    const { execSync } = require('child_process');
    try {
      execSync(
        `npx playwright test "${outputPath}" ${headed ? '--headed' : ''} --reporter=list`,
        { stdio: 'inherit' }
      );
    } catch {
      console.error('\n❌ 回放執行失敗');
      process.exit(1);
    }
  }
}

main();
