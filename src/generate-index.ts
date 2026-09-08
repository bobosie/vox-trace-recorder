/**
 * generate-index.ts — 掃 spec-schema/specs/ 下的驗證程序（*.spec.yaml 完整程序 + _shared/*.step.yaml 步驟片段），
 * 讀 frontmatter，產出 spec-schema/index.yaml（精確查詢）+ spec-schema/CATALOG.md（人可讀）。
 *
 * 這是「驗證程序目錄」：AI-Judge 要實證某功能時，先查此目錄有無現成程序，命中就照 steps 點過、逐 assertions 判定。
 *
 * Usage:
 *   npx tsx src/generate-index.ts                 # 掃 spec-schema/specs → 寫 index.yaml + CATALOG.md
 *   npx tsx src/generate-index.ts <specs-dir> [--output <index.yaml>]
 *
 * 慣例：domain 未標時從第一層目錄推導（_inbox→unsorted）；e2e_status 未標預設 draft。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface IndexEntry {
  path: string;                 // 相對 specs root
  kind: 'spec' | 'step';        // 完整程序 vs 可複用步驟片段
  title: string;
  domain: string;
  feature?: string;
  description?: string;         // 這程序在驗什麼（AI-Judge 判斷相關性用）
  tags: string[];
  priority?: string;
  e2e_status: string;
  acts: number;                 // 步驟群組數（step 片段為 0）
  assertions: number;          // 驗證點總數（越多越完整）
  vone_e2e_helper?: string | null; // 有值 → AI-Judge 可走確定性路徑
  session_id?: string;
  recorded_at?: string;
}

export interface IndexDoc {
  generated_at?: string;
  total: number;
  specs: number;
  steps: number;
  entries: IndexEntry[];
}

/** 遞迴找 *.spec.yaml 與 *.step.yaml */
function findProcedureFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findProcedureFiles(full));
    } else if (entry.isFile() && (entry.name.endsWith('.spec.yaml') || entry.name.endsWith('.step.yaml'))) {
      out.push(full);
    }
  }
  return out;
}

function deriveDomain(relPath: string): string {
  const first = relPath.split(path.sep)[0];
  if (!first || first.endsWith('.yaml')) return 'unsorted';
  if (first === '_inbox') return 'unsorted';
  if (first === '_shared') return '_shared';
  return first;
}

/** 數 assertions：頂層 + 每個 act 內 */
function countAssertions(doc: any): number {
  let n = Array.isArray(doc.assertions) ? doc.assertions.length : 0;
  if (Array.isArray(doc.acts)) {
    for (const a of doc.acts) if (Array.isArray(a?.assertions)) n += a.assertions.length;
  }
  return n;
}

/** 掃 specsRoot 回傳目錄物件（純函式，供測試）。解析失敗跳過並警告。 */
export function buildIndex(specsRoot: string): IndexDoc {
  const files = findProcedureFiles(specsRoot);
  const entries: IndexEntry[] = [];

  for (const file of files) {
    const relPath = path.relative(specsRoot, file).split(path.sep).join('/');
    let doc: any;
    try {
      doc = yaml.load(fs.readFileSync(file, 'utf-8')) ?? {};
    } catch (err) {
      console.warn(`⚠️  略過解析失敗: ${relPath} (${(err as Error).message})`);
      continue;
    }
    const isStep = file.endsWith('.step.yaml');
    const recorded = doc.recorded_from ?? {};
    entries.push({
      path: relPath,
      kind: isStep ? 'step' : 'spec',
      title: typeof doc.title === 'string' ? doc.title : (doc.step_id || relPath),
      domain: doc.domain || deriveDomain(relPath),
      feature: doc.feature,
      description: doc.description || doc.intent,
      tags: Array.isArray(doc.tags) ? doc.tags : [],
      priority: doc.priority,
      e2e_status: doc.e2e_status || (isStep ? 'reusable' : 'draft'),
      acts: Array.isArray(doc.acts) ? doc.acts.length : 0,
      assertions: countAssertions(doc),
      vone_e2e_helper: 'vone_e2e_helper' in doc ? doc.vone_e2e_helper : undefined,
      session_id: recorded.session_id,
      recorded_at: recorded.recorded_at,
    });
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  return {
    total: entries.length,
    specs: entries.filter(e => e.kind === 'spec').length,
    steps: entries.filter(e => e.kind === 'step').length,
    entries,
  };
}

/** 產出人可讀 CATALOG.md（grep + 掃讀友善） */
export function renderCatalog(index: IndexDoc): string {
  const lines: string[] = [
    '# 驗證程序目錄（CATALOG）',
    '',
    '> 自動產生（`npx tsx src/generate-index.ts`）。AI-Judge 實證前先查此表：找到相關程序 → 照 steps 點過、逐 assertions 判定。',
    '',
    `共 ${index.total}（完整程序 ${index.specs} / 可複用步驟 ${index.steps}）`,
    '',
  ];
  const byDomain: Record<string, IndexEntry[]> = {};
  for (const e of index.entries) (byDomain[e.domain] ||= []).push(e);
  for (const domain of Object.keys(byDomain).sort()) {
    lines.push(`## ${domain}`, '');
    lines.push('| 程序 | 驗什麼 | 驗證點 | 確定性 helper | 狀態 | path |');
    lines.push('|------|--------|:----:|--------------|------|------|');
    for (const e of byDomain[domain]) {
      const helper = e.vone_e2e_helper ? '✅ ' + e.vone_e2e_helper : (e.vone_e2e_helper === null ? '🔴 無' : '—');
      const desc = (e.description || '').replace(/\|/g, '/').slice(0, 50);
      lines.push(`| ${e.title} | ${desc} | ${e.assertions} | ${helper} | ${e.e2e_status} | ${e.path} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ─── CLI ────────────────────────────────────────────────────
function main(): void {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--output');
  const outputArg = outIdx !== -1 ? args[outIdx + 1] : undefined;
  const specsDir = args.find((a, i) => !a.startsWith('--') && (outIdx === -1 || i !== outIdx + 1))
    || path.join(process.cwd(), 'spec-schema', 'specs');

  const resolvedSpecs = path.resolve(specsDir);
  if (!fs.existsSync(resolvedSpecs)) {
    console.error(`❌ specs 目錄不存在: ${resolvedSpecs}`);
    process.exit(1);
  }

  const schemaDir = path.dirname(resolvedSpecs);
  const outputPath = outputArg ? path.resolve(outputArg) : path.join(schemaDir, 'index.yaml');
  const catalogPath = path.join(schemaDir, 'CATALOG.md');

  const index = buildIndex(resolvedSpecs);
  // index.yaml / CATALOG.md 落在 schemaDir(spec-schema/)，但 entries.path 相對 specsRoot(specs/)。
  // 補上 specs/ 前綴，讓消費者（AI-Judge / verify）照 path 從 spec-schema/ 讀得到檔案。
  const prefix = path.basename(resolvedSpecs);
  index.entries = index.entries.map(e => ({ ...e, path: `${prefix}/${e.path}` }));
  index.generated_at = new Date().toISOString();

  const header = '# 自動產生 — 請勿手改。來源：npx tsx src/generate-index.ts\n' +
    '# 精確查詢：yq / grep；語意查詢：memsearch；人可讀：CATALOG.md\n';
  fs.writeFileSync(outputPath, header + yaml.dump(index, { lineWidth: 120, noRefs: true, sortKeys: false }), 'utf-8');
  fs.writeFileSync(catalogPath, renderCatalog(index), 'utf-8');

  console.log(`✅ index: ${outputPath}（${index.total}：spec ${index.specs} / step ${index.steps}）`);
  console.log(`✅ catalog: ${catalogPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith('generate-index.ts')) {
  main();
}
