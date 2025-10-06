const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');

/**
 * Security headers middleware using Helmet
 * Relaxed config for local-only dashboard
 */
function securityHeaders() {
  return helmet({
    contentSecurityPolicy: false, // Disabled for local dashboard
    crossOriginResourcePolicy: false,
    hsts: false, // Local dashboard - HTTP is fine
  });
}

/**
 * Correlation ID and request timing middleware
 */
function correlationAndTiming(req, res, next) {
  const corrId = req.headers['x-correlation-id'] || uuidv4();
  res.locals.corrId = corrId;
  res.setHeader('X-Correlation-Id', corrId);
  
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const end = process.hrtime.bigint();
    const ms = Number(end - start) / 1e6;
    console.log(`[${corrId}] ${req.method} ${req.originalUrl} -> ${res.statusCode} in ${ms.toFixed(1)}ms`);
  });
  
  // Safety timeout on responses
  res.setTimeout(60_000, () => {
    console.warn(`[${corrId}] Response timeout`);
    try { 
      res.status(504).json({ error: 'Gateway Timeout' }); 
    } catch (_) {}
  });
  
  next();
}

/**
 * Prevent caching for polling clients
 */
function noCacheHeaders(req, res, next) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
}

/**
 * Rate limiting middleware
 */
function rateLimiter() {
  return rateLimit({ 
    windowMs: 60 * 1000, 
    max: 60,
    message: { error: 'Too many requests' }
  });
}

/**
 * Apply all standard middleware to Express app
 */
function applyMiddleware(app) {
  app.use(morgan('dev'));
  app.use(securityHeaders());
  app.use(correlationAndTiming);
  app.use(rateLimiter());
  app.use(noCacheHeaders);
}

module.exports = {
  securityHeaders,
  correlationAndTiming,
  noCacheHeaders,
  rateLimiter,
  applyMiddleware,
};
