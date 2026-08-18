/**
 * graceful-stop 訊號：讓錄製能在「不 kill 進程」的前提下安全收尾。
 *
 * 背景：record-manual-session.ts 用 page.pause() 阻塞等人在 Playwright
 * Inspector 按 Resume。直接 kill 進程會丟失所有產出（trace/network/
 * user-actions 都還沒 flush）。為了讓 agent 能在使用者說「done/好了」時
 * 幫忙收尾，改成 race：page.pause() 與「監看 sentinel 檔」誰先到都往下
 * 走原本的存檔流程——出現 .stop-recording 檔 = 等同按 Resume。
 *
 * 純檔案輪詢（不用 fs.watch）：跨平台穩定、不受 macOS FSEvents 合併事件影響，
 * 且 sentinel 檔可能在 watcher 啟動前就已存在。
 */

import * as fs from 'fs';

export interface StopWatcher {
  /** sentinel 檔出現時 resolve；cancel 後永不 resolve。 */
  promise: Promise<void>;
  /** 停止輪詢、釋放 timer（race 另一邊先贏時呼叫，避免 timer 洩漏）。 */
  cancel: () => void;
}

/**
 * 輪詢 stopFilePath 是否存在；出現即 resolve。
 * @param stopFilePath sentinel 檔路徑（通常是 SESSION_DIR/.stop-recording）
 * @param pollMs 輪詢間隔毫秒（預設 500）
 */
export function waitForStopFile(stopFilePath: string, pollMs = 500): StopWatcher {
  let timer: ReturnType<typeof setInterval> | null = null;
  let cancelled = false;

  const promise = new Promise<void>((resolve) => {
    // 啟動時就已存在 → 立即命中
    if (fs.existsSync(stopFilePath)) {
      resolve();
      return;
    }
    timer = setInterval(() => {
      if (cancelled) return;
      if (fs.existsSync(stopFilePath)) {
        if (timer) { clearInterval(timer); timer = null; }
        resolve();
      }
    }, pollMs);
    // Node 環境下讓 timer 不阻止進程結束（record 進程另有 page.pause 撐著）。
    // tsconfig 的 lib 把 setInterval 回傳當成 browser 的 number，故用守衛式 cast。
    const t = timer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
  });

  const cancel = () => {
    cancelled = true;
    if (timer) { clearInterval(timer); timer = null; }
  };

  return { promise, cancel };
}
