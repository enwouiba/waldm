'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');

// Locate a yt-dlp binary: bundled with the app, on PATH, or common install dirs.
function resolveYtDlp() {
  const candidates = [
    process.env.WALDM_YTDLP,
    // Dedicated venv shipped/created next to the app (survives system Python
    // upgrades that orphan a --user install).
    path.join(__dirname, '..', '..', 'bin', 'ytdlp-venv', 'bin', 'yt-dlp'),
    path.join(process.resourcesPath || '', 'bin', 'ytdlp-venv', 'bin', 'yt-dlp'),
    path.join(process.resourcesPath || '', 'bin', 'yt-dlp'),
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    '/home/' + (process.env.USER || 'user') + '/.local/bin/yt-dlp',
    'yt-dlp', // PATH fallback
  ].filter(Boolean);
  for (const c of candidates) {
    if (c === 'yt-dlp') return c;
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return 'yt-dlp';
}

const YTDLP = resolveYtDlp();

function isProbablyVideoPage(url) {
  return /youtube\.com|youtu\.be|vimeo\.com|dailymotion|twitch\.tv|tiktok\.com|facebook\.com|instagram\.com|\.m3u8(\?|$)/i.test(
    url
  );
}

// Fetch metadata + available formats without downloading.
function probeVideo(url) {
  return new Promise((resolve, reject) => {
    const p = spawn(YTDLP, ['-J', '--no-warnings', url]);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) =>
      reject(new Error('yt-dlp not available: ' + e.message))
    );
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim() || 'yt-dlp exited ' + code));
      try {
        const j = JSON.parse(out);
        const formats = (j.formats || [])
          .filter((f) => f.vcodec !== 'none' || f.acodec !== 'none')
          .map((f) => ({
            format_id: f.format_id,
            ext: f.ext,
            resolution: f.resolution || (f.height ? f.height + 'p' : 'audio'),
            fps: f.fps,
            filesize: f.filesize || f.filesize_approx || 0,
            vcodec: f.vcodec,
            acodec: f.acodec,
            note: f.format_note || '',
          }));
        resolve({
          title: j.title || 'video',
          duration: j.duration || 0,
          thumbnail: j.thumbnail || '',
          ext: j.ext || 'mp4',
          formats,
        });
      } catch (e) {
        reject(new Error('Could not parse yt-dlp output'));
      }
    });
  });
}

// Drives a yt-dlp download; emits the same shape of events as DownloadEngine.
class VideoDownload extends EventEmitter {
  constructor(task) {
    super();
    this.id = task.id;
    this.url = task.url;
    this.dir = task.dir;
    this.filename = task.filename || null; // template picks name if null
    this.formatId = task.formatId || null;
    this.state = 'queued';
    this.received = 0;
    this.total = task.total || 0;
    this.proc = null;
    this._paused = false;
    this.filePath = task.filePath || null;
  }

  _setState(s) {
    this.state = s;
    this.emit('state', s);
  }

  start() {
    this._paused = false;
    const outTmpl = this.filename
      ? path.join(this.dir, this.filename)
      : path.join(this.dir, '%(title)s.%(ext)s');
    const args = [
      '--no-warnings',
      '--newline',
      '--progress',
      '-o',
      outTmpl,
      '--print',
      'after_move:filepath',
    ];
    // Format selection that degrades gracefully:
    //  - a chosen (often video-only) id: try id+audio, then id alone, then best
    //  - no choice: best video+audio merged, else best progressive
    const fmt = this.formatId
      ? `${this.formatId}+bestaudio/${this.formatId}/bestvideo+bestaudio/best`
      : 'bestvideo*+bestaudio/best';
    args.push('-f', fmt, '--merge-output-format', 'mp4');
    args.push(this.url);

    this._setState('downloading');
    this._errTail = '';
    try {
      this.proc = spawn(YTDLP, args);
    } catch (e) {
      this._setState('error');
      return this.emit('error', new Error('Cannot start yt-dlp: ' + e.message));
    }
    this.proc.on('error', (e) => {
      this._setState('error');
      this.emit(
        'error',
        new Error(
          e.code === 'ENOENT'
            ? 'yt-dlp not found. Install it (see README) or set WALDM_YTDLP.'
            : 'yt-dlp: ' + e.message
        )
      );
    });
    this.proc.stdout.on('data', (buf) => this._parse(buf.toString()));
    this.proc.stderr.on('data', (buf) => {
      const t = buf.toString();
      this._errTail = (this._errTail + t).slice(-800);
      this._parse(t);
    });
    this.proc.on('close', (code) => {
      if (this._paused) {
        this._setState('paused');
        return;
      }
      if (code === 0) {
        this._setState('completed');
        this.emit('progress', { received: this.total, total: this.total, speed: 0, percent: 100 });
        this.emit('done', { filePath: this.filePath });
      } else {
        this._setState('error');
        const lines = this._errTail.split(/\r|\n/).filter((l) => /error|traceback|unavailable|not found|modulenotfound/i.test(l));
        const detail = (lines.pop() || this._errTail.trim().split(/\r|\n/).pop() || '').slice(0, 200);
        this.emit('error', new Error(detail ? 'yt-dlp: ' + detail : 'yt-dlp exited ' + code));
      }
    });
  }

  _parse(text) {
    for (const line of text.split(/\r|\n/)) {
      // [download]  42.1% of 50.00MiB at 3.00MiB/s ETA 00:10
      const m = /\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+)(\w+)\s+at\s+([\d.]+)(\w+)\/s/.exec(
        line
      );
      if (m) {
        const percent = parseFloat(m[1]);
        const total = toBytes(parseFloat(m[2]), m[3]);
        const speed = toBytes(parseFloat(m[4]), m[5]);
        this.total = total;
        this.received = (percent / 100) * total;
        this.emit('progress', { received: this.received, total, speed, percent });
      } else if (/^\//.test(line.trim()) && fs.existsSync(line.trim())) {
        this.filePath = line.trim(); // after_move:filepath print
      }
    }
  }

  pause() {
    // yt-dlp has no live pause; stop the process. Partial .part files let it
    // resume from where it left off on the next start().
    if (this.state !== 'downloading') return;
    this._paused = true;
    this._setState('pausing');
    if (this.proc) this.proc.kill('SIGTERM');
  }

  serialize() {
    return {
      id: this.id,
      url: this.url,
      dir: this.dir,
      filename: this.filename,
      formatId: this.formatId,
      total: this.total,
      received: this.received,
      state: this.state,
      filePath: this.filePath,
      kind: 'video',
    };
  }
}

function toBytes(n, unit) {
  const u = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, KB: 1000, MB: 1e6, GB: 1e9 };
  return n * (u[unit] || 1);
}

module.exports = { probeVideo, VideoDownload, isProbablyVideoPage, resolveYtDlp };
