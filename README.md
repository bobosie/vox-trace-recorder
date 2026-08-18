# vox-trace-recorder

Record manual browser sessions → structured data for AI-assisted test generation.

> 這是 **recorder 子集**：只含「錄製 → 產出 → （選配）自動上傳」那條鏈。
> 搭配 Claude Code 的 `ax:debug` 使用時，把本 repo clone 到 `~/vox-trace`（或設 `VOX_TRACE_DIR` 指到它）。

## What it does

You operate a web app manually in a Playwright-controlled browser. vox-trace captures everything:

| Output | Source | Description |
|--------|--------|-------------|
| `trace.zip` | Playwright | DOM snapshots + network requests + screenshots |
| `codegen.ts` | Playwright | Operation summary & navigation log |
| `network.json` | Playwright | All API requests/responses (excluding static assets) |
| `api-summary.md` | Playwright | Human-readable API digest |
| `screenshots/` | Playwright | Auto-captured screenshots on each page load (DOM-aware) |
| `keyframes/` | ffmpeg | Scene-change keyframes from video (pixel-level fallback) |
| `video.webm` | Playwright | Full session video |
| `metadata.json` | Both | Session metadata (URLs, timestamps, counts) |

`screenshots/` and `keyframes/` complement each other — Playwright captures on page load events (structural), ffmpeg captures on visual scene changes (pixel-level). Together they ensure no important UI state is missed.

Feed these to an AI coding assistant (Claude, etc.) to generate comprehensive E2E test specs.

## Quick Start

```bash
# Install
npm install

# Record a session
npm run record

# Record with existing auth session
npm run record -- --load-storage ./path/to/auth.json

# Record with custom name
npm run record -- --name my-feature-test
```

## Two Recording Approaches

### Route A: Playwright Inspector (recommended)

Best for: structured data quality (DOM, API, codegen).

```bash
npm run record
# → Browser opens → Playwright Inspector appears
# → You operate manually → Close Inspector when done
# → Structured data saved to recordings/{session-id}/
```

### Route B: Screen Recording + Keyframes (flexible)

Best for: using your own browser with existing login state.

```bash
# 1. Record screen with macOS (Cmd+Shift+5) or any tool
# 2. Extract keyframes
npm run keyframes -- recording.mov

# Output: keyframes-{name}/ with scene-change screenshots
```

## CLI Options

### `npm run record`

| Option | Description |
|--------|-------------|
| `--load-storage <path>` | Load existing Playwright storage state (cookies/localStorage) |
| `--name <name>` | Custom session name (default: ISO timestamp) |
| `--base-url <url>` | Override base URL (default: `$BASE_URL` or localhost) |
| `--codegen` | Enable codegen recording hint |

### `npm run keyframes`

```bash
npm run keyframes -- <video-file> [output-dir] [threshold]
```

| Param | Description |
|-------|-------------|
| `video-file` | Input video (mov/mp4/webm) |
| `output-dir` | Output directory (default: `keyframes-{name}/`) |
| `threshold` | Scene change sensitivity 0.0-1.0 (default: 0.3, lower = more frames) |

## Reconstruct the video from a recording (storyboard replay)

vox-trace already captures every DOM action during recording (`user-actions.json`).
Two commands turn that into a **re-playable storyboard** and **reconstruct the video**
from it — the same "record steps → regenerate video" idea as
[shot-scraper video](https://simonwillison.net/2026/Jun/30/shot-scraper-video/),
but driven by vox-trace's own recording, native TypeScript + Playwright (no Python).

```bash
# 1. Turn a recorded session's actions into a storyboard (+ vox sidecar)
./start.sh storyboard <session>   # → recordings/<session>/storyboard.yml + storyboard.vox.json

# 2. Reconstruct the video by replaying the storyboard (auto-runs step 1 if needed)
./start.sh reconstruct <session>              # → recordings/<session>/reconstructed.mp4 (silent)
./start.sh reconstruct <session> --with-audio # re-attach the original narration (audio.wav)
./start.sh reconstruct <session> --headed     # watch the replay in a visible browser
./start.sh reconstruct <session> --with-audio --audio-offset 11   # manual A/V offset (sec)
```

`storyboard` produces two files:
- **`storyboard.yml`** — a **pure shot-scraper storyboard**: each `scenes[].do[]` step is a
  single-key mapping, no extra keys (shot-scraper v1.10 uses strict validation — extra keys are
  rejected). git-versionable; commit it and re-run `reconstruct` after a UI change to refresh the demo.
- **`storyboard.vox.json`** — a vox-trace sidecar (same order/length as `do[]`) carrying
  coordinates / `isCanvasKit` / API correlations. shot-scraper never reads it; native
  `reconstruct` uses it (mainly for canvas coordinate clicks).

**shot-scraper compatibility (verified against v1.10)** — you can run
`shot-scraper video storyboard.yml` directly **when the storyboard only uses the verbs
shot-scraper supports**: `pause`, `click`, `type:{into,text,delay_ms}`, `press:{selector,key}`,
`scroll:{y,duration}`, `wait_for`. Two recorded actions are **vox-native only** (shot-scraper
errors `Unknown storyboard action`): `select` (dropdowns) and in-flow `navigate` (multi-page).
Storyboards containing those — or canvas coordinate clicks — run via `./start.sh reconstruct`
(native, the primary path), which handles every verb.

### Audio (`--with-audio`)

Video (Playwright) and audio (`sox rec`) start at slightly different times. New recordings
store `audioStartOffsetMs` in `metadata.json` as the default mux offset. For older recordings
(or fine-tuning), calibrate manually: find 3+ narration cues in `transcript.md`, match them to
the on-screen action, compute `video_time = audio_time + offset`, and pass `--audio-offset <sec>`.

### Limitation: Flutter / canvas front-ends

Storyboard replay is **DOM-selector driven**. Flutter Web / CanvasKit pages render to a
`<canvas>` with no DOM elements — those actions fall back to best-effort coordinate clicks
(marked `bestEffort` in the `.vox.json` sidecar) and are fragile. Regular DOM sites (Vue / React /
Element UI admin panels, general websites) reconstruct reliably. For canvas front-ends, keep using
the normal video + audio recording.

## Feeding Data to AI

After recording, point your AI assistant to the session directory:

```
recordings/2026-03-22T14-30-00/
├── trace.zip          ← Most valuable (DOM + network + screenshots)
├── codegen.ts         ← Operation sequence
├── network.json       ← API behavior
├── api-summary.md     ← Quick API overview
├── screenshots/       ← Playwright: UI state per page load
├── keyframes/         ← ffmpeg: scene-change frames (fallback)
├── video.webm         ← Full video
└── metadata.json      ← Session info
```

Recommended reading order for AI:
1. `codegen.ts` — understand operation sequence
2. `api-summary.md` — understand API behavior
3. `screenshots/` — understand UI state (max 20 images per AI request)
4. `network.json` — deep-dive specific API calls
5. `npx playwright show-trace trace.zip` — interactive trace viewer

## Requirements

- Node.js 18+
- ffmpeg (for keyframe extraction): `brew install ffmpeg`

## License

MIT
