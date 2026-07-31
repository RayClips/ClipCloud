const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const { shell } = require('electron');
const tokens = require('./tokens');

const CHUNK = 8 * 1024 * 1024; // 8 MiB (multiple of 256 KiB, required by Drive)

function readChunk(fd, position, length) {
  const buf = Buffer.alloc(length);
  fs.readSync(fd, buf, 0, length, position);
  return buf;
}

// Dropbox requires the API-Arg header to be ASCII; escape any non-ASCII char.
function dbxArg(obj) {
  let out = '';
  for (const ch of JSON.stringify(obj)) {
    const code = ch.charCodeAt(0);
    out += code > 127 ? '\\u' + code.toString(16).padStart(4, '0') : ch;
  }
  return out;
}

const b64url = (buf) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

const PROVIDERS = {
  google: {
    label: 'Google Drive',
    clientId: () => process.env.CLIENTID_GOOGLE,
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    scope: 'openid email https://www.googleapis.com/auth/drive.file',
    fixedPort: 0, 
    extra: { access_type: 'offline', prompt: 'consent' },
    async account(accessToken) {
      const r = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const j = await r.json().catch(() => ({}));
      return j.email || j.name || 'Google account';
    },
    async quota(accessToken) {
      const r = await fetch('https://www.googleapis.com/drive/v3/about?fields=storageQuota', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error?.message || `Quota request failed (${r.status})`);
      const q = j.storageQuota || {};
      return {
        used: Number(q.usage ?? 0),
        total: q.limit != null ? Number(q.limit) : null,
      };
    },

    async upload(accessToken, { filePath, name, size }, onProgress) {
      const init = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Length': String(size),
          },
          body: JSON.stringify({ name }),
        }
      );
      if (!init.ok) throw new Error(`Drive could not start upload (${init.status})`);
      const location = init.headers.get('location');
      if (!location) throw new Error('Drive did not return an upload URL');

      const fd = fs.openSync(filePath, 'r');
      try {
        let offset = 0;
        while (offset < size) {
          const end = Math.min(offset + CHUNK, size);
          const len = end - offset;
          const res = await fetch(location, {
            method: 'PUT',
            headers: { 'Content-Range': `bytes ${offset}-${end - 1}/${size}` },
            body: readChunk(fd, offset, len),
          });
          if (res.status === 308) {
            offset = end;
            onProgress?.(offset / size);
            continue;
          }
          if (res.ok) {
            onProgress?.(1);
            const j = await res.json().catch(() => ({}));
            return { id: j.id || null };
          }
          const t = await res.text().catch(() => '');
          throw new Error(`Drive upload failed (${res.status}) ${t.slice(0, 120)}`);
        }
        return { id: null };
      } finally {
        fs.closeSync(fd);
      }
    },
  },
  dropbox: {
    label: 'Dropbox',
    clientId: () => process.env.DROPBOX_APPKEY,
    authUrl: 'https://www.dropbox.com/oauth2/authorize',
    tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
    revokeUrl: null,
    scope: 'account_info.read files.content.write files.content.read',
    fixedPort: 53682, // must match a registered redirect URI in the Dropbox app
    extra: { token_access_type: 'offline' },
    async account(accessToken) {
      const r = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const j = await r.json().catch(() => ({}));
      return j.email || j.name?.display_name || 'Dropbox account';
    },
    async quota(accessToken) {
      const r = await fetch('https://api.dropboxapi.com/2/users/get_space_usage', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error_summary || `Quota request failed (${r.status})`);
      const alloc = j.allocation || {};
      const total = alloc.allocated != null ? Number(alloc.allocated) : null;
      return { used: Number(j.used ?? 0), total };
    },
    async upload(accessToken, { filePath, name, size }, onProgress) {
      const fd = fs.openSync(filePath, 'r');
      const headers = (arg) => ({
        Authorization: `Bearer ${accessToken}`,
        'Dropbox-API-Arg': dbxArg(arg),
        'Content-Type': 'application/octet-stream',
      });
      try {
        const first = Math.min(CHUNK, size);
        let r = await fetch('https://content.dropboxapi.com/2/files/upload_session/start', {
          method: 'POST',
          headers: headers({ close: false }),
          body: readChunk(fd, 0, first),
        });
        let j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error_summary || `Dropbox start failed (${r.status})`);
        const sessionId = j.session_id;
        let offset = first;
        onProgress?.(size ? offset / size : 1);

        while (offset < size) {
          const end = Math.min(offset + CHUNK, size);
          const len = end - offset;
          r = await fetch('https://content.dropboxapi.com/2/files/upload_session/append_v2', {
            method: 'POST',
            headers: headers({ cursor: { session_id: sessionId, offset }, close: false }),
            body: readChunk(fd, offset, len),
          });
          if (!r.ok) {
            const e = await r.json().catch(() => ({}));
            throw new Error(e.error_summary || `Dropbox append failed (${r.status})`);
          }
          offset = end;
          onProgress?.(offset / size);
        }

        r = await fetch('https://content.dropboxapi.com/2/files/upload_session/finish', {
          method: 'POST',
          headers: headers({
            cursor: { session_id: sessionId, offset: size },
            commit: { path: `/${name}`, mode: 'add', autorename: true, mute: true },
          }),
          body: Buffer.alloc(0),
        });
        j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error_summary || `Dropbox finish failed (${r.status})`);
        onProgress?.(1);
        return { id: j.id || null };
      } finally {
        fs.closeSync(fd);
      }
    },
  },
};

const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>ClipCloud</title>
<style>body{font-family:system-ui,Segoe UI,sans-serif;background:#0b0b12;color:#f0f0f5;
display:grid;place-items:center;height:100vh;margin:0}
.card{text-align:center}.c{font-size:42px}h1{font-weight:650;margin:14px 0 6px}
p{color:#9a9ab0;margin:0}</style></head>
<body><div class="card"><div class="c">&#9729;&#65039;&#10003;</div><h1>Connected to ClipCloud</h1>
<p>You can close this window and return to the app.</p></div></body></html>`;

function getAuthCode(p, clientId, challenge) {
  return new Promise((resolve, reject) => {
    let redirectUri;
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://localhost');
      const code = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      if (!code && !err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(SUCCESS_HTML);
      cleanup();
      err ? reject(new Error(err)) : resolve({ code, redirectUri });
    });

    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for authorization')); }, 180000);
    function cleanup() { clearTimeout(timer); server.close(); }

    server.on('error', (e) => { cleanup(); reject(e); });
    server.listen(p.fixedPort, '127.0.0.1', () => {
      const port = server.address().port;
      redirectUri = `http://localhost:${port}`;
      const params = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: p.scope,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        ...p.extra,
      });
      shell.openExternal(`${p.authUrl}?${params.toString()}`);
    });
  });
}

async function exchange(p, clientId, code, verifier, redirectUri) {
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });
  const r = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.error || `Token exchange failed (${r.status})`);
  return j;
}

async function connect(providerKey) {
  const p = PROVIDERS[providerKey];
  if (!p) throw new Error(`Unknown provider: ${providerKey}`);
  const clientId = p.clientId();
  if (!clientId) throw new Error(`Missing client ID for ${p.label}. Check your .env file.`);

  const { verifier, challenge } = pkce();
  const { code, redirectUri } = await getAuthCode(p, clientId, challenge);
  const tok = await exchange(p, clientId, code, verifier, redirectUri);

  const account = await p.account(tok.access_token).catch(() => p.label);
  tokens.set(providerKey, {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || null,
    expires_at: tok.expires_in ? Date.now() + tok.expires_in * 1000 : null,
    account,
  });
  return { connected: true, account };
}

async function disconnect(providerKey) {
  const p = PROVIDERS[providerKey];
  const stored = tokens.get(providerKey);
  if (stored?.access_token && p?.revokeUrl) {
    try {
      await fetch(`${p.revokeUrl}?token=${encodeURIComponent(stored.access_token)}`, { method: 'POST' });
    } catch { /* ignore */ }
  }
  tokens.remove(providerKey);
  return { connected: false };
}

function status() {
  const out = {};
  for (const key of Object.keys(PROVIDERS)) {
    const t = tokens.get(key);
    out[key] = { connected: !!t, account: t?.account || null };
  }
  return out;
}

async function refresh(providerKey) {
  const p = PROVIDERS[providerKey];
  const t = tokens.get(providerKey);
  if (!t?.refresh_token) throw new Error('Session expired — reconnect this account.');
  const body = new URLSearchParams({
    client_id: p.clientId(),
    grant_type: 'refresh_token',
    refresh_token: t.refresh_token,
  });
  const r = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.error || 'Token refresh failed');
  const updated = {
    ...t,
    access_token: j.access_token,
    expires_at: j.expires_in ? Date.now() + j.expires_in * 1000 : null,
    refresh_token: j.refresh_token || t.refresh_token, 
  };
  tokens.set(providerKey, updated);
  return updated.access_token;
}

async function accessTokenFor(providerKey) {
  const t = tokens.get(providerKey);
  if (!t) return null;
  if (t.expires_at && Date.now() > t.expires_at - 60000 && t.refresh_token) {
    return refresh(providerKey);
  }
  return t.access_token;
}

module.exports = { connect, disconnect, status, accessTokenFor, PROVIDERS };
