/**
 * generate-spec.ts — 從錄製 session 自動產生 spec.yaml 骨架
 *
 * 用法: npx tsx src/generate-spec.ts <session-dir>
 * 產出: spec-schema/specs/{session-id}.spec.yaml
 *
 * v2 改進：
 *   1. Act 按 tab 切換 + API 業務路徑細粒度分段
 *   2. 自動產生 steps（從 API request body 推斷 fill/click/select）
 *   3. 自動產生 assertions（API response + transcript UI 斷言）
 *   4. parameters 三層分類（parameters / variables / 移除 config）
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

// ─── Domain Glossary（從 transcribe.ts 複製核心邏輯）──────

interface DomainGlossary {
  corrections?: Record<string, string>;
  proper_nouns?: string[];
}

function loadGlossary(): DomainGlossary | null {
  const glossaryPath = path.resolve(process.cwd(), 'spec-schema', 'domain-glossary.yaml');
  if (!fs.existsSync(glossaryPath)) return null;
  try {
    const content = fs.readFileSync(glossaryPath, 'utf-8');
    return yaml.load(content) as DomainGlossary;
  } catch (err: any) {
    console.warn(`   ⚠️  Failed to load glossary: ${err.message}`);
    return null;
  }
}

function applyCorrections(text: string, glossary: DomainGlossary): string {
  if (!glossary.corrections) return text;
  let result = text;
  const entries = Object.entries(glossary.corrections)
    .filter(([k]) => k.length > 0)
    .sort((a, b) => b[0].length - a[0].length);
  for (const [wrong, correct] of entries) {
    result = result.split(wrong).join(correct);
  }
  return result;
}

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
  duration: number;
  resourceType: string;
  tabIndex: number;
}

interface UrlEntry {
  timestamp: string;
  url: string;
  title: string;
  tabIndex: number;
}

interface SessionMetadata {
  sessionId: string;
  startTime: string;
  endTime: string;
  baseUrl: string;
  urls: UrlEntry[];
  screenshotCount: number;
  networkEntryCount: number;
  tabCount: number;
  codegenEnabled: boolean;
  errors?: Array<{ timestamp: string; message: string; tabIndex: number }>;
}

interface TranscriptLine {
  timeSeconds: number;
  text: string;
}

interface Step {
  action: string;
  target: string;
  value?: string;
  selector_hint?: string;
  description?: string;
  params?: Record<string, string>;
}

interface Assertion {
  type: string;
  description: string;
  endpoint?: string;
  response_status?: number;
  response_match?: Record<string, any>;
}

interface Act {
  id: string;
  title: string;
  service: string;
  actor: string;
  intent: string;
  intent_raw?: string;
  depends_on?: string[];
  steps?: Step[];
  api?: ApiEntry[];
  assertions?: Assertion[];
  screenshot_ref?: string;
  variables_out?: Record<string, string>;
}

interface ApiEntry {
  endpoint: string;
  role: 'trigger' | 'verify' | 'background';
  request?: { body?: Record<string, any>; content_type?: string };
  response?: { status: number; body?: Record<string, any> };
}

// ─── 業務路徑映射 ─────────────────────────────────────────

/** 從 API endpoint path 的第二段提取業務名稱 */
const BUSINESS_PATH_MAP: Record<string, string> = {
  register: '註冊',
  deposit: '存款',
  withdrawal: '提款',
  withdraw: '提款',
  security: '安全設置',
  login: '登入',
  'launch_url': '遊戲',
  games: '遊戲',
  'bet-record': '注單記錄',
  ledger: '帳戶明細',
  member: '會員管理',
  // 多段路徑（finance/transfer-audit/...）
  'finance/transfer-audit': '存款審批',
  'finance/transfer-all': '存款審批',
  'finance/transfer-review': '提款審核',
  // C1: 稽核任務（不可被合併到其他 act）
  'admin/task': '稽核任務',
  'task/manual': '稽核任務解除',
  // C4: 返水閉環（各自獨立 act，不可合併）
  'client/rebate/claim': '領取返水',
  'client/rebate': '返水查詢',
  'promotion/apply': '返水申請',
  'admin/promotion': '後台優惠審核',
  'promotion/claim': '領取獎勵',
};

/** 活動/優惠相關路徑（注意：返水/稽核路徑已在 BUSINESS_PATH_MAP 優先匹配） */
const ACTIVITY_PATHS = ['client/activity'];

/** 遊戲相關路徑 */
const GAME_PATHS = ['launch_url', 'games', 'game'];

/** 不獨立分段的路徑（歸入前一個 act 的驗證） */
const PASSIVE_PATHS = ['wallet/balance', 'client/deposit/list', 'client/task'];

/** 完全忽略的路徑（初始 config 等，不計入任何 act 分段） */
const IGNORED_PATHS = ['config'];

/** 轉折詞列表 — 同一 tab 內若 transcript 含轉折詞且前後 API 端點業務路徑不同，拆成兩個 act */
const TRANSITION_WORDS = ['接下來', '然後', '那這個時候', '我到後台', '回到前台', '先去', '再去', '那我就'];

// ─── H1: Intent 業務化模板 ────────────────────────────────

const INTENT_TEMPLATES: Record<string, string> = {
  '註冊': '新用戶註冊帳號，建立基礎資料（帳號、密碼、幣別、姓名、生日）',
  '存款': '用戶透過銀行卡存款，上傳轉帳憑證並確認轉帳',
  '登入': '管理員登入後台管理系統（含 2FA 驗證）',
  '存款審批': '管理員審批用戶的銀行卡存款單，確認入款',
  '驗證到帳': '驗證用戶餘額已正確更新',
  '活動/優惠': '領取充值活動獎勵',
  '遊戲': '進入遊戲進行投注（消耗流水）',
  '返水查詢': '查看遊戲流水是否達返水門檻',
  '返水申請': '流水達標後提交返水申請',
  '後台優惠審核': '管理員審核返水/優惠申請',
  '領取獎勵': '領取已通過審核的返水獎勵',
  '領取返水': '領取返水獎勵（稽核/流水達標後）',
  '遊戲操作': '進入遊戲進行投注（消耗流水）',
  '前台操作': '前台頁面操作',
  '稽核任務': '管理員查看用戶稽核任務狀態',
  '稽核任務解除': '管理員解除用戶的未完成稽核任務以允許提款',
  '安全設置': '安全驗證 + 設定提款密碼',
  '提款': '新增銀行卡並提交提款申請',
  '會員管理': '管理員查看會員資料和狀態',
  '提款審核': '管理員進行提款風控審核',
  '帳戶明細': '查看帳戶變動記錄',
  '注單記錄': '查看遊戲注單記錄',
  '翻水': '流水達標後申請翻水/返水獎勵',
};

// ─── H3: 業務斷言模板 ────────────────────────────────────

const BUSINESS_ASSERTIONS: Record<string, Assertion[]> = {
  '註冊': [
    { type: 'url', description: '註冊後跳轉首頁', response_match: { contains: '/home' } },
    { type: 'api', description: '新帳號餘額為 0', endpoint: 'GET /api/v1/wallet/balance', response_match: { 'data.balance': '0' } },
  ],
  '存款': [
    { type: 'element', description: '頁面顯示等待審核', response_match: { text_contains: '等待審核' } },
  ],
  '存款審批': [
    { type: 'element', description: '審批成功提示', response_match: { text_contains: '成功' } },
  ],
  '驗證到帳': [
    { type: 'api', description: '餘額等於存款金額', endpoint: 'GET /api/v1/wallet/balance', response_match: { 'data.balance': '{{amount}}' } },
  ],
  '活動/優惠': [
    { type: 'element', description: '領取成功提示', response_match: { text_contains: '領取成功' } },
    { type: 'api', description: '餘額增加', endpoint: 'GET /api/v1/wallet/balance', response_match: { 'data.balance': '>{{amount}}' } },
  ],
  '遊戲': [
    { type: 'api', description: '遊戲 Session 建立', endpoint: 'GET /Web/SessionInfo', response_match: { online: '1' } },
  ],
  '返水查詢': [
    { type: 'api', description: '返水資訊顯示可申請', endpoint: 'GET /api/v1/client/rebate/info', response_match: { 'data.list[0].can_apply': true } },
  ],
  '返水申請': [
    { type: 'api', description: '返水申請成功', endpoint: 'POST /api/v1/promotion/apply', response_status: 200 },
    { type: 'element', description: '頁面顯示申請成功提示', response_match: { text_contains: '申請成功' } },
  ],
  '領取獎勵': [
    { type: 'element', description: '領取成功提示', response_match: { text_contains: '領取成功' } },
  ],
  '稽核任務解除': [
    { type: 'api', description: '稽核任務解除成功', endpoint: 'POST /api/v1/task/manual/status', response_status: 200 },
  ],
  '安全設置': [
    { type: 'element', description: '設定成功提示', response_match: { text_contains: '成功' } },
  ],
  '提款': [
    { type: 'api', description: '提款凍結餘額減少', endpoint: 'GET /api/v1/wallet/balance', response_match: { 'data.balance': '<{{previous_balance}}' } },
  ],
  '提款審核': [
    { type: 'element', description: '審核成功提示', response_match: { text_contains: '成功' } },
  ],
};

/** 從 URL pathname 提取業務名稱 */
function extractBusinessName(pathname: string): string | null {
  // 移除開頭的 /api/v1/ 或 /api/
  const cleaned = pathname.replace(/^\/api\/(v\d+\/)?/, '');
  const segments = cleaned.split('/');

  // 完全忽略的路徑（不影響分段）
  if (IGNORED_PATHS.some(p => cleaned === p || cleaned.startsWith(p + '/'))) return null;

  // 不獨立分段的被動路徑 → 回傳 null（歸入前一個 act 的驗證）
  for (const p of PASSIVE_PATHS) {
    if (cleaned.startsWith(p)) return null;
  }

  // 多段路徑優先匹配（finance/transfer-audit, admin/task, client/rebate, promotion/apply 等）
  if (segments.length >= 3) {
    const threeSeg = `${segments[0]}/${segments[1]}/${segments[2]}`;
    if (BUSINESS_PATH_MAP[threeSeg]) return BUSINESS_PATH_MAP[threeSeg];
  }
  if (segments.length >= 2) {
    const twoSeg = `${segments[0]}/${segments[1]}`;
    if (BUSINESS_PATH_MAP[twoSeg]) return BUSINESS_PATH_MAP[twoSeg];

    // 活動/優惠
    for (const p of ACTIVITY_PATHS) {
      if (cleaned.startsWith(p)) return '活動/優惠';
    }
  }

  // 單段匹配
  const firstSeg = segments[0];
  if (BUSINESS_PATH_MAP[firstSeg]) return BUSINESS_PATH_MAP[firstSeg];

  // 遊戲
  for (const p of GAME_PATHS) {
    if (firstSeg === p) return '遊戲';
  }

  return null;
}

// ─── Request Body → Steps 推斷 ──────────────────────────

/** 欄位名 → step 動作映射 */
const FIELD_TO_STEP: Record<string, { action: string; target: string; paramName: string }> = {
  username: { action: 'fill', target: '帳號', paramName: 'username' },
  account: { action: 'fill', target: '帳號', paramName: 'username' },
  password: { action: 'fill', target: '密碼', paramName: 'password' },
  real_name: { action: 'fill', target: '姓名', paramName: 'real_name' },
  receiver_name: { action: 'fill', target: '姓名', paramName: 'real_name' },
  amount: { action: 'fill', target: '金額', paramName: 'amount' },
  payment_amount: { action: 'fill', target: '金額', paramName: 'amount' },
  withdraw_amount: { action: 'fill', target: '提款金額', paramName: 'withdrawal_amount' },
  currency: { action: 'select', target: '幣別', paramName: 'currency' },
  birthday: { action: 'fill', target: '生日', paramName: 'birthday' },
  bank_id: { action: 'select', target: '銀行', paramName: 'bank_id' },
  receiver_account_plain: { action: 'fill', target: '卡號', paramName: 'card_number' },
  otp_code: { action: 'fill', target: '2FA 驗證碼', paramName: 'otp_code' },
  new_password: { action: 'fill', target: '新密碼', paramName: 'new_password' },
  withdraw_password: { action: 'fill', target: '提款密碼', paramName: 'withdrawal_password' },
  branch_location: { action: 'fill', target: '開戶行地址', paramName: 'branch_location' },
  client_remark: { action: 'fill', target: '備註', paramName: 'client_remark' },
};

/** 不產生 step 的欄位（config/環境類） */
const CONFIG_FIELDS = new Set([
  'corp_code', 'site_code', 'device_fingerprint', 'device_platform',
  'device_type', 'is_mobile', 'page', 'page_size', 'status',
  'promotion_source_type', 'game_category', 'category_id',
  'exchange_rate', 'payer_wallet_address', 'transfer_receipt_url',
  'payment_channel_info_id', 'provider_code', 'game_code',
  'game_provider_code', 'user_payout_method_id',
  'operation', 'mgmt_remark', 'method',
]);

/** 動態擷取的欄位（variables，不作為 parameters） */
const VARIABLE_PATTERNS = [
  /token$/i, /ticket$/i, /order_id$/i, /^id$/, /^ref_ticket$/,
  /verification_token/i, /^ticket$/, /^tickets$/,
];

function isVariableField(field: string): boolean {
  return VARIABLE_PATTERNS.some(p => p.test(field));
}

function isConfigField(field: string): boolean {
  return CONFIG_FIELDS.has(field);
}

// ─── M5: Selector Hints ──────────────────────────────────

/** action + target → CSS/Playwright selector 提示 */
const SELECTOR_HINTS: Record<string, Record<string, string>> = {
  fill: {
    '帳號': "input[placeholder*='帳號'], input[name='username'], input[name='account']",
    '密碼': "input[type='password']",
    '姓名': "input[placeholder*='姓名'], input[name='real_name']",
    '金額': "input[placeholder*='金額'], input[name='amount']",
    '提款金額': "input[placeholder*='金額'], input[name='withdraw_amount']",
    '生日': "input[type='date'], input[name='birthday']",
    '卡號': "input[placeholder*='卡號'], input[name='receiver_account_plain']",
    '2FA 驗證碼': "input[placeholder*='驗證碼'], input[name='otp_code']",
    '新密碼': "input[type='password'][name*='new']",
    '提款密碼': "input[type='password'][name*='withdraw']",
    '開戶行地址': "input[placeholder*='開戶行'], input[name='branch_location']",
    '備註': "textarea[name*='remark'], input[placeholder*='備註']",
    '搜尋欄位': "input[type='search'], input[placeholder*='搜尋'], input[placeholder*='帳號']",
    '管理員備註': "textarea[name*='remark'], input[placeholder*='備註']",
  },
  select: {
    '幣別': "select[name='currency'], .currency-select, [data-test*='currency']",
    '銀行': "select[name='bank_id'], .bank-select, [data-test*='bank']",
  },
  click: {
    '提交': "button[type='submit'], button:has-text('提交'), button:has-text('確認')",
    '註冊': "button:has-text('註冊'), [data-test='btn-register']",
    '登入': "button:has-text('登入'), [data-test='btn-login']",
    '確認': "button:has-text('確認'), button:has-text('確定')",
    '確認審批': "button:has-text('確認'), button:has-text('確定'), [data-test*='approve']",
    '搜尋': "button:has-text('搜尋'), button:has-text('查詢'), button[type='submit']",
    '強制入款按鈕': "button:has-text('強制入款'), [data-test*='force-deposit']",
  },
};

/** 為 step 附加 selector_hint（如果匹配到） */
function attachSelectorHint(step: Step): void {
  if (step.selector_hint) return; // 已有則不覆蓋
  const actionHints = SELECTOR_HINTS[step.action];
  if (actionHints && actionHints[step.target]) {
    step.selector_hint = actionHints[step.target];
  }
}

/** 從 request body 欄位推斷 steps */
function inferStepsFromBody(bodyKeys: string[]): Step[] {
  const steps: Step[] = [];
  for (const key of bodyKeys) {
    if (isConfigField(key) || isVariableField(key)) continue;
    const mapping = FIELD_TO_STEP[key];
    if (mapping) {
      const step: Step = {
        action: mapping.action,
        target: mapping.target,
        value: `{{${mapping.paramName}}}`,
      };
      attachSelectorHint(step);
      steps.push(step);
    }
  }
  return steps;
}

// ─── Assertions 推斷 ──────────────────────────────────────

/** 從 trigger API 推斷 assertions */
function inferAssertions(
  apis: ApiEntry[],
  transcriptText: string,
): Assertion[] {
  const assertions: Assertion[] = [];

  for (const api of apis) {
    if (api.role !== 'trigger') continue;

    // 1. 每個 trigger API → response_status assertion
    assertions.push({
      type: 'api',
      description: `${api.endpoint} 回應成功`,
      endpoint: api.endpoint,
      response_status: api.response?.status ?? 200,
    });

    // 2. response 含 token → non_empty 斷言
    if (api.response?.body) {
      const bodyKeys = Object.keys(api.response.body);
      if (bodyKeys.some(k => /token/i.test(k))) {
        assertions.push({
          type: 'api',
          description: '取得有效 token',
          endpoint: api.endpoint,
          response_match: { token: '{{non_empty}}' },
        });
      }
    }
  }

  // 3. 有 GET /wallet/balance → 餘額變化驗證
  const hasBalanceCheck = apis.some(a =>
    a.endpoint.includes('/wallet/balance') && a.role === 'verify',
  );
  if (hasBalanceCheck) {
    assertions.push({
      type: 'api',
      description: '餘額變化驗證',
      endpoint: 'GET /api/v1/wallet/balance',
    });
  }

  // 4. 從 transcript 提取 UI 斷言
  if (transcriptText) {
    if (/成功|完成/.test(transcriptText)) {
      assertions.push({
        type: 'ui',
        description: '成功提示訊息',
      });
    }
    if (/彈窗|彈出|跳出/.test(transcriptText)) {
      assertions.push({
        type: 'ui',
        description: '彈窗出現',
      });
    }
    if (/錯誤|失敗|error/i.test(transcriptText)) {
      assertions.push({
        type: 'ui',
        description: '錯誤提示訊息',
      });
    }
  }

  return assertions;
}

// ─── URL 分類 ──────────────────────────────────────────────

function buildServiceMap(urls: UrlEntry[]): Map<string, { service: string; placeholder: string }> {
  const hostMap = new Map<string, { service: string; placeholder: string }>();

  for (const u of urls) {
    try {
      const parsed = new URL(u.url);
      const host = parsed.hostname;
      if (host === 'chrome://newtab' || host === '') continue;
      if (hostMap.has(host)) continue;

      if (host.includes('client-gateway-api') || host.includes('client-api')) {
        hostMap.set(host, { service: 'client', placeholder: '{{client_api_url}}' });
      } else if (host.includes('mgmt-gateway-api') || host.includes('mgmt-api')) {
        hostMap.set(host, { service: 'mgmt', placeholder: '{{mgmt_api_url}}' });
      } else if (host.includes('central-gateway-api')) {
        hostMap.set(host, { service: 'central', placeholder: '{{central_api_url}}' });
      } else if (host.includes('mgmt')) {
        hostMap.set(host, { service: 'mgmt', placeholder: '{{mgmt_url}}' });
      } else if (host.includes('client')) {
        hostMap.set(host, { service: 'client', placeholder: '{{client_url}}' });
      } else if (host.includes('game') || host.includes('slot') || host.includes('royal')) {
        hostMap.set(host, { service: 'game', placeholder: '{{game_url}}' });
      } else {
        hostMap.set(host, { service: 'external', placeholder: `{{${host.split('.')[0]}_url}}` });
      }
    } catch { /* ignore invalid URLs */ }
  }

  return hostMap;
}

/** 將路徑中的動態 ID 替換為 {{id}} */
function parameterizePath(pathname: string): string {
  return pathname
    .split('/')
    .map(seg => {
      if (!seg) return seg;
      // 純數字且長度 > 3（排除 v1, v2 等版本號）
      if (/^\d+$/.test(seg) && seg.length > 3) return '{{id}}';
      // 英數混合且長度 > 10（token-like）
      if (/^[a-zA-Z0-9]+$/.test(seg) && /[a-zA-Z]/.test(seg) && /\d/.test(seg) && seg.length > 10) return '{{id}}';
      // UUID-like（8-4-4-4-12 或含連字號的長 hex）
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return '{{id}}';
      return seg;
    })
    .join('/');
}

function toEndpoint(method: string, url: string): string {
  try {
    const parsed = new URL(url);
    return `${method} ${parameterizePath(parsed.pathname)}`;
  } catch {
    return `${method} ${url}`;
  }
}

// ─── 重複 endpoint 過濾（優先保留 2xx）─────────────────────

/**
 * 同一 endpoint（method + pathname）如果有 2xx 和 4xx 記錄，只保留 2xx。
 * 特別針對 POST /api/v1/login 等場景。
 */
function deduplicateByStatus(entries: NetworkEntry[]): NetworkEntry[] {
  // 按 endpoint 分組
  const groups = new Map<string, NetworkEntry[]>();
  for (const entry of entries) {
    const key = toEndpoint(entry.method, entry.url);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(entry);
  }

  const result: NetworkEntry[] = [];
  for (const [, group] of groups) {
    const has2xx = group.some(e => e.status >= 200 && e.status < 300);
    if (has2xx) {
      // 只保留 2xx 記錄
      result.push(...group.filter(e => e.status >= 200 && e.status < 300));
    } else {
      result.push(...group);
    }
  }

  // 維持原始時間順序
  result.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return result;
}

// ─── 過濾 ──────────────────────────────────────────────────

const SKIP_EXTENSIONS = [
  '.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.ico',
  '.wasm', '.map', '.mp3', '.mp4', '.webm', '.ogg',
  '.fnt', '.json.js',
];

const SKIP_URL_PATTERNS = [
  'cdn-cgi/', '/canvaskit/', '/rum?', 'challenge-platform',
  'g/collect', 'Telemetry/', '/resource/common/music/',
  '/resource/music/', '/resource/images/', '/WebUI3/content/',
];

function isApiRequest(entry: NetworkEntry): boolean {
  const url = entry.url.toLowerCase();

  if (['stylesheet', 'script', 'image', 'font', 'media'].includes(entry.resourceType)) return false;
  for (const ext of SKIP_EXTENSIONS) {
    if (url.includes(ext)) return false;
  }
  for (const pattern of SKIP_URL_PATTERNS) {
    if (url.includes(pattern.toLowerCase())) return false;
  }
  if (entry.resourceType === 'document') return false;
  if (url.startsWith('blob:')) return false;

  try {
    const pathname = new URL(url).pathname;
    const host = new URL(url).hostname;
    const isKnownHost = host.includes('client') || host.includes('mgmt') || host.includes('central');
    if (isKnownHost && !pathname.includes('/api/') && !pathname.includes('/api.')) {
      return false;
    }
  } catch { /* ignore */ }

  return true;
}

// ─── Schema 推導 ──────────────────────────────────────────

/** 精簡 schema — 只保留頂層 key，不展開巢狀 */
function inferSchemaTopLevel(value: any): Record<string, any> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const result: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === null || v === undefined) result[k] = { type: 'any' };
    else if (typeof v === 'string') result[k] = { type: 'string' };
    else if (typeof v === 'number') result[k] = { type: 'number' };
    else if (typeof v === 'boolean') result[k] = { type: 'boolean' };
    else if (Array.isArray(v)) result[k] = { type: 'array' };
    else if (typeof v === 'object') result[k] = { type: 'object' };
  }
  return result;
}

function tryParseJson(str: string | undefined): any | null {
  if (!str || str.trim() === '') return null;
  try { return JSON.parse(str); } catch { return null; }
}

function inferRole(method: string, pathname: string): 'trigger' | 'verify' | 'background' {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) return 'trigger';
  // 被動路徑（wallet/balance, deposit/list）歸為 verify
  if (PASSIVE_PATHS.some(p => pathname.includes(p))) return 'verify';
  return 'background';
}

// ─── Transcript 解析 ───────────────────────────────────────

function parseTranscript(content: string): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  const regex = /\[(\d{2}):(\d{2})\]\s*(.+)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const minutes = parseInt(match[1], 10);
    const seconds = parseInt(match[2], 10);
    lines.push({
      timeSeconds: minutes * 60 + seconds,
      text: match[3].trim(),
    });
  }

  return lines;
}

function getTranscriptForRange(
  transcript: TranscriptLine[],
  startSec: number,
  endSec: number,
): string {
  return transcript
    .filter(l => l.timeSeconds >= startSec && l.timeSeconds <= endSec)
    .map(l => l.text)
    .join('。');
}

// ─── Act 分段邏輯（v2: tab + 業務路徑雙重分段）─────────────

interface BusinessSegment {
  startTime: Date;
  endTime: Date;
  tabIndex: number;
  service: string;
  businessName: string;
  entries: NetworkEntry[];
}

/** 從 network entry 取得 pathname */
function getPathname(url: string): string {
  try { return new URL(url).pathname; } catch { return ''; }
}

/**
 * v2 分段：先按 tab 切換，再在同一 tab 內按業務路徑變化分段
 */
function segmentByBusinessPath(
  entries: NetworkEntry[],
  metadata: SessionMetadata,
  serviceMap: Map<string, { service: string; placeholder: string }>,
): BusinessSegment[] {
  if (entries.length === 0) return [];

  const segments: BusinessSegment[] = [];
  let currentTab = entries[0].tabIndex;
  let currentBusiness = '';
  let segEntries: NetworkEntry[] = [];
  let segStart = new Date(entries[0].timestamp);

  /** 暫存的被忽略 entries，在下一個正式段落中併入 */
  let pendingIgnored: NetworkEntry[] = [];

  function flushSegment(endEntry: NetworkEntry) {
    if (segEntries.length === 0) return;
    const service = tabToService(currentTab, metadata, serviceMap);

    // 檢查是否全部都是被忽略的路徑
    const allIgnored = segEntries.every(e => {
      const p = getPathname(e.url).replace(/^\/api\/(v\d+\/)?/, '');
      return IGNORED_PATHS.some(pp => p === pp || p.startsWith(pp + '/'));
    });
    if (allIgnored) {
      // 不建立獨立段落，暫存到下一段
      pendingIgnored.push(...segEntries);
      segEntries = [];
      return;
    }

    // 將之前暫存的 ignored entries 併入當前段落
    const allEntries = [...pendingIgnored, ...segEntries];
    pendingIgnored = [];

    // 只有被動路徑（balance/deposit-list）的段落 → 命名為「驗證」
    let name = currentBusiness;
    if (!name) {
      const hasVerify = allEntries.some(e => {
        const p = getPathname(e.url).replace(/^\/api\/(v\d+\/)?/, '');
        return PASSIVE_PATHS.some(pp => p.startsWith(pp));
      });
      name = hasVerify ? '驗證到帳' : `${serviceLabel(service)}操作`;
    }

    segments.push({
      startTime: segStart,
      endTime: new Date(endEntry.timestamp),
      tabIndex: currentTab,
      service,
      businessName: name,
      entries: allEntries,
    });
    segEntries = [];
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const pathname = getPathname(entry.url);

    // Tab 切換 → 一定產生新 act
    if (entry.tabIndex !== currentTab) {
      if (i > 0) flushSegment(entries[i - 1]);
      currentTab = entry.tabIndex;
      currentBusiness = '';
      segStart = new Date(entry.timestamp);
    }

    // 在同一 tab 內，檢查業務路徑變化
    const biz = extractBusinessName(pathname);

    // 被忽略的路徑（如 /api/config）→ 直接歸入當前 segment，不影響分段
    const cleanedPath = pathname.replace(/^\/api\/(v\d+\/)?/, '');
    const isIgnored = IGNORED_PATHS.some(p => cleanedPath === p || cleanedPath.startsWith(p + '/'));
    if (isIgnored) {
      segEntries.push(entry);
      continue;
    }

    if (biz !== null && biz !== currentBusiness) {
      // 業務路徑變化 → 產生新 act（但第一筆不需要 flush）
      if (segEntries.length > 0) {
        flushSegment(entries[i - 1]);
        segStart = new Date(entry.timestamp);
      }
      currentBusiness = biz;
    }

    segEntries.push(entry);
  }

  // 最後一段
  if (segEntries.length > 0) {
    flushSegment(entries[entries.length - 1]);
  }

  return segments;
}

/**
 * 轉折詞拆分：在同一 tab 同一業務路徑內，如果 transcript 含轉折詞
 * 且該時間點後的 API endpoint 業務路徑與之前不同，拆成兩個 act。
 */
function splitByTransitionWords(
  segments: BusinessSegment[],
  transcript: TranscriptLine[],
  sessionStart: Date,
): BusinessSegment[] {
  const result: BusinessSegment[] = [];

  for (const seg of segments) {
    const startSec = Math.floor((seg.startTime.getTime() - sessionStart.getTime()) / 1000);
    const endSec = Math.ceil((seg.endTime.getTime() - sessionStart.getTime()) / 1000);

    // 找這個時間段內含轉折詞的 transcript lines
    const relevantLines = transcript.filter(
      l => l.timeSeconds >= startSec && l.timeSeconds <= endSec,
    );

    let splitDone = false;

    for (const line of relevantLines) {
      const hasTransition = TRANSITION_WORDS.some(w => line.text.includes(w));
      if (!hasTransition) continue;

      // 轉折詞所在的絕對時間
      const splitTimeMs = sessionStart.getTime() + line.timeSeconds * 1000;

      // 將 entries 分成轉折詞前後
      const beforeEntries = seg.entries.filter(e => new Date(e.timestamp).getTime() <= splitTimeMs);
      const afterEntries = seg.entries.filter(e => new Date(e.timestamp).getTime() > splitTimeMs);

      if (beforeEntries.length === 0 || afterEntries.length === 0) continue;

      // 檢查前後的業務路徑是否不同
      const bizBefore = beforeEntries
        .map(e => extractBusinessName(getPathname(e.url)))
        .filter(Boolean)
        .pop();
      const bizAfter = afterEntries
        .map(e => extractBusinessName(getPathname(e.url)))
        .filter(Boolean)
        .shift();

      if (bizBefore && bizAfter && bizBefore !== bizAfter) {
        // 拆分！
        result.push({
          ...seg,
          endTime: new Date(splitTimeMs),
          businessName: bizBefore,
          entries: beforeEntries,
        });
        result.push({
          ...seg,
          startTime: new Date(splitTimeMs),
          businessName: bizAfter,
          entries: afterEntries,
        });
        splitDone = true;
        break; // 一個 segment 只拆一次
      }
    }

    if (!splitDone) {
      result.push(seg);
    }
  }

  return result;
}

function tabToService(
  tabIndex: number,
  metadata: SessionMetadata,
  serviceMap: Map<string, { service: string; placeholder: string }>,
): string {
  const tabUrls = metadata.urls.filter(u => u.tabIndex === tabIndex && u.title);
  const urlEntry = tabUrls.length > 0 ? tabUrls[tabUrls.length - 1] : metadata.urls.find(u => u.tabIndex === tabIndex);
  if (!urlEntry) return 'client';

  try {
    const host = new URL(urlEntry.url).hostname;
    return serviceMap.get(host)?.service ?? 'client';
  } catch {
    return 'client';
  }
}

// ─── Act ID 產生 ────────────────────────────────────────────

/** 中文業務名稱 → 英文 id */
const BIZ_TO_ID: Record<string, string> = {
  '註冊': 'register',
  '存款': 'deposit',
  '提款': 'withdrawal',
  '安全設置': 'security_setup',
  '登入': 'login',
  '遊戲': 'play_game',
  '遊戲操作': 'play_game',
  '注單記錄': 'bet_record',
  '帳戶明細': 'ledger',
  '會員管理': 'member',
  '存款審批': 'approve_deposit',
  '提款審核': 'review_withdrawal',
  '活動/優惠': 'claim_activity',
  '翻水': 'apply_rebate',
  '驗證到帳': 'verify_balance',
  // C1: 稽核任務
  '稽核任務': 'audit_task',
  '稽核任務解除': 'release_audit',
  // C4: 返水閉環
  '返水查詢': 'check_rebate',
  '返水申請': 'apply_rebate',
  '後台優惠審核': 'mgmt_rebate_review',
  '領取獎勵': 'claim_reward',
  '領取返水': 'claim_rebate',
  '前台操作': 'client_op',
};

/** 產生語意化 act id */
function generateActId(index: number, service: string, businessName: string): string {
  const bizId = BIZ_TO_ID[businessName] ?? `step_${index + 1}`;
  return `act_${index + 1}_${bizId}`;
}

function serviceToActor(service: string): string {
  switch (service) {
    case 'mgmt': return 'admin';
    case 'game': return 'user';
    case 'client': return 'user';
    default: return 'system';
  }
}

// ─── Screenshot 匹配 ───────────────────────────────────────

function findScreenshotForTab(
  tabIndex: number,
  screenshotFiles: string[],
): string | undefined {
  const match = screenshotFiles.find(f => f.includes(`_tab${tabIndex}_`));
  return match ? `screenshots/${match}` : undefined;
}

// ─── Parameters 三層分類 ──────────────────────────────────

/** 外部輸入欄位（parameters）的語意描述 */
const PARAM_DESCRIPTIONS: Record<string, { type: string; description: string }> = {
  username: { type: 'string', description: '註冊/登入帳號' },
  password: { type: 'string', description: '登入密碼' },
  real_name: { type: 'string', description: '真實姓名' },
  birthday: { type: 'string', description: '生日（YYYY-MM-DD）' },
  currency: { type: 'string', description: '幣別（CNY/HKD/USD/USDTTRC）' },
  amount: { type: 'number', description: '存款金額' },
  deposit_amount: { type: 'number', description: '存款金額' },
  withdrawal_amount: { type: 'number', description: '提款金額' },
  bank_id: { type: 'string', description: '銀行 ID' },
  card_number: { type: 'string', description: '銀行卡號' },
  withdrawal_password: { type: 'string', description: '提款密碼' },
  new_password: { type: 'string', description: '新密碼' },
  otp_code: { type: 'string', description: '2FA 驗證碼' },
  receiver_name: { type: 'string', description: '收款人姓名' },
  receiver_account_plain: { type: 'string', description: '收款銀行卡號' },
  payment_amount: { type: 'number', description: '付款金額' },
  branch_location: { type: 'string', description: '開戶行地址' },
  client_remark: { type: 'string', description: '客戶備註' },
  admin_username: { type: 'string', description: '後台管理員帳號' },
  admin_password: { type: 'string', description: '後台管理員密碼' },
};

/** 欄位名正規化（合併別名） */
const FIELD_ALIASES: Record<string, string> = {
  account: 'username',
  payment_amount: 'amount',
  withdraw_amount: 'withdrawal_amount',
  withdraw_password: 'withdrawal_password',
  // receiver_name 不再 alias 到 real_name，由 ensureReceiverName 獨立處理
};

function classifyParameters(allBodyKeys: Set<string>): {
  parameters: Record<string, any>;
  variables: Record<string, any>;
} {
  const parameters: Record<string, any> = {};
  const variables: Record<string, any> = {};

  for (const field of allBodyKeys) {
    // config → 移除
    if (isConfigField(field)) continue;

    // variable → 歸入 variables
    if (isVariableField(field)) {
      variables[field] = { type: 'string', source: 'API response 動態擷取' };
      continue;
    }

    // parameter → 歸入 parameters，使用正規化名稱
    const normalized = FIELD_ALIASES[field] ?? field;
    if (parameters[normalized]) continue; // 已存在（別名重複）

    const desc = PARAM_DESCRIPTIONS[normalized] ?? PARAM_DESCRIPTIONS[field];
    if (desc) {
      parameters[normalized] = { type: desc.type, description: desc.description };
    } else {
      // 未知欄位但不是 config/variable → 仍歸入 parameters
      parameters[normalized] = { type: 'string', description: `（自 ${field} 推斷）` };
    }
  }

  return { parameters, variables };
}

// ─── Variables Out 推斷 ──────────────────────────────────

/** 從 response body key 推斷語意化的輸出變數名 */
function mapVariableOutKey(key: string, method: string): { varName: string; path: string } | null {
  if (/token$/i.test(key) && !/verification/i.test(key)) {
    return { varName: 'auth_token', path: `response.data.${key}` };
  }
  if (/verification_token/i.test(key)) {
    return { varName: 'verification_token', path: `response.data.${key}` };
  }
  if (/ticket/i.test(key) || /order_id/i.test(key)) {
    return { varName: 'ticket', path: `response.data.${key}` };
  }
  if (/^id$/i.test(key) && method === 'POST') {
    return { varName: 'resource_id', path: `response.data.${key}` };
  }
  // M3: payment_channel / payout_method 動態變數
  if (/payment_channel/i.test(key)) {
    return { varName: 'payment_channel_info_id', path: `response.data.${key}` };
  }
  if (/payout_method/i.test(key)) {
    return { varName: 'user_payout_method_id', path: `response.data.${key}` };
  }
  // M3: balance 動態變數
  if (/^balance$/i.test(key)) {
    return { varName: 'current_balance', path: `response.data.${key}` };
  }
  return null;
}

function inferVariablesOut(apis: ApiEntry[]): Record<string, string> | undefined {
  const vars: Record<string, string> = {};

  for (const api of apis) {
    // M3: 掃描 trigger + verify APIs 的 response body
    if (api.role === 'background' || !api.response?.body) continue;
    const method = api.endpoint.split(' ')[0] ?? '';

    // 掃描頂層 key
    const bodyKeys = Object.keys(api.response.body);
    for (const key of bodyKeys) {
      const mapping = mapVariableOutKey(key, method);
      if (mapping && !vars[mapping.varName]) {
        vars[mapping.varName] = mapping.path;
      }
    }

    // 也掃描 `data` 包裝層內的 key（常見 API 回應格式 { code, data: { token, ticket, ... } }）
    const dataField = api.response.body['data'];
    if (dataField && dataField.type === 'object' && dataField.properties) {
      for (const key of Object.keys(dataField.properties)) {
        const mapping = mapVariableOutKey(key, method);
        if (mapping && !vars[mapping.varName]) {
          vars[mapping.varName] = mapping.path;
        }
      }
    }
  }

  return Object.keys(vars).length > 0 ? vars : undefined;
}

// ─── Variants 自動建議 ──────────────────────────────────

interface Variant {
  name: string;
  description: string;
  parameter_overrides?: Record<string, any>;
  skip_acts?: string[];
  modify_acts?: Record<string, { response_status?: number; description?: string }>;
}

function inferVariants(
  parameters: Record<string, any>,
  acts: Act[],
): Variant[] {
  const variants: Variant[] = [];

  // 收集所有 mgmt act IDs（用於多個 variant）
  const mgmtActIds = acts.filter(a => a.service === 'mgmt').map(a => a.id);

  // 收集所有含 trigger API 的 act（用於 modify_acts）
  const triggerActIds = acts
    .filter(a => a.api?.some(api => api.role === 'trigger'))
    .map(a => a.id);

  // 1. 有 currency parameter → 幣別變體
  if (parameters.currency) {
    variants.push({
      name: 'currency_hkd',
      description: '使用 HKD 幣別',
      parameter_overrides: { currency: 'HKD' },
    });
    // M1: currency_usdttrc 加 skip_acts（跳過所有 mgmt 審批，虛擬幣走不同審批流程）
    const usdttrcVariant: Variant = {
      name: 'currency_usdttrc',
      description: '使用 USDTTRC 虛擬幣（跳過銀行卡相關後台審批）',
      parameter_overrides: { currency: 'USDTTRC' },
    };
    if (mgmtActIds.length > 0) {
      usdttrcVariant.skip_acts = mgmtActIds;
    }
    variants.push(usdttrcVariant);
  }

  // 2. 有 amount / withdrawal_amount → 金額邊界變體（M2: 加 modify_acts + response_status: 400）
  const amountParam = parameters.amount || parameters.withdrawal_amount;
  if (amountParam) {
    const paramKey = parameters.amount ? 'amount' : 'withdrawal_amount';
    // 找到存款/提款的 trigger act（用於 modify_acts）
    const depositAct = acts.find(a => a.id.includes('deposit') && a.api?.some(api => api.role === 'trigger'));
    const withdrawalAct = acts.find(a => a.id.includes('withdrawal') && a.api?.some(api => api.role === 'trigger'));
    const targetAct = depositAct || withdrawalAct;

    const zeroVariant: Variant = {
      name: 'amount_zero',
      description: '金額為 0（應被拒絕，API 回應 400）',
      parameter_overrides: { [paramKey]: 0 },
    };
    if (targetAct) {
      zeroVariant.modify_acts = { [targetAct.id]: { response_status: 400, description: '金額為 0 應被後端拒絕' } };
    }
    variants.push(zeroVariant);

    const maxVariant: Variant = {
      name: 'amount_max',
      description: '超大金額（邊界測試，API 回應 400）',
      parameter_overrides: { [paramKey]: 999999999 },
    };
    if (targetAct) {
      maxVariant.modify_acts = { [targetAct.id]: { response_status: 400, description: '超過最大金額限制' } };
    }
    variants.push(maxVariant);
  }

  // 3. 有 mgmt service act → 跳過所有後台步驟
  if (mgmtActIds.length > 0) {
    variants.push({
      name: 'skip_mgmt_approval',
      description: '跳過後台審批步驟（自動審批）',
      skip_acts: mgmtActIds,
    });
  }

  // 4. 有 game service act → 跳過遊戲投注變體
  const gameAct = acts.find(a => a.service === 'game');
  if (gameAct) {
    variants.push({
      name: 'skip_game_bet',
      description: '跳過遊戲投注步驟',
      skip_acts: [gameAct.id],
    });
  }

  // 5. M2: 提款超額（withdrawal_exceeds_balance）
  if (parameters.withdrawal_amount) {
    const wdAct = acts.find(a => a.id.includes('withdrawal') && a.api?.some(api => api.role === 'trigger'));
    const exceedsVariant: Variant = {
      name: 'withdrawal_exceeds_balance',
      description: '提款金額超過可用餘額（應被拒絕）',
      parameter_overrides: { withdrawal_amount: 99999999 },
    };
    if (wdAct) {
      exceedsVariant.modify_acts = { [wdAct.id]: { response_status: 400, description: '餘額不足，提款被拒' } };
    }
    variants.push(exceedsVariant);
  }

  // 6. M2: 無可用活動（no_activity_available）
  const activityAct = acts.find(a => a.id.includes('claim_activity'));
  if (activityAct) {
    variants.push({
      name: 'no_activity_available',
      description: '無可領取的活動獎勵（活動列表為空或已領取）',
      modify_acts: { [activityAct.id]: { response_status: 400, description: '無可領取活動' } },
    });
  }

  // 7. M2: VIP 跳過稽核（vip_skip_audit）
  const auditAct = acts.find(a => a.id.includes('audit') || a.id.includes('release_audit'));
  if (auditAct) {
    variants.push({
      name: 'vip_skip_audit',
      description: 'VIP 用戶免稽核（跳過稽核任務步驟）',
      skip_acts: [auditAct.id],
    });
  }

  return variants;
}

// ─── receiver_name 補充 ──────────────────────────────────

/** 檢查 allBodyKeys 是否含 receiver_name，若有則確保 parameters 中存在 */
function ensureReceiverName(
  allBodyKeys: Set<string>,
  parameters: Record<string, any>,
): void {
  if (allBodyKeys.has('receiver_name') && !parameters.receiver_name) {
    parameters.receiver_name = {
      type: 'string',
      description: '收款人姓名',
    };
  }
}

// ─── 主邏輯 ────────────────────────────────────────────────

function generateSpec(sessionDir: string, outDir?: string): void {
  const absDir = path.resolve(sessionDir);

  // 1. 讀取 session 資料
  const metadataPath = path.join(absDir, 'metadata.json');
  if (!fs.existsSync(metadataPath)) {
    console.error(`❌ 找不到 metadata.json: ${metadataPath}`);
    process.exit(1);
  }

  const metadata: SessionMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
  console.log(`📂 Session: ${metadata.sessionId}`);
  console.log(`   Tab 數: ${metadata.tabCount}, API 數: ${metadata.networkEntryCount}`);

  const networkPath = path.join(absDir, 'network.json');
  const allEntries: NetworkEntry[] = fs.existsSync(networkPath)
    ? JSON.parse(fs.readFileSync(networkPath, 'utf-8'))
    : [];

  const transcriptPath = path.join(absDir, 'transcript.md');
  const transcriptContent = fs.existsSync(transcriptPath)
    ? fs.readFileSync(transcriptPath, 'utf-8')
    : '';
  const transcript = parseTranscript(transcriptContent);

  const screenshotsDir = path.join(absDir, 'screenshots');
  const screenshotFiles = fs.existsSync(screenshotsDir)
    ? fs.readdirSync(screenshotsDir).filter(f => f.endsWith('.png')).sort()
    : [];

  // 2. 建立 service map
  const allUrlEntries: UrlEntry[] = [...metadata.urls];
  for (const entry of allEntries) {
    try {
      const host = new URL(entry.url).hostname;
      if (!allUrlEntries.some(u => {
        try { return new URL(u.url).hostname === host; } catch { return false; }
      })) {
        allUrlEntries.push({ timestamp: entry.timestamp, url: entry.url, title: '', tabIndex: entry.tabIndex });
      }
    } catch { /* ignore */ }
  }
  const serviceMap = buildServiceMap(allUrlEntries);

  // 3. 過濾出 API 請求 + 去重（同 endpoint 有 2xx 和 4xx 時只保留 2xx）
  const filteredEntries = allEntries.filter(isApiRequest);
  const apiEntries = deduplicateByStatus(filteredEntries);
  const removedCount = filteredEntries.length - apiEntries.length;
  console.log(`   過濾後 API 數: ${apiEntries.length}（原始 ${allEntries.length}${removedCount > 0 ? `，去重移除 ${removedCount} 筆 4xx` : ''}）`);

  // 3.5 載入 glossary（用於 intent 校正）
  const glossary = loadGlossary();
  const hasGlossary = glossary?.corrections && Object.keys(glossary.corrections).length > 0;
  if (hasGlossary) {
    console.log(`   Glossary: ${Object.keys(glossary!.corrections!).length} 組校正詞彙`);
  }

  // 4. v2 分段：tab + 業務路徑
  let segments = segmentByBusinessPath(apiEntries, metadata, serviceMap);

  // 4.5 轉折詞拆分：同一 tab 內 transcript 含轉折詞且前後 API 業務路徑不同 → 拆分
  segments = splitByTransitionWords(segments, transcript, new Date(metadata.startTime));
  console.log(`   分段數: ${segments.length}`);

  // 5. 計算 session 開始時間
  const sessionStart = new Date(metadata.startTime);

  // 6. 收集所有 body keys（用於 parameters 分類）
  const allBodyKeys = new Set<string>();

  // 7. 組裝 acts
  const acts: Act[] = [];
  const prevActIds: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const actId = generateActId(i, seg.service, seg.businessName);

    // 推導 API schema（精簡版）
    const apiSchemas: ApiEntry[] = [];
    const seenEndpoints = new Set<string>();

    for (const entry of seg.entries) {
      const endpoint = toEndpoint(entry.method, entry.url);
      if (seenEndpoints.has(endpoint)) continue;
      seenEndpoints.add(endpoint);
      if (entry.method === 'HEAD') continue;

      const pathname = getPathname(entry.url);
      const apiEntry: ApiEntry = {
        endpoint,
        role: inferRole(entry.method, pathname),
      };

      // Request body schema — trigger 才保留完整 request schema
      const reqBody = tryParseJson(entry.requestBody);
      if (reqBody && typeof reqBody === 'object' && !Array.isArray(reqBody)) {
        if (apiEntry.role === 'trigger') {
          apiEntry.request = { body: inferSchemaTopLevel(reqBody) };
        }
        // 收集 body keys（不論 role，用於 parameters 分類）
        for (const key of Object.keys(reqBody)) {
          allBodyKeys.add(key);
        }
      }

      // Multipart detection（僅 trigger）
      const contentType = entry.requestHeaders?.['content-type'] ?? '';
      if (contentType.includes('multipart/form-data') && apiEntry.role === 'trigger') {
        apiEntry.request = { content_type: 'multipart/form-data' };
      }

      // Response body schema — 依 role 精簡
      // trigger: 完整 request + response schema
      // verify: response schema（含 body）
      // background: 只保留 status，省略 body
      const resBody = tryParseJson(entry.responseBody);
      apiEntry.response = { status: entry.status };
      if (apiEntry.role !== 'background' && resBody && typeof resBody === 'object') {
        const topLevel = inferSchemaTopLevel(resBody);
        if (Object.keys(topLevel).length > 0) {
          apiEntry.response.body = topLevel;
        }
      }

      apiSchemas.push(apiEntry);
    }

    // 推導 steps
    const steps: Step[] = [];

    // Tab 切換時加 switch_tab step
    if (i > 0 && seg.tabIndex !== segments[i - 1].tabIndex) {
      steps.push({
        action: 'switch_tab',
        target: `${serviceLabel(seg.service)}（Tab ${seg.tabIndex}）`,
      });
    }

    // 如果是新頁面/新業務，加 navigate step
    const isNewBusiness = i === 0 || seg.businessName !== segments[i - 1]?.businessName;
    if (isNewBusiness) {
      steps.push({
        action: 'navigate',
        target: `${seg.businessName}頁面`,
      });
    }

    // 從 trigger API 的 request body 推斷 fill/select steps
    for (const entry of seg.entries) {
      if (!['POST', 'PUT', 'PATCH'].includes(entry.method)) continue;

      // Multipart → upload step（不需要 body 解析）
      const contentType = entry.requestHeaders?.['content-type'] ?? '';
      if (contentType.includes('multipart/form-data')) {
        steps.push({
          action: 'upload',
          target: '上傳檔案',
          description: '上傳圖片/憑證',
        });
        // upload 也需要一個 click
        const endpoint = toEndpoint(entry.method, entry.url);
        steps.push({
          action: 'click',
          target: '提交',
          description: `觸發 ${endpoint}`,
        });
        continue;
      }

      const reqBody = tryParseJson(entry.requestBody);
      if (reqBody && typeof reqBody === 'object') {
        const bodyKeys = Object.keys(reqBody);
        const fieldSteps = inferStepsFromBody(bodyKeys);
        steps.push(...fieldSteps);
      }

      // 每個 trigger API → click（提交按鈕）
      const endpoint = toEndpoint(entry.method, entry.url);
      const clickStep: Step = {
        action: 'click',
        target: '提交',
        description: `觸發 ${endpoint}`,
      };
      attachSelectorHint(clickStep);
      steps.push(clickStep);
    }

    // H2: 遊戲 Tab 切換 — 如果 act 的 API 含 launch_url，補充遊戲相關 steps
    const hasLaunchUrl = seg.entries.some(e => e.url.includes('launch_url'));
    if (hasLaunchUrl) {
      // 在現有 steps 後追加遊戲 Tab 切換步驟
      steps.push({
        action: 'switch_tab',
        target: '遊戲 Tab（新 Tab）',
        description: 'launch_url 回傳的 URL 在新 Tab 開啟',
      });
      steps.push({
        action: 'wait',
        target: '遊戲載入完成',
        description: '等待遊戲頁面載入',
      });
      steps.push({
        action: 'manual',
        target: '遊戲下注',
        description: '手動操作遊戲下注（Canvas 遊戲無法自動化）',
      });
      steps.push({
        action: 'switch_tab',
        target: '前台（Tab 0）',
        description: '返回前台確認餘額變化',
      });
    }

    // H4: 存款審批 steps 補齊 — 如果 act 含 transfer-audit 或 force-deposit API
    const hasTransferAudit = seg.entries.some(e =>
      e.url.includes('transfer-audit') || e.url.includes('force-deposit'),
    );
    if (hasTransferAudit) {
      // 移除已有的簡陋 steps，重新補齊完整流程
      const auditSteps: Step[] = [
        { action: 'navigate', target: '銀行轉帳充值列表頁面', selector_hint: '/finance/transfer-review' },
        { action: 'find_row', target: '找到待審核的存款單', description: '在列表中搜尋目標存款記錄', params: { real_name: '{{real_name}}' } },
        { action: 'click', target: '強制入款按鈕', description: '點擊目標記錄的「強制入款」操作按鈕', selector_hint: SELECTOR_HINTS.click['強制入款按鈕'] },
        { action: 'wait', target: '審核彈窗', description: '等待審核確認對話框出現' },
        { action: 'fill', target: '管理員備註', value: 'E2E 測試審批', description: '可選，填寫審批備註', selector_hint: SELECTOR_HINTS.fill['管理員備註'] },
        { action: 'click', target: '確認審批', description: '觸發 PUT /api/v1/finance/transfer-audit/{{id}}', selector_hint: SELECTOR_HINTS.click['確認審批'] },
      ];
      // 清除原有的 navigate + click steps，用完整版替換
      steps.length = 0;
      steps.push(...auditSteps);
    }

    // 對齊 transcript 時間
    const startSec = Math.floor((seg.startTime.getTime() - sessionStart.getTime()) / 1000);
    const endSec = Math.ceil((seg.endTime.getTime() - sessionStart.getTime()) / 1000);
    const transcriptText = getTranscriptForRange(transcript, startSec, endSec);

    // H1: Intent 業務化 — 優先使用 INTENT_TEMPLATES，fallback 到校正後 transcript
    const rawIntent = transcriptText || `${seg.businessName}（Tab ${seg.tabIndex}）`;
    const correctedIntent = (hasGlossary && transcriptText) ? applyCorrections(rawIntent, glossary!) : rawIntent;
    const templateIntent = INTENT_TEMPLATES[seg.businessName];
    const intent = templateIntent ?? correctedIntent;

    // Screenshot
    const screenshot = findScreenshotForTab(seg.tabIndex, screenshotFiles);

    // Assertions — API status 200 + H3: 業務斷言
    const assertions = inferAssertions(apiSchemas, transcriptText);
    const bizAssertions = BUSINESS_ASSERTIONS[seg.businessName];
    if (bizAssertions) {
      // 去重：避免 inferAssertions 和 BUSINESS_ASSERTIONS 產生重複（同 endpoint + 同 type）
      for (const ba of bizAssertions) {
        const isDuplicate = assertions.some(a =>
          a.type === ba.type && a.endpoint === ba.endpoint && a.description === ba.description
        );
        if (!isDuplicate) assertions.push(ba);
      }
    }

    // Variables out
    const variablesOut = inferVariablesOut(apiSchemas);

    // 組裝 act
    const act: Act = {
      id: actId,
      title: `${serviceLabel(seg.service)} ${seg.businessName}`,
      service: seg.service,
      actor: serviceToActor(seg.service),
      intent,
    };

    // H1: 如果使用了模板 intent，將原始 transcript 放入 intent_raw
    if (templateIntent && transcriptText) {
      act.intent_raw = correctedIntent;
    }

    if (prevActIds.length > 0) {
      act.depends_on = [prevActIds[prevActIds.length - 1]];
    }

    if (steps.length > 0) {
      act.steps = steps;
    }

    if (apiSchemas.length > 0) {
      act.api = apiSchemas;
    }

    if (assertions.length > 0) {
      act.assertions = assertions;
    }

    if (screenshot) {
      act.screenshot_ref = screenshot;
    }

    if (variablesOut) {
      act.variables_out = variablesOut;
    }

    acts.push(act);
    prevActIds.push(actId);
  }

  // 7.5 M4: placeholder acts 充實 — 純查詢 act 加 verify assertions
  const QUERY_ACT_ASSERTIONS: Record<string, Assertion[]> = {
    'member': [
      { type: 'api', description: '會員資料查詢成功', response_match: { 'data.account': '{{non_empty}}' } },
      { type: 'ui', description: '會員列表顯示目標帳號' },
    ],
    'ledger': [
      { type: 'ui', description: '帳變記錄列表非空' },
      { type: 'api', description: '帳變紀錄包含最近操作', response_match: { 'data.list': '{{non_empty_array}}' } },
    ],
    'bet_record': [
      { type: 'ui', description: '注單記錄列表非空' },
      { type: 'api', description: '注單記錄包含最近下注', response_match: { 'data.list': '{{non_empty_array}}' } },
    ],
  };

  for (const act of acts) {
    const hasTrigger = act.api?.some(a => a.role === 'trigger');
    if (hasTrigger) continue;

    // 純查詢 act → 加搜尋/查看步驟 + verify assertions
    for (const [bizKey, extraAssertions] of Object.entries(QUERY_ACT_ASSERTIONS)) {
      if (act.id.includes(bizKey)) {
        // 加搜尋步驟（如果沒有 steps）
        if (!act.steps || act.steps.length <= 1) {
          const searchSteps: Step[] = [
            { action: 'navigate', target: `${act.title}頁面` },
            { action: 'fill', target: '搜尋欄位', value: '{{username}}', description: '搜尋目標帳號', selector_hint: SELECTOR_HINTS.fill['搜尋欄位'] },
            { action: 'click', target: '搜尋', description: '執行查詢', selector_hint: SELECTOR_HINTS.click['搜尋'] },
          ];
          act.steps = searchSteps;
        }
        // 加 assertions
        if (!act.assertions) act.assertions = [];
        act.assertions.push(...extraAssertions);
        break;
      }
    }
  }

  // 8. Parameters 三層分類
  const { parameters, variables } = classifyParameters(allBodyKeys);

  // 8.5 receiver_name 補充（確保 receiver_name 不被 alias 吃掉）
  ensureReceiverName(allBodyKeys, parameters);

  // 9. 產生 flow diagram
  const flowLines: string[] = [];
  const tabLabels: Record<number, string> = {};
  for (const u of metadata.urls) {
    if (u.title && u.tabIndex !== undefined && !tabLabels[u.tabIndex]) {
      tabLabels[u.tabIndex] = `${u.title} (Tab ${u.tabIndex})`;
    }
  }

  const uniqueTabs = [...new Set(segments.map(s => s.tabIndex))];
  const tabHeaders = uniqueTabs.map(t => tabLabels[t] ?? `Tab ${t}`);
  flowLines.push(tabHeaders.join('    '));
  flowLines.push(tabHeaders.map(h => '─'.repeat(h.length)).join('    '));

  for (let i = 0; i < acts.length; i++) {
    const seg = segments[i];
    const tabLabel = tabLabels[seg.tabIndex] ?? `Tab ${seg.tabIndex}`;
    flowLines.push(`${acts[i].id}: ${seg.businessName} → ${tabLabel}`);
  }

  // 10. 計算 duration
  const duration = Math.round(
    (new Date(metadata.endTime).getTime() - new Date(metadata.startTime).getTime()) / 1000,
  );

  // 11. 組裝 spec
  const spec: any = {
    spec_version: '1.0',
    title: `Session ${metadata.sessionId} 自動分析`,
    description: '由 vox-trace analyze 自動產生的 spec 骨架（v2: 含 steps + assertions）',

    recorded_from: {
      session_id: metadata.sessionId,
      tool: 'vox-trace',
      duration,
      recorded_at: metadata.startTime,
    },

    tags: ['auto-generated'],
    priority: 'high',
    estimated_duration: duration,
  };

  if (Object.keys(parameters).length > 0) {
    spec.parameters = parameters;
  }

  if (Object.keys(variables).length > 0) {
    spec.variables = variables;
  }

  spec.acts = acts;

  // Variants 自動建議
  const variants = inferVariants(parameters, acts);
  if (variants.length > 0) {
    spec.variants = variants;
  }

  spec.flow = {
    diagram: flowLines.join('\n'),
  };

  // 12. 寫出 spec.yaml
  //   預設落在 repo 的 spec-schema/specs/；排程處理 repo 外的 intake session 時，
  //   session 目錄找不到 package.json（findProjectRoot 會 fallback 到錯的路徑），
  //   故 pipeline 用 --out-dir 明確指定歸檔位置（如 spec-schema/specs/_inbox）。
  const specsDir = outDir
    ? path.resolve(outDir)
    : path.join(findProjectRoot(absDir), 'spec-schema', 'specs');

  if (!fs.existsSync(specsDir)) {
    fs.mkdirSync(specsDir, { recursive: true });
  }

  const outputPath = path.join(specsDir, `${metadata.sessionId}.spec.yaml`);

  const yamlContent = yaml.dump(spec, {
    lineWidth: 120,
    noRefs: true,
    quotingType: '"',
    forceQuotes: false,
    sortKeys: false,
  });

  fs.writeFileSync(outputPath, yamlContent, 'utf-8');
  console.log(`\n✅ Spec 已產生: ${outputPath}`);
  console.log(`   Acts: ${acts.length}`);
  console.log(`   Steps: ${acts.reduce((sum, a) => sum + (a.steps?.length ?? 0), 0)}`);
  console.log(`   Assertions: ${acts.reduce((sum, a) => sum + (a.assertions?.length ?? 0), 0)}`);
  console.log(`   APIs: ${acts.reduce((sum, a) => sum + (a.api?.length ?? 0), 0)}`);
  console.log(`   Parameters: ${Object.keys(parameters).length}`);
  console.log(`   Variables: ${Object.keys(variables).length}`);
  console.log(`   Variables Out: ${acts.reduce((sum, a) => sum + (a.variables_out ? Object.keys(a.variables_out).length : 0), 0)}`);
  console.log(`   Variants: ${variants.length}`);
  const bgApis = acts.reduce((sum, a) => sum + (a.api?.filter(x => x.role === 'background' && !x.response?.body).length ?? 0), 0);
  console.log(`   Background APIs（schema 精簡）: ${bgApis}`);
}

function serviceLabel(service: string): string {
  switch (service) {
    case 'client': return '前台';
    case 'mgmt': return '後台';
    case 'game': return '遊戲';
    case 'central': return '中央';
    default: return service;
  }
}

function findProjectRoot(dir: string): string {
  let current = dir;
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, 'package.json'))) {
      return current;
    }
    current = path.dirname(current);
  }
  return path.resolve(dir, '..', '..');
}

// ─── CLI arg 解析（純函式，供測試）────────────────────────────
export interface SpecCliArgs {
  sessionDir?: string;
  outDir?: string;
  outDirFlagPresent: boolean;
}

export function parseSpecArgs(args: string[]): SpecCliArgs {
  const outDirIdx = args.indexOf('--out-dir');
  const outDir = outDirIdx !== -1 ? args[outDirIdx + 1] : undefined;
  // 找第一個非旗標參數當 session dir；有 --out-dir 時排除它的值（否則會把 out-dir 路徑誤當 session）。
  // 陷阱：無 --out-dir 時 outDirIdx=-1、outDirIdx+1=0，不可用來排除 index 0，否則單一 session 參數被吃掉。
  const sessionDir = args.find((a, i) => !a.startsWith('--') && (outDirIdx === -1 || i !== outDirIdx + 1));
  return { sessionDir, outDir, outDirFlagPresent: outDirIdx !== -1 };
}

// ─── CLI Entry ─────────────────────────────────────────────
function runCli(): void {
  const { sessionDir, outDir, outDirFlagPresent } = parseSpecArgs(process.argv.slice(2));

  if (!sessionDir) {
    console.error('用法: npx tsx src/generate-spec.ts <session-dir> [--out-dir <dir>]');
    console.error('範例: npx tsx src/generate-spec.ts recordings/2026-03-22T10-33-56');
    console.error('      npx tsx src/generate-spec.ts /abs/intake/<session> --out-dir spec-schema/specs/_inbox');
    process.exit(1);
  }
  if (outDirFlagPresent && !outDir) {
    console.error('❌ --out-dir 需要一個路徑參數');
    process.exit(1);
  }
  if (!fs.existsSync(sessionDir)) {
    console.error(`❌ 找不到目錄: ${sessionDir}`);
    process.exit(1);
  }
  generateSpec(sessionDir, outDir);
}

// 只有直接執行才跑 CLI（被 test import 時不觸發）
if (process.argv[1] && path.resolve(process.argv[1]).endsWith('generate-spec.ts')) {
  runCli();
}
