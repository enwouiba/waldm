'use strict';

const api = window.waldm;
const rowsEl = document.getElementById('rows');
const emptyEl = document.getElementById('empty');
const items = new Map(); // id -> record
let filter = 'all';
let query = '';

function human(n) {
  if (!n || n < 1) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i];
}
function ext(name) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name || '');
  return m ? m[1].toUpperCase() : '•';
}
function statusLabel(r) {
  if (r.state === 'scheduled' && r.schedule)
    return 'Scheduled ' + new Date(r.schedule.at).toLocaleString();
  return { downloading: 'Downloading', probing: 'Connecting…', paused: 'Paused',
    queued: 'Queued', completed: 'Completed', error: 'Failed', pausing: 'Pausing…' }[r.state] || r.state;
}

function matches(r) {
  if (filter === 'downloading' && !['downloading', 'probing', 'queued'].includes(r.state)) return false;
  if (filter !== 'all' && filter !== 'downloading' && r.state !== filter) return false;
  if (query && !(r.filename || r.url).toLowerCase().includes(query)) return false;
  return true;
}

function render() {
  const visible = [...items.values()].filter(matches).sort((a, b) => b.createdAt - a.createdAt);
  emptyEl.classList.toggle('hidden', items.size !== 0);
  rowsEl.innerHTML = '';
  for (const r of visible) rowsEl.appendChild(renderRow(r));
  // global speed
  let gs = 0;
  for (const r of items.values()) if (r.state === 'downloading') gs += r.speed || 0;
  document.getElementById('globalSpeed').textContent = human(gs) + '/s';
}

function renderRow(r) {
  const tr = document.createElement('tr');
  tr.dataset.id = r.id;
  const pct = Math.min(100, r.percent || 0).toFixed(1);
  const barCls = r.state === 'completed' ? 'bar done' : r.state === 'error' ? 'bar err' : 'bar';
  const canPause = ['downloading', 'probing', 'queued', 'scheduled'].includes(r.state);
  const canResume = ['paused', 'error'].includes(r.state);

  tr.innerHTML = `
    <td>
      <div class="name-cell">
        <div class="ftype">${r.kind === 'video' ? '►' : ext(r.filename)}</div>
        <div>
          <div class="fname" title="${esc(r.filename || r.url)}">${esc(r.filename || '(resolving…)')}</div>
          <div class="furl" title="${esc(r.url)}">${esc(r.url)}</div>
        </div>
      </div>
    </td>
    <td>${r.total ? human(r.total) : '—'}</td>
    <td>
      <div class="${barCls}"><i style="width:${pct}%"></i></div>
      <span class="pct">${r.state === 'completed' ? '100%' : pct + '%'}${r.total ? ' · ' + human(r.received) : ''}</span>
    </td>
    <td>${r.state === 'downloading' ? human(r.speed) + '/s' : '—'}</td>
    <td><span class="status ${r.state}">${statusLabel(r)}</span></td>
    <td>
      <div class="rowact">
        ${canPause ? btn('pause', '⏸', 'Pause') : ''}
        ${canResume ? btn('resume', '▶', 'Resume') : ''}
        ${r.state === 'completed' ? btn('open', '↗', 'Open') : ''}
        ${btn('folder', '📁', 'Show in folder')}
        ${btn('remove', '🗑', 'Remove')}
      </div>
    </td>`;
  tr.querySelector('.rowact').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    onAction(b.dataset.act, r);
  });
  return tr;
}
function btn(act, icon, title) {
  return `<button class="iconbtn" data-act="${act}" title="${title}">${icon}</button>`;
}
function esc(s) {
  return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function onAction(act, r) {
  if (act === 'pause') api.pause(r.id);
  else if (act === 'resume') api.resume(r.id);
  else if (act === 'open') api.openFile(r.id);
  else if (act === 'folder') api.openFolder(r.id);
  else if (act === 'remove') {
    const del = r.state !== 'completed' && confirm('Delete the partial file too?');
    api.remove(r.id, del);
  }
}

// ---- live updates ----
api.onItem((rec) => { items.set(rec.id, rec); render(); });
api.onRemoved((id) => { items.delete(id); render(); });
api.onCaptured((rec) => { items.set(rec.id, rec); render(); });

// ---- toolbar ----
document.getElementById('btnPauseAll').onclick = () =>
  items.forEach((r) => ['downloading', 'probing', 'queued'].includes(r.state) && api.pause(r.id));
document.getElementById('btnResumeAll').onclick = () =>
  items.forEach((r) => ['paused', 'error'].includes(r.state) && api.resume(r.id));

document.querySelectorAll('.chip').forEach((c) =>
  c.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
    c.classList.add('active');
    filter = c.dataset.filter;
    render();
  })
);
document.getElementById('search').addEventListener('input', (e) => {
  query = e.target.value.toLowerCase();
  render();
});

// ---- Add modal ----
const addModal = document.getElementById('addModal');
const addUrl = document.getElementById('addUrl');
const addDir = document.getElementById('addDir');
const addName = document.getElementById('addName');
const addVideo = document.getElementById('addVideo');
const addSchedule = document.getElementById('addSchedule');
const addFormat = document.getElementById('addFormat');
const formatBox = document.getElementById('formatBox');
const probeMsg = document.getElementById('probeMsg');

document.getElementById('btnAdd').onclick = async () => {
  const s = await api.getSettings();
  addDir.value = s.downloadDir || '';
  addUrl.value = ''; addName.value = ''; addVideo.checked = false;
  addSchedule.value = ''; formatBox.classList.add('hidden'); addFormat.innerHTML = '';
  // Prefill from clipboard if it looks like a URL
  try {
    const t = (await navigator.clipboard.readText()).trim();
    if (/^https?:\/\//i.test(t)) addUrl.value = t;
  } catch {}
  addModal.classList.add('open');
  addUrl.focus();
};
document.getElementById('addCancel').onclick = () => addModal.classList.remove('open');
document.getElementById('btnChooseDir').onclick = async () => {
  const d = await api.chooseDir();
  if (d) addDir.value = d;
};
addVideo.onchange = () => formatBox.classList.toggle('hidden', !addVideo.checked);
document.getElementById('btnProbe').onclick = async () => {
  probeMsg.textContent = 'Fetching…';
  addFormat.innerHTML = '';
  try {
    const info = await api.probeVideo(addUrl.value.trim());
    probeMsg.textContent = info.title;
    const best = document.createElement('option');
    best.value = ''; best.textContent = 'Best available';
    addFormat.appendChild(best);
    for (const f of info.formats.reverse()) {
      if (f.vcodec === 'none') continue;
      const o = document.createElement('option');
      o.value = f.format_id;
      o.textContent = `${f.resolution}${f.fps ? ' ' + f.fps + 'fps' : ''} · ${f.ext}${f.filesize ? ' · ' + human(f.filesize) : ''}`;
      addFormat.appendChild(o);
    }
  } catch (e) {
    probeMsg.textContent = 'Could not fetch: ' + e.message;
  }
};
document.getElementById('addConfirm').onclick = async () => {
  const url = addUrl.value.trim();
  if (!/^https?:\/\//i.test(url)) return alert('Enter a valid http(s) URL');
  const schedule = addSchedule.value ? { at: new Date(addSchedule.value).getTime() } : null;
  await api.add({
    url,
    dir: addDir.value || undefined,
    filename: addName.value.trim() || undefined,
    kind: addVideo.checked ? 'video' : undefined,
    formatId: addVideo.checked ? addFormat.value || null : null,
    schedule,
  });
  addModal.classList.remove('open');
};

// ---- Settings modal ----
const setModal = document.getElementById('setModal');
document.getElementById('btnSettings').onclick = async () => {
  const s = await api.getSettings();
  document.getElementById('setDir').value = s.downloadDir || '';
  document.getElementById('setConcurrent').value = s.maxConcurrent;
  document.getElementById('setSegments').value = s.segments;
  document.getElementById('setSpeed').value = s.speedLimitKBps;
  const b = await api.getBridgeInfo();
  document.getElementById('bridgeToken').value = b.token;
  document.getElementById('bridgePort').textContent = 'http://127.0.0.1:' + b.port;
  setModal.classList.add('open');
};
document.getElementById('setCancel').onclick = () => setModal.classList.remove('open');
document.getElementById('setChooseDir').onclick = async () => {
  const d = await api.chooseDir();
  if (d) document.getElementById('setDir').value = d;
};
document.getElementById('btnCopyToken').onclick = () => {
  navigator.clipboard.writeText(document.getElementById('bridgeToken').value);
};
document.getElementById('setSave').onclick = async () => {
  await api.updateSettings({
    downloadDir: document.getElementById('setDir').value,
    maxConcurrent: +document.getElementById('setConcurrent').value || 4,
    segments: +document.getElementById('setSegments').value || 8,
    speedLimitKBps: +document.getElementById('setSpeed').value || 0,
  });
  setModal.classList.remove('open');
};

// close modals on backdrop click / Escape
[addModal, setModal].forEach((m) =>
  m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('open'); })
);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') [addModal, setModal].forEach((m) => m.classList.remove('open'));
});

// initial load
(async () => {
  const list = await api.list();
  list.forEach((r) => items.set(r.id, r));
  render();
})();
