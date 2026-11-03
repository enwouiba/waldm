'use strict';

// Injects a floating "Download with WalDM" button on pages that have a video,
// the way IDM drops a "Download this video" panel over a player. Clicking it
// sends the current page URL to WalDM, which runs yt-dlp to resolve the stream.
(function () {
  if (window.top !== window.self) return; // main frame only
  if (document.getElementById('waldm-fab')) return;

  const VIDEO_HOST =
    /(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|tiktok\.com|facebook\.com|fb\.watch|instagram\.com|twitch\.tv|twitter\.com|x\.com|bilibili\.com|ok\.ru|rumble\.com|streamable\.com)/i;

  let fab, hiddenForUrl = null;

  function hasRealVideo() {
    if (VIDEO_HOST.test(location.hostname)) return true;
    for (const v of document.querySelectorAll('video')) {
      if (v.src || v.currentSrc || v.querySelector('source')) {
        if ((v.duration && v.duration > 1) || v.readyState >= 1) return true;
      }
    }
    return false;
  }

  function makeFab() {
    const el = document.createElement('div');
    el.id = 'waldm-fab';
    el.innerHTML =
      '<button class="waldm-dl" title="Download this video with WalDM">' +
      '<span class="waldm-ic">⬇</span><span class="waldm-tx">Download with WalDM</span></button>' +
      '<button class="waldm-x" title="Hide">×</button>';
    document.documentElement.appendChild(el);

    el.querySelector('.waldm-dl').addEventListener('click', onDownload);
    el.querySelector('.waldm-x').addEventListener('click', () => {
      hiddenForUrl = location.href;
      el.style.display = 'none';
    });
    makeDraggable(el);
    return el;
  }

  function onDownload() {
    const btn = fab.querySelector('.waldm-dl');
    const tx = btn.querySelector('.waldm-tx');
    chrome.runtime.sendMessage({ type: 'hasConfig' }, (r) => {
      if (!r || !r.ok) {
        toast('Open WalDM extension options and paste the pairing token first.');
        return;
      }
      tx.textContent = 'Sending…';
      chrome.runtime.sendMessage(
        { type: 'send', payload: { url: location.href, kind: 'video' } },
        (res) => {
          const ok = res && res.ok;
          tx.textContent = ok ? 'Sent ✓' : 'Failed — is WalDM open?';
          btn.classList.toggle('ok', ok);
          setTimeout(() => {
            tx.textContent = 'Download with WalDM';
            btn.classList.remove('ok');
          }, 2200);
        }
      );
    });
  }

  function toast(text) {
    const t = document.createElement('div');
    t.className = 'waldm-toast';
    t.textContent = text;
    document.documentElement.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 300);
    }, 3500);
  }

  function makeDraggable(el) {
    let sx, sy, ox, oy, drag = false;
    el.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      drag = true;
      sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect();
      ox = r.left; oy = r.top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      el.style.left = ox + (e.clientX - sx) + 'px';
      el.style.top = oy + (e.clientY - sy) + 'px';
      el.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => (drag = false));
  }

  function sync() {
    if (hasRealVideo()) {
      if (!fab) fab = makeFab();
      if (hiddenForUrl !== location.href) fab.style.display = '';
    } else if (fab) {
      fab.style.display = 'none';
    }
  }

  // Poll: covers lazy players and SPA navigation (YouTube changes URL without
  // a full reload, so re-check and un-hide on navigation).
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      hiddenForUrl = null;
    }
    sync();
  }, 1200);
  sync();
})();
