const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

// Encrypted blob of cloud tokens, kept out of settings.json.
const FILE = path.join(app.getPath('userData'), 'tokens.enc');

function readAll() {
  try {
    const buf = fs.readFileSync(FILE);
    const json = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(buf)
      : buf.toString('utf8');
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function writeAll(obj) {
  const json = JSON.stringify(obj);
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)         // DPAPI / Keychain / libsecret
    : Buffer.from(json, 'utf8');              // fallback (e.g. headless Linux)
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, FILE);
}

function get(provider) {
  return readAll()[provider] || null;
}

function set(provider, data) {
  const all = readAll();
  all[provider] = data;
  writeAll(all);
}

function remove(provider) {
  const all = readAll();
  delete all[provider];
  writeAll(all);
}

module.exports = { get, set, remove, FILE };
