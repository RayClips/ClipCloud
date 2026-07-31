const fs = require('fs');
const path = require('path');
const settings = require('./settings');
const auth = require('./auth');
const tokens = require('./tokens');
const db = require('./clipsdb');
const resources = require('./resources');

const BUSY_RECHECK_MS = 20000;

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.flv', '.m4v', '.wmv']);

let emit = () => {};
let processing = false;
let watcher = null;
let rescanTimer = null;
let resumeTimer = null;
let pausedReason = null;
const queue = [];

function setEmitter(fn) {
  emit = fn || (() => {});
}

function listVideos(dir) {
  const out = [];
  function walk(d, depth) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 4) walk(full, depth + 1);
      } else if (VIDEO_EXT.has(path.extname(e.name).toLowerCase())) {
        try {
          const st = fs.statSync(full);
          out.push({ path: full, name: e.name, size: st.size, mtime: st.mtimeMs });
        } catch {
          /* skip unreadable */
        }
      }
    }
  }
  if (dir && fs.existsSync(dir)) walk(dir, 0);
  return out;
}

function pickProvider() {
  const st = auth.status();
  if (st.google?.connected) return 'google';
  if (st.dropbox?.connected) return 'dropbox';
  return null;
}

function list() {
  const s = settings.load();
  const records = db.all();
  const map = new Map();

  for (const f of listVideos(s.clipsFolder)) {
    const rec = records[f.path] || {};
    const status = ['uploaded', 'uploading', 'pending', 'error'].includes(rec.status)
      ? rec.status
      : 'local';
    map.set(f.path, {
      path: f.path, name: f.name, size: f.size, mtime: f.mtime,
      status, provider: rec.provider || null, onDisk: true,
    });
  }

  for (const [p, rec] of Object.entries(records)) {
    if (!map.has(p) && rec.status === 'uploaded') {
      map.set(p, {
        path: p, name: rec.name, size: rec.size, mtime: rec.mtime,
        status: 'uploaded', provider: rec.provider || null, onDisk: false,
      });
    }
  }

  return [...map.values()].sort((a, b) => b.mtime - a.mtime);
}

function rescan() {
  const provider = pickProvider();
  if (!provider) { emit('clips:changed'); return; }

  const s = settings.load();
  const autoRetry = s.autoRetry;
  for (const f of listVideos(s.clipsFolder)) {
    const rec = db.get(f.path);
    if (rec) {
      if (rec.status === 'uploaded' || rec.status === 'uploading') continue;
      if (rec.status === 'error' && !autoRetry) continue;
    }
    if (!queue.includes(f.path)) {
      db.set(f.path, { name: f.name, size: f.size, mtime: f.mtime, status: 'pending' });
      queue.push(f.path);
    }
  }
  emit('clips:changed');
  pump();
}

function scheduleResume() {
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(pump, BUSY_RECHECK_MS);
}

async function pump() {
  if (processing) return;
  const provider = pickProvider();
  if (!provider) return;
  if (!queue.length) return;

  if (settings.load().pauseWhenBusy) {
    const load = await resources.check();
    if (load.busy) {
      if (pausedReason !== load.reason) {
        pausedReason = load.reason;
        emit('uploads:state', { paused: true, reason: load.reason });
      }
      scheduleResume();
      return;
    }
  }
  if (pausedReason !== null) {
    pausedReason = null;
    emit('uploads:state', { paused: false });
  }

  const next = queue.shift();
  if (!next) return;

  processing = true;
  try {
    let st;
    try {
      st = fs.statSync(next);
    } catch {
      db.set(next, { status: 'error', error: 'File no longer exists' });
      return;
    }
    const name = path.basename(next);
    db.set(next, { name, size: st.size, mtime: st.mtimeMs, status: 'uploading', provider });
    emit('clips:changed');

    const token = await auth.accessTokenFor(provider);
    if (!token) throw new Error('Not connected');

    const res = await auth.PROVIDERS[provider].upload(
      token,
      { filePath: next, name, size: st.size },
      (frac) => emit('clip:progress', { path: next, pct: Math.round(frac * 100) })
    );

    db.set(next, { status: 'uploaded', remoteId: res.id || null, provider, uploadedAt: Date.now() });

    if (settings.load().deleteLocal) {
      try {
        fs.unlinkSync(next);
        db.set(next, { onDiskDeleted: true });
      } catch { /* leave the file if we can't delete it */ }
    }
    emit('clips:changed');
  } catch (e) {
    db.set(next, { status: 'error', error: String(e.message || e) });
    emit('clips:changed');
  } finally {
    processing = false;
    if (queue.length) setImmediate(pump); 
  }
}

function scheduleRescan() {
  clearTimeout(rescanTimer);
  rescanTimer = setTimeout(rescan, 1500);
}

function init() {
  if (watcher) {
    try { watcher.close(); } catch { /* ignore */ }
    watcher = null;
  }

  const all = db.all();
  for (const [p, rec] of Object.entries(all)) {
    if (rec.status === 'uploading') db.set(p, { status: 'pending' });
  }

  const dir = settings.load().clipsFolder;
  if (dir && fs.existsSync(dir)) {
    try {
      watcher = fs.watch(dir, { recursive: true }, scheduleRescan);
    } catch { /* recursive watch may be unsupported; rescan still works manually */ }
  }
  rescan();
}

function state() {
  return { paused: pausedReason !== null, reason: pausedReason };
}

module.exports = { init, rescan, list, state, setEmitter };
