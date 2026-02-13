const express = require('express');
const config = require('./config/env');
const logger = require('./utils/logger');
const { migrate } = require('./db/migrate');
const { startTrackingPoller, pollAllUndelivered } = require('./jobs/tracking-poller');

// Import routes
const healthRoutes = require('./routes/health');
const webhookRoutes = require('./routes/webhooks');
const invoiceRoutes = require('./routes/invoices');
const apiRoutes = require('./routes/api');
const dashboardRoutes = require('./routes/dashboard');
const dashboardApiRoutes = require('./routes/dashboard-api');

const app = express();

// Cookie parser (simple implementation)
app.use((req, res, next) => {
  req.cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach(cookie => {
      const [name, ...rest] = cookie.trim().split('=');
      req.cookies[name.trim()] = decodeURIComponent(rest.join('='));
    });
  }
  // Add res.cookie helper
  if (!res.cookie) {
    res.cookie = function(name, value, opts = {}) {
      let cookie = `${name}=${encodeURIComponent(value)}`;
      if (opts.maxAge) cookie += `; Max-Age=${Math.floor(opts.maxAge / 1000)}`;
      if (opts.httpOnly) cookie += '; HttpOnly';
      if (opts.secure) cookie += '; Secure';
      if (opts.sameSite) cookie += `; SameSite=${opts.sameSite}`;
      cookie += '; Path=/';
      this.setHeader('Set-Cookie', cookie);
      return this;
    };
  }
  next();
});

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.path !== '/health') { // Don't log health checks
      logger.info({
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration,
      }, 'Request');
    }
  });
  next();
});

// Routes
app.use('/health', healthRoutes);
app.use('/webhooks', webhookRoutes);
app.use('/invoices', invoiceRoutes);
app.use('/api', apiRoutes);
app.use('/dashboard/api', dashboardApiRoutes);
app.use('/dashboard', dashboardRoutes);

// Manual trigger for tracking poll (useful for testing)
app.post('/admin/poll-tracking', async (req, res) => {
  try {
    const result = await pollAllUndelivered();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Root — redirect to dashboard
app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

// Error handler
app.use((err, req, res, next) => {
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
async function start() {
  try {
    // Run database migrations
    logger.info('Running database migrations...');
    await migrate();

    // Start Express server
    app.listen(config.port, '0.0.0.0', () => {
      logger.info({ port: config.port, env: config.nodeEnv }, 'Server started');
    });

    // Start cron jobs
    startTrackingPoller();

    logger.info('Shipping Intelligence Platform is running');
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

start();

module.exports = app;
