/**
 * record-config 純函式測試（node:test）。
 * 執行：npx tsx --test src/shared/record-config.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExtensionConfig, buildStorageInitScripts, parseExtraUrls, shouldAutoUpload } from './record-config';

const HOME = '/Users/tester';
const EXT_A = '/opt/ext-a';
const EXT_B = '/opt/ext-b';
const existsAB = (p: string) => [EXT_A, EXT_B].includes(p);

// 預設不載任何擴充：vox-trace 是分發給團隊的工具，預設值不能指向任何特定
// 個人的擴充路徑（見 ax-marketplace 20260721 org-portability 教訓）。
// 要載入一律由 VOX_EXTENSIONS 或 --extension 明說。

test('預設不載任何擴充（無 env、無旗標）', () => {
  const plan = parseExtensionConfig([], {}, existsAB, HOME);
  assert.equal(plan.disabled, false);
  assert.deepEqual(plan.paths, []);
  assert.deepEqual(plan.missing, []);
});

test('預設情況不會去猜任何路徑（不回報 missing）', () => {
  const plan = parseExtensionConfig([], {}, () => false, HOME);
  assert.deepEqual(plan.paths, []);
  assert.deepEqual(plan.missing, [], '沒有人指定擴充時不該回報「找不到」');
});

test('--no-extensions 完全關閉，且不回報 missing', () => {
  const plan = parseExtensionConfig(['--no-extensions'], { VOX_EXTENSIONS: EXT_A }, existsAB, HOME);
  assert.equal(plan.disabled, true);
  assert.deepEqual(plan.paths, []);
  assert.deepEqual(plan.missing, []);
});

test('--extension 可重複，保持給定順序', () => {
  const plan = parseExtensionConfig(
    ['--extension', EXT_A, '--extension', EXT_B], {}, existsAB, HOME);
  assert.deepEqual(plan.paths, [EXT_A, EXT_B]);
});

test('VOX_EXTENSIONS（冒號分隔）載入指定的擴充', () => {
  const plan = parseExtensionConfig([], { VOX_EXTENSIONS: `${EXT_A}:${EXT_B}` }, existsAB, HOME);
  assert.deepEqual(plan.paths, [EXT_A, EXT_B]);
});

test('VOX_EXTENSIONS 與 --extension 併用時，env 在前', () => {
  const plan = parseExtensionConfig(['--extension', EXT_B], { VOX_EXTENSIONS: EXT_A }, existsAB, HOME);
  assert.deepEqual(plan.paths, [EXT_A, EXT_B]);
});

test('指定了但目錄不存在 → 記 missing 供呼叫端警告，不中斷', () => {
  const plan = parseExtensionConfig([], { VOX_EXTENSIONS: '/opt/not-there' }, () => false, HOME);
  assert.deepEqual(plan.paths, []);
  assert.deepEqual(plan.missing, ['/opt/not-there']);
});

test('VOX_EXTENSIONS 空字串等同沒設', () => {
  const plan = parseExtensionConfig([], { VOX_EXTENSIONS: '' }, existsAB, HOME);
  assert.deepEqual(plan.paths, []);
});

test('重複路徑去重，順序保持首次出現', () => {
  const plan = parseExtensionConfig(['--extension', EXT_A], { VOX_EXTENSIONS: EXT_A }, existsAB, HOME);
  assert.deepEqual(plan.paths, [EXT_A]);
});

test('--extension 在旗標尾端沒帶值時忽略、不當成路徑', () => {
  const plan = parseExtensionConfig(['--extension'], { VOX_EXTENSIONS: EXT_A }, existsAB, HOME);
  assert.deepEqual(plan.paths, [EXT_A]);
});

// ─── storageState → persistent context 注入 ────────────────
// launchPersistentContext 不吃 storageState 選項，要自己把 localStorage 灌回去。

test('每個 origin 產出一段 init script，只在該 origin 生效', () => {
  const scripts = buildStorageInitScripts({
    cookies: [],
    origins: [
      { origin: 'https://a.example', localStorage: [{ name: 'tok', value: '1' }] },
      { origin: 'https://b.example', localStorage: [{ name: 'x', value: 'y' }] },
    ],
  });
  assert.equal(scripts.length, 2);
  assert.ok(scripts[0].includes('https://a.example'));
  assert.ok(scripts[0].includes('tok'));
  assert.ok(!scripts[0].includes('b.example'));
});

test('沒有 origins 時回空陣列', () => {
  assert.deepEqual(buildStorageInitScripts({ cookies: [] }), []);
  assert.deepEqual(buildStorageInitScripts({ cookies: [], origins: [] }), []);
});

test('localStorage 為空的 origin 不產 script', () => {
  const scripts = buildStorageInitScripts({
    cookies: [], origins: [{ origin: 'https://a.example', localStorage: [] }],
  });
  assert.deepEqual(scripts, []);
});

test('值含引號/反斜線/換行不會破壞 script（走 JSON 編碼）', () => {
  const nasty = `a"b\\c\nd</script>`;
  const scripts = buildStorageInitScripts({
    cookies: [], origins: [{ origin: 'https://a.example', localStorage: [{ name: 'k', value: nasty }] }],
  });
  // 模擬頁面端的還原路徑（外層字面值 → JSON.parse → items），值要一字不差
  const literal = scripts[0].match(/JSON\.parse\((".*?")\)/s)![1];
  const items = JSON.parse(JSON.parse(literal));
  assert.deepEqual(items, [{ name: 'k', value: nasty }]);
  // script 本身不得出現未逸出的 </script>（會提前中斷注入）
  assert.ok(!scripts[0].includes('</script>'));
});

// ─── 額外開啟的分頁（--open，可重複） ──────────────────────

test('沒有 --open 時回空陣列', () => {
  assert.deepEqual(parseExtraUrls([]), []);
  assert.deepEqual(parseExtraUrls(['--base-url', 'https://a.example']), []);
});

test('--open 可重複，保持給定順序', () => {
  assert.deepEqual(
    parseExtraUrls(['--open', 'https://a.example', '--open', 'https://b.example']),
    ['https://a.example', 'https://b.example']);
});

test('--open 在尾端沒帶值時忽略', () => {
  assert.deepEqual(parseExtraUrls(['--open']), []);
});

test('--open 後面接的若是另一個旗標，不當成 URL', () => {
  assert.deepEqual(parseExtraUrls(['--open', '--pm-mode']), []);
});

test('重複的 URL 去重', () => {
  assert.deepEqual(
    parseExtraUrls(['--open', 'https://a.example', '--open', 'https://a.example']),
    ['https://a.example']);
});

// ─── 自動上傳（NL 線）────────────────────────────────────────

test('預設開啟自動上傳——真正的開關是「這台有沒有 NL 設定」，由 nl-upload 判斷', () => {
  assert.equal(shouldAutoUpload([], false), true);
});

test('--no-upload 關掉自動上傳', () => {
  assert.equal(shouldAutoUpload(['--no-upload'], false), false);
});

test('PM 模式一律不自動上傳——AX 那條線走 Studio→GDrive，不是 NL server', () => {
  // 我自己的機器同時裝了 AX 與 NL workflow，~/.config/nl-workflow/env 是存在的。
  // 少了這道判斷，PM 錄製會被誤送到 NL server（跨組織外洩，不只是走錯路）。
  assert.equal(shouldAutoUpload([], true), false);
});

test('PM 模式即使沒帶 --no-upload 也不上傳', () => {
  assert.equal(shouldAutoUpload(['--screenshots'], true), false);
});
