const fs = require('fs');
const path = require('path');
const settings = require('./settings');
const auth = require('./auth');
const tokens = require('./tokens');

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.flv', '.m4v', '.wmv']);

function scanLocal(dir) {
  let count = 0;
  let bytes = 0;
  let newest = 0;

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
          bytes += st.size;
          count += 1;
          if (st.mtimeMs > newest) newest = st.mtimeMs;
        } catch {
          /* skip unreadable file */
        }
      }
    }
  }

  const exists = !!dir && fs.existsSync(dir);
  if (exists) walk(dir, 0);
  return { count, bytes, newest, exists };
}

async function get() {
  const s = settings.load();
  const local = scanLocal(s.clipsFolder);

  const providers = [];
  for (const [key, p] of Object.entries(auth.PROVIDERS)) {
    const info = tokens.get(key);
    if (!info) continue; 
    try {
      const token = await auth.accessTokenFor(key);
      const q = await p.quota(token);
      providers.push({ key, label: p.label, account: info.account, used: q.used, total: q.total });
    } catch (e) {
      providers.push({ key, label: p.label, account: info.account, error: e.message });
    }
  }

  return { clipsFolder: s.clipsFolder, local, providers };
}

module.exports = { get };
