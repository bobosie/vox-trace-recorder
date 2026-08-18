/**
 * generate-spec.test.ts — parseSpecArgs 單元測試 + --out-dir 整合測試（CLI 子行程）
 * 執行：npx tsx --test src/generate-spec.test.ts
 *
 * 回歸重點：2026-08-05 修掉的 bug——無 --out-dir 時 sessionDir 被誤排除（outDirIdx=-1→+1=0）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseSpecArgs } from './generate-spec';

// ─── 單元：parseSpecArgs ────────────────────────────────────
test('無旗標：單一 session 參數不被吃掉（回歸 index-0 bug）', () => {
  const r = parseSpecArgs(['recordings/foo']);
  assert.equal(r.sessionDir, 'recordings/foo');
  assert.equal(r.outDir, undefined);
  assert.equal(r.outDirFlagPresent, false);
});

test('--out-dir 在 session 之後', () => {
  const r = parseSpecArgs(['recordings/foo', '--out-dir', '/tmp/out']);
  assert.equal(r.sessionDir, 'recordings/foo');
  assert.equal(r.outDir, '/tmp/out');
  assert.equal(r.outDirFlagPresent, true);
});

test('--out-dir 在 session 之前（out-dir 值不被當 session）', () => {
  const r = parseSpecArgs(['--out-dir', '/tmp/out', 'recordings/foo']);
  assert.equal(r.sessionDir, 'recordings/foo');
  assert.equal(r.outDir, '/tmp/out');
});

test('--out-dir 缺值：flag present 但 outDir undefined（CLI 會報錯）', () => {
  const r = parseSpecArgs(['recordings/foo', '--out-dir']);
  assert.equal(r.sessionDir, 'recordings/foo');
  assert.equal(r.outDir, undefined);
  assert.equal(r.outDirFlagPresent, true);
});

// ─── 整合：CLI 實跑，--out-dir 讓 spec 落在指定目錄（repo 外 session 場景）──
function makeSyntheticSession(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-cli-'));
  const sess = path.join(root, 'sess-1');
  fs.mkdirSync(sess, { recursive: true });
  fs.writeFileSync(path.join(sess, 'metadata.json'), JSON.stringify({
    sessionId: 'sess-1', startTime: '2026-08-05T00:00:00Z', baseUrl: 'https://x', urls: [],
    screenshotCount: 0, networkEntryCount: 0, tabCount: 1, periodicScreenshotCount: 0,
    codegenEnabled: false, pmMode: true, errors: [], endTime: '2026-08-05T00:01:00Z',
  }), 'utf-8');
  fs.writeFileSync(path.join(sess, 'network.json'), '[]', 'utf-8');
  fs.writeFileSync(path.join(sess, 'user-actions.json'), '[]', 'utf-8');
  return sess;
}

test('CLI --out-dir 把 spec 寫進指定目錄（session 在 repo 外也可）', () => {
  const sess = makeSyntheticSession();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-out-'));
  const repoRoot = path.resolve(__dirname, '..');

  execFileSync('npx', ['tsx', 'src/generate-spec.ts', sess, '--out-dir', outDir], {
    cwd: repoRoot, stdio: 'pipe',
  });

  const expected = path.join(outDir, 'sess-1.spec.yaml');
  assert.ok(fs.existsSync(expected), `spec 應落在 --out-dir: ${expected}`);
  const body = fs.readFileSync(expected, 'utf-8');
  assert.match(body, /sess-1/);
});
