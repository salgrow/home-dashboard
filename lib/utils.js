const fs = require('fs');
const { AUTH_PATH } = require('./paths');

/**
 * Get base URL from Express request
 * @param {Object} req - Express request object
 * @returns {string} Base URL (e.g., "http://localhost:7272")
 */
function getBaseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
  const host = req.get('host');
  return `${proto}://${host}`;
}

/**
 * Read auth.json file
 * @returns {Object} Auth data or empty object
 */
function readAuthFile() {
  try {
    if (fs.existsSync(AUTH_PATH)) {
      return JSON.parse(fs.readFileSync(AUTH_PATH, 'utf-8'));
    }
  } catch (e) {
    console.warn('Failed to read auth file:', e.message);
  }
  return {};
}

/**
 * Write auth.json file
 * @param {Object} auth - Auth data to write
 */
function writeAuthFile(auth) {
  fs.writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2));
}

/**
 * Update specific section of auth.json
 * @param {string} section - Section name (e.g., 'google', 'smartcar')
 * @param {Object} data - Data to set for that section
 */
function updateAuthSection(section, data) {
  const auth = readAuthFile();
  auth[section] = data;
  writeAuthFile(auth);
}

/**
 * Delete specific section from auth.json
 * @param {string} section - Section name to delete
 */
function deleteAuthSection(section) {
  const auth = readAuthFile();
  delete auth[section];
  writeAuthFile(auth);
}

module.exports = {
  getBaseUrl,
  readAuthFile,
  writeAuthFile,
  updateAuthSection,
  deleteAuthSection,
};
