const axios = require('axios');
const { BaseService } = require('../lib/BaseService');
const { mapIconAndDescription } = require('../lib/weatherUtils');
const zipcodes = require('zipcodes');

/**
 * Weather API Service (Visual Crossing) - PRIMARY WEATHER DATA SOURCE
 * This is the only required service - all others are optional
 */
class WeatherService extends BaseService {
  constructor(cacheTTLMinutes = 30) {
    super({
      name: 'Visual Crossing Weather',
      cacheKey: 'weather',
      cacheTTL: cacheTTLMinutes * 60 * 1000,
      retryAttempts: 3,
      retryCooldown: 1000,
    });
  }

  isEnabled() {
    const apiKey = process.env.VISUAL_CROSSING_API_KEY;
    return !!apiKey;
  }

  buildForecastUrl(apiKey, zip, days = 7) {
    // Visual Crossing uses location/next{days}days format for forecast
    const url = new URL(`https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/${encodeURIComponent(zip)}/next${days}days`);
    url.searchParams.set('key', apiKey);
    url.searchParams.set('unitGroup', 'us'); // Use US units (Fahrenheit, mph, inches)
    url.searchParams.set('include', 'days,hours,current,alerts');
    // Include air quality elements: aqius (US EPA AQI) and pm2p5 (PM2.5)
    url.searchParams.set('elements', 'datetime,tempmax,tempmin,temp,feelslike,feelslikemax,feelslikemin,humidity,precip,precipprob,preciptype,snow,snowdepth,windspeed,winddir,pressure,cloudcover,visibility,solarradiation,solarenergy,uvindex,sunrise,sunset,moonphase,conditions,description,icon,severerisk,aqius,pm2p5');
    return url.toString();
  }

  async fetchData(config, logger) {
    const apiKey = process.env.VISUAL_CROSSING_API_KEY;
    if (!apiKey) throw new Error('VISUAL_CROSSING_API_KEY not configured');

    // Read location ZIPs from env
    const mainZip = (process.env.MAIN_LOCATION_ZIP || '').trim();
    const additionalZips = process.env.ADDITIONAL_LOCATION_ZIPS || '';
    const additionalArray = additionalZips.split(',').map(z => z.trim()).filter(z => z).slice(0, 3);
    const locationZips = mainZip ? [mainZip, ...additionalArray] : [];
    
    if (locationZips.length === 0) throw new Error('MAIN_LOCATION_ZIP not configured');

    const days = 7;
    
    // Fetch all locations in parallel
    const promises = locationZips.map(zip => 
      this.fetchLocationData(apiKey, zip, days, logger)
    );
    
    const results = await Promise.all(promises);
    return results;
  }

  async fetchLocationData(apiKey, zip, days, logger) {
    const url = this.buildForecastUrl(apiKey, zip, days);
    const resp = await axios.get(url, { timeout: 10000 });
    
    if (resp.status !== 200) {
      throw new Error(`Weather API returned status ${resp.status}`);
    }
    
    return { zip, data: resp.data };
  }

  mapToDashboard(apiResults, config) {
    if (!Array.isArray(apiResults) || apiResults.length === 0) {
      throw new Error('No weather data available');
    }

    // Extract timezone from first location for date parsing
    const locationTimezone = apiResults[0]?.data?.timezone || 'America/Los_Angeles';

    /**
     * Get day of week for a date string in the location's timezone
     * @param {string} dateStr - Date string in YYYY-MM-DD format
     * @returns {string} Day of week (e.g., 'Mon', 'Tue')
     */
    const getDayOfWeek = (dateStr) => {
      // Parse at noon to avoid timezone issues with midnight
      const date = new Date(dateStr + 'T12:00:00');
      return date.toLocaleDateString('en-US', { 
        weekday: 'short',
        timeZone: locationTimezone  // Use the location's timezone from Visual Crossing
      });
    };

    // Extract and transform data from raw API response
    const processedLocations = apiResults.map(({ zip, data }) => {
      const forecastDays = data?.days || [];
      const current = data?.currentConditions || {};
      
      // Parse location from resolvedAddress
      // Visual Crossing returns "ZIP, Country" for ZIP queries, not city names
      const resolvedAddress = data?.resolvedAddress || '';
      
      let location;
      if (resolvedAddress.startsWith(zip)) {
        // Visual Crossing didn't resolve the ZIP to a city name
        // Use zipcodes package to lookup city/state from ZIP
        const zipInfo = zipcodes.lookup(zip);
        location = {
          name: zipInfo?.city || zip, // Use city name or fall back to ZIP
          region: zipInfo?.state || '',
          country: 'US',
          tz_id: data?.timezone || locationTimezone,
        };
      } else {
        // resolvedAddress has actual city/state info
        const addressParts = resolvedAddress.split(',').map(s => s.trim());
        location = {
          name: addressParts[0] || zip,
          region: addressParts[1] || '',
          country: addressParts[2] || 'US',
          tz_id: data?.timezone || locationTimezone,
        };
      }
      
      const today = forecastDays[0];

      return {
        zip,
        location,
        current: {
          temp_f: current.temp,
          feels_like_f: current.feelslike,
          humidity: current.humidity,
          pressure_in: current.pressure,
          wind_mph: current.windspeed,
          wind_dir: current.winddir,
          condition: current.conditions,
          pm2_5: current.pm2p5, // PM2.5 particulate matter
          aqi: current.aqius, // US EPA Air Quality Index
        },
        forecast: forecastDays.map(day => {
          return {
            date: day.datetime,
            day_of_week: getDayOfWeek(day.datetime),
            high_f: day.tempmax,
            low_f: day.tempmin,
            condition: day.conditions,
            rain_chance: day.precipprob,
            precip_in: day.precip,
            avghumidity: day.humidity,
            hour: (day.hours || []).map(h => ({
              time: h.datetime,
              temp_f: h.temp,
              condition: h.conditions,
              rain_chance: h.precipprob,
              wind_mph: h.windspeed,
            })),
          };
        }),
        astro: {
          sunrise: this.formatTime12Hour(today?.sunrise),
          sunset: this.formatTime12Hour(today?.sunset),
          moon_phase: this.convertMoonPhase(today?.moonphase),
          moon_illumination: this.calculateMoonIllumination(today?.moonphase),
        },
      };
    });

    const mainLocation = processedLocations[0];

    // Map locations for dashboard
    const locations = processedLocations.map(loc => {
      const today = loc.forecast[0];
      // Use current actual conditions, not forecast
      const { icon } = mapIconAndDescription(loc.current.condition || '');
      const condition = loc.current.condition || 'Clear';
      
      return {
        name: loc.location.name,
        region: loc.location.region,
        country: loc.location.country,
        zip_code: loc.zip,
        current_temp: Math.round(Number(loc.current.temp_f || 0)),
        high: Math.round(Number(today?.high_f || 0)),
        low: Math.round(Number(today?.low_f || 0)),
        icon,
        condition,
        rain_chance: Number(today?.rain_chance || 0),
        // Current conditions data (used as fallback if Ambient Weather unavailable)
        humidity: Math.round(Number(loc.current.humidity || 0)),
        pressure: Math.round(Number(loc.current.pressure_in || 0) * 100) / 100,
        wind_mph: Math.round(Number(loc.current.wind_mph || 0) * 10) / 10,
        wind_dir: loc.current.wind_dir || 0,
      };
    });

    // Build 5-day forecast (skip today, show next 5 days)
    const allForecast = mainLocation.forecast.map(day => {
      const { icon } = mapIconAndDescription(day.condition || '');
      return {
        date: day.date,
        day: day.day_of_week,
        high: Math.round(Number(day.high_f || 0)),
        low: Math.round(Number(day.low_f || 0)),
        icon,
        rain_chance: Number(day.rain_chance || 0),
      };
    });

    // Skip today and show next 5 days (use actual date comparison)
    // Use local date, not UTC (important for timezone-aware comparison)
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const todayIndex = allForecast.findIndex(d => d.date === todayStr);
    const startIndex = todayIndex >= 0 ? todayIndex + 1 : 1;
    const forecast = allForecast.slice(startIndex, startIndex + 5);

    // Build hourly forecast (next 24 hours)
    const hourlyForecast = this.getNext24Hours(mainLocation.forecast);

    // Use AQI from Visual Crossing if available, otherwise calculate from PM2.5
    let aqi = mainLocation.current.aqi;
    if (aqi == null && mainLocation.current.pm2_5 != null) {
      aqi = this.calculateAQI(mainLocation.current.pm2_5);
    }
    const aqiCategory = this.mapAqiCategory(aqi);

    // Moon phase mapping
    const { phase, direction } = this.mapMoonPhase(mainLocation.astro.moon_phase);

    // Precipitation totals
    const total24h = mainLocation.forecast[0]?.precip_in || 0;
    const weekTotal = mainLocation.forecast.slice(0, 7).reduce(
      (sum, d) => sum + Number(d.precip_in || 0), 0
    );

    return {
      locations,
      forecast,
      hourlyForecast,
      timezone: locationTimezone,
      sun: {
        sunrise: mainLocation.astro.sunrise,
        sunset: mainLocation.astro.sunset,
      },
      moon: {
        phase,
        direction,
        illumination: mainLocation.astro.moon_illumination ? Number(mainLocation.astro.moon_illumination) : null,
      },
      air_quality: aqi != null ? { aqi, category: aqiCategory } : { aqi: null, category: 'Unknown' },
      precipitation: {
        last_24h_in: Number(total24h.toFixed(2)),
        week_total_in: Number(weekTotal.toFixed(2)),
        year_total_in: null,
      },
    };
  }

  getNext24Hours(forecastDays) {
    const now = new Date();
    const currentHour = now.getHours();
    const hourlyData = [];

    for (let dayIndex = 0; dayIndex < Math.min(3, forecastDays.length) && hourlyData.length < 24; dayIndex++) {
      const day = forecastDays[dayIndex];
      const hours = day.hour || [];

      for (const hourData of hours) {
        if (hourlyData.length >= 24) break;

        // Visual Crossing uses HH:MM:SS format for hour time
        const [hourStr] = (hourData.time || '00:00:00').split(':');
        const hour = parseInt(hourStr, 10);

        if (dayIndex === 0 && hour < currentHour) continue;

        const { icon } = mapIconAndDescription(hourData.condition || '');
        
        // Format time display
        const hourNum = hour % 12 || 12;
        const ampm = hour < 12 ? 'AM' : 'PM';
        
        hourlyData.push({
          time: `${hourNum} ${ampm}`,
          temp_f: Math.round(Number(hourData.temp_f || 0)),
          condition: hourData.condition || 'Unknown',
          icon,
          rain_chance: Number(hourData.rain_chance || 0),
          wind_mph: Math.round(Number(hourData.wind_mph || 0)),
        });
      }
    }

    return hourlyData;
  }

  calculateAQI(pm25) {
    if (pm25 == null || pm25 < 0) return null;

    const breakpoints = [
      { cLow: 0.0, cHigh: 12.0, aqiLow: 0, aqiHigh: 50 },
      { cLow: 12.1, cHigh: 35.4, aqiLow: 51, aqiHigh: 100 },
      { cLow: 35.5, cHigh: 55.4, aqiLow: 101, aqiHigh: 150 },
      { cLow: 55.5, cHigh: 150.4, aqiLow: 151, aqiHigh: 200 },
      { cLow: 150.5, cHigh: 250.4, aqiLow: 201, aqiHigh: 300 },
      { cLow: 250.5, cHigh: 500.4, aqiLow: 301, aqiHigh: 500 },
    ];

    let bp = breakpoints[breakpoints.length - 1];
    for (const breakpoint of breakpoints) {
      if (pm25 >= breakpoint.cLow && pm25 <= breakpoint.cHigh) {
        bp = breakpoint;
        break;
      }
    }

    const { cLow, cHigh, aqiLow, aqiHigh } = bp;
    const aqi = ((aqiHigh - aqiLow) / (cHigh - cLow)) * (pm25 - cLow) + aqiLow;
    return Math.round(aqi);
  }

  mapAqiCategory(aqi) {
    if (aqi == null) return 'Unknown';
    if (aqi <= 50) return 'Good';
    if (aqi <= 100) return 'Moderate';
    if (aqi <= 150) return 'Unhealthy for Sensitive Groups';
    if (aqi <= 200) return 'Unhealthy';
    if (aqi <= 300) return 'Very Unhealthy';
    return 'Hazardous';
  }

  /**
   * Calculate moon illumination percentage from moon phase value
   * @param {number} moonphase - Moon phase value from 0 (new) to 1 (next new)
   * @returns {number} Illumination percentage (0-100)
   */
  calculateMoonIllumination(moonphase) {
    if (moonphase == null) return 0;
    const phase = Number(moonphase);
    
    // Phase cycle: 0 (new) -> 0.5 (full) -> 1 (new)
    // Illumination: 0% -> 100% -> 0%
    if (phase <= 0.5) {
      // Waxing: 0 to 0.5 maps to 0% to 100%
      return Math.round(phase * 2 * 100);
    } else {
      // Waning: 0.5 to 1 maps to 100% to 0%
      return Math.round((1 - phase) * 2 * 100);
    }
  }

  /**
   * Format time from 24-hour "HH:MM:SS" to 12-hour "H:MM AM/PM"
   * @param {string} timeStr - Time string in "HH:MM:SS" format
   * @returns {string} Formatted time in 12-hour format
   */
  formatTime12Hour(timeStr) {
    if (!timeStr) return '';
    
    // Parse time string (format: "07:08:18")
    const [hoursStr, minutesStr] = timeStr.split(':');
    const hours24 = parseInt(hoursStr, 10);
    const minutes = minutesStr.padStart(2, '0');
    
    // Convert to 12-hour format
    const period = hours24 >= 12 ? 'PM' : 'AM';
    const hours12 = hours24 % 12 || 12;
    
    return `${hours12}:${minutes} ${period}`;
  }

  /**
   * Convert Visual Crossing moon phase (0-1) to text description
   * @param {number} moonphase - Moon phase value from 0 (new) to 1 (next new)
   * @returns {string} Moon phase text description
   */
  convertMoonPhase(moonphase) {
    if (moonphase == null) return 'New Moon';
    const phase = Number(moonphase);
    
    if (phase === 0) return 'New Moon';
    if (phase < 0.25) return 'Waxing Crescent';
    if (phase === 0.25) return 'First Quarter';
    if (phase < 0.5) return 'Waxing Gibbous';
    if (phase === 0.5) return 'Full Moon';
    if (phase < 0.75) return 'Waning Gibbous';
    if (phase === 0.75) return 'Last Quarter';
    if (phase < 1) return 'Waning Crescent';
    return 'New Moon';
  }

  mapMoonPhase(phaseText) {
    const t = String(phaseText || '').toLowerCase();
    if (t.includes('new')) return { phase: 'new', direction: 'waxing' };
    if (t.includes('first')) return { phase: 'first_quarter', direction: 'waxing' };
    if (t.includes('full')) return { phase: 'full', direction: 'waning' };
    if (t.includes('last') || t.includes('third')) return { phase: 'last_quarter', direction: 'waning' };
    if (t.includes('waxing') && t.includes('crescent')) return { phase: 'waxing_crescent', direction: 'waxing' };
    if (t.includes('waning') && t.includes('crescent')) return { phase: 'waning_crescent', direction: 'waning' };
    if (t.includes('waxing') && t.includes('gibbous')) return { phase: 'waxing_gibbous', direction: 'waxing' };
    if (t.includes('waning') && t.includes('gibbous')) return { phase: 'waning_gibbous', direction: 'waning' };
    return { phase: 'new', direction: 'waxing' };
  }
}

module.exports = { WeatherService };
