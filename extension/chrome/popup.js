'use strict';
const $ = (id) => document.getElementById(id);

function human(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i];
}
function kind(url, type) {
  const m = /\.([a-z0-9]{2,4})(\?|#|$)/i.exec(url);
  if (/mpegurl/i.test(type) || /\.m3u8/i.test(url)) return 'HLS';
  if (/dash/i.test(type) || /\.mpd/i.test(url)) return 'DASH';
  return (m ? m[1] : (type.split('/')[1] || '•')).toUpperCase().slice(0, 4);
}
function fileName(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop()) || new URL(url).hostname;
  } catch {
    return url.slice(0, 40);
  }
}

chrome.runtime.sendMessage({ type: 'ping' }, (res) => {
  const ok = res && res.ok;
  $('dot').classList.toggle('on', ok);
  $('state').textContent = ok ? 'Connected to WalDM' : 'WalDM not running — start the app';
});

// detected media on the active tab
chrome.runtime.sendMessage({ type: 'media' }, (res) => {
  const items = (res && res.items) || [];
  const box = $('media');
  if (!items.length) {
    box.innerHTML = '<div class="empty">Nothing detected yet. Play a video or start a download.</div>';
    return;
  }
  box.innerHTML = '';
  items
    .sort((a, b) => (b.size || 0) - (a.size || 0))
    .forEach((it) => {
      const row = document.createElement('div');
      row.className = 'mrow';
      row.innerHTML =
        `<div class="mi">${kind(it.url, it.type)}</div>` +
        `<div class="mmeta"><div class="mname">${fileName(it.url)}</div>` +
        `<div class="msub">${it.type || ''}${it.size ? ' · ' + human(it.size) : ''}</div></div>`;
      row.addEventListener('click', () => {
        row.querySelector('.mname').textContent = 'Sending…';
        chrome.runtime.sendMessage({ type: 'send', payload: { url: it.url } }, (r) => {
          row.querySelector('.mname').textContent = r && r.ok ? 'Sent ✓' : 'Failed';
          if (r && r.ok) setTimeout(() => window.close(), 700);
        });
      });
      box.appendChild(row);
    });
});

// paste-a-link
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs[0] && /^https?:/i.test(tabs[0].url)) $('url').value = tabs[0].url;
});
$('send').onclick = () => {
  const url = $('url').value.trim();
  if (!/^https?:\/\//i.test(url)) return;
  chrome.runtime.sendMessage({ type: 'send', payload: { url } }, (r) => {
    $('send').textContent = r && r.ok ? 'Sent ✓' : 'Failed — check options';
    setTimeout(() => window.close(), 800);
  });
};
$('opt').onclick = () => chrome.runtime.openOptionsPage();
