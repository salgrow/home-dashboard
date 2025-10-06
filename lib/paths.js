const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (_) {}
}

const AUTH_PATH = path.join(DATA_DIR, 'auth.json');
const STATE_PATH = path.join(DATA_DIR, 'state.json');

module.exports = {
  ROOT,
  DATA_DIR,
  ensureDataDir,
  AUTH_PATH,
  STATE_PATH,
};
