/**
 * Parameterize — 自動偵測可參數化的值並生成參數化測試
 *
 * 分析 user-actions.json 中的 value 欄位 + network.json 中的 request body，
 * 自動偵測帳號/密碼/OTP/金額/URL 等可參數化的值，生成：
 * 1. {session}.parameterized.spec.ts — 使用變數的測試
 * 2. {session}.data.yaml — 預設值 + 備選值
 *
 * Usage:
 *   npx tsx src/parameterize.ts <session-dir> [--output-dir <path>]
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { RecordedAction } from './dom-recorder';

// ─── CLI ────────────────────────────────────────────────────

const args = process.argv.slice(2);
const sessionDir = args[0];

if (!sessionDir) {
  console.error('❌ 用法: npx tsx src/parameterize.ts <session-dir>');
  process.exit(1);
}

const resolvedDir = path.resolve(sessionDir);
if (!fs.existsSync(resolvedDir)) {
  console.error(`❌ Session 目錄不存在: ${resolvedDir}`);
  process.exit(1);
}

const outputDirIdx = args.indexOf('--output-dir');
const outputDir = outputDirIdx !== -1 && args[outputDirIdx + 1]
  ? path.resolve(args[outputDirIdx + 1])
  : resolvedDir;

// ─── Load Data Sources ──────────────────────────────────────

const actionsPath = path.join(resolvedDir, 'user-actions.json');
if (!fs.existsSync(actionsPath)) {
  console.error(`❌ user-actions.json 不存在`);
  process.exit(1);
}

const actions: RecordedAction[] = JSON.parse(fs.readFileSync(actionsPath, 'utf-8'));
console.log(`📥 載入 ${actions.length} 個 user actions`);

interface NetworkEntry {
  timestamp: string;
  method: string;
  url: string;
  status: number;
  requestBody?: string;
  responseBody?: string;
  resourceType: string;
  tabIndex: number;
}

let networkEntries: NetworkEntry[] = [];
const networkPath = path.join(resolvedDir, 'network.json');
if (fs.existsSync(networkPath)) {
  networkEntries = JSON.parse(fs.readFileSync(networkPath, 'utf-8'));
  console.log(`📥 載入 ${networkEntries.length} 個 network entries`);
}

// ─── Parameter Detection ────────────────────────────────────

interface DetectedParam {
  name: string;           // e.g. "username", "password", "otp_code"
  varName: string;        // e.g. "ENV.adminAccount", "testData.username"
  originalValue: string;  // the actual value found
  detectedBy: string;     // how it was detected
  actionIndices: number[]; // which actions contain this value
}

const detectedParams: DetectedParam[] = [];
const valueToParam = new Map<string, string>(); // original value → param varName

// Detect login credentials from API calls
function detectFromApi(): void {
  const apiEntries = networkEntries.filter(
    e => (e.resourceType === 'xhr' || e.resourceType === 'fetch') && e.requestBody
  );

  for (const entry of apiEntries) {
    if (!entry.requestBody) continue;

    try {
      const body = JSON.parse(entry.requestBody);
      const urlLower = entry.url.toLowerCase();

      // Username detection
      if (body.username || body.account || body.loginName) {
        const value = body.username || body.account || body.loginName;
        if (!valueToParam.has(value)) {
          registerParam('username', 'testData.username', value, `API ${entry.method} ${shortenUrl(entry.url)}`);
        }
      }

      // Password detection
      if (body.password || body.pwd) {
        const value = body.password || body.pwd;
        if (!valueToParam.has(value)) {
          registerParam('password', 'testData.password', value, `API ${entry.method} ${shortenUrl(entry.url)}`);
        }
      }

      // OTP detection
      if (body.code || body.otp || body.verifyCode || body.googleCode) {
        const value = String(body.code || body.otp || body.verifyCode || body.googleCode);
        if (/^\d{6}$/.test(value) && !valueToParam.has(value)) {
          registerParam('otp_code', 'otp', value, `API ${entry.method} ${shortenUrl(entry.url)}`);
        }
      }

      // Amount detection
      if (body.amount || body.money) {
        const value = String(body.amount || body.money);
        if (!valueToParam.has(value)) {
          registerParam('amount', 'testData.amount', value, `API ${entry.method} ${shortenUrl(entry.url)}`);
        }
      }

      // Site ID detection
      if (body.siteId || body.site_id || body.siteCode) {
        const value = String(body.siteId || body.site_id || body.siteCode);
        if (!valueToParam.has(value)) {
          registerParam('site_id', 'testData.siteId', value, `API ${entry.method} ${shortenUrl(entry.url)}`);
        }
      }
    } catch {}
  }
}

// Detect from action values
function detectFromActions(): void {
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    if (!action.value) continue;

    const value = action.value;

    // Password fields (by input type)
    if (action.inputType === 'password' && !valueToParam.has(value)) {
      registerParam('password', 'testData.password', value, `input[type=password]`, [i]);
      continue;
    }

    // OTP (6-digit number)
    if (/^\d{6}$/.test(value) && !valueToParam.has(value)) {
      const isOtpContext = action.placeholder?.toLowerCase().includes('otp')
        || action.placeholder?.toLowerCase().includes('驗證')
        || action.placeholder?.toLowerCase().includes('code')
        || action.correlatedApi?.endpoint.includes('verify')
        || action.correlatedApi?.endpoint.includes('2fa')
        || action.correlatedApi?.endpoint.includes('otp');
      if (isOtpContext) {
        registerParam('otp_code', 'otp', value, `6-digit + OTP context`, [i]);
        continue;
      }
    }

    // Username (near login API or in username-like input)
    if (!valueToParam.has(value)) {
      const isUsernameContext = action.selectorStrategies?.dataTest?.includes('username')
        || action.selectorStrategies?.dataTest?.includes('account')
        || action.placeholder?.toLowerCase().includes('帳號')
        || action.placeholder?.toLowerCase().includes('account')
        || action.placeholder?.toLowerCase().includes('username');
      if (isUsernameContext) {
        registerParam('username', 'testData.username', value, `username-like input`, [i]);
        continue;
      }
    }

    // Amount (numeric value in amount-like context)
    if (/^\d+(\.\d+)?$/.test(value) && parseFloat(value) > 0 && !valueToParam.has(value)) {
      const isAmountContext = action.selectorStrategies?.dataTest?.includes('amount')
        || action.placeholder?.toLowerCase().includes('金額')
        || action.placeholder?.toLowerCase().includes('amount')
        || action.correlatedApi?.endpoint.includes('deposit')
        || action.correlatedApi?.endpoint.includes('withdraw');
      if (isAmountContext) {
        registerParam('amount', 'testData.amount', value, `amount-like input`, [i]);
        continue;
      }
    }

    // Search keywords
    if (!valueToParam.has(value) && value.length > 0) {
      const isSearchContext = action.selectorStrategies?.dataTest?.includes('search')
        || action.placeholder?.toLowerCase().includes('搜尋')
        || action.placeholder?.toLowerCase().includes('search')
        || action.placeholder?.toLowerCase().includes('關鍵字');
      if (isSearchContext) {
        registerParam('search_keyword', 'testData.searchKeyword', value, `search-like input`, [i]);
      }
    }
  }
}

// Detect URLs that should be parameterized
function detectUrls(): void {
  const urls = new Set<string>();
  for (const action of actions) {
    if (action.url) {
      try {
        const u = new URL(action.url);
        urls.add(u.origin);
      } catch {}
    }
    if (action.type === 'navigate' && action.value) {
      try {
        const u = new URL(action.value);
        urls.add(u.origin);
      } catch {}
    }
  }

  // Detect mgmt and client URLs
  for (const origin of urls) {
    if (origin.includes('mgmt') || origin.includes('admin') || origin.includes('manage')) {
      registerParam('mgmt_url', 'ENV.mgmtUrl', origin, 'URL contains mgmt/admin');
    } else if (origin.includes('client') || origin.includes('site-client')) {
      registerParam('client_url', 'ENV.clientUrl', origin, 'URL contains client');
    } else if (!origin.includes('localhost') && !origin.includes('file://')) {
      registerParam('base_url', 'ENV.baseUrl', origin, 'external URL');
    }
  }
}

function registerParam(name: string, varName: string, value: string, detectedBy: string, actionIndices?: number[]): void {
  // Don't register empty values
  if (!value || value.trim() === '') return;

  // Check for existing param with same name
  const existing = detectedParams.find(p => p.name === name);
  if (existing) {
    if (actionIndices) existing.actionIndices.push(...actionIndices);
    return;
  }

  detectedParams.push({
    name,
    varName,
    originalValue: value,
    detectedBy,
    actionIndices: actionIndices || [],
  });
  valueToParam.set(value, varName);
}

function shortenUrl(url: string): string {
  try { return new URL(url).pathname; } catch { return url; }
}

// ─── Code Generation ────────────────────────────────────────

function escapeString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
}

function generateParamTestCode(sessionName: string): string {
  // Read the raw spec to use as template
  const rawSpecPath = path.join(resolvedDir, `${sessionName}.raw.spec.ts`);
  if (!fs.existsSync(rawSpecPath)) {
    console.error(`❌ 找不到 raw spec: ${rawSpecPath}`);
    console.error('   請先執行 ./start.sh generate');
    process.exit(1);
  }

  const rawCode = fs.readFileSync(rawSpecPath, 'utf-8');

  // Build header (imports + testData)
  const headerLines: string[] = [
    `import { test, expect } from '@playwright/test';`,
    '',
    `/**`,
    ` * 參數化測試 — 自動生成自 vox-trace session: ${sessionName}`,
    ` * 生成時間: ${new Date().toISOString()}`,
    ` *`,
    ` * 參數定義在 ${sessionName}.data.yaml`,
    ` * 修改 data.yaml 的 variants 可自動產生不同測試組合`,
    ` */`,
    '',
  ];

  const hasOtp = detectedParams.some(p => p.name === 'otp_code');
  if (hasOtp) {
    headerLines.push(`import { TOTP } from 'otpauth';`);
  }

  // testData block — uses ORIGINAL values as defaults
  headerLines.push('');
  headerLines.push('const testData = {');
  for (const param of detectedParams) {
    if (param.name === 'otp_code') continue;
    const envName = param.name.toUpperCase();
    if (param.name.endsWith('_url')) {
      headerLines.push(`  ${camelCase(param.name)}: process.env.${envName} || '${escapeString(param.originalValue)}',`);
    } else if (param.name === 'password') {
      headerLines.push(`  ${camelCase(param.name)}: process.env.ADMIN_PASSWORD || '${escapeString(param.originalValue)}',`);
    } else if (param.name === 'username') {
      headerLines.push(`  ${camelCase(param.name)}: process.env.ADMIN_USERNAME || '${escapeString(param.originalValue)}',`);
    } else {
      headerLines.push(`  ${camelCase(param.name)}: '${escapeString(param.originalValue)}',`);
    }
  }
  if (hasOtp) {
    headerLines.push(`  otpSecret: process.env.ADMIN_TOTP_SECRET || 'YOUR_TOTP_SECRET_HERE',`);
  }
  headerLines.push('};');
  headerLines.push('');

  if (hasOtp) {
    headerLines.push('function generateOTP(): string {');
    headerLines.push("  const totp = new TOTP({ secret: testData.otpSecret, algorithm: 'SHA1', digits: 6, period: 30 });");
    headerLines.push('  return totp.generate();');
    headerLines.push('}');
    headerLines.push('');
  }

  // Extract the test body (everything from test.describe onwards)
  const describeMatch = rawCode.match(/test\.describe\([\s\S]*$/);
  if (!describeMatch) {
    console.error('❌ 無法解析 raw spec 的 test.describe 區塊');
    process.exit(1);
  }

  let testBody = describeMatch[0];

  // Replace values ONLY in the test body (not in the header)
  for (const param of detectedParams) {
    const escaped = escapeRegex(param.originalValue);

    if (param.name === 'password') {
      testBody = testBody.replace(
        /'\*\*\*\*' \/\* TODO: 替換為 ENV\.password \*\//g,
        'testData.password'
      );
      testBody = testBody.replace(
        new RegExp(`'${escaped}'`, 'g'),
        'testData.password'
      );
    } else if (param.name === 'otp_code') {
      testBody = testBody.replace(
        new RegExp(`'${escaped}'`, 'g'),
        'generateOTP()'
      );
    } else if (param.name === 'username') {
      testBody = testBody.replace(
        new RegExp(`'${escaped}'`, 'g'),
        'testData.username'
      );
    } else if (param.name === 'amount') {
      testBody = testBody.replace(
        new RegExp(`'${escaped}'`, 'g'),
        'String(testData.amount)'
      );
    } else if (param.name.endsWith('_url')) {
      const varRef = `testData.${camelCase(param.name)}`;
      const origin = param.originalValue;
      testBody = testBody.replace(
        new RegExp(`'${escapeRegex(origin)}([^']*)'`, 'g'),
        (_, urlPath) => '`${' + varRef + '}' + urlPath + '`'
      );
    } else if (param.name === 'search_keyword') {
      testBody = testBody.replace(
        new RegExp(`'${escaped}'`, 'g'),
        'testData.searchKeyword'
      );
    } else if (param.name === 'site_id') {
      testBody = testBody.replace(
        new RegExp(`'${escaped}'`, 'g'),
        'testData.siteId'
      );
    }
  }

  return headerLines.join('\n') + '\n' + testBody + '\n';
}

function generateDataYaml(sessionName: string): string {
  const data: any = {
    session: sessionName,
    generated: new Date().toISOString(),
    defaults: {} as Record<string, any>,
    variants: [] as any[],
  };

  for (const param of detectedParams) {
    if (param.name === 'otp_code') {
      data.defaults.otp_secret = 'YOUR_TOTP_SECRET_HERE';
    } else if (param.name === 'password') {
      data.defaults[param.name] = param.originalValue;
    } else {
      data.defaults[param.name] = param.originalValue;
    }
  }

  // Generate example variants
  if (detectedParams.some(p => p.name === 'username')) {
    data.variants.push({
      name: '子品牌帳號',
      username: 'sb1',
      otp_secret: 'SB1_TOTP_SECRET',
    });
  }

  if (detectedParams.some(p => p.name === 'amount')) {
    data.variants.push({
      name: '大額',
      amount: 999999,
    });
    data.variants.push({
      name: '最小額',
      amount: 1,
    });
  }

  return yaml.dump(data, { indent: 2, lineWidth: 120 });
}

// ─── Helpers ────────────────────────────────────────────────

function camelCase(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Main ───────────────────────────────────────────────────

function main() {
  const sessionName = path.basename(resolvedDir);

  console.log('\n🔍 偵測可參數化的值...\n');

  detectFromApi();
  detectFromActions();
  detectUrls();

  if (detectedParams.length === 0) {
    console.log('⚠️  未偵測到可參數化的值');
    console.log('   可能原因：操作中沒有帳號/密碼/金額等典型參數');
    return;
  }

  console.log(`✅ 偵測到 ${detectedParams.length} 個參數：\n`);
  for (const param of detectedParams) {
    const maskedValue = param.name === 'password' ? '****' : param.originalValue;
    console.log(`   ${param.name.padEnd(16)} = ${maskedValue.slice(0, 40).padEnd(42)} (${param.detectedBy})`);
  }

  // Generate parameterized spec
  const paramCode = generateParamTestCode(sessionName);
  const paramSpecPath = path.join(outputDir, `${sessionName}.parameterized.spec.ts`);
  fs.writeFileSync(paramSpecPath, paramCode, 'utf-8');
  console.log(`\n📄 已生成: ${paramSpecPath}`);

  // Generate data YAML
  const dataYaml = generateDataYaml(sessionName);
  const dataYamlPath = path.join(outputDir, `${sessionName}.data.yaml`);
  fs.writeFileSync(dataYamlPath, dataYaml, 'utf-8');
  console.log(`📄 已生成: ${dataYamlPath}`);

  console.log('\n💡 使用方式：');
  console.log(`   1. 修改 ${sessionName}.data.yaml 中的 defaults 和 variants`);
  console.log(`   2. 設定環境變數（ADMIN_PASSWORD, ADMIN_TOTP_SECRET 等）`);
  console.log(`   3. 執行: npx playwright test ${paramSpecPath}`);
}

main();
