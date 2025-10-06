const express = require('express');
require('dotenv').config();
const fs = require('fs');
const { AUTH_PATH } = require('./lib/paths');
const { applyMiddleware } = require('./lib/middleware');
const { isAuthed } = require('./services/calendarService');
const adminRoutes = require('./routes/admin');
const dashboardRoutes = require('./routes/dashboard');

const app = express();
const PORT = process.env.PORT || 7272;
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', './views');

// Static file serving
app.use('/styles', express.static('views/styles', {
  setHeaders: (res, path) => {
    if (path.endsWith('.otf') || path.endsWith('.ttf') || path.endsWith('.woff') || path.endsWith('.woff2')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=31536000');
    }
  }
}));

app.use('/assets', express.static('views/assets', {
  setHeaders: (res, path) => {
    if (path.endsWith('.png') || path.endsWith('.jpg') || path.endsWith('.jpeg') || path.endsWith('.svg')) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  }
}));

// Body parsing
app.use(express.json());

// Apply all standard middleware
applyMiddleware(app);

// Mount route modules
app.use('/', adminRoutes);
app.use('/', dashboardRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  const baseUrl = `http://localhost:${PORT}`;
  console.log(`Server listening on ${baseUrl}`);
  console.log(`Network access: http://0.0.0.0:${PORT}`);
  
  console.log(`Dashboard page: ${baseUrl}/dashboard`);
  console.log(`Admin page: ${baseUrl}/admin`);
});

module.exports = app; // For testing
