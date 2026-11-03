#!/usr/bin/env bash
# WalDM launcher for the desktop entry. Ensures Node is on PATH (nvm installs
# aren't on the default desktop-session PATH), moves into the app directory,
# and starts the Electron GUI. launch.js strips ELECTRON_RUN_AS_NODE; we add
# --no-sandbox because a locally-installed Electron's chrome-sandbox helper is
# usually not setuid-root on Linux.
export PATH="/home/kali/.nvm/versions/node/v20.20.2/bin:$PATH"
cd "$(dirname "$(readlink -f "$0")")" || exit 1
unset ELECTRON_RUN_AS_NODE
# Prefer the bundled yt-dlp venv (immune to system Python upgrades).
if [ -x "$PWD/bin/ytdlp-venv/bin/yt-dlp" ]; then
  export WALDM_YTDLP="$PWD/bin/ytdlp-venv/bin/yt-dlp"
fi
exec node launch.js --no-sandbox "$@"
