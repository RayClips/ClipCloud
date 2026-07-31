const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const FILE = path.join(app.getPath('userData'), 'settings.json');

const DEFAULTS = Object.freeze({
  clipsFolder: app.getPath('videos'),
  provider: 'Google Drive',
  deleteLocal: false,   
  autoRetry: true,
  pauseWhenBusy: true,  // hold uploads while gaming (high CPU/GPU/RAM)
});

function load() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(settings) {
  const merged = { ...DEFAULTS, ...settings };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
  return merged;
}

module.exports = { load, save, FILE, DEFAULTS };
