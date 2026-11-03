'use strict';

// Standalone test harness for the download engine (no Electron needed):
//   node src/main/engineCli.js <url> [destPath] [segments] [limitKBps]
const path = require('path');
const os = require('os');
const { DownloadEngine } = require('./downloadEngine');
const { RateLimiter } = require('./rateLimiter');

function human(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return (n / 1024 ** i).toFixed(1) + ' ' + u[i];
}

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error('usage: node engineCli.js <url> [dest] [segments] [limitKBps]');
    process.exit(1);
  }
  const dest =
    process.argv[3] || path.join(os.tmpdir(), 'waldm-test-' + Date.now() + '.bin');
  const segments = parseInt(process.argv[4] || '8', 10);
  const limitKBps = parseInt(process.argv[5] || '0', 10);
  const limiter = new RateLimiter(limitKBps * 1024);

  const eng = new DownloadEngine({
    id: 'cli',
    url,
    filePath: path.resolve(dest),
    segments,
    limiter,
  });

  eng.on('meta', (m) =>
    console.log(
      `meta: ${m.filename} | ${human(m.total)} | resumable=${m.resumable} | ${m.contentType}`
    )
  );
  eng.on('state', (s) => console.log('state ->', s));
  eng.on('progress', (p) => {
    const bar = p.total
      ? `${p.percent.toFixed(1)}%`
      : `${human(p.received)}`;
    process.stdout.write(
      `\r${bar}  ${human(p.received)}/${human(p.total)}  ${human(p.speed)}/s   `
    );
  });
  eng.on('done', (d) => {
    console.log('\nDONE ->', d.filePath);
    process.exit(0);
  });
  eng.on('error', (e) => {
    console.error('\nERROR:', e.message);
    process.exit(1);
  });

  // Demo pause/resume: pause at ~40%, resume after 1.5s.
  let paused = false;
  eng.on('progress', (p) => {
    if (!paused && p.percent > 40 && p.percent < 70 && process.env.TEST_PAUSE) {
      paused = true;
      console.log('\n[test] pausing...');
      eng.pause();
      setTimeout(() => {
        console.log('[test] resuming...');
        eng.start();
      }, 1500);
    }
  });

  await eng.start();
}

main();
