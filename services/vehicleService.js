const fs = require('fs');
const Smartcar = require('smartcar');
const { BaseService } = require('../lib/BaseService');
const { AUTH_PATH } = require('../lib/paths');

/**
 * Vehicles Service (Smartcar) - OPTIONAL
 * Provides vehicle telemetry (battery/fuel level, range)
 */
class VehiclesService extends BaseService {
  constructor(cacheTTLMinutes = 30) {
    super({
      name: 'Vehicles',
      cacheKey: 'vehicles',
      cacheTTL: cacheTTLMinutes * 60 * 1000,
      retryAttempts: 2,
      retryCooldown: 1000,
    });
  }

  isEnabled() {
    const clientId = process.env.SMARTCAR_CLIENT_ID;
    const clientSecret = process.env.SMARTCAR_CLIENT_SECRET;
    const authorizations = this.loadVehicleAuthorizations();
    return !!(clientId && clientSecret && authorizations.length > 0);
  }

  loadVehicleAuthorizations() {
    try {
      if (fs.existsSync(AUTH_PATH)) {
        const auth = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf-8'));
        const authorizations = auth.smartcar?.authorizations || [];
        return Array.isArray(authorizations) ? authorizations : [];
      }
    } catch (_) {}
    return [];
  }

  async fetchData(config, logger) {
    const authorizations = this.loadVehicleAuthorizations();
    if (authorizations.length === 0) {
      throw new Error('No vehicle authorizations found');
    }

    const summaries = [];

    for (const auth of authorizations) {
      try {
        const validAuth = await this.refreshAuthorizationIfNeeded(auth, logger);
        const accessToken = validAuth.accessToken || validAuth.access_token;
        
        if (!accessToken) {
          logger.warn?.(`[Vehicles] Missing access token for ${auth.authId}`);
          continue;
        }

        const vehicleIds = validAuth.vehicleIds || [];
        for (const id of vehicleIds) {
          try {
            const summary = await this.fetchVehicleSummary(accessToken, id);
            const displayName = validAuth.displayNames?.[id] || `${summary.make} ${summary.model}`;
            summaries.push({
              id,
              name: displayName,
              make: summary.make,
              percent: summary.percent,
              range_miles: summary.range_miles,
            });
          } catch (e) {
            logger.warn?.(`[Vehicles] Failed to fetch vehicle ${id}: ${e.message}`);
          }
        }
      } catch (e) {
        logger.warn?.(`[Vehicles] Failed to process authorization ${auth.authId}: ${e.message}`);
      }
    }

    if (summaries.length === 0) {
      throw new Error('No vehicle data available');
    }

    return summaries;
  }

  async refreshAuthorizationIfNeeded(authorization, logger) {
    try {
      const now = Date.now();
      const expiration = authorization.expiration ? new Date(authorization.expiration).getTime() : 0;
      
      if (expiration && expiration - now < 60 * 1000) {
        logger.info?.(`[Vehicles] Refreshing tokens for ${authorization.authId}`);
        
        const client = this.getAuthClient();
        const refreshed = await client.exchangeRefreshToken(
          authorization.refreshToken || authorization.refresh_token
        );

        // Update stored authorization
        const auth = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf-8'));
        const authIndex = auth.smartcar.authorizations.findIndex(a => a.authId === authorization.authId);
        if (authIndex !== -1) {
          auth.smartcar.authorizations[authIndex] = {
            ...auth.smartcar.authorizations[authIndex],
            ...refreshed,
            refreshedAt: new Date().toISOString(),
          };
          fs.writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2));
        }

        return { ...authorization, ...refreshed };
      }
    } catch (e) {
      logger.warn?.(`[Vehicles] Token refresh error for ${authorization.authId}: ${e.message}`);
    }
    
    return authorization;
  }

  async fetchVehicleSummary(accessToken, vehicleId) {
    const vehicle = new Smartcar.Vehicle(vehicleId, accessToken);
    const attrs = await vehicle.attributes();

    let percent = null;
    let range_miles = null;

    // Try fuel first
    try {
      const fuel = await vehicle.fuel();
      if (fuel && typeof fuel.percentRemaining === 'number') {
        percent = Math.round(fuel.percentRemaining * 100);
      }
      if (fuel && typeof fuel.range === 'number') {
        range_miles = Math.round(fuel.range);
      }
    } catch (_) {}

    // Try battery if fuel didn't work
    if (percent == null) {
      try {
        const battery = await vehicle.battery();
        if (battery && typeof battery.percentRemaining === 'number') {
          percent = Math.round(battery.percentRemaining * 100);
        }
        if (battery && typeof battery.range === 'number') {
          range_miles = Math.round(battery.range);
        }
      } catch (_) {}
    }

    return {
      id: vehicleId,
      make: attrs.make,
      model: attrs.model,
      percent: typeof percent === 'number' ? percent : null,
      range_miles: typeof range_miles === 'number' ? range_miles : null,
    };
  }

  getAuthClient() {
    const clientId = process.env.SMARTCAR_CLIENT_ID;
    const clientSecret = process.env.SMARTCAR_CLIENT_SECRET;
    const redirectUri = process.env.SMARTCAR_REDIRECT_URI;
    const mode = process.env.SMARTCAR_MODE === 'live' ? 'live' : 'test';

    return new Smartcar.AuthClient({
      clientId,
      clientSecret,
      redirectUri,
      mode,
    });
  }

  mapToDashboard(apiData, config) {
    return apiData.map(v => ({
      name: v.name,
      make: v.make,
      percent: typeof v.percent === 'number' ? v.percent : 0,
      range_miles: typeof v.range_miles === 'number' ? v.range_miles : 0,
    }));
  }
}

// OAuth helper functions for server.js
const service = new VehiclesService();

function buildSmartcarAuthUrl(state = 'sc_state') {
  const client = service.getAuthClient();
  const scope = ['read_vehicle_info', 'read_battery', 'read_charge', 'read_fuel'];
  return client.getAuthUrl(scope, { forcePrompt: true, state });
}

async function handleSmartcarCallback(code) {
  const client = service.getAuthClient();
  const access = await client.exchangeCode(code);
  
  try {
    const accessToken = access.accessToken || access.access_token;
    const vehicleIds = await Smartcar.getVehicles(accessToken).then(res => res.vehicles || []);
    
    if (vehicleIds.length > 0) {
      const auth = fs.existsSync(AUTH_PATH) 
        ? JSON.parse(fs.readFileSync(AUTH_PATH, 'utf-8')) 
        : {};
      auth.smartcar = auth.smartcar || {};
      auth.smartcar.authorizations = auth.smartcar.authorizations || [];
      
      const newAuth = {
        ...access,
        vehicleIds,
        authorizedAt: new Date().toISOString(),
        authId: `auth_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      };
      
      auth.smartcar.authorizations = auth.smartcar.authorizations.filter(existing => {
        const existingVehicleIds = existing.vehicleIds || [];
        return !vehicleIds.some(vid => existingVehicleIds.includes(vid));
      });
      
      auth.smartcar.authorizations.push(newAuth);
      fs.writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2));
    }
  } catch (e) {
    console.error('Failed to process vehicle authorization:', e.message);
    throw new Error('Failed to complete vehicle authorization');
  }
  
  return access;
}

async function listAllVehicles() {
  const authorizations = service.loadVehicleAuthorizations();
  if (authorizations.length === 0) throw new Error('Smartcar not authenticated');
  
  const allVehicles = [];
  
  for (const auth of authorizations) {
    try {
      const validAuth = await service.refreshAuthorizationIfNeeded(auth, console);
      const accessToken = validAuth.accessToken || validAuth.access_token;
      if (!accessToken) continue;
      
      const vehicleIds = validAuth.vehicleIds || [];
      for (const id of vehicleIds) {
        try {
          const vehicle = new Smartcar.Vehicle(id, accessToken);
          const attrs = await vehicle.attributes();
          const displayName = validAuth.displayNames?.[id] || null;
          
          allVehicles.push({ 
            id, 
            make: attrs.make, 
            model: attrs.model,
            display_name: displayName,
          });
        } catch (e) {
          console.warn(`Failed to fetch attributes for vehicle ${id}:`, e.message);
        }
      }
    } catch (e) {
      console.warn(`Failed to process authorization ${auth.authId}:`, e.message);
    }
  }
  
  return allVehicles;
}

function updateVehicleDisplayNames(displayNames) {
  const auth = fs.existsSync(AUTH_PATH) 
    ? JSON.parse(fs.readFileSync(AUTH_PATH, 'utf-8')) 
    : {};
  
  if (auth.smartcar?.authorizations) {
    for (const authItem of auth.smartcar.authorizations) {
      const vehicleIds = authItem.vehicleIds || [];
      authItem.displayNames = authItem.displayNames || {};
      for (const vehicleId of vehicleIds) {
        if (displayNames[vehicleId]) {
          authItem.displayNames[vehicleId] = displayNames[vehicleId];
        }
      }
    }
    fs.writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2));
  }
}

function removeVehicleAuthorization(vehicleId) {
  const auth = fs.existsSync(AUTH_PATH) 
    ? JSON.parse(fs.readFileSync(AUTH_PATH, 'utf-8')) 
    : {};
  
  if (auth.smartcar?.authorizations) {
    auth.smartcar.authorizations = auth.smartcar.authorizations.filter(authItem => {
      const vehicleIds = authItem.vehicleIds || [];
      return !vehicleIds.includes(vehicleId);
    });
    fs.writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2));
  }
}

module.exports = {
  VehiclesService,
  buildSmartcarAuthUrl,
  handleSmartcarCallback,
  listAllVehicles,
  updateVehicleDisplayNames,
  removeVehicleAuthorization,
};
