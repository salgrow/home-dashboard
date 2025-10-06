const express = require('express');
const { getBaseUrl, readAuthFile, writeAuthFile, deleteAuthSection } = require('../lib/utils');
const { buildAuthUrl, handleOAuthCallback, isAuthed, listCalendars } = require('../services/calendarService');
const { 
  buildSmartcarAuthUrl, 
  handleSmartcarCallback, 
  listAllVehicles, 
  updateVehicleDisplayNames, 
  removeVehicleAuthorization 
} = require('../services/vehicleService');
const { VehiclesService } = require('../services/vehicleService');
const { getServiceStatuses } = require('../lib/dataBuilder');
const { getStateKey } = require('../lib/state');

const router = express.Router();

// ===== Admin Panel =====

/**
 * GET /admin - Admin panel UI
 */
router.get('/admin', (req, res) => {
  res.render('admin');
});

/**
 * GET /api/services/status - Service status for admin panel
 */
router.get('/api/services/status', async (req, res) => {
  try {
    const statuses = getServiceStatuses();
    const displaySync = getStateKey('last_display_sync', null);
    
    // Add LLM cost info if available
    const { LLMService } = require('../services/llmService');
    const llmService = new LLMService();
    const llmCostInfo = llmService.getCostInfo();
    
    res.status(200).json({ 
      services: statuses,
      lastDisplaySync: displaySync,
      llmCost: llmCostInfo
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /auth/status - Check if Google Calendar is authenticated
 */
router.get('/auth/status', (req, res) => {
  try {
    const authed = isAuthed();
    res.status(200).json({ authed });
  } catch (e) {
    res.status(500).json({ authed: false, error: e.message });
  }
});

/**
 * GET /auth/google - Start Google OAuth flow
 */
router.get('/auth/google', (req, res) => {
  try {
    const url = buildAuthUrl(getBaseUrl(req));
    res.redirect(url);
  } catch (e) {
    console.error('Failed to start Google OAuth:', e);
    res.status(500).json({ error: 'Failed to start Google OAuth', details: e.message });
  }
});

/**
 * GET /auth/google/callback - Google OAuth callback
 */
router.get('/auth/google/callback', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).json({ error: 'Missing code param' });
    await handleOAuthCallback(getBaseUrl(req), code);
    res.redirect('/admin');
  } catch (e) {
    console.error('OAuth callback error:', e);
    res.status(500).json({ error: 'OAuth callback failed', details: e.message });
  }
});

/**
 * GET /auth/google/signout - Sign out of Google Calendar
 */
router.get('/auth/google/signout', (req, res) => {
  try {
    deleteAuthSection('google');
    res.redirect('/admin');
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /admin/calendars - List available calendars
 */
router.get('/admin/calendars', async (req, res) => {
  try {
    const items = await listCalendars(getBaseUrl(req), console);
    const auth = readAuthFile();
    const selected = new Set(auth.google?.selectedCalendars || []);
    res.status(200).json({ 
      items: items.map(c => ({ ...c, selected: selected.has(c.id) })) 
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /admin/calendars - Save selected calendars
 */
router.post('/admin/calendars', async (req, res) => {
  try {
    const body = req.body || {};
    const selected = Array.isArray(body.selected_calendar_ids) ? body.selected_calendar_ids : [];
    
    const auth = readAuthFile();
    auth.google = auth.google || {};
    auth.google.selectedCalendars = selected;
    writeAuthFile(auth);
    
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== Smartcar OAuth =====

/**
 * GET /auth/smartcar - Start Smartcar OAuth flow
 */
router.get('/auth/smartcar', (req, res) => {
  try {
    const url = buildSmartcarAuthUrl('init');
    res.redirect(url);
  } catch (e) {
    console.error('Failed to start Smartcar OAuth:', e);
    res.status(500).json({ error: 'Failed to start Smartcar OAuth', details: e.message });
  }
});

/**
 * GET /auth/smartcar/callback - Smartcar OAuth callback
 */
router.get('/auth/smartcar/callback', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).json({ error: 'Missing code param' });
    await handleSmartcarCallback(code);
    res.redirect('/admin');
  } catch (e) {
    console.error('Smartcar OAuth callback error:', e);
    res.status(500).json({ error: 'Smartcar OAuth callback failed', details: e.message });
  }
});

/**
 * GET /auth/vehicles - List authenticated vehicles (basic)
 */
router.get('/auth/vehicles', async (req, res) => {
  try {
    const vehiclesService = new VehiclesService();
    const result = await vehiclesService.getData({}, console);
    res.status(200).json({ vehicles: result.data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /admin/vehicles - List all vehicles with details
 */
router.get('/admin/vehicles', async (req, res) => {
  try {
    const items = await listAllVehicles();
    res.status(200).json({ items });
  } catch (e) {
    if (e.message === 'Smartcar not authenticated') {
      res.status(200).json({ items: [] });
    } else {
      res.status(500).json({ error: e.message });
    }
  }
});

/**
 * POST /admin/vehicles - Update vehicle display names
 */
router.post('/admin/vehicles', async (req, res) => {
  try {
    const body = req.body || {};
    const display_names = typeof body.display_names === 'object' && body.display_names ? body.display_names : {};
    updateVehicleDisplayNames(display_names);
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * DELETE /admin/vehicles/:vehicleId - Remove vehicle authorization
 */
router.delete('/admin/vehicles/:vehicleId', async (req, res) => {
  try {
    const vehicleId = req.params.vehicleId;
    removeVehicleAuthorization(vehicleId);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Error removing vehicle:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
