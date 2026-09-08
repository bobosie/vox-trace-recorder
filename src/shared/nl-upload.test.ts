/**
 * nl-upload 的純函式單元測試。
 *
 * 這裡只測「不需要網路、不需要檔案系統」的那幾層——設定解析、名稱轉換、
 * tar 打包。真正的上傳（HTTP）由整合驗證負責，不在這裡假造 server。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as zlib from 'zlib';

import {
  parseEnvFile,
  resolveUploadConfig,
  toUploadName,
  buildTarGz,
  UPLOAD_NAME_RE,
} from './nl-upload';

describe('parseEnvFile', () => {
  test('解析基本的 KEY=VALUE', () => {
    const got = parseEnvFile('NL_RECALL_SERVER=http://10.0.0.1:7654\nNL_RECALL_TOKEN=abc\n');
    assert.strictEqual(got.NL_RECALL_SERVER, 'http://10.0.0.1:7654');
    assert.strictEqual(got.NL_RECALL_TOKEN, 'abc');
  });

  test('略過空行與註解', () => {
    const got = parseEnvFile('# 註解\n\nA=1\n  # 縮排註解\nB=2\n');
    assert.deepStrictEqual(got, { A: '1', B: '2' });
  });

  test('值裡面的 = 不被切斷（token 可能含 =）', () => {
    const got = parseEnvFile('NL_RECALL_TOKEN=aa==bb=\n');
    assert.strictEqual(got.NL_RECALL_TOKEN, 'aa==bb=');
  });

  test('剝掉鍵與值前後的空白，以及 CRLF 的 \\r', () => {
    // Windows 上這個檔可能是 CRLF——殘留的 \r 會變成 token 的一部分，
    // 送出去的 Authorization header 就多一個字元，server 回 401 而看不出原因。
    const got = parseEnvFile('  A = 1 \r\nB=2\r\n');
    assert.strictEqual(got.A, '1');
    assert.strictEqual(got.B, '2');
  });

  test('沒有 = 的行整行略過，不當成空值的鍵', () => {
    const got = parseEnvFile('這是一行說明文字\nA=1\n');
    assert.deepStrictEqual(got, { A: '1' });
  });
});

describe('resolveUploadConfig', () => {
  test('env 檔有 NL_RECALL_SERVER 就啟用', () => {
    const cfg = resolveUploadConfig({
      env: {},
      envFileText: 'NL_RECALL_SERVER=http://s:7654\nNL_RECALL_TOKEN=tok\n',
    });
    assert.strictEqual(cfg.enabled, true);
    assert.strictEqual(cfg.server, 'http://s:7654');
    assert.strictEqual(cfg.token, 'tok');
  });

  test('完全沒有 NL 設定就不啟用——AX 版裝的錄影器不能誤傳到 NL server', () => {
    const cfg = resolveUploadConfig({ env: {}, envFileText: null });
    assert.strictEqual(cfg.enabled, false);
    assert.strictEqual(cfg.reason, 'no-nl-config');
  });

  test('NL_AUTO_UPLOAD=0 關閉自動上傳（設定檔）', () => {
    const cfg = resolveUploadConfig({
      env: {},
      envFileText: 'NL_RECALL_SERVER=http://s:7654\nNL_AUTO_UPLOAD=0\n',
    });
    assert.strictEqual(cfg.enabled, false);
    assert.strictEqual(cfg.reason, 'opt-out');
  });

  test('NL_AUTO_UPLOAD=0 關閉自動上傳（環境變數）', () => {
    const cfg = resolveUploadConfig({
      env: { NL_AUTO_UPLOAD: '0' },
      envFileText: 'NL_RECALL_SERVER=http://s:7654\n',
    });
    assert.strictEqual(cfg.enabled, false);
    assert.strictEqual(cfg.reason, 'opt-out');
  });

  test('環境變數蓋過設定檔', () => {
    const cfg = resolveUploadConfig({
      env: { NL_RECALL_SERVER: 'http://override:7654' },
      envFileText: 'NL_RECALL_SERVER=http://s:7654\n',
    });
    assert.strictEqual(cfg.server, 'http://override:7654');
  });

  test('NL_DEBUG_SERVER 優先於 NL_RECALL_SERVER（與 vox-nl-ship 同序）', () => {
    const cfg = resolveUploadConfig({
      env: {},
      envFileText: 'NL_RECALL_SERVER=http://recall:7654\nNL_DEBUG_SERVER=http://debug:7654\n',
    });
    assert.strictEqual(cfg.server, 'http://debug:7654');
  });

  test('尾斜線去掉，避免組出 //debug/upload', () => {
    const cfg = resolveUploadConfig({
      env: {},
      envFileText: 'NL_RECALL_SERVER=http://s:7654/\n',
    });
    assert.strictEqual(cfg.server, 'http://s:7654');
  });

  test('環境變數是空字串時 fallback 回設定檔，不把有效值蓋掉', () => {
    // shell/launchd 裡 `export NL_RECALL_SERVER="$SOMETHING"` 而 SOMETHING 未設時，
    // 環境變數會是空字串。用 ?? 串接的話空字串不算 nullish，會蓋掉設定檔的有效值
    // → 自動上傳靜默停用，症狀跟「根本沒做這個功能」一模一樣，連橫幅都不會印。
    const cfg = resolveUploadConfig({
      env: { NL_RECALL_SERVER: '' },
      envFileText: 'NL_RECALL_SERVER=http://s:7654\nNL_RECALL_TOKEN=tok\n',
    });
    assert.strictEqual(cfg.enabled, true);
    assert.strictEqual(cfg.server, 'http://s:7654');
    assert.strictEqual(cfg.token, 'tok');
  });

  test('環境變數只有空白也算沒設', () => {
    const cfg = resolveUploadConfig({
      env: { NL_RECALL_SERVER: '   ' },
      envFileText: 'NL_RECALL_SERVER=http://s:7654\n',
    });
    assert.strictEqual(cfg.server, 'http://s:7654');
  });

  test('NL_AUTO_UPLOAD 是空字串時不當成關閉，沿用設定檔', () => {
    const cfg = resolveUploadConfig({
      env: { NL_AUTO_UPLOAD: '' },
      envFileText: 'NL_RECALL_SERVER=http://s:7654\nNL_AUTO_UPLOAD=0\n',
    });
    assert.strictEqual(cfg.enabled, false);
    assert.strictEqual(cfg.reason, 'opt-out');
  });

  test('有 server 沒 token 仍啟用（server 端可能免 token）', () => {
    const cfg = resolveUploadConfig({ env: {}, envFileText: 'NL_RECALL_SERVER=http://s:7654\n' });
    assert.strictEqual(cfg.enabled, true);
    assert.strictEqual(cfg.token, '');
  });
});

describe('toUploadName', () => {
  const AT = new Date('2026-09-04T11:34:56Z');

  test('本來就合法的名字原樣送出', () => {
    assert.strictEqual(toUploadName('debug-20260904-1', AT), 'debug-20260904-1');
  });

  test('中文名轉成 server 收得下的名字', () => {
    // sanitizeSessionName 刻意保留中文（給人看的目錄名），但 server 的
    // X-Vox-Session 只收 [A-Za-z0-9._-]。不轉的話整包會被 400 退回。
    const got = toUploadName('改資料測試', AT);
    assert.match(got, UPLOAD_NAME_RE);
  });

  test('同一場錄製轉出來的名字是穩定的', () => {
    assert.strictEqual(toUploadName('改資料測試', AT), toUploadName('改資料測試', AT));
  });

  test('中英混合保留得住的 ASCII 片段，方便人辨認', () => {
    const got = toUploadName('後台bug-123', AT);
    assert.match(got, UPLOAD_NAME_RE);
    assert.ok(got.includes('bug-123'), `應保留可辨認片段，實際是 ${got}`);
  });

  test('開頭非英數會被修掉（server 要求首字元是英數）', () => {
    const got = toUploadName('__leading', AT);
    assert.match(got, UPLOAD_NAME_RE);
  });

  test('超長名字截到 64 以內', () => {
    const got = toUploadName('a'.repeat(200), AT);
    assert.match(got, UPLOAD_NAME_RE);
    assert.ok(got.length <= 64, `實際長度 ${got.length}`);
  });

  test('完全沒有可用字元時仍產出合法名字', () => {
    const got = toUploadName('。、！', AT);
    assert.match(got, UPLOAD_NAME_RE);
  });
});

describe('buildTarGz', () => {
  test('產出的是合法 gzip', () => {
    const tgz = buildTarGz([{ path: 'sess/a.txt', body: Buffer.from('hello') }]);
    const raw = zlib.gunzipSync(tgz);
    assert.ok(raw.length > 0);
  });

  test('tar header 帶得動檔名、大小與內容', () => {
    const body = Buffer.from('hello world');
    const raw = zlib.gunzipSync(buildTarGz([{ path: 'sess/a.txt', body }]));
    assert.strictEqual(raw.subarray(0, 11).toString(), 'sess/a.txt\0');
    // size 是八進位、11 位數
    assert.strictEqual(raw.subarray(124, 135).toString(), body.length.toString(8).padStart(11, '0'));
    assert.strictEqual(raw.subarray(512, 512 + body.length).toString(), 'hello world');
  });

  test('checksum 算得對——算錯的話 server 端 tarfile 會直接拒收整包', () => {
    const raw = zlib.gunzipSync(buildTarGz([{ path: 'sess/a.txt', body: Buffer.from('x') }]));
    const stored = parseInt(raw.subarray(148, 156).toString().replace(/\0.*/, '').trim(), 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : raw[i];
    assert.strictEqual(stored, sum);
  });

  test('內容補齊到 512 的倍數，並以兩個空區塊收尾', () => {
    const raw = zlib.gunzipSync(buildTarGz([{ path: 'sess/a.txt', body: Buffer.from('x') }]));
    // 1 header + 1 content + 2 trailer = 4 blocks
    assert.strictEqual(raw.length, 512 * 4);
    assert.ok(raw.subarray(1024).every(b => b === 0));
  });

  test('多個檔案依序排好', () => {
    const raw = zlib.gunzipSync(buildTarGz([
      { path: 'sess/a.txt', body: Buffer.from('aa') },
      { path: 'sess/b.txt', body: Buffer.from('bb') },
    ]));
    assert.strictEqual(raw.subarray(0, 10).toString(), 'sess/a.txt');
    assert.strictEqual(raw.subarray(1024, 1034).toString(), 'sess/b.txt');
  });

  test('超過 100 字元的路徑用 ustar prefix 欄位帶，不截斷檔名', () => {
    const deep = 'sess/' + 'd'.repeat(60) + '/' + 'f'.repeat(60) + '.png';
    const raw = zlib.gunzipSync(buildTarGz([{ path: deep, body: Buffer.from('x') }]));
    const name = raw.subarray(0, 100).toString().replace(/\0+$/, '');
    const prefix = raw.subarray(345, 500).toString().replace(/\0+$/, '');
    assert.strictEqual(prefix + '/' + name, deep);
  });

  test('連 prefix 都塞不下時明確拋錯，不靜默送出壞掉的包', () => {
    const tooDeep = 'sess/' + ('x'.repeat(90) + '/').repeat(4) + 'f.png';
    assert.throws(() => buildTarGz([{ path: tooDeep, body: Buffer.from('x') }]), /路徑太長/);
  });

  test('ustar magic 有寫，否則某些 tar 實作會當成古早格式', () => {
    const raw = zlib.gunzipSync(buildTarGz([{ path: 'sess/a.txt', body: Buffer.from('x') }]));
    assert.strictEqual(raw.subarray(257, 263).toString(), 'ustar\0');
  });
});
