#!/bin/bash
# ============================================
# Video Keyframe Extractor
#
# Extracts keyframes from screen recordings using ffmpeg scene detection.
# Useful when you want to use your own browser instead of Playwright.
#
# Usage:
#   extract-keyframes.sh <video-file> [output-dir] [threshold]
#
# Arguments:
#   video-file   Video file path (mov/mp4/webm)
#   output-dir   Output directory (default: keyframes-{name}/ next to video)
#   threshold    Scene change threshold 0.0~1.0 (default: 0.3, lower = more frames)
#
# Examples:
#   extract-keyframes.sh recording.mov
#   extract-keyframes.sh recording.mov ./frames 0.2
#   extract-keyframes.sh ~/Desktop/demo.mp4 /tmp/frames 0.4
#
# Output:
#   kf_001.png, kf_002.png, ...   (scene change keyframes)
#   first_frame.png, last_frame.png
#   metadata.json
# ============================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Check ffmpeg
if ! command -v ffmpeg &> /dev/null; then
    echo -e "${RED}❌ ffmpeg not found. Install with: brew install ffmpeg${NC}"
    exit 1
fi

# Parse arguments
VIDEO_FILE="${1}"
if [ -z "$VIDEO_FILE" ]; then
    echo -e "${YELLOW}Usage: extract-keyframes.sh <video-file> [output-dir] [threshold]${NC}"
    echo ""
    echo "Examples:"
    echo "  extract-keyframes.sh recording.mov"
    echo "  extract-keyframes.sh recording.mov ./frames 0.2"
    exit 1
fi

if [ ! -f "$VIDEO_FILE" ]; then
    echo -e "${RED}❌ File not found: ${VIDEO_FILE}${NC}"
    exit 1
fi

VIDEO_DIR="$(dirname "$VIDEO_FILE")"
VIDEO_NAME="$(basename "$VIDEO_FILE" | sed 's/\.[^.]*$//')"
OUTPUT_DIR="${2:-${VIDEO_DIR}/keyframes-${VIDEO_NAME}}"
THRESHOLD="${3:-0.3}"

echo -e "${BLUE}🎬 Video Keyframe Extractor${NC}"
echo ""
echo -e "📹 Input: ${VIDEO_FILE}"
echo -e "📁 Output: ${OUTPUT_DIR}"
echo -e "🎚️  Threshold: ${THRESHOLD}"
echo ""

mkdir -p "$OUTPUT_DIR"

# Get video duration
DURATION="$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$VIDEO_FILE" 2>/dev/null | cut -d'.' -f1)"
echo -e "${BLUE}⏱️  Duration: ${DURATION}s${NC}"

# Method 1: Scene change detection (primary)
echo -e "\n${GREEN}▶ Extracting scene-change keyframes...${NC}"
ffmpeg -i "$VIDEO_FILE" \
    -vf "select='gt(scene,${THRESHOLD})',scale='min(1568,iw)':-1" \
    -fps_mode vfr \
    -frame_pts 1 \
    "${OUTPUT_DIR}/kf_%03d.png" \
    -y 2>/dev/null

SCENE_COUNT=$(ls -1 "${OUTPUT_DIR}"/kf_*.png 2>/dev/null | wc -l | tr -d ' ')
echo -e "   Scene changes: ${SCENE_COUNT} keyframes"

# If too few scene-change frames (< 3), supplement with fixed-interval
if [ "$SCENE_COUNT" -lt 3 ]; then
    echo -e "\n${YELLOW}⚠️  Few scene changes detected, adding fixed-interval frames...${NC}"

    if [ "$DURATION" -gt 0 ]; then
        INTERVAL=$(( DURATION / 15 ))
        [ "$INTERVAL" -lt 2 ] && INTERVAL=2
        [ "$INTERVAL" -gt 10 ] && INTERVAL=10
    else
        INTERVAL=5
    fi

    ffmpeg -i "$VIDEO_FILE" \
        -vf "fps=1/${INTERVAL},scale='min(1568,iw)':-1" \
        "${OUTPUT_DIR}/interval_%03d.png" \
        -y 2>/dev/null

    INTERVAL_COUNT=$(ls -1 "${OUTPUT_DIR}"/interval_*.png 2>/dev/null | wc -l | tr -d ' ')
    echo -e "   Fixed interval (${INTERVAL}s): ${INTERVAL_COUNT} frames"
fi

# First and last frame (ensure start/end state is captured)
echo -e "\n${GREEN}▶ Extracting first/last frames...${NC}"
ffmpeg -i "$VIDEO_FILE" -vf "scale='min(1568,iw)':-1" -frames:v 1 "${OUTPUT_DIR}/first_frame.png" -y 2>/dev/null
ffmpeg -sseof -1 -i "$VIDEO_FILE" -vf "scale='min(1568,iw)':-1" -frames:v 1 "${OUTPUT_DIR}/last_frame.png" -y 2>/dev/null

TOTAL_COUNT=$(ls -1 "${OUTPUT_DIR}"/*.png 2>/dev/null | wc -l | tr -d ' ')

# Generate metadata
echo -e "\n${GREEN}▶ Generating metadata...${NC}"
cat > "${OUTPUT_DIR}/metadata.json" << EOF
{
  "source": "$(cd "$(dirname "$VIDEO_FILE")" && pwd)/$(basename "$VIDEO_FILE")",
  "duration": ${DURATION:-0},
  "threshold": ${THRESHOLD},
  "totalFrames": ${TOTAL_COUNT},
  "sceneChangeFrames": ${SCENE_COUNT},
  "extractedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "files": [
$(ls -1 "${OUTPUT_DIR}"/*.png 2>/dev/null | while read f; do
    echo "    \"$(basename "$f")\","
done | sed '$ s/,$//')
  ]
}
EOF

# Summary
echo ""
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo -e "${GREEN}✅ Extraction complete!${NC}"
echo ""
echo -e "📁 Output: ${OUTPUT_DIR}"
echo -e "📸 Total frames: ${TOTAL_COUNT}"
echo ""
echo -e "📄 Files:"
ls -lh "${OUTPUT_DIR}"/*.png 2>/dev/null | awk '{print "   " $NF " (" $5 ")"}'
echo ""

if [ "$TOTAL_COUNT" -gt 20 ]; then
    echo -e "${YELLOW}⚠️  More than 20 frames. AI tools typically accept max 20 images per request.${NC}"
    echo -e "${YELLOW}   Consider increasing threshold or selecting a subset.${NC}"
    echo ""
fi

echo -e "${GREEN}═══════════════════════════════════════════${NC}"
