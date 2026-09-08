/**
 * generate-index.test.ts — buildIndex / renderCatalog 單元測試
 * 執行：npx tsx --test src/generate-index.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { buildIndex, renderCatalog } from './generate-index';

function writeSpec(dir: string, name: string, body: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body, 'utf-8');
}

function makeFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idxtest-'));
  const specs = path.join(root, 'specs');

  // 完整程序：有 acts + assertions
  writeSpec(path.join(specs, 'lifecycle'), 'a.spec.yaml',
    'spec_version: "1.0"\ntitle: "A 生命週期"\ndomain: lifecycle\nfeature: new-site\ne2e_status: reviewed\n' +
    'description: "全流程驗收"\ntags: [smoke, critical]\npriority: critical\n' +
    'recorded_from:\n  session_id: "sess-a"\n' +
    'acts:\n  - id: act1\n    assertions:\n      - {type: api}\n      - {type: url}\n');

  // _inbox：無 domain、無 e2e_status → unsorted / draft；acts 0
  writeSpec(path.join(specs, '_inbox'), 'b.spec.yaml',
    'spec_version: "1.0"\ntitle: "B 草稿"\npriority: high\nrecorded_from:\n  session_id: "sess-b"\n');

  // checkout：domain 從目錄推導；draft
  writeSpec(path.join(specs, 'checkout'), 'c.spec.yaml',
    'spec_version: "1.0"\ntitle: "C 結帳"\ntags: [checkout]\npriority: medium\n');

  // 巢狀：domain 取第一層 deposit
  writeSpec(path.join(specs, 'deposit', 'sub'), 'd.spec.yaml',
    'spec_version: "1.0"\ntitle: "D 存款"\npriority: low\n');

  // 可複用步驟片段
  writeSpec(path.join(specs, '_shared'), 's.step.yaml',
    'step_id: mgmt-login\ntitle: "後台登入"\nintent: "登入取得權限"\n' +
    'vone_e2e_helper: "totp.ts::loginWith2FA"\nassertions:\n  - {type: api}\n');

  fs.writeFileSync(path.join(specs, 'lifecycle', 'notes.md'), '# not a spec\n', 'utf-8');
  return specs;
}

test('收 *.spec.yaml + *.step.yaml，忽略其他；spec/step 計數', () => {
  const idx = buildIndex(makeFixture());
  assert.equal(idx.total, 5);
  assert.equal(idx.specs, 4);
  assert.equal(idx.steps, 1);
});

test('entries 依 path 排序（穩定輸出）', () => {
  const idx = buildIndex(makeFixture());
  const paths = idx.entries.map(s => s.path);
  assert.deepEqual(paths, [...paths].sort());
});

test('spec：acts / assertions 計數 + description', () => {
  const idx = buildIndex(makeFixture());
  const a = idx.entries.find(s => s.title === 'A 生命週期')!;
  assert.equal(a.kind, 'spec');
  assert.equal(a.acts, 1);
  assert.equal(a.assertions, 2);
  assert.equal(a.domain, 'lifecycle');
  assert.equal(a.e2e_status, 'reviewed');
  assert.equal(a.description, '全流程驗收');
});

test('step 片段：kind=step、domain=_shared、e2e_status=reusable、帶 helper 與 intent', () => {
  const idx = buildIndex(makeFixture());
  const s = idx.entries.find(s => s.path.endsWith('s.step.yaml'))!;
  assert.equal(s.kind, 'step');
  assert.equal(s.domain, '_shared');
  assert.equal(s.e2e_status, 'reusable');
  assert.equal(s.vone_e2e_helper, 'totp.ts::loginWith2FA');
  assert.equal(s.description, '登入取得權限'); // 取 intent
  assert.equal(s.assertions, 1);
});

test('_inbox 未標欄位：domain=unsorted、e2e_status 預設 draft', () => {
  const idx = buildIndex(makeFixture());
  const b = idx.entries.find(s => s.title === 'B 草稿')!;
  assert.equal(b.domain, 'unsorted');
  assert.equal(b.e2e_status, 'draft');
  assert.equal(b.acts, 0);
});

test('domain 從第一層目錄推導（非 sub）', () => {
  const idx = buildIndex(makeFixture());
  assert.equal(idx.entries.find(s => s.title === 'C 結帳')!.domain, 'checkout');
  assert.equal(idx.entries.find(s => s.title === 'D 存款')!.domain, 'deposit');
});

test('renderCatalog 產 markdown，含 domain 標題與 helper', () => {
  const md = renderCatalog(buildIndex(makeFixture()));
  assert.match(md, /## lifecycle/);
  assert.match(md, /## _shared/);
  assert.match(md, /loginWith2FA/);
  assert.match(md, /驗證程序目錄/);
});
