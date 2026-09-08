/**
 * 跨平台小工具：查外部指令在不在、家目錄在哪、檔案能不能執行。
 *
 * 為什麼需要這支：原本這些判斷散在各檔，寫法是 POSIX 專屬的——
 *   spawnSync('which', [cmd])   → Windows 沒有 which（對應的是 where.exe），永遠 status≠0
 *   process.env.HOME            → Windows 上通常沒設（是 USERPROFILE），變成空字串
 *   spawnSync('test', ['-x',p]) → Windows 沒有 test
 * 後果不是崩潰而是「靜默判定成工具不存在」：麥克風與轉錄在 Windows 一律停用，
 * 就算使用者真的裝了 sox / whisper 也一樣。功能降級是可接受的，但**理由是錯的**，
 * 而且沒有留下讓 Windows 使用者啟用的路。
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';

export const isWindows = process.platform === 'win32';

/** 家目錄。Windows 沒有 HOME，os.homedir() 會回 USERPROFILE。 */
export function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir() || '';
}

/**
 * 查指令的完整路徑，找不到回 null。
 * POSIX 用 `command -v`（比 which 標準，shell builtin 也查得到）；Windows 用 `where`。
 * `where` 命中多個時每行一個，取第一行。
 */
export function commandPath(cmd: string): string | null {
  try {
    const r = isWindows
      ? spawnSync('where', [cmd], { encoding: 'utf-8' })
      : spawnSync('sh', ['-c', `command -v ${JSON.stringify(cmd)}`], { encoding: 'utf-8' });
    if (r.status === 0 && r.stdout && r.stdout.trim()) {
      return r.stdout.trim().split(/\r?\n/)[0].trim() || null;
    }
  } catch {}
  return null;
}

/** 指令存在與否（只要布林值時用這個，語意比 commandPath() !== null 清楚）。 */
export function hasCommand(cmd: string): boolean {
  return commandPath(cmd) !== null;
}

/**
 * 檔案存在且可執行。
 * Windows 沒有 POSIX 的 x bit，fs.constants.X_OK 在那邊等同 F_OK（存在即可），
 * 這正是我們要的語意——存在就試著跑。
 */
export function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
