/**
 * upload-session — 把一場已經錄好的 session 送回 NL server。
 *
 * 正常情況不必用這支：錄製收尾會自動上傳（見 shared/nl-upload.ts）。
 * 這支是給三種補救情境：
 *   1. 錄的時候沒連 VPN，或 server 當時不在
 *   2. 當時帶了 --no-upload，後來決定還是要送
 *   3. 舊版錄影器錄的（那時還沒有自動上傳）
 *
 * 用法：
 *   npx tsx src/upload-session.ts <session 名或目錄路徑>
 *   npx tsx src/upload-session.ts --list          # 列出本機有哪些錄製
 *
 * 跨平台：純 Node，Windows 原生 PowerShell 也跑得動（不需要 bash，
 * 這正是取代 pipeline-nl/vox-nl-ship 的原因——那支是 bash，Windows 沒有）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { autoUploadSession, resolveUploadConfig, readNlEnvFile, nlEnvFilePath } from './shared/nl-upload';

const RECORDINGS_DIR = process.env.VOX_OUTPUT_DIR
  ? path.resolve(process.env.VOX_OUTPUT_DIR)
  : path.resolve(process.cwd(), 'recordings');

function listSessions(): string[] {
  try {
    return fs.readdirSync(RECORDINGS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** session 開始時間：優先用 metadata.json 記的，讓補傳與當初自動上傳算出同一個名字。 */
function sessionStartedAt(dir: string): Date {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf-8'));
    if (meta?.startTime) {
      const d = new Date(meta.startTime);
      if (!Number.isNaN(d.getTime())) return d;
    }
  } catch {}
  try {
    return fs.statSync(dir).mtime;
  } catch {
    return new Date();
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--list') || args.length === 0) {
    const sessions = listSessions();
    console.log(`📁 錄製目錄：${RECORDINGS_DIR}`);
    if (sessions.length === 0) {
      console.log('   （沒有找到任何錄製）');
    } else {
      for (const s of sessions) console.log(`   ${s}`);
    }
    console.log('');
    console.log('用法：npx tsx src/upload-session.ts <session 名>');
    process.exit(args.length === 0 ? 1 : 0);
  }

  const target = args[0];
  // 給的是路徑就直接用，給的是名字就接在錄製目錄下
  const sessionDir = target.includes(path.sep) || target.includes('/')
    ? path.resolve(target)
    : path.join(RECORDINGS_DIR, target);

  if (!fs.existsSync(sessionDir) || !fs.statSync(sessionDir).isDirectory()) {
    console.error(`❌ 找不到 session 目錄：${sessionDir}`);
    console.error('   看有哪些：npx tsx src/upload-session.ts --list');
    process.exit(1);
  }

  const envFileText = readNlEnvFile();
  const cfg = resolveUploadConfig({ env: process.env, envFileText });
  if (!cfg.enabled && cfg.reason === 'no-nl-config') {
    console.error('❌ 找不到 NL server 設定。');
    console.error(`   預期 ${nlEnvFilePath()} 裡有 NL_RECALL_SERVER=`);
    console.error('   沒裝過 NL workflow 的話先跑一次安裝，或用環境變數指定：');
    console.error('   NL_RECALL_SERVER=http://<server>:7654 NL_RECALL_TOKEN=<token> npx tsx src/upload-session.ts <session>');
    process.exit(1);
  }

  // 明確叫這支上傳，就不受 NL_AUTO_UPLOAD=0 影響——那個開關管的是
  // 「錄完要不要自動送」，不是「我現在手動叫你送」。
  const res = await autoUploadSession({
    sessionDir,
    sessionName: path.basename(sessionDir),
    startedAt: sessionStartedAt(sessionDir),
    env: { ...process.env, NL_AUTO_UPLOAD: '1' },
    envFileText,
  });

  if (!res) process.exit(1);
  // 與 vox-nl-ship 同樣的 exit 語意：75 = 暫時性錯誤，稍後重跑同一行
  if (!res.ok) process.exit(res.retryable ? 75 : 1);
}

main().catch(err => {
  console.error(`❌ ${err?.message ?? err}`);
  process.exit(1);
});
