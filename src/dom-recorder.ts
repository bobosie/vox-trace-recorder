/**
 * DOM Event Recorder — 注入式瀏覽器操作錄製器
 *
 * 在 Playwright 開啟的瀏覽器頁面中注入 JavaScript，
 * 捕捉使用者的 click、fill、select 等 DOM 事件，
 * 透過 page.exposeFunction 即時回傳 Node.js 進程。
 *
 * 設計原則：資訊只增不減 — 每個動作記錄多策略 selector + 座標 + 元素屬性
 */

import type { Page, Frame } from 'playwright';

// ─── Types ──────────────────────────────────────────────────

export interface SelectorStrategies {
  dataTest?: string;
  id?: string;
  ariaLabel?: string;
  role?: string;
  cssPath: string;
  textContent?: string;
  nthMatch?: string;
  placeholder?: string;
}

export interface RecordedAction {
  seq: number;
  timestamp: number;
  type: 'click' | 'fill' | 'select' | 'navigate' | 'press_key' | 'upload' | 'scroll';
  selector: string;
  selectorStrategies: SelectorStrategies;
  coordinates: { x: number; y: number };
  boundingBox: { x: number; y: number; width: number; height: number };
  viewportSize: { width: number; height: number };
  tagName: string;
  inputType?: string;
  value?: string;
  key?: string;
  placeholder?: string;
  innerText?: string;
  attributes: Record<string, string>;
  url: string;
  tabIndex: number;
  frameIndex?: number;
  isCanvasKit?: boolean;
  correlatedApi?: {
    endpoint: string;
    method: string;
    status: number;
    duration: number;
  };
  correlatedTranscript?: string;
}

// ─── Injected Script ────────────────────────────────────────
// This string will be injected into the browser page via page.evaluate().
// It must be self-contained (no external imports).

const RECORDER_SCRIPT = `
(() => {
  // Guard against double injection
  if (window.__voxRecorderActive) return;
  window.__voxRecorderActive = true;

  let seq = window.__voxSeq || 0;
  window.__voxSeq = seq;

  // ─── Selector Computation ────────────────────────────

  function getDataTestAttr(el) {
    return el.getAttribute('data-test') || el.getAttribute('data-testid') || el.getAttribute('data-cy');
  }

  function getCssPath(el) {
    const parts = [];
    let current = el;
    while (current && current !== document.body && current !== document.documentElement) {
      let selector = current.tagName.toLowerCase();
      if (current.id && /^[a-zA-Z]/.test(current.id)) {
        selector = '#' + CSS.escape(current.id);
        parts.unshift(selector);
        break;
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(current) + 1;
          selector += ':nth-of-type(' + idx + ')';
        }
      }
      // Include meaningful class names (skip scoped/hash classes)
      const classes = Array.from(current.classList || [])
        .filter(c => !c.match(/^(data-v-|_|css-|sc-)/))
        .slice(0, 2);
      if (classes.length > 0) {
        selector += '.' + classes.map(c => CSS.escape(c)).join('.');
      }
      parts.unshift(selector);
      current = parent;
    }
    return parts.join(' > ');
  }

  function computeSelectors(el) {
    const strategies = {};

    // 1. data-test
    const dt = getDataTestAttr(el);
    if (dt) strategies.dataTest = '[data-test="' + dt + '"]';

    // 2. id (skip dynamic IDs like Element Plus el-id-*, Vue :id, etc.)
    if (el.id && /^[a-zA-Z]/.test(el.id) && !/^el-id-|^el-|^__vue/.test(el.id)) {
      strategies.id = '#' + el.id;
    }

    // 3. aria-label
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) {
      strategies.ariaLabel = '[aria-label="' + ariaLabel.replace(/"/g, '\\\\"') + '"]';
    }

    // 4. role + name
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    const name = ariaLabel || el.textContent?.trim().slice(0, 30);
    if (role && name) {
      strategies.role = role + '[name="' + name.replace(/"/g, '\\\\"') + '"]';
    }

    // 5. CSS path
    strategies.cssPath = getCssPath(el);

    // 6. text content (for buttons/links)
    const text = el.textContent?.trim();
    if (text && text.length > 0 && text.length <= 50 && ['BUTTON', 'A', 'SPAN', 'LABEL', 'LI'].includes(el.tagName)) {
      strategies.textContent = 'text="' + text.replace(/"/g, '\\\\"') + '"';
    }

    // 7. placeholder (for inputs)
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) {
      strategies.placeholder = '[placeholder="' + placeholder.replace(/"/g, '\\\\"') + '"]';
    }

    return strategies;
  }

  function chooseBestSelector(strategies) {
    return strategies.dataTest
      || strategies.id
      || strategies.ariaLabel
      || strategies.placeholder  // placeholder 優先於 role/text（更穩定）
      || strategies.textContent
      || strategies.role
      || strategies.cssPath
      || 'unknown';
  }

  function getAttributes(el) {
    const attrs = {};
    for (const attr of el.attributes) {
      if (attr.name.startsWith('data-') || attr.name === 'role' || attr.name === 'type'
          || attr.name === 'name' || attr.name === 'placeholder' || attr.name === 'aria-label') {
        attrs[attr.name] = attr.value;
      }
    }
    return attrs;
  }

  function getBoundingBox(el) {
    const rect = el.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }

  function isCanvasKitPage() {
    return !!document.querySelector('flt-glass-pane') || !!document.querySelector('flutter-view');
  }

  // ─── Event Dispatch ──────────────────────────────────

  function sendAction(data) {
    seq++;
    window.__voxSeq = seq;
    const ts = data.__overrideTimestamp || Date.now();
    delete data.__overrideTimestamp;
    const action = {
      seq: seq,
      timestamp: ts,
      viewportSize: { width: window.innerWidth, height: window.innerHeight },
      url: window.location.href,
      isCanvasKit: isCanvasKitPage(),
      ...data,
    };
    try {
      window.__voxRecordAction(JSON.stringify(action));
    } catch (e) {
      // exposeFunction not available (page navigated)
    }
  }

  // ─── Fill Debounce ───────────────────────────────────
  // Collect consecutive input events on the same element into one fill action
  // Preserves the timestamp of the FIRST input event (not the debounce resolution)
  const fillTimers = new Map();
  const fillFirstTimestamp = new Map();

  function handleInputEvent(el, value) {
    const key = getCssPath(el);
    if (fillTimers.has(key)) {
      clearTimeout(fillTimers.get(key));
    } else {
      // Record the timestamp of the first input event
      fillFirstTimestamp.set(key, Date.now());
    }
    fillTimers.set(key, setTimeout(() => {
      const firstTs = fillFirstTimestamp.get(key) || Date.now();
      fillTimers.delete(key);
      fillFirstTimestamp.delete(key);
      const strategies = computeSelectors(el);
      // Override timestamp with the first input event time
      const action = {
        type: 'fill',
        selector: chooseBestSelector(strategies),
        selectorStrategies: strategies,
        coordinates: { x: 0, y: 0 },
        boundingBox: getBoundingBox(el),
        tagName: el.tagName,
        inputType: el.type || undefined,
        value: value,
        placeholder: el.getAttribute('placeholder') || undefined,
        innerText: undefined,
        attributes: getAttributes(el),
        __overrideTimestamp: firstTs,
      };
      sendAction(action);
    }, 300));
  }

  // ─── Click Handler ───────────────────────────────────

  document.addEventListener('click', (e) => {
    const el = e.target;
    if (!el || !el.tagName) return;

    // Skip clicks on the Playwright Inspector overlay
    if (el.closest && el.closest('#playwright-inspector')) return;

    const strategies = computeSelectors(el);
    sendAction({
      type: 'click',
      selector: chooseBestSelector(strategies),
      selectorStrategies: strategies,
      coordinates: { x: e.clientX, y: e.clientY },
      boundingBox: getBoundingBox(el),
      tagName: el.tagName,
      inputType: el.type || undefined,
      value: undefined,
      placeholder: el.getAttribute('placeholder') || undefined,
      innerText: (el.textContent || '').trim().slice(0, 100) || undefined,
      attributes: getAttributes(el),
    });
  }, true);

  // ─── Input / Change Handler ──────────────────────────

  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!el || !el.tagName) return;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      handleInputEvent(el, el.value);
    }
  }, true);

  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!el || !el.tagName) return;

    if (el.tagName === 'SELECT') {
      const strategies = computeSelectors(el);
      sendAction({
        type: 'select',
        selector: chooseBestSelector(strategies),
        selectorStrategies: strategies,
        coordinates: { x: 0, y: 0 },
        boundingBox: getBoundingBox(el),
        tagName: el.tagName,
        value: el.value,
        innerText: el.options?.[el.selectedIndex]?.text || undefined,
        attributes: getAttributes(el),
      });
    } else if (el.tagName === 'INPUT' && el.type === 'file') {
      const strategies = computeSelectors(el);
      sendAction({
        type: 'upload',
        selector: chooseBestSelector(strategies),
        selectorStrategies: strategies,
        coordinates: { x: 0, y: 0 },
        boundingBox: getBoundingBox(el),
        tagName: el.tagName,
        inputType: 'file',
        value: Array.from(el.files || []).map(f => f.name).join(', '),
        attributes: getAttributes(el),
      });
    }
  }, true);

  // ─── Keyboard Handler (Enter/Tab/Escape) ─────────────

  document.addEventListener('keydown', (e) => {
    const specialKeys = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown'];
    if (!specialKeys.includes(e.key)) return;

    const el = e.target;
    if (!el || !el.tagName) return;

    const strategies = computeSelectors(el);
    sendAction({
      type: 'press_key',
      selector: chooseBestSelector(strategies),
      selectorStrategies: strategies,
      coordinates: { x: 0, y: 0 },
      boundingBox: getBoundingBox(el),
      tagName: el.tagName,
      key: e.key,
      attributes: getAttributes(el),
    });
  }, true);

  // ─── Navigation Detection ───────────────────────────

  // Capture URL changes (SPA navigation via pushState/replaceState)
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  function notifyNavigation() {
    sendAction({
      type: 'navigate',
      selector: '',
      selectorStrategies: { cssPath: '' },
      coordinates: { x: 0, y: 0 },
      boundingBox: { x: 0, y: 0, width: 0, height: 0 },
      tagName: 'WINDOW',
      value: window.location.href,
      attributes: {},
    });
  }

  history.pushState = function(...args) {
    originalPushState.apply(this, args);
    setTimeout(notifyNavigation, 100);
  };

  history.replaceState = function(...args) {
    originalReplaceState.apply(this, args);
    setTimeout(notifyNavigation, 100);
  };

  window.addEventListener('popstate', () => {
    setTimeout(notifyNavigation, 100);
  });

  console.log('[vox-trace] DOM recorder injected ✓');
})();
`;

// ─── Node.js Side: Injection & Collection ───────────────────

export class DomRecorder {
  private actions: RecordedAction[] = [];
  private globalSeq = 0;

  getActions(): RecordedAction[] {
    return [...this.actions];
  }

  /**
   * Inject the recorder into a page and all its frames.
   * Should be called after page creation and on framenavigated events.
   */
  async injectIntoPage(page: Page, tabIndex: number): Promise<void> {
    // Expose the callback function (only once per page)
    try {
      await page.exposeFunction('__voxRecordAction', (jsonStr: string) => {
        try {
          const raw = JSON.parse(jsonStr);
          this.globalSeq++;
          const action: RecordedAction = {
            ...raw,
            seq: this.globalSeq,
            tabIndex,
            frameIndex: 0,
          };
          this.actions.push(action);
        } catch {}
      });
    } catch {
      // exposeFunction may already be registered (e.g., after SPA navigation)
    }

    // Inject into main frame
    await this.injectIntoFrame(page, tabIndex, 0);

    // Inject into existing iframes
    for (let i = 0; i < page.frames().length; i++) {
      const frame = page.frames()[i];
      if (frame !== page.mainFrame()) {
        await this.injectIntoFrame(frame, tabIndex, i);
      }
    }

    // Re-inject on frame navigation (MPA or iframe reload)
    page.on('framenavigated', async (frame) => {
      const frameIndex = page.frames().indexOf(frame);
      await this.injectIntoFrame(frame, tabIndex, frameIndex).catch(() => {});
    });
  }

  private async injectIntoFrame(frame: Page | Frame, tabIndex: number, frameIndex: number): Promise<void> {
    try {
      await frame.evaluate(RECORDER_SCRIPT);
    } catch {
      // Frame may not be ready or cross-origin — non-fatal
    }
  }

  /**
   * Post-process: correlate actions with API calls by timestamp proximity
   */
  correlateWithApi(networkEntries: Array<{
    timestamp: string;
    method: string;
    url: string;
    status: number;
    duration?: number;
    resourceType: string;
  }>): void {
    const apiEntries = networkEntries.filter(
      e => e.resourceType === 'xhr' || e.resourceType === 'fetch'
    );

    for (const action of this.actions) {
      if (action.type !== 'click' && action.type !== 'press_key') continue;

      // Find API calls within 2000ms after this action
      const actionTime = action.timestamp;
      const candidates = apiEntries.filter(api => {
        const apiTime = new Date(api.timestamp).getTime();
        return apiTime >= actionTime && apiTime <= actionTime + 2000;
      });

      // Pick the first trigger API (POST/PUT/PATCH/DELETE)
      const trigger = candidates.find(api =>
        ['POST', 'PUT', 'PATCH', 'DELETE'].includes(api.method)
      );

      if (trigger) {
        try {
          const url = new URL(trigger.url);
          action.correlatedApi = {
            endpoint: `${trigger.method} ${url.pathname}`,
            method: trigger.method,
            status: trigger.status,
            duration: trigger.duration || 0,
          };
        } catch {}
      }
    }
  }

  /**
   * Post-process: correlate actions with transcript segments
   */
  correlateWithTranscript(transcriptText: string): void {
    // Parse transcript.md — expected format:
    // [00:00:05] 接下來我們要登入後台
    // [00:00:12] 輸入帳號密碼
    const segments: Array<{ timeMs: number; text: string }> = [];
    const regex = /\[(\d{2}):(\d{2}):(\d{2})\]\s*(.*)/g;
    let match;
    while ((match = regex.exec(transcriptText)) !== null) {
      const [, hh, mm, ss, text] = match;
      const timeMs = (parseInt(hh) * 3600 + parseInt(mm) * 60 + parseInt(ss)) * 1000;
      segments.push({ timeMs, text });
    }

    if (segments.length === 0) return;

    // Use session start time as reference
    const sessionStart = this.actions.length > 0 ? this.actions[0].timestamp : Date.now();

    for (const action of this.actions) {
      const relativeTime = action.timestamp - sessionStart;
      // Find the closest preceding transcript segment
      let closest: typeof segments[0] | undefined;
      for (const seg of segments) {
        if (seg.timeMs <= relativeTime + 3000) {
          closest = seg;
        }
      }
      if (closest) {
        action.correlatedTranscript = closest.text;
      }
    }
  }
}
