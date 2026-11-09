#!/usr/bin/env bash
# m5e installer for macOS. Double-click it in Finder (first time: right-click -> Open).
# Also works on Linux if python3 (3.10+) and ffmpeg are already installed: bash install.command
set -euo pipefail
cd "$(dirname "$0")"

bold() { printf "\n\033[1m%s\033[0m\n" "$1"; }
fail() { printf "\n\033[31m%s\033[0m\n" "$1"; read -r -p "Press Enter to close." _ || true; exit 1; }

bold "m5e setup"

if [[ "$(uname)" == "Darwin" ]]; then
  if ! command -v brew >/dev/null 2>&1; then
    for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [[ -x $b ]] && eval "$($b shellenv)"; done
  fi
  if ! command -v brew >/dev/null 2>&1; then
    fail "Homebrew is needed to install ffmpeg and Python. Install it from https://brew.sh (one command in Terminal), then double-click install.command again."
  fi
  command -v ffmpeg >/dev/null 2>&1 || { bold "Installing ffmpeg..."; brew install ffmpeg; }
fi

command -v ffmpeg >/dev/null 2>&1 || fail "ffmpeg isn't installed. Install it, then run this again."

# a Python that's new enough (macOS's built-in one is too old)
PY=""
for c in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
    PY="$c"; break
  fi
done
if [[ -z "$PY" && "$(uname)" == "Darwin" ]]; then
  bold "Installing Python..."; brew install python@3.12; PY="$(brew --prefix)/bin/python3.12"
fi
[[ -n "$PY" ]] || fail "Python 3.10 or newer is needed. Install it from https://www.python.org/downloads/ and run this again."

bold "Setting up m5e's own Python environment (.venv)..."
"$PY" -m venv .venv
.venv/bin/python -m pip install --upgrade pip --quiet
.venv/bin/python -m pip install -r requirements.txt --quiet

bold "Downloading the speech-to-text model (one time, ~500 MB)..."
.venv/bin/python -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8')" \
  || echo "(skipped - it will download on the first edit instead)"

KEYFILE="$HOME/.m5e/anthropic_key"
if [[ -s "$KEYFILE" ]]; then
  bold "Anthropic API key: already saved."
else
  bold "Anthropic API key (for the AI editor). Create one at https://console.anthropic.com -> API Keys."
  read -r -s -p "Paste it here and press Enter (or just press Enter to skip for now): " KEY || KEY=""
  echo
  if [[ -n "${KEY:-}" ]]; then
    mkdir -p "$HOME/.m5e"; umask 077; printf '%s' "$KEY" > "$KEYFILE"; chmod 600 "$KEYFILE"
    echo "Saved to $KEYFILE (only your user can read it)."
  else
    echo "Skipped: m5e will use its rule-based editor until you add a key (run this again any time)."
  fi
fi

bold "Done. To edit a reel: double-click m5e.command and choose the folder with your clips and vo.m4a."
read -r -p "Press Enter to close." _ || true
