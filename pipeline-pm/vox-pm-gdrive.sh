#!/bin/bash
# vox-pm-gdrive.sh — vox-pm-gdrive.py 的 bash 包裝（用 uv run 帶 Google 依賴）。
# 直接把所有參數透傳給 python helper，透傳其 exit code。
#   bash vox-pm-gdrive.sh auth
#   bash vox-pm-gdrive.sh upload --session-dir <dir> --folder <name>
#   bash vox-pm-gdrive.sh list --folder <name>
#   bash vox-pm-gdrive.sh download --folder <name> --session <名> --dest <dir>
export PATH=/opt/homebrew/bin:$HOME/.local/bin:$HOME/bin:$PATH
set -uo pipefail

# 帶入 Shared Drive 設定（VOX_PM_DRIVE_ID 等），存在才 source。
VOX_PM_ENV="${VOX_PM_ENV:-$HOME/.config/vox-pm/env}"
# shellcheck source=/dev/null
[ -f "$VOX_PM_ENV" ] && source "$VOX_PM_ENV"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GDRIVE_PY="$SELF_DIR/vox-pm-gdrive.py"
UV="$(command -v uv || echo "$HOME/.local/bin/uv")"

exec "$UV" run --quiet --python 3.12 \
    --with google-api-python-client --with google-auth \
    python3 "$GDRIVE_PY" "$@"
