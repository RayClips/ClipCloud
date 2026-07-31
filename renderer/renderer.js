const statusLabel = {
  local: 'On device', pending: 'Queued', uploading: 'Uploading',
  uploaded: 'Backed up', error: 'Failed',
};

const thumbIcon = `<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="m10 9 5 3-5 3V9Z" fill="currentColor"/></svg>`;

const grid = document.getElementById('clip-grid');
const empty = document.getElementById('clip-empty');
const search = document.getElementById('search');

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function relTime(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

let allClips = [];

function clipCard(c) {
  const bar = c.status === 'uploading'
    ? `<div class="cbar"><div class="cbar-fill" style="width:0%"></div></div>` : '';
  const tag = c.onDisk === false ? '<span class="dur">cloud</span>' : '';
  return `<article class="clip" data-path="${esc(c.path)}">
    <div class="thumb">${thumbIcon}${tag}</div>
    <div class="clip-body">
      <div class="clip-title" title="${esc(c.name)}">${esc(c.name)}</div>
      <div class="clip-sub"><span>${fmtBytes(c.size)}</span><span class="sep">·</span><span>${relTime(c.mtime)}</span></div>
      <span class="status ${c.status}">${statusLabel[c.status] || c.status}</span>
      ${bar}
    </div>
  </article>`;
}

function renderClips(list) {
  grid.innerHTML = list.map(clipCard).join('');
  empty.hidden = list.length > 0;
  empty.textContent = allClips.length
    ? 'No clips match your search.'
    : 'No clips yet — record something and it will show up here.';
}

function applyFilter() {
  const q = search.value.trim().toLowerCase();
  renderClips(q ? allClips.filter(c => c.name.toLowerCase().includes(q)) : allClips);
}

async function loadClips() {
  allClips = await window.clips.list();
  applyFilter();
  const heroNum = document.querySelector('.hero-num');
  if (heroNum) heroNum.textContent = allClips.filter(c => c.status === 'uploaded').length;
}

search.addEventListener('input', applyFilter);

const pauseBanner = document.getElementById('pause-banner');
const pauseText = document.getElementById('pause-text');
function showPause(state) {
  if (state && state.paused) {
    pauseText.textContent = `Backup paused — ${state.reason || 'system busy'}. Resuming automatically.`;
    pauseBanner.hidden = false;
  } else {
    pauseBanner.hidden = true;
  }
}

window.clips.onChanged(() => loadClips());
window.clips.onState((state) => showPause(state));
window.clips.onProgress(({ path, pct }) => {
  for (const el of grid.querySelectorAll('.clip')) {
    if (el.dataset.path === path) {
      const fill = el.querySelector('.cbar-fill');
      if (fill) fill.style.width = pct + '%';
      break;
    }
  }
});
loadClips();
window.clips.state().then(showPause);

// Custom window controls
document.getElementById('min').addEventListener('click', () => window.win.minimize());
document.getElementById('max').addEventListener('click', () => window.win.maximize());
document.getElementById('close').addEventListener('click', () => window.win.close());

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('view-' + btn.dataset.view).classList.add('active');
    if (btn.dataset.view === 'dashboard') loadStorage();
    if (btn.dataset.view === 'clips') window.clips.rescan();
  });
});

// ── Settings: load from disk, auto-save on change ──
const els = {
  folder: document.getElementById('set-folder'),
  pick: document.getElementById('set-pick'),
  deleteLocal: document.getElementById('set-deleteLocal'),
  autoRetry: document.getElementById('set-autoRetry'),
  pauseWhenBusy: document.getElementById('set-pauseWhenBusy'),
  saved: document.getElementById('set-saved'),
};

let savedTimer;
function flashSaved() {
  els.saved.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => els.saved.classList.remove('show'), 1400);
}

function applySettings(s) {
  els.folder.textContent = s.clipsFolder;
  els.deleteLocal.checked = s.deleteLocal;
  els.autoRetry.checked = s.autoRetry;
  els.pauseWhenBusy.checked = s.pauseWhenBusy;
}

async function initSettings() {
  applySettings(await window.settings.get());

  els.deleteLocal.addEventListener('change', async () => {
    await window.settings.save({ deleteLocal: els.deleteLocal.checked });
    flashSaved();
  });
  els.autoRetry.addEventListener('change', async () => {
    await window.settings.save({ autoRetry: els.autoRetry.checked });
    flashSaved();
  });
  els.pauseWhenBusy.addEventListener('change', async () => {
    await window.settings.save({ pauseWhenBusy: els.pauseWhenBusy.checked });
    window.clips.rescan(); // re-evaluate immediately when toggled
    flashSaved();
  });
  els.pick.addEventListener('click', async () => {
    const folder = await window.settings.pickFolder();
    if (folder) { els.folder.textContent = folder; flashSaved(); }
  });
}

initSettings();

// ── Cloud connections (OAuth) ──
function paintConn(provider, info) {
  const sub = document.getElementById(`conn-${provider}-sub`);
  const btn = document.getElementById(`conn-${provider}`);
  if (info && info.connected) {
    sub.textContent = info.account || 'Connected';
    sub.classList.add('ok');
    btn.textContent = 'Disconnect';
    btn.classList.add('danger');
  } else {
    sub.textContent = 'Not connected';
    sub.classList.remove('ok');
    btn.textContent = 'Connect';
    btn.classList.remove('danger');
  }
}

async function refreshConnections() {
  const st = await window.cloud.status();
  paintConn('google', st.google);
  paintConn('dropbox', st.dropbox);
}

document.querySelectorAll('[data-provider]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const provider = btn.dataset.provider;
    const isConnected = btn.classList.contains('danger');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = isConnected ? 'Disconnecting…' : 'Connecting…';
    try {
      if (isConnected) await window.cloud.disconnect(provider);
      else await window.cloud.connect(provider);
      await refreshConnections();
    } catch (err) {
      btn.textContent = label;
      const msg = String(err && err.message ? err.message : err).replace(/^Error: /, '');
      const sub = document.getElementById(`conn-${provider}-sub`);
      sub.textContent = msg;
      sub.classList.add('err');
      setTimeout(() => sub.classList.remove('err'), 4000);
    } finally {
      btn.disabled = false;
    }
  });
});

refreshConnections();

// ── Storage (live metrics) ──
const storageBody = document.getElementById('storage-body');

function fmtBytes(n) {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)} ${u[i]}`;
}

function providerCard(p) {
  if (p.error) {
    return `<div class="stat wide">
      <div class="stat-head"><span class="stat-label">${esc(p.label)}${p.account ? ` · ${esc(p.account)}` : ''}</span></div>
      <span class="srow-sub err">${esc(p.error)}</span></div>`;
  }
  const pct = p.total ? Math.min(100, Math.round((p.used / p.total) * 100)) : 0;
  const totalText = p.total ? fmtBytes(p.total) : 'Unlimited';
  const tail = p.total ? `${fmtBytes(p.total - p.used)} available` : `${fmtBytes(p.used)} used`;
  return `<div class="stat wide">
    <div class="stat-head">
      <span class="stat-label">${esc(p.label)}${p.account ? ` · ${esc(p.account)}` : ''}</span>
      <span class="stat-meta">${fmtBytes(p.used)} / ${totalText}</span>
    </div>
    <div class="meter"><div class="meter-fill" style="width:${pct}%"></div></div>
    <span class="stat-meta">${tail}</span></div>`;
}

async function loadStorage() {
  storageBody.innerHTML = '<p class="empty">Loading…</p>';
  let data;
  try {
    data = await window.cloud.storage();
  } catch (e) {
    storageBody.innerHTML = `<p class="empty">Couldn't load storage: ${esc(String(e.message || e))}</p>`;
    return;
  }

  const cloud = data.providers.length
    ? data.providers.map(providerCard).join('')
    : `<div class="stat wide"><span class="stat-label">No cloud connected</span>
       <span class="stat-meta">Connect Google Drive or Dropbox in Settings to see your cloud usage.</span></div>`;

  const folderNote = data.local.exists ? 'in watched folder' : 'folder not found';
  const local = `
    <div class="stat"><span class="stat-label">Local clips</span>
      <span class="stat-value">${data.local.count}</span><span class="stat-meta">${folderNote}</span></div>
    <div class="stat"><span class="stat-label">Local size</span>
      <span class="stat-value">${fmtBytes(data.local.bytes)}</span><span class="stat-meta">on disk</span></div>
    <div class="stat"><span class="stat-label">Watched folder</span>
      <span class="stat-meta path">${esc(data.clipsFolder || '—')}</span></div>`;

  storageBody.innerHTML = `
    <p class="group-label">Cloud</p>
    <div class="stats">${cloud}</div>
    <p class="group-label">Local</p>
    <div class="stats">${local}</div>`;
}

document.getElementById('storage-refresh').addEventListener('click', loadStorage);
