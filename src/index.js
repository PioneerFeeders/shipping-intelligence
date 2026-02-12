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

const app = express();

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

// Manual trigger for tracking poll (useful for testing)
app.post('/admin/poll-tracking', async (req, res) => {
  try {
    const result = await pollAllUndelivered();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Root
app.get('/', (req, res) => {
  res.json({
    app: 'Pioneer Feeders Shipping Intelligence',
    version: '1.0.0',
    endpoints: {
      health: 'GET /health',
      webhook: 'POST /webhooks/shipstation',
      invoiceUpload: 'POST /invoices/upload',
      invoiceUnmatched: 'GET /invoices/unmatched',
      shipments: 'GET /api/shipments',
      orders: 'GET /api/orders',
      reconciliation: 'GET /api/reconciliation',
      stats: 'GET /api/stats',
      pollTracking: 'POST /admin/poll-tracking',
    },
  });
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
