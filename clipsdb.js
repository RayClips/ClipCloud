const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const FILE = path.join(app.getPath('userData'), 'clips.json');

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeAll(obj) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

function get(key) {
  return readAll()[key];
}

function set(key, patch) {
  const all = readAll();
  all[key] = { ...all[key], ...patch };
  writeAll(all);
  return all[key];
}

function all() {
  return readAll();
}

module.exports = { get, set, all, FILE };
