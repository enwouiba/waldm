'use strict';

// WalDM browser bridge. Three ways to grab media, IDM-style:
//   1) a floating "Download with WalDM" button injected on video pages
//      (content.js), which sends the page URL (yt-dlp resolves the stream);
//   2) passive sniffing of media requests (mp4/m3u8/mpd/…) per tab, surfaced
//      as a badge count + a list in the popup;
//   3) capturing normal browser downloads + a right-click menu.

const DEFAULTS = { port: 7611, token: '', capture: true, minBytes: 0 };

// Media detected per tab: tabId -> Map(url -> {url, type, size})
const media = new Map();
const MEDIA_RE = /\.(mp4|m3u8|mpd|webm|mkv|mov|avi|flv|mp3|m4a|aac|ogg|opus|wav|flac)(\?|#|$)/i;
const MEDIA_CT = /^(video\/|audio\/|application\/(x-mpegurl|vnd\.apple\.mpegurl|dash\+xml))/i;
const SKIP_HOST = /(127\.0\.0\.1|localhost)/i;

async function cfg() {
  return new Promise((r) => chrome.storage.sync.get(DEFAULTS, r));
}

async function sendToWalDM(payload) {
  const c = await cfg();
  if (!c.token) {
    notify('WalDM not configured', 'Open the extension options and paste the pairing token from WalDM › Settings.');
    return false;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${c.port}/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WalDM-Token': c.token },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return true;
  } catch (e) {
    notify('WalDM unreachable', 'Is the WalDM app running? (' + e.message + ')');
    return false;
  }
}

function notify(title, message) {
  try {
    chrome.notifications.create({ type: 'basic', iconUrl: 'icon128.png', title, message });
  } catch {
    /* optional */
  }
}

// ---- media sniffing ----
function addMedia(tabId, url, type, size) {
  if (tabId < 0 || SKIP_HOST.test(url)) return;
  let m = media.get(tabId);
  if (!m) {
    m = new Map();
    media.set(tabId, m);
  }
  if (!m.has(url)) {
    m.set(url, { url, type: type || '', size: size || 0 });
    updateBadge(tabId);
  }
}

function updateBadge(tabId) {
  const n = media.get(tabId)?.size || 0;
  try {
    chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  } catch {
    /* ignore */
  }
}

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    const ct = (d.responseHeaders || []).find((h) => h.name.toLowerCase() === 'content-type');
    const ctv = ct ? ct.value : '';
    const looksMedia = MEDIA_RE.test(d.url) || MEDIA_CT.test(ctv);
    if (!looksMedia) return;
    // Ignore tiny HLS/DASH segments; keep playlists and real files.
    if (/\.ts(\?|#|$)/i.test(d.url)) return;
    const len = (d.responseHeaders || []).find((h) => h.name.toLowerCase() === 'content-length');
    const size = len ? parseInt(len.value, 10) : 0;
    if (/^video\/|^audio\//i.test(ctv) && size && size < 100 * 1024 && !MEDIA_RE.test(d.url)) return;
    addMedia(d.tabId, d.url, ctv, size);
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// Reset a tab's detections when it navigates to a new page.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url || info.status === 'loading') {
    if (info.url) {
      media.delete(tabId);
      updateBadge(tabId);
    }
  }
});
chrome.tabs.onRemoved.addListener((tabId) => media.delete(tabId));

// ---- context menu ----
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'waldm-link',
    title: 'Download with WalDM',
    contexts: ['link', 'image', 'video', 'audio', 'selection', 'page'],
  });
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.linkUrl || info.srcUrl || info.selectionText || (tab && tab.url);
  if (url && /^https?:\/\//i.test(url)) {
    sendToWalDM({ url, kind: info.mediaType === 'video' ? 'video' : undefined }).then(
      (ok) => ok && notify('Sent to WalDM', url)
    );
  }
});

// ---- auto-capture normal downloads ----
chrome.downloads.onCreated.addListener(async (item) => {
  const c = await cfg();
  if (!c.capture) return;
  const u = item.finalUrl || item.url || '';
  if (!/^https?:\/\//i.test(u)) return;
  if (c.minBytes && item.fileSize > 0 && item.fileSize < c.minBytes) return;
  const ok = await sendToWalDM({
    url: u,
    filename: item.filename ? item.filename.split(/[\\/]/).pop() : undefined,
    referrer: item.referrer || undefined,
  });
  if (ok) {
    try {
      await chrome.downloads.cancel(item.id);
      await chrome.downloads.erase({ id: item.id });
    } catch {
      /* already gone */
    }
    notify('Captured by WalDM', u);
  }
});

// ---- messaging (content script + popup) ----
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'send') {
    sendToWalDM(msg.payload).then((ok) => reply({ ok }));
    return true;
  }
  if (msg.type === 'ping') {
    cfg()
      .then((c) => fetch(`http://127.0.0.1:${c.port}/ping`).then((r) => r.ok))
      .then((ok) => reply({ ok }))
      .catch(() => reply({ ok: false }));
    return true;
  }
  if (msg.type === 'media') {
    const tabId = msg.tabId ?? sender.tab?.id;
    if (tabId != null) return reply({ items: [...(media.get(tabId)?.values() || [])] });
    chrome.tabs.query({ active: true, currentWindow: true }, (t) => {
      const id = t[0]?.id;
      reply({ items: id != null ? [...(media.get(id)?.values() || [])] : [] });
    });
    return true;
  }
  if (msg.type === 'hasConfig') {
    cfg().then((c) => reply({ ok: !!c.token }));
    return true;
  }
});
