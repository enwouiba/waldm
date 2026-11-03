'use strict';
// Cross-platform launcher. Some shells/CI set ELECTRON_RUN_AS_NODE=1, which
// makes the `electron` binary behave like plain Node and breaks the app
// (`require('electron')` returns a path string, so `app` is undefined). Strip
// that variable and spawn the real Electron GUI process.
const { spawn } = require('child_process');
const electronPath = require('electron'); // resolves to the binary path

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});
child.on('close', (code) => process.exit(code ?? 0));
