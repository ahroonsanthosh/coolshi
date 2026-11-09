#!/usr/bin/env bash
# Edit a reel with m5e. Double-click it in Finder (first time: right-click -> Open), choose the folder that
# has your clips + vo.m4a, and the review page opens in your browser.
# From Terminal you can also pass the folder: ./m5e.command ~/Desktop/lisbon-day1
cd "$(dirname "$0")"
if [[ ! -x .venv/bin/python ]]; then
  echo "m5e isn't set up yet: double-click install.command first."
  read -r -p "Press Enter to close." _ || true
  exit 1
fi
FOLDER="${1:-}"
if [[ -z "$FOLDER" && "$(uname)" == "Darwin" ]]; then
  FOLDER=$(osascript -e 'POSIX path of (choose folder with prompt "Choose the folder with your clips and vo.m4a")' 2>/dev/null) || exit 0
fi
if [[ -z "$FOLDER" ]]; then
  read -r -p "Folder with your clips: " FOLDER
fi
echo "Editing: $FOLDER"
echo "The review page opens in your browser. Leave this window open while you work; close it to stop m5e."
exec .venv/bin/python -m m5e ui "$FOLDER"
