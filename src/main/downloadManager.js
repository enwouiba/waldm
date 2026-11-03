'use strict';

const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { EventEmitter } = require('events');
const { DownloadEngine, filenameFromUrl } = require('./downloadEngine');
const { RateLimiter } = require('./rateLimiter');
const { VideoDownload, probeVideo, isProbablyVideoPage } = require('./ytdlp');

const DEFAULTS = {
  maxConcurrent: 4,
  segments: 8,
  speedLimitKBps: 0, // 0 = unlimited
};

// Public record shape (what the renderer sees). Engines are kept separately.
function publicRecord(rec) {
  return {
    id: rec.id,
    url: rec.url,
    filename: rec.filename,
    filePath: rec.filePath,
    dir: rec.dir,
    kind: rec.kind,
    total: rec.total || 0,
    received: rec.received || 0,
    percent: rec.percent || 0,
    speed: rec.speed || 0,
    state: rec.state,
    resumable: rec.resumable,
    error: rec.error || null,
    schedule: rec.schedule || null,
    createdAt: rec.createdAt,
    completedAt: rec.completedAt || null,
  };
}

class DownloadManager extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.records = new Map(); // id -> record
    this.engines = new Map(); // id -> DownloadEngine | VideoDownload
    this.settings = { ...DEFAULTS, ...(store.data.settings || {}) };
    this.limiter = new RateLimiter(this.settings.speedLimitKBps * 1024);
    this._scheduleTimer = setInterval(() => this._tickSchedule(), 5000);
    this._hydrate();
  }

  _hydrate() {
    for (const d of this.store.data.downloads || []) {
      // Anything mid-flight when the app closed comes back paused, not broken.
      if (d.state === 'downloading' || d.state === 'probing' || d.state === 'pausing') {
        d.state = 'paused';
      }
      this.records.set(d.id, d);
    }
  }

  _persist() {
    this.store.data.downloads = [...this.records.values()].map((r) => ({
      ...r,
      speed: 0,
    }));
    this.store.data.settings = this.settings;
    this.store.save();
  }

  list() {
    return [...this.records.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(publicRecord);
  }

  getSettings() {
    return { ...this.settings };
  }

  updateSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    if (patch.speedLimitKBps !== undefined) {
      this.limiter.setLimit(this.settings.speedLimitKBps * 1024);
    }
    this._persist();
    if (patch.maxConcurrent !== undefined) this._pump();
    return this.getSettings();
  }

  _emitUpdate(id) {
    const rec = this.records.get(id);
    if (rec) this.emit('item', publicRecord(rec));
  }

  _activeCount() {
    let n = 0;
    for (const r of this.records.values()) {
      if (r.state === 'downloading' || r.state === 'probing') n++;
    }
    return n;
  }

  // Start queued items up to the concurrency limit.
  _pump() {
    const max = this.settings.maxConcurrent;
    for (const rec of [...this.records.values()].sort((a, b) => a.createdAt - b.createdAt)) {
      if (this._activeCount() >= max) break;
      if (rec.state === 'queued') this._run(rec);
    }
  }

  async add({ url, dir, filename, kind, segments, formatId, schedule }) {
    const id = randomUUID();
    const isVideo = kind === 'video' || (kind !== 'file' && isProbablyVideoPage(url));
    const rec = {
      id,
      url,
      dir: dir || this.settings.downloadDir || process.cwd(),
      filename: filename || (isVideo ? null : filenameFromUrl(url)),
      filePath: null,
      kind: isVideo ? 'video' : 'file',
      total: 0,
      received: 0,
      percent: 0,
      speed: 0,
      state: schedule && schedule.at > Date.now() ? 'scheduled' : 'queued',
      resumable: false,
      segments: segments || this.settings.segments,
      formatId: formatId || null,
      schedule: schedule || null,
      createdAt: Date.now(),
    };
    if (rec.filename) rec.filePath = path.join(rec.dir, rec.filename);
    this.records.set(id, rec);
    this._persist();
    this._emitUpdate(id);
    if (rec.state === 'queued') this._pump();
    return publicRecord(rec);
  }

  _wireEngine(rec, engine) {
    this.engines.set(rec.id, engine);
    engine.on('meta', (m) => {
      if (m.filename && !rec.filename) {
        rec.filename = m.filename;
        rec.filePath = path.join(rec.dir, m.filename);
        engine.filePath = rec.filePath;
        engine.partPath = rec.filePath + '.waldm';
      }
      rec.total = m.total;
      rec.resumable = m.resumable;
      this._emitUpdate(rec.id);
      this._persist();
    });
    engine.on('state', (s) => {
      const map = { pausing: 'pausing', paused: 'paused', downloading: 'downloading', probing: 'probing', completed: 'completed', error: 'error' };
      rec.state = map[s] || rec.state;
      this._emitUpdate(rec.id);
      if (s === 'paused') {
        rec.segments_state = engine.segments ? engine.segments.map((x) => ({ ...x })) : null;
        rec.total = engine.total;
        rec.resumable = engine.resumable;
        this._persist();
        this._pump();
      }
    });
    engine.on('progress', (p) => {
      rec.received = p.received;
      rec.total = p.total || rec.total;
      rec.speed = p.speed;
      rec.percent = p.percent;
      this._emitUpdate(rec.id);
    });
    engine.on('done', (d) => {
      rec.state = 'completed';
      rec.filePath = d.filePath || rec.filePath;
      rec.speed = 0;
      rec.percent = 100;
      rec.completedAt = Date.now();
      rec.segments_state = null;
      this.engines.delete(rec.id);
      this._emitUpdate(rec.id);
      this._persist();
      this._pump();
    });
    engine.on('error', (e) => {
      rec.state = 'error';
      rec.error = e.message;
      rec.speed = 0;
      this.engines.delete(rec.id);
      this._emitUpdate(rec.id);
      this._persist();
      this._pump();
    });
  }

  async _run(rec) {
    rec.state = rec.kind === 'video' ? 'downloading' : 'probing';
    rec.error = null;
    this._emitUpdate(rec.id);

    let engine;
    if (rec.kind === 'video') {
      engine = new VideoDownload({
        id: rec.id,
        url: rec.url,
        dir: rec.dir,
        filename: rec.filename,
        formatId: rec.formatId,
        total: rec.total,
        filePath: rec.filePath,
      });
    } else {
      engine = new DownloadEngine({
        id: rec.id,
        url: rec.url,
        filePath: rec.filePath,
        headers: rec.headers,
        segments: rec.segments,
        limiter: this.limiter,
        total: rec.total,
        resumable: rec.resumable,
        segments_state: rec.segments_state,
      });
    }
    this._wireEngine(rec, engine);
    engine.start();
  }

  pause(id) {
    const engine = this.engines.get(id);
    const rec = this.records.get(id);
    if (!rec) return;
    if (engine) {
      engine.pause();
    } else if (rec.state === 'queued' || rec.state === 'scheduled') {
      rec.state = 'paused';
      this._emitUpdate(id);
      this._persist();
    }
  }

  resume(id) {
    const rec = this.records.get(id);
    if (!rec) return;
    if (rec.state === 'paused' || rec.state === 'error') {
      rec.state = 'queued';
      rec.error = null;
      this._emitUpdate(id);
      this._pump();
    }
  }

  async remove(id, deleteFile) {
    const engine = this.engines.get(id);
    if (engine) engine.pause();
    const rec = this.records.get(id);
    this.engines.delete(id);
    this.records.delete(id);
    if (rec && deleteFile) {
      for (const f of [rec.filePath, rec.filePath && rec.filePath + '.waldm']) {
        try {
          if (f && fs.existsSync(f)) fs.unlinkSync(f);
        } catch {
          /* ignore */
        }
      }
    }
    this._persist();
    this.emit('removed', id);
    this._pump();
  }

  retry(id) {
    const rec = this.records.get(id);
    if (!rec) return;
    rec.state = 'queued';
    rec.error = null;
    rec.received = 0;
    rec.percent = 0;
    rec.segments_state = null;
    this._emitUpdate(id);
    this._pump();
  }

  async probeVideoFormats(url) {
    return probeVideo(url);
  }

  _tickSchedule() {
    const now = Date.now();
    let changed = false;
    for (const rec of this.records.values()) {
      if (rec.state === 'scheduled' && rec.schedule && rec.schedule.at <= now) {
        rec.state = 'queued';
        changed = true;
        this._emitUpdate(rec.id);
      }
    }
    if (changed) this._pump();
  }
}

module.exports = { DownloadManager };
