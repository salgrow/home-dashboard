#!/usr/bin/env node
/**
 * Test individual services - shows actual output
 * Usage: npm run test:service <service-name>
 * Services: weather, ambient, calendar, vehicle, llm
 */

require('dotenv').config();

const services = {
  weather: () => require('../services/weatherService').WeatherService,
  ambient: () => require('../services/ambientService').AmbientService,
  calendar: () => require('../services/calendarService').CalendarService,
  vehicle: () => require('../services/vehicleService').VehiclesService,
  llm: () => require('../services/llmService').LLMService,
};

const logger = {
  info: (msg) => console.log(`[INFO] ${msg}`),
  warn: (msg) => console.warn(`[WARN] ${msg}`),
  error: (msg) => console.error(`[ERROR] ${msg}`),
};

async function test() {
  const serviceName = process.argv[2];
  
  if (!serviceName) {
    console.error('Usage: node scripts/test-service.js <service-name>');
    console.error('Available services:', Object.keys(services).join(', '));
    process.exit(1);
  }
  
  if (!services[serviceName]) {
    console.error(`Unknown service: ${serviceName}`);
    console.error('Available services:', Object.keys(services).join(', '));
    process.exit(1);
  }
  
  console.log(`\n=== Testing ${serviceName} Service ===\n`);
  
  const ServiceClass = services[serviceName]();
  const service = new ServiceClass();
  
  console.log('Enabled:', service.isEnabled());
  console.log('\nFetching data...\n');
  
  try {
    const data = await service.getData({}, logger);
    console.log('Result:', JSON.stringify(data, null, 2));
    console.log('\n✅ Success\n');
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    if (error.stack) console.error(error.stack);
    process.exit(1);
  }
}

test();
