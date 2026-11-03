'use strict';

const http = require('http');
const crypto = require('crypto');

// A tiny localhost-only HTTP endpoint the browser extension talks to. It hands
// captured URLs to the manager. Bound to 127.0.0.1 and gated by a shared token
// so only this machine's extension (which was given the token) can post.
class NativeServer {
  constructor({ manager, store, port = 7611 }) {
    this.manager = manager;
    this.store = store;
    this.port = port;
    this.token = store.getSetting('bridgeToken', null);
    if (!this.token) {
      this.token = crypto.randomBytes(16).toString('hex');
      store.setSetting('bridgeToken', this.token);
    }
    this.server = null;
  }

  _cors(res, origin) {
    // Extensions post from chrome-extension:// / moz-extension:// origins.
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-WalDM-Token');
  }

  start() {
    this.server = http.createServer((req, res) => {
      this._cors(res, req.headers.origin);
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }

      if (req.method === 'GET' && req.url === '/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ app: 'WalDM', ok: true }));
      }

      const token = req.headers['x-waldm-token'];
      if (token !== this.token) {
        res.writeHead(401);
        return res.end('unauthorized');
      }

      if (req.method === 'POST' && req.url === '/capture') {
        let body = '';
        req.on('data', (c) => {
          body += c;
          if (body.length > 1e6) req.destroy();
        });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body || '{}');
            if (!data.url) {
              res.writeHead(400);
              return res.end('missing url');
            }
            const rec = await this.manager.add({
              url: data.url,
              dir: this.store.getSetting('downloadDir', undefined),
              filename: data.filename || undefined,
              kind: data.kind || undefined,
            });
            this.manager.emit('captured', rec);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, id: rec.id }));
          } catch (e) {
            res.writeHead(500);
            res.end('error');
          }
        });
        return;
      }

      res.writeHead(404);
      res.end('not found');
    });

    this.server.on('error', (e) => {
      // Port busy is non-fatal; capture just won't be available.
      console.error('[waldm] bridge server error:', e.message);
    });
    this.server.listen(this.port, '127.0.0.1', () => {
      console.log('[waldm] browser bridge on http://127.0.0.1:' + this.port);
    });
  }

  stop() {
    if (this.server) this.server.close();
  }
}

module.exports = { NativeServer };
