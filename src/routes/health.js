const express = require('express');
const router = express.Router();
const { healthCheck } = require('../config/database');

router.get('/', async (req, res) => {
  const dbHealth = await healthCheck();

  const status = dbHealth.status === 'ok' ? 200 : 503;

  res.status(status).json({
    app: 'Pioneer Feeders Shipping Intelligence',
    version: '1.0.0',
    status: dbHealth.status === 'ok' ? 'healthy' : 'unhealthy',
    database: dbHealth,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
