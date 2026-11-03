'use strict';
const DEFAULTS = { port: 7611, token: '', capture: true, minBytes: 0 };
const $ = (id) => document.getElementById(id);

chrome.storage.sync.get(DEFAULTS, (c) => {
  $('token').value = c.token;
  $('port').value = c.port;
  $('minBytes').value = c.minBytes;
  $('capture').checked = c.capture;
});

$('save').onclick = () => {
  chrome.storage.sync.set(
    {
      token: $('token').value.trim(),
      port: +$('port').value || 7611,
      minBytes: +$('minBytes').value || 0,
      capture: $('capture').checked,
    },
    () => { $('status').textContent = 'Saved ✓'; setTimeout(() => ($('status').textContent = ''), 1500); }
  );
};

$('test').onclick = () => {
  const port = +$('port').value || 7611;
  $('status').textContent = 'Testing…';
  fetch(`http://127.0.0.1:${port}/ping`)
    .then((r) => r.json())
    .then((j) => ($('status').textContent = j.ok ? 'Connected ✓' : 'No response'))
    .catch(() => ($('status').textContent = 'WalDM not reachable'));
};
