/**
 * Shared: RecordedAction → Playwright 動作映射（單一真相來源）
 *
 * 這裡集中放「所錄即所得」的核心映射邏輯，供以下三處共用：
 *   - src/generate-playwright.ts   （產生 .raw.spec.ts）
 *   - src/generate-storyboard.ts   （產生 shot-scraper 相容 storyboard.yml）
 *   - src/reconstruct.ts           （用 recordVideo context 逐步 replay 重錄影片）
 *
 * 抽出後三者共用同一份映射，避免兩份會漂移的邏輯。
 * generate-playwright.ts 的原始行為必須保持不變。
 */

import type { RecordedAction } from '../dom-recorder';

export interface ProcessedStep {
  comment: string;
  code: string;
  selectorComment?: string;
  transcriptNote?: string;
  apiInfo?: { endpoint: string; method: string; status: number };
}

export function escapeString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
}

export function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

export function selectorComment(action: RecordedAction): string {
  const strats = action.selectorStrategies;
  const parts: string[] = [];
  if (strats.dataTest) parts.push(`data-test: ${strats.dataTest}`);
  if (strats.id) parts.push(`id: ${strats.id}`);
  if (strats.ariaLabel) parts.push(`aria: ${strats.ariaLabel}`);
  if (strats.placeholder) parts.push(`placeholder: ${strats.placeholder}`);
  if (strats.textContent) parts.push(`text: ${strats.textContent}`);
  if (strats.cssPath) parts.push(`css: ${strats.cssPath.slice(0, 80)}`);
  if (action.isCanvasKit) {
    parts.push(`canvas coords: (${action.coordinates.x}, ${action.coordinates.y})`);
  }
  return parts.length > 0 ? `// selectors: ${parts.join(' | ')}` : '';
}

export function extractApiPathPattern(endpoint: string): string {
  // "POST /api/v1/login" → "/api/v1/login"
  const parts = endpoint.split(' ');
  return parts.length > 1 ? parts[1] : endpoint;
}

export function generateSteps(sortedActions: RecordedAction[]): ProcessedStep[] {
  const steps: ProcessedStep[] = [];

  // Track current page URL for navigation detection
  let currentUrl = '';
  let currentTabIndex = 0;

  for (let i = 0; i < sortedActions.length; i++) {
    const action = sortedActions[i];
    const sel = escapeString(action.selector);
    const selComment = selectorComment(action);
    const transcript = action.correlatedTranscript
      ? `// [旁白] ${action.correlatedTranscript}`
      : undefined;

    // Tab switch detection
    if (action.tabIndex !== currentTabIndex && action.type !== 'navigate') {
      steps.push({
        comment: `--- 切換到 Tab ${action.tabIndex} ---`,
        code: `    page = context.pages()[${action.tabIndex}];`,
      });
      currentTabIndex = action.tabIndex;
    }

    switch (action.type) {
      case 'navigate': {
        if (action.value && action.value !== currentUrl) {
          const isFirst = currentUrl === '';
          currentUrl = action.value;
          if (isFirst || !action.value.startsWith(currentUrl.split('/').slice(0, 3).join('/'))) {
            // First navigation or cross-origin → use goto
            steps.push({
              comment: `Navigate: ${shortenUrl(action.value)}`,
              code: `    await page.goto('${escapeString(action.value)}', { waitUntil: 'domcontentloaded' });`,
              transcriptNote: transcript,
            });
          } else {
            // Same-origin SPA navigation → use waitForURL
            steps.push({
              comment: `Navigate: ${shortenUrl(action.value)}`,
              code: `    await page.waitForURL('${escapeString(action.value)}');`,
              transcriptNote: transcript,
            });
          }
        }
        break;
      }

      case 'click': {
        // Check if this click triggers an API call
        if (action.correlatedApi) {
          const api = action.correlatedApi;
          const urlPattern = extractApiPathPattern(api.endpoint);
          steps.push({
            comment: `Click: ${action.innerText || action.tagName} → API: ${api.endpoint}`,
            selectorComment: selComment,
            transcriptNote: transcript,
            apiInfo: api,
            code: action.isCanvasKit
              ? [
                  `    // CanvasKit: 使用座標點擊（viewport: ${action.viewportSize.width}x${action.viewportSize.height}）`,
                  `    const [resp_${i}] = await Promise.all([`,
                  `      page.waitForResponse(r => r.url().includes('${escapeString(urlPattern)}') && r.request().method() === '${api.method}'),`,
                  `      page.mouse.click(${action.coordinates.x}, ${action.coordinates.y}),`,
                  `    ]);`,
                  `    expect(resp_${i}.status()).toBe(${api.status});`,
                ].join('\n')
              : [
                  `    const [resp_${i}] = await Promise.all([`,
                  `      page.waitForResponse(r => r.url().includes('${escapeString(urlPattern)}') && r.request().method() === '${api.method}'),`,
                  `      page.click('${sel}'),`,
                  `    ]);`,
                  `    expect(resp_${i}.status()).toBe(${api.status});`,
                ].join('\n'),
          });
        } else {
          steps.push({
            comment: `Click: ${action.innerText || action.tagName}`,
            selectorComment: selComment,
            transcriptNote: transcript,
            code: action.isCanvasKit
              ? `    // CanvasKit: 座標點擊 (${action.coordinates.x}, ${action.coordinates.y})\n    await page.mouse.click(${action.coordinates.x}, ${action.coordinates.y});`
              : `    await page.click('${sel}');`,
          });
        }
        break;
      }

      case 'fill': {
        const value = action.value || '';
        const isSensitive = action.inputType === 'password';
        const displayValue = isSensitive ? '****' : escapeString(value);
        const codeValue = isSensitive ? `'****' /* TODO: 替換為 ENV.password */` : `'${escapeString(value)}'`;

        steps.push({
          comment: `Fill: ${action.placeholder || action.tagName} = "${displayValue}"`,
          selectorComment: selComment,
          transcriptNote: transcript,
          code: `    await page.fill('${sel}', ${codeValue});`,
        });
        break;
      }

      case 'select': {
        steps.push({
          comment: `Select: ${action.innerText || action.value}`,
          selectorComment: selComment,
          transcriptNote: transcript,
          code: `    await page.selectOption('${sel}', '${escapeString(action.value || '')}');`,
        });
        break;
      }

      case 'press_key': {
        steps.push({
          comment: `Press: ${action.key}`,
          selectorComment: selComment,
          code: `    await page.press('${sel}', '${action.key}');`,
        });
        break;
      }

      case 'upload': {
        steps.push({
          comment: `Upload: ${action.value}`,
          selectorComment: selComment,
          code: `    // TODO: 設定上傳檔案路徑\n    await page.setInputFiles('${sel}', '/path/to/file');`,
        });
        break;
      }

      case 'scroll': {
        // Skip scroll events in generated code (usually not important for E2E)
        break;
      }
    }
  }

  return steps;
}
