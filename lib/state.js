const fs = require('fs');
const { STATE_PATH, ensureDataDir } = require('./paths');

ensureDataDir();

/**
 * Read state from disk
 * @returns {Object} State object with all persisted data
 */
function readState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      const raw = fs.readFileSync(STATE_PATH, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn('Failed to read state.json:', err.message);
  }
  return {};
}

/**
 * Write state to disk
 * @param {Object} state - State object to persist
 */
function writeState(state) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn('Failed to write state.json:', err.message);
  }
}

/**
 * Get a specific key from state
 * @param {string} key - Key to retrieve
 * @param {*} defaultValue - Default value if key doesn't exist
 * @returns {*} Value for the key
 */
function getStateKey(key, defaultValue = null) {
  const state = readState();
  return state[key] !== undefined ? state[key] : defaultValue;
}

/**
 * Set a specific key in state
 * @param {string} key - Key to set
 * @param {*} value - Value to set
 */
function setStateKey(key, value) {
  const state = readState();
  state[key] = value;
  writeState(state);
}

/**
 * Update multiple keys in state
 * @param {Object} updates - Object with key-value pairs to update
 */
function updateState(updates) {
  const state = readState();
  Object.assign(state, updates);
  writeState(state);
}

module.exports = {
  readState,
  writeState,
  getStateKey,
  setStateKey,
  updateState,
};
