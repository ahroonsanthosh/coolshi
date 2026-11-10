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

bold "Downloading the speech-to-text and vision models (one time, ~1 GB, free, they run on this Mac)..."
.venv/bin/python -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8')" \
  || echo "(skipped - it will download on the first edit instead)"
.venv/bin/python -c "from m5e import see; see.seer()" \
  || echo "(skipped - it will download on the first edit instead)"

if [[ -f "$HOME/.m5e/anthropic_key" ]]; then
  rm -f "$HOME/.m5e/anthropic_key"
  echo "Removed the API key an older m5e saved: m5e never uses pay-per-use API keys now."
fi

bold "Claude (optional): help from Claude on your Claude Pro/Max plan, never pay-per-use"
echo "m5e edits for free on this Mac. If Claude Code is logged in with your Claude subscription, m5e also asks"
echo "Claude to log the shots, direct the cut and review it - on your plan's included usage, and it stops by"
echo "itself when you hit the plan's limit."
CLAUDE_BIN="$(command -v claude || true)"
for c in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" /opt/homebrew/bin/claude /usr/local/bin/claude; do
  if [[ -z "$CLAUDE_BIN" && -x "$c" ]]; then CLAUDE_BIN="$c"; fi
done
if [[ -z "$CLAUDE_BIN" ]]; then
  read -r -p "Claude Code isn't installed. Install it now? [y/N] " A || A=""
  if [[ "$A" =~ ^[Yy] ]]; then
    curl -fsSL https://claude.ai/install.sh | bash || echo "Claude Code didn't install; m5e uses its free editor."
    [[ -x "$HOME/.local/bin/claude" ]] && CLAUDE_BIN="$HOME/.local/bin/claude"
  else
    echo "Skipped: m5e uses its free editor (run this again any time to add Claude)."
  fi
fi
if [[ -n "$CLAUDE_BIN" ]]; then
  export PATH="$(dirname "$CLAUDE_BIN"):$PATH"
  if ! .venv/bin/python -c "import sys; from m5e import brain; ok, why = brain.login(); print(why); sys.exit(0 if ok else 1)"; then
    echo "Log in with the Claude account that has your Max plan (a browser window opens):"
    env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN "$CLAUDE_BIN" auth login --claudeai \
      || echo "Login skipped: run 'claude auth login' any time."
    .venv/bin/python -c "import sys; from m5e import brain; ok, why = brain.login(force=True); print(why)" || true
  fi
  echo
  echo "To be sure nothing is ever billed beyond your plan, keep 'extra usage' (usage credits) switched OFF at"
  echo "https://claude.ai/settings/usage - m5e never uses it either way, and stops at your plan's limit."
fi

bold "Done. To edit a reel: double-click m5e.command and choose the folder with your clips and vo.m4a."
read -r -p "Press Enter to close." _ || true
