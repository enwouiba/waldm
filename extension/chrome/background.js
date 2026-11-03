'use strict';

// WalDM browser bridge. Captures downloads (when enabled) and offers a
// right-click "Download with WalDM" on links/media/pages, forwarding the URL
// to the desktop app's localhost bridge.

const DEFAULTS = { port: 7611, token: '', capture: true, minBytes: 0 };

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
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icon128.png',
      title,
      message,
    });
  } catch {
    /* notifications optional */
  }
}

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

// ---- auto-capture ----
chrome.downloads.onCreated.addListener(async (item) => {
  const c = await cfg();
  if (!c.capture) return;
  if (!/^https?:\/\//i.test(item.finalUrl || item.url || '')) return;
  if (c.minBytes && item.fileSize > 0 && item.fileSize < c.minBytes) return;

  // Hand it to WalDM and cancel the browser's own download so there's no dupe.
  const ok = await sendToWalDM({
    url: item.finalUrl || item.url,
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
    notify('Captured by WalDM', item.finalUrl || item.url);
  }
});

// ---- popup messaging ----
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === 'send') {
    sendToWalDM(msg.payload).then(reply);
    return true; // async
  }
  if (msg.type === 'ping') {
    cfg()
      .then((c) => fetch(`http://127.0.0.1:${c.port}/ping`).then((r) => r.ok))
      .then((ok) => reply({ ok }))
      .catch(() => reply({ ok: false }));
    return true;
  }
});
