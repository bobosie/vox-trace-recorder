/**
 * Whisper Transcription
 *
 * Converts audio.wav to transcript.md using Whisper (CLI or Python fallback).
 */

import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';

interface WhisperSegment {
  start: number;
  end: number;
  text: string;
}

function formatTimestamp(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function getAudioDuration(audioPath: string): number {
  try {
    // Try sox/soxi first
    const result = spawnSync('soxi', ['-D', audioPath], { encoding: 'utf-8' });
    if (result.status === 0 && result.stdout.trim()) {
      return parseFloat(result.stdout.trim());
    }
  } catch {}
  try {
    // Try ffprobe
    const result = spawnSync('ffprobe', [
      '-v', 'quiet', '-show_entries', 'format=duration',
      '-of', 'csv=p=0', audioPath,
    ], { encoding: 'utf-8' });
    if (result.status === 0 && result.stdout.trim()) {
      return parseFloat(result.stdout.trim());
    }
  } catch {}
  return 0;
}

function resolveWhisperBin(): string | null {
  // 先看 PATH；找不到再退到已知安裝位置（vox-trace 子程序 PATH 常不含 pip user bin，
  // 導致「Whisper not available」而產空稿——見 vestpkg R8/R9 兩輪踩坑）。
  const which = spawnSync('which', ['whisper'], { encoding: 'utf-8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  const home = process.env.HOME || '';
  const candidates = [
    path.join(home, 'Library/Python/3.9/bin/whisper'),
    path.join(home, '.local/bin/whisper'),
    '/opt/homebrew/bin/whisper',
    '/usr/local/bin/whisper',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function tryWhisperCli(audioPath: string, outputDir: string): WhisperSegment[] | null {
  const whisperBin = resolveWhisperBin();
  if (!whisperBin) return null;

  console.log(`   Using whisper CLI (${whisperBin})...`);
  try {
    spawnSync(whisperBin, [
      audioPath, '--model', 'small', '--language', 'zh',
      '--output_format', 'json', '--output_dir', outputDir,
    ], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 900_000 });

    const baseName = path.basename(audioPath, path.extname(audioPath));
    const jsonPath = path.join(outputDir, `${baseName}.json`);
    if (fs.existsSync(jsonPath)) {
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      return data.segments || [];
    }
  } catch (err: any) {
    console.warn(`   ⚠️  whisper CLI failed: ${err.message?.split('\n')[0]}`);
  }
  return null;
}

function tryWhisperPython(audioPath: string, outputDir: string): WhisperSegment[] | null {
  const pythonPath = path.join(process.env.HOME || '~', 'Tool/spec_from_video/venv/bin/python');
  const which = spawnSync('test', ['-x', pythonPath]);
  if (which.status !== 0) return null;

  console.log('   Using Python whisper...');
  const script = `
import whisper, json, sys
model = whisper.load_model("small")
result = model.transcribe(sys.argv[1], language="zh")
segments = [{"start": s["start"], "end": s["end"], "text": s["text"].strip()} for s in result["segments"]]
print(json.dumps(segments))
`;

  try {
    const result = spawnSync(pythonPath, ['-c', script, audioPath], {
      encoding: 'utf-8',
      timeout: 300_000,
    });
    if (result.status === 0 && result.stdout.trim()) {
      return JSON.parse(result.stdout.trim());
    }
    if (result.stderr) {
      console.warn(`   ⚠️  Python whisper stderr: ${result.stderr.split('\n')[0]}`);
    }
  } catch (err: any) {
    console.warn(`   ⚠️  Python whisper failed: ${err.message?.split('\n')[0]}`);
  }
  return null;
}

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
  // Sort by key length descending so longer phrases match first
  const entries = Object.entries(glossary.corrections)
    .filter(([k]) => k.length > 0)
    .sort((a, b) => b[0].length - a[0].length);
  for (const [wrong, correct] of entries) {
    result = result.split(wrong).join(correct);
  }
  return result;
}

export async function transcribe(
  audioPath: string,
  outputDir: string,
  sessionId: string,
): Promise<void> {
  console.log('🗣️  Transcribing audio with Whisper...');

  const duration = getAudioDuration(audioPath);
  let segments: WhisperSegment[] | null = null;

  // Try whisper CLI first, then Python fallback
  segments = tryWhisperCli(audioPath, outputDir);
  if (!segments) {
    segments = tryWhisperPython(audioPath, outputDir);
  }

  if (!segments) {
    console.warn('   ⚠️  Whisper not available (install: pip install openai-whisper)');
    console.warn('   Generating empty transcript.');
  }

  // Load domain glossary for correction
  const glossary = loadGlossary();
  const hasCorrections = glossary?.corrections && Object.keys(glossary.corrections).length > 0;

  // Build raw transcript lines
  const buildLines = (title: string): string[] => {
    const lines: string[] = [
      `# ${title}`,
      '',
      `> Session: ${sessionId} | Duration: ${duration > 0 ? `${Math.round(duration)}s` : 'unknown'}`,
      '',
    ];

    if (segments && segments.length > 0) {
      for (const seg of segments) {
        lines.push(`[${formatTimestamp(seg.start)}] ${seg.text}`);
      }
    } else {
      lines.push('_（無語音內容或 Whisper 不可用）_');
    }

    lines.push('');
    return lines;
  };

  if (hasCorrections) {
    // Save raw version
    const rawLines = buildLines('語音逐字稿（原始）');
    fs.writeFileSync(path.join(outputDir, 'transcript-raw.md'), rawLines.join('\n'));

    // Apply corrections and save corrected version
    const correctedLines = buildLines('語音逐字稿（已校正）');
    const corrected = correctedLines.map(line => applyCorrections(line, glossary!));
    fs.writeFileSync(path.join(outputDir, 'transcript.md'), corrected.join('\n'));

    const correctionCount = Object.keys(glossary!.corrections!).length;
    console.log(`   ✅ transcript.md generated（已校正，${correctionCount} 組詞彙）+ transcript-raw.md`);
  } else {
    // No glossary or no corrections — just write transcript.md
    const lines = buildLines('語音逐字稿');
    fs.writeFileSync(path.join(outputDir, 'transcript.md'), lines.join('\n'));
    console.log(`   ✅ transcript.md generated${segments && segments.length > 0 ? ` (${segments.length} segments)` : ''}`);
  }
}
