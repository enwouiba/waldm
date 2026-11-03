'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// Tiny JSON-file store for the download list and settings. Writes are
// debounced and atomic (write temp + rename) so a crash can't truncate state.
class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    this.data = { downloads: [], settings: {} };
    this._timer = null;
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = {
        downloads: Array.isArray(parsed.downloads) ? parsed.downloads : [],
        settings: parsed.settings || {},
      };
    } catch {
      this.data = { downloads: [], settings: {} };
    }
    return this.data;
  }

  save() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this._flush(), 300);
  }

  async _flush() {
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      const tmp = this.file + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(this.data, null, 2));
      await fsp.rename(tmp, this.file);
    } catch (e) {
      // non-fatal
    }
  }

  getSetting(key, fallback) {
    return this.data.settings[key] !== undefined ? this.data.settings[key] : fallback;
  }

  setSetting(key, value) {
    this.data.settings[key] = value;
    this.save();
  }
}

module.exports = { Store };
