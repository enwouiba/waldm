# WalDM — Download Manager (IDM-style)

A fast, cross-platform download manager built with Electron + Node.js.
Multi-segment accelerated downloads, pause/resume, a browser extension that
captures downloads, video capture (yt-dlp) and scheduling.

## Features

- **Multi-segment downloading** — splits each file into up to 32 parallel
  connections (HTTP `Range`) for maximum speed. Verified byte-for-byte correct.
- **Pause / resume** — survives app restarts; partial files resume from exactly
  where they stopped (per-segment progress is persisted).
- **Queue & concurrency** — cap how many downloads run at once; the rest queue.
- **Global speed limit** — token-bucket throttle shared across all connections.
- **Browser integration** — a Chrome/Edge extension captures downloads and
  right-click links, forwarding them to the app over a token-gated localhost
  bridge.
- **Video capture** — paste a YouTube/Vimeo/HLS URL, pick a quality, download
  via bundled `yt-dlp`.
- **Scheduling** — queue a download to start at a chosen date/time.
- **Tray** — keeps running in the background; "Add from clipboard" from the tray.

## Architecture

```
src/main/
  downloadEngine.js  multi-segment engine (Range, resume, pause, retry) — zero deps
  rateLimiter.js     token-bucket global speed limit
  downloadManager.js queue, concurrency, persistence, scheduling, video routing
  ytdlp.js           yt-dlp wrapper (probe formats + download with progress)
  store.js           atomic JSON persistence of the download list + settings
  nativeServer.js    127.0.0.1 bridge for the browser extension (token-gated)
  main.js            Electron app, IPC, window, tray
  preload.js         contextBridge — the only surface the UI can call
src/renderer/        the UI (HTML/CSS/vanilla JS, no build step)
extension/chrome/    MV3 browser extension (background, popup, options)
```

The engine has **no third-party dependencies** — it uses only Node's `http`/
`https`/`fs`. You can test it without Electron:

```bash
# <url> [dest] [segments] [limitKBps]
node src/main/engineCli.js https://example.com/big.iso ./big.iso 8 0
```

## Run (development)

```bash
npm install
npm start
```

## Build installers

```bash
npm run dist:linux   # AppImage + .deb
npm run dist:win     # NSIS .exe   (run on Windows or with wine)
npm run dist:mac     # .dmg        (run on macOS)
```

Output lands in `dist/`.

## yt-dlp (video capture)

WalDM looks for `yt-dlp` in this order: `$WALDM_YTDLP` → `bin/ytdlp-venv/bin/yt-dlp`
→ packaged `resources/bin/…` → `/usr/local/bin` → `/usr/bin` → `~/.local/bin`
→ `PATH`. For merging hi-res video+audio, `ffmpeg` must also be installed.

Recommended: a dedicated virtualenv next to the app (immune to system-Python
upgrades, which commonly orphan a `pip --user` install with
`ModuleNotFoundError: No module named 'yt_dlp'`):

```bash
sudo apt install ffmpeg
python3 -m venv bin/ytdlp-venv
bin/ytdlp-venv/bin/pip install -U yt-dlp
```

The desktop launcher (`waldm.sh`) auto-detects `bin/ytdlp-venv` and exports
`WALDM_YTDLP`. To ship yt-dlp inside a packaged build, drop a standalone binary
at `resources/bin/yt-dlp`.

## Browser extension setup

1. Open the WalDM app → **Settings ⚙ → Browser integration** → copy the token.
2. In Chrome/Edge go to `chrome://extensions`, enable **Developer mode**, click
   **Load unpacked**, and select `extension/chrome/`.
3. Open the extension's **Options**, paste the token, keep the port `7611`, Save,
   then **Test connection**.
4. Now browser downloads are captured into WalDM, and you get a right-click
   **"Download with WalDM"** on any link, image, video or page.

The bridge listens only on `127.0.0.1` and rejects any request without the
token, so other machines and websites can't reach it.

## Notes & limits

- The download engine is fully tested on Linux (multi-segment + pause/resume +
  speed limit verified with SHA-256). The Electron shell builds on all three
  desktop platforms.
- yt-dlp has no live pause; pausing a video stops the process and resumes from
  its `.part` file on the next start.

## License

MIT
