'use strict';
const $ = (id) => document.getElementById(id);

chrome.runtime.sendMessage({ type: 'ping' }, (res) => {
  const ok = res && res.ok;
  $('dot').classList.toggle('on', ok);
  $('state').textContent = ok ? 'Connected to WalDM' : 'WalDM not running';
});

// Prefill with the active tab URL
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs[0] && /^https?:/i.test(tabs[0].url)) $('url').value = tabs[0].url;
});

$('send').onclick = () => {
  const url = $('url').value.trim();
  if (!/^https?:\/\//i.test(url)) return;
  chrome.runtime.sendMessage({ type: 'send', payload: { url } }, (ok) => {
    $('send').textContent = ok ? 'Sent ✓' : 'Failed — check options';
    setTimeout(() => window.close(), 800);
  });
};

$('opt').onclick = () => chrome.runtime.openOptionsPage();
