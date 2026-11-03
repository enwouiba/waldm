'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { EventEmitter } = require('events');

const MAX_REDIRECTS = 8;
const SEG_RETRY = 6;
const MIN_SEGMENT_BYTES = 1024 * 1024; // don't split files smaller than 1 MiB

function pickAgent(u) {
  return u.protocol === 'https:' ? https : http;
}

// Low-level GET that follows redirects and resolves with the live response
// stream. Rejects on non-2xx (except that Range gives 206).
function openStream(rawUrl, { headers = {}, method = 'GET', signal } = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(rawUrl);
    } catch (e) {
      return reject(new Error('Invalid URL: ' + rawUrl));
    }
    const lib = pickAgent(u);
    const req = lib.request(
      u,
      {
        method,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) WalDM/0.1 Safari/537.36',
          Accept: '*/*',
          ...headers,
        },
      },
      (res) => {
        const code = res.statusCode;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume(); // discard body
          if (redirects >= MAX_REDIRECTS) {
            return reject(new Error('Too many redirects'));
          }
          const next = new URL(res.headers.location, u).toString();
          return resolve(openStream(next, { headers, method, signal }, redirects + 1));
        }
        if (code < 200 || code >= 300) {
          res.resume();
          return reject(new Error('HTTP ' + code + ' for ' + rawUrl));
        }
        resolve({ res, req, finalUrl: u.toString() });
      }
    );
    req.on('error', reject);
    if (signal) {
      if (signal.aborted) req.destroy(new Error('aborted'));
      signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    }
    req.end();
  });
}

function filenameFromDisposition(disposition) {
  if (!disposition) return null;
  // RFC 5987 filename*=UTF-8''...
  let m = /filename\*=(?:UTF-8|utf-8)''([^;]+)/i.exec(disposition);
  if (m) {
    try {
      return decodeURIComponent(m[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through */
    }
  }
  m = /filename="?([^";]+)"?/i.exec(disposition);
  return m ? m[1].trim() : null;
}

function filenameFromUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const base = decodeURIComponent(path.basename(u.pathname));
    if (base && base !== '/' && base !== '') return base;
  } catch {
    /* ignore */
  }
  return 'download';
}

/**
 * Drives one download: probe -> segment -> write at offsets -> resume/pause.
 * Emits: 'progress' {received,total,speed,percent}, 'state' (string),
 *        'done' {filePath}, 'error' (Error), 'meta' {total,filename,resumable}.
 */
class DownloadEngine extends EventEmitter {
  constructor(task) {
    super();
    this.id = task.id;
    this.url = task.url;
    this.headers = task.headers || {};
    this.filePath = task.filePath; // absolute final path
    this.partPath = this.filePath + '.waldm';
    this.segmentCount = Math.max(1, Math.min(32, task.segments || 8));
    this.limiter = task.limiter; // shared RateLimiter
    this.total = task.total || 0;
    this.resumable = !!task.resumable;
    this.segments = task.segments_state || null; // [{start,end,downloaded}]
    this.received = this.segments
      ? this.segments.reduce((a, s) => a + s.downloaded, 0)
      : 0;
    this.state = 'queued';
    this._controllers = [];
    this._fd = null;
    this._lastReceived = this.received;
    this._lastTick = Date.now();
    this._speed = 0;
    this._progressTimer = null;
    this._paused = false;
  }

  _setState(s) {
    this.state = s;
    this.emit('state', s);
  }

  async probe() {
    // A ranged GET of the first byte tells us size + range support in one shot,
    // and works on servers that reject HEAD.
    const { res } = await openStream(this.url, {
      headers: { ...this.headers, Range: 'bytes=0-0' },
    });
    const h = res.headers;
    res.resume();
    let total = 0;
    let resumable = false;
    if (res.statusCode === 206 && h['content-range']) {
      const m = /\/(\d+)\s*$/.exec(h['content-range']);
      if (m) total = parseInt(m[1], 10);
      resumable = true;
    } else {
      total = parseInt(h['content-length'], 10) || 0;
      resumable = (h['accept-ranges'] || '').includes('bytes');
    }
    const name =
      filenameFromDisposition(h['content-disposition']) || filenameFromUrl(this.url);
    this.total = total;
    this.resumable = resumable;
    return { total, resumable, filename: name, contentType: h['content-type'] || '' };
  }

  _buildSegments() {
    const n =
      this.resumable && this.total > MIN_SEGMENT_BYTES ? this.segmentCount : 1;
    const segs = [];
    if (n === 1 || !this.total) {
      segs.push({ start: 0, end: this.total ? this.total - 1 : -1, downloaded: 0 });
    } else {
      const chunk = Math.floor(this.total / n);
      for (let i = 0; i < n; i++) {
        const start = i * chunk;
        const end = i === n - 1 ? this.total - 1 : start + chunk - 1;
        segs.push({ start, end, downloaded: 0 });
      }
    }
    return segs;
  }

  async _ensureFile() {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    // Pre-create a sparse file so segments can write at their offsets.
    if (!fs.existsSync(this.partPath)) {
      const fd = await fsp.open(this.partPath, 'w');
      if (this.total) await fd.truncate(this.total);
      await fd.close();
    }
    this._fd = await fsp.open(this.partPath, 'r+');
  }

  _startProgress() {
    this._progressTimer = setInterval(() => {
      const now = Date.now();
      const dt = (now - this._lastTick) / 1000;
      if (dt > 0) {
        this._speed = (this.received - this._lastReceived) / dt;
        this._lastReceived = this.received;
        this._lastTick = now;
      }
      this.emit('progress', {
        received: this.received,
        total: this.total,
        speed: this._speed,
        percent: this.total ? (this.received / this.total) * 100 : 0,
        segments: this.segments.map((s) => ({ ...s })),
      });
    }, 500);
  }

  _stopProgress() {
    if (this._progressTimer) clearInterval(this._progressTimer);
    this._progressTimer = null;
  }

  async _downloadSegment(seg) {
    for (let attempt = 0; attempt <= SEG_RETRY; attempt++) {
      if (this._paused) return;
      const from = seg.start + seg.downloaded;
      if (seg.end >= 0 && from > seg.end) return; // already complete
      const controller = new AbortController();
      this._controllers.push(controller);
      // Writes for a segment must land in arrival order and must all finish
      // before the segment resolves — otherwise pause() could close the fd
      // while a write is still pending and corrupt the file.
      let writePos = from;
      let writeChain = Promise.resolve();
      let chainError = null;
      try {
        const rangeHeader =
          seg.end >= 0 ? `bytes=${from}-${seg.end}` : `bytes=${from}-`;
        const { res } = await openStream(this.url, {
          headers: this.resumable ? { ...this.headers, Range: rangeHeader } : this.headers,
          signal: controller.signal,
        });
        await new Promise((resolve, reject) => {
          res.on('data', (chunk) => {
            res.pause();
            const pos = writePos;
            writePos += chunk.length;
            writeChain = writeChain.then(async () => {
              if (chainError) return;
              try {
                if (this.limiter) await this.limiter.consume(chunk.length);
                if (!this._fd) throw new Error('file closed');
                await this._fd.write(chunk, 0, chunk.length, pos);
                seg.downloaded += chunk.length;
                this.received += chunk.length;
                if (!this._paused) res.resume();
              } catch (e) {
                chainError = e;
                reject(e);
              }
            });
            if (this._paused) controller.abort();
          });
          res.on('end', resolve);
          res.on('error', reject);
          res.on('aborted', () => reject(new Error('stream aborted')));
        });
        await writeChain; // flush every queued write before returning
        return; // segment finished
      } catch (e) {
        await writeChain.catch(() => {}); // let in-flight writes drain
        if (this._paused) return;
        if (attempt === SEG_RETRY) throw chainError || e;
        await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** attempt)));
      } finally {
        this._controllers = this._controllers.filter((c) => c !== controller);
      }
    }
  }

  async start() {
    try {
      this._paused = false;
      if (!this.total || !this.segments) {
        this._setState('probing');
        const info = await this.probe();
        if (!this.filePath) throw new Error('No destination path set');
        this.emit('meta', info);
      }
      if (!this.segments) this.segments = this._buildSegments();
      await this._ensureFile();
      this._setState('downloading');
      this._lastTick = Date.now();
      this._lastReceived = this.received;
      this._startProgress();
      await Promise.all(this.segments.map((s) => this._downloadSegment(s)));
      this._stopProgress();
      if (this._paused) {
        this._setState('paused');
        await this._fd.close();
        this._fd = null;
        return;
      }
      await this._fd.sync().catch(() => {});
      await this._fd.close();
      this._fd = null;
      await fsp.rename(this.partPath, this.filePath);
      this.received = this.total || this.received;
      this._setState('completed');
      this.emit('progress', {
        received: this.received,
        total: this.total,
        speed: 0,
        percent: 100,
        segments: this.segments.map((s) => ({ ...s })),
      });
      this.emit('done', { filePath: this.filePath });
    } catch (err) {
      this._stopProgress();
      if (this._fd) {
        await this._fd.close().catch(() => {});
        this._fd = null;
      }
      if (this._paused) {
        this._setState('paused');
        return;
      }
      this._setState('error');
      this.emit('error', err);
    }
  }

  pause() {
    if (this.state !== 'downloading' && this.state !== 'probing') return;
    this._paused = true;
    this._controllers.forEach((c) => {
      try {
        c.abort();
      } catch {
        /* ignore */
      }
    });
    this._setState('pausing');
  }

  // Snapshot for persistence / resume.
  serialize() {
    return {
      id: this.id,
      url: this.url,
      headers: this.headers,
      filePath: this.filePath,
      total: this.total,
      resumable: this.resumable,
      segments: this.segmentCount,
      segments_state: this.segments ? this.segments.map((s) => ({ ...s })) : null,
      received: this.received,
      state: this.state,
    };
  }
}

module.exports = {
  DownloadEngine,
  openStream,
  filenameFromUrl,
  filenameFromDisposition,
};
