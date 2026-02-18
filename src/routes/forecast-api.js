const express = require('express');
const router = express.Router();
const neonDb = require('../config/neon');
const config = require('../config/env');
const logger = require('../utils/logger');

// Auth middleware (same as dashboard-api)
function requireAuth(req, res, next) {
  const token = req.cookies?.dashboard_token || req.headers['x-dashboard-token'];
  if (token === config.dashboardPassword) return next();
  res.status(401).json({ error: 'Unauthorized' });
}
router.use(requireAuth);

// ============================================================
// CONSTANTS
// ============================================================
const SHRINKAGE_PER_POUR = 76; // 40 food cups + 36 holdbacks
const SAFETY_BUFFER = 0.10;    // 10% overage
const CHEWY_SKU_CUP_MAP = {
  'HW25COUNT': 1,
  'HW50COUNT': 2,
  'HW75COUNT': 3,
  'HW100COUNT': 4,
  'SILKWORMS25CTCUP': 0,  // silkworm, tracked but not in HW forecast
  'SILKWORMS50CTCUP': 0,
  'SILKWORMS75CTCUP': 0,
  'SILKWORMS100CTCUP': 0,
};

// ============================================================
// FORECAST SUMMARY
// Combined demand across all channels + pour recommendation
// ============================================================
router.get('/summary', async (req, res) => {
  try {
    const now = new Date();
    const currentMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString().split('T')[0];
    const threeMonthsOut = new Date(now.getFullYear(), now.getMonth() + 3, 1).toISOString().split('T')[0];

    // 1. Chewy forecast for current + next 3 months
    const chewyResult = await neonDb.query(`
      SELECT forecast_month, SUM(physical_cups) as cups
      FROM demand_chewy_forecast
      WHERE forecast_month >= $1 AND forecast_month < $2
      GROUP BY forecast_month ORDER BY forecast_month
    `, [currentMonth, threeMonthsOut]);

    // 2. Amazon historical avg (last 6 months with data)
    const amazonResult = await neonDb.query(`
      SELECT AVG(units_sold) as avg_monthly_units
      FROM (
        SELECT units_sold FROM demand_amazon_monthly
        WHERE units_sold > 0 ORDER BY sales_month DESC LIMIT 6
      ) sub
    `);

    // 3. Shopify weekly avg (last 12 weeks)
    const shopifyResult = await neonDb.query(`
      SELECT AVG(hornworm_cups) as avg_weekly_cups,
             SUM(hornworm_cups) as total_12wk
      FROM (
        SELECT hornworm_cups FROM demand_shopify_weekly
        WHERE hornworm_cups > 0 ORDER BY week_start DESC LIMIT 12
      ) sub
    `);

    // 4. Recent pours (last 4 weeks)
    const pourResult = await neonDb.query(`
      SELECT SUM(sellable_cups) as total_poured,
             COUNT(*) as pour_count,
             MAX(pour_date) as last_pour
      FROM cup_pouring_log
      WHERE pour_date >= NOW() - INTERVAL '28 days'
    `);

    // Calculate monthly demand by channel
    const chewyMonthly = chewyResult.rows.reduce((acc, r) => {
      acc[r.forecast_month.toISOString().split('T')[0]] = parseInt(r.cups);
      return acc;
    }, {});

    const amazonAvgMonthly = Math.round(parseFloat(amazonResult.rows[0]?.avg_monthly_units || 0));
    const shopifyAvgWeekly = Math.round(parseFloat(shopifyResult.rows[0]?.avg_weekly_cups || 0));
    const shopifyAvgMonthly = shopifyAvgWeekly * 4.33;

    // Total monthly demand (current month)
    const chewyCurrentMonth = chewyMonthly[currentMonth] || 0;
    const totalMonthlyDemand = chewyCurrentMonth + amazonAvgMonthly + Math.round(shopifyAvgMonthly);

    // Weekly demand
    const weeklyDemand = Math.round(totalMonthlyDemand / 4.33);

    // Pour recommendation = weekly demand * (1 + safety) + shrinkage
    const pourRecommendation = Math.round(weeklyDemand * (1 + SAFETY_BUFFER)) + SHRINKAGE_PER_POUR;

    // Recent pour data
    const recentPoured = parseInt(pourResult.rows[0]?.total_poured || 0);
    const lastPour = pourResult.rows[0]?.last_pour;

    // Estimated weeks of inventory (rough: recent poured vs weekly demand)
    const weeksInventory = weeklyDemand > 0
      ? Math.round((recentPoured / weeklyDemand) * 10) / 10
      : 0;

    res.json({
      pourRecommendation,
      weeklyDemand,
      totalMonthlyDemand,
      weeksOfInventory: weeksInventory,
      safetyBuffer: SAFETY_BUFFER,
      shrinkage: SHRINKAGE_PER_POUR,
      channels: {
        chewy: { monthly: chewyCurrentMonth, source: 'vendor_forecast' },
        amazon: { monthly: amazonAvgMonthly, source: 'historical_avg' },
        shopify: { monthly: Math.round(shopifyAvgMonthly), weekly: shopifyAvgWeekly, source: 'historical_avg' },
      },
      chewyForecast: chewyMonthly,
      recentPours: {
        totalSellable: recentPoured,
        pourCount: parseInt(pourResult.rows[0]?.pour_count || 0),
        lastPour,
      },
    });
  } catch (err) {
    logger.error({ err }, 'Forecast summary error');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// CHEWY FORECAST DATA
// ============================================================
router.get('/chewy', async (req, res) => {
  try {
    const result = await neonDb.query(`
      SELECT forecast_month, sku, sku_units, cups_per_sku, physical_cups, ingested_at, source
      FROM demand_chewy_forecast
      ORDER BY forecast_month, sku
    `);

    // Also aggregate by month
    const monthly = await neonDb.query(`
      SELECT forecast_month, SUM(physical_cups) as total_cups, SUM(sku_units) as total_skus
      FROM demand_chewy_forecast
      GROUP BY forecast_month ORDER BY forecast_month
    `);

    res.json({ detail: result.rows, monthly: monthly.rows });
  } catch (err) {
    logger.error({ err }, 'Chewy forecast error');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// HISTORICAL DEMAND (Shopify + Amazon combined)
// ============================================================
router.get('/history', async (req, res) => {
  try {
    // Shopify weekly (last 12 months)
    const shopify = await neonDb.query(`
      SELECT week_start, hornworm_cups, silkworm_cups, total_orders, revenue
      FROM demand_shopify_weekly
      WHERE week_start >= NOW() - INTERVAL '12 months'
      ORDER BY week_start
    `);

    // Amazon monthly
    const amazon = await neonDb.query(`
      SELECT sales_month, units_sold, revenue, active_days
      FROM demand_amazon_monthly
      ORDER BY sales_month
    `);

    // Pouring log
    const pours = await neonDb.query(`
      SELECT pour_date, cups_24ct, cups_12ct, shrinkage, sellable_cups
      FROM cup_pouring_log
      ORDER BY pour_date
    `);

    res.json({
      shopify: shopify.rows,
      amazon: amazon.rows,
      pours: pours.rows,
    });
  } catch (err) {
    logger.error({ err }, 'Forecast history error');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POUR LOG
// ============================================================
router.get('/pour-log', async (req, res) => {
  try {
    const result = await neonDb.query(`
      SELECT pour_date, cups_24ct, cups_12ct, shrinkage, sellable_cups
      FROM cup_pouring_log
      ORDER BY pour_date DESC
      LIMIT 52
    `);
    res.json(result.rows);
  } catch (err) {
    logger.error({ err }, 'Pour log error');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// WEEKLY POUR PLANNER
// Next 4 Wednesdays with recommended pour counts
// ============================================================
router.get('/pour-planner', async (req, res) => {
  try {
    // Get demand by channel
    const now = new Date();
    const currentMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];

    const chewy = await neonDb.query(`
      SELECT forecast_month, SUM(physical_cups) as cups
      FROM demand_chewy_forecast
      WHERE forecast_month >= $1
      GROUP BY forecast_month ORDER BY forecast_month LIMIT 4
    `, [currentMonth]);

    const amazon = await neonDb.query(`
      SELECT AVG(units_sold) as avg FROM demand_amazon_monthly WHERE units_sold > 0
    `);

    const shopify = await neonDb.query(`
      SELECT AVG(hornworm_cups) as avg
      FROM (SELECT hornworm_cups FROM demand_shopify_weekly WHERE hornworm_cups > 0 ORDER BY week_start DESC LIMIT 12) s
    `);

    const amazonWeekly = Math.round(parseFloat(amazon.rows[0]?.avg || 0) / 4.33);
    const shopifyWeekly = Math.round(parseFloat(shopify.rows[0]?.avg || 0));

    // Build next 4 Wednesdays
    const wednesdays = [];
    let d = new Date(now);
    // Find next Wednesday
    const dayOfWeek = d.getDay();
    const daysUntilWed = (3 - dayOfWeek + 7) % 7 || 7;
    d.setDate(d.getDate() + daysUntilWed);

    for (let i = 0; i < 4; i++) {
      const wedDate = new Date(d);
      wedDate.setDate(d.getDate() + (i * 7));
      const monthKey = `${wedDate.getFullYear()}-${String(wedDate.getMonth()+1).padStart(2,'0')}-01`;
      const chewyMonth = chewy.rows.find(r => r.forecast_month.toISOString().split('T')[0] === monthKey);
      const chewyWeekly = chewyMonth ? Math.round(parseInt(chewyMonth.cups) / 4.33) : 0;

      const weeklyDemand = chewyWeekly + amazonWeekly + shopifyWeekly;
      const pourTarget = Math.round(weeklyDemand * (1 + SAFETY_BUFFER)) + SHRINKAGE_PER_POUR;

      wednesdays.push({
        date: wedDate.toISOString().split('T')[0],
        chewyDemand: chewyWeekly,
        amazonDemand: amazonWeekly,
        shopifyDemand: shopifyWeekly,
        totalDemand: weeklyDemand,
        pourTarget,
        shrinkage: SHRINKAGE_PER_POUR,
        safetyBuffer: Math.round(weeklyDemand * SAFETY_BUFFER),
      });
    }

    res.json({ wednesdays });
  } catch (err) {
    logger.error({ err }, 'Pour planner error');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// CHEWY FORECAST INGEST (from n8n or manual)
// POST body: { forecasts: [{ sku, month, units }] }
// ============================================================
router.post('/chewy-ingest', express.json(), async (req, res) => {
  try {
    const { forecasts } = req.body;
    if (!forecasts || !Array.isArray(forecasts)) {
      return res.status(400).json({ error: 'forecasts array required' });
    }

    let inserted = 0;
    for (const f of forecasts) {
      const cupsPerSku = CHEWY_SKU_CUP_MAP[f.sku] ?? 0;
      if (cupsPerSku === 0) continue; // skip silkworm for now

      const physicalCups = f.units * cupsPerSku;
      await neonDb.query(`
        INSERT INTO demand_chewy_forecast (forecast_month, sku, sku_units, cups_per_sku, physical_cups, source)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (forecast_month, sku)
        DO UPDATE SET sku_units = $3, physical_cups = $5, ingested_at = NOW(), source = $6
      `, [f.month, f.sku, f.units, cupsPerSku, physicalCups, f.source || 'api']);
      inserted++;
    }

    res.json({ success: true, inserted });
  } catch (err) {
    logger.error({ err }, 'Chewy ingest error');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// AMAZON CSV UPLOAD
// POST body: { months: [{ month, units, revenue, active_days }] }
// ============================================================
router.post('/amazon-upload', express.json(), async (req, res) => {
  try {
    const { months } = req.body;
    if (!months || !Array.isArray(months)) {
      return res.status(400).json({ error: 'months array required' });
    }

    let inserted = 0;
    for (const m of months) {
      await neonDb.query(`
        INSERT INTO demand_amazon_monthly (sales_month, units_sold, revenue, active_days)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (sales_month)
        DO UPDATE SET units_sold = $2, revenue = $3, active_days = $4, uploaded_at = NOW()
      `, [m.month, m.units, m.revenue, m.active_days || 0]);
      inserted++;
    }

    res.json({ success: true, inserted });
  } catch (err) {
    logger.error({ err }, 'Amazon upload error');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SHOPIFY BACKFILL
// Pulls 12 months of Shopify orders, aggregates weekly cups
// ============================================================
router.post('/shopify-backfill', async (req, res) => {
  try {
    const axios = require('axios');
    const { shopifyLimiter } = require('../utils/rate-limiter');

    const baseURL = `https://${config.shopify.storeUrl}/admin/api/${config.shopify.apiVersion}`;
    const headers = {
      'X-Shopify-Access-Token': config.shopify.accessToken,
      'Content-Type': 'application/json',
    };

    // Pull last 12 months
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 12);
    const startStr = startDate.toISOString().split('T')[0];

    let allOrders = [];
    let url = `${baseURL}/orders.json?status=any&created_at_min=${startStr}T00:00:00Z&limit=250&fields=id,created_at,line_items,tags`;

    while (url) {
      await shopifyLimiter.wait();
      try {
        const response = await axios.get(url, { headers, timeout: 30000 });
        allOrders = allOrders.concat(response.data.orders || []);
        const linkHeader = response.headers['link'];
        if (linkHeader && linkHeader.includes('rel="next"')) {
          const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
          url = match ? match[1] : null;
        } else {
          url = null;
        }
      } catch (err) {
        logger.error({ err }, 'Shopify backfill fetch error');
        break;
      }
    }

    logger.info({ orderCount: allOrders.length }, 'Shopify backfill: fetched orders');

    // Process orders into weekly cup counts
    // We need product tags to identify hornworm cups
    const productTagCache = new Map();

    async function getProductTags(productId) {
      if (!productId) return [];
      if (productTagCache.has(productId)) return productTagCache.get(productId);
      await shopifyLimiter.wait();
      try {
        const resp = await axios.get(`${baseURL}/products/${productId}.json?fields=tags`, { headers, timeout: 10000 });
        const tags = (resp.data.product?.tags || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
        productTagCache.set(productId, tags);
        return tags;
      } catch {
        productTagCache.set(productId, []);
        return [];
      }
    }

    // Aggregate by week (Monday start)
    const weeklyData = {};

    for (const order of allOrders) {
      const orderDate = new Date(order.created_at);
      // Get Monday of that week
      const day = orderDate.getDay();
      const diff = day === 0 ? 6 : day - 1;
      const monday = new Date(orderDate);
      monday.setDate(orderDate.getDate() - diff);
      const weekKey = monday.toISOString().split('T')[0];

      if (!weeklyData[weekKey]) {
        weeklyData[weekKey] = { hornworm: 0, silkworm: 0, orders: 0, revenue: 0 };
      }

      weeklyData[weekKey].orders++;
      const orderTags = (order.tags || '').toLowerCase();

      for (const item of (order.line_items || [])) {
        const qty = item.quantity || 0;
        const price = parseFloat(item.price || 0) * qty;
        weeklyData[weekKey].revenue += price;

        // Check product tags
        const tags = await getProductTags(item.product_id);
        const allTags = [...tags, ...orderTags.split(',').map(t => t.trim())];

        const isHornworm = allTags.some(t => t.includes('hornworm'));
        const isSilkworm = allTags.some(t => t.includes('silkworm'));
        const isCup = allTags.some(t => t.includes('cup'));

        if (isCup || item.title?.toLowerCase().includes('cup')) {
          if (isHornworm || item.title?.toLowerCase().includes('hornworm')) {
            weeklyData[weekKey].hornworm += qty;
          } else if (isSilkworm || item.title?.toLowerCase().includes('silkworm')) {
            weeklyData[weekKey].silkworm += qty;
          }
        }
      }
    }

    // Upsert into database
    let inserted = 0;
    for (const [weekStart, data] of Object.entries(weeklyData)) {
      await neonDb.query(`
        INSERT INTO demand_shopify_weekly (week_start, hornworm_cups, silkworm_cups, total_orders, revenue)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (week_start)
        DO UPDATE SET hornworm_cups = $2, silkworm_cups = $3, total_orders = $4, revenue = $5, refreshed_at = NOW()
      `, [weekStart, data.hornworm, data.silkworm, data.orders, data.revenue]);
      inserted++;
    }

    res.json({ success: true, ordersProcessed: allOrders.length, weeksInserted: inserted });
  } catch (err) {
    logger.error({ err }, 'Shopify backfill error');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POUR LOG SYNC (from Google Sheet data)
// POST body: { pours: [{ date, cups_24ct, cups_12ct }] }
// ============================================================
router.post('/pour-sync', express.json(), async (req, res) => {
  try {
    const { pours } = req.body;
    if (!pours || !Array.isArray(pours)) {
      return res.status(400).json({ error: 'pours array required' });
    }

    let inserted = 0;
    for (const p of pours) {
      const cups24 = parseInt(p.cups_24ct) || 0;
      const cups12 = parseInt(p.cups_12ct) || 0;
      await neonDb.query(`
        INSERT INTO cup_pouring_log (pour_date, cups_24ct, cups_12ct)
        VALUES ($1, $2, $3)
        ON CONFLICT (pour_date)
        DO UPDATE SET cups_24ct = $2, cups_12ct = $3, logged_at = NOW()
      `, [p.date, cups24, cups12]);
      inserted++;
    }

    res.json({ success: true, inserted });
  } catch (err) {
    logger.error({ err }, 'Pour sync error');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// RUN MIGRATION (creates tables if not exist)
// ============================================================
router.post('/migrate', async (req, res) => {
  try {
    await neonDb.query(`
      CREATE TABLE IF NOT EXISTS demand_chewy_forecast (
        id SERIAL PRIMARY KEY,
        forecast_month DATE NOT NULL,
        sku VARCHAR(30) NOT NULL,
        sku_units INTEGER NOT NULL DEFAULT 0,
        cups_per_sku INTEGER NOT NULL DEFAULT 1,
        physical_cups INTEGER NOT NULL DEFAULT 0,
        ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        source VARCHAR(50) DEFAULT 'manual',
        UNIQUE(forecast_month, sku)
      )
    `);
    await neonDb.query(`
      CREATE TABLE IF NOT EXISTS demand_amazon_monthly (
        id SERIAL PRIMARY KEY,
        sales_month DATE NOT NULL,
        units_sold INTEGER NOT NULL DEFAULT 0,
        revenue NUMERIC(12,2) NOT NULL DEFAULT 0,
        active_days INTEGER NOT NULL DEFAULT 0,
        uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(sales_month)
      )
    `);
    await neonDb.query(`
      CREATE TABLE IF NOT EXISTS demand_shopify_weekly (
        id SERIAL PRIMARY KEY,
        week_start DATE NOT NULL,
        hornworm_cups INTEGER NOT NULL DEFAULT 0,
        silkworm_cups INTEGER NOT NULL DEFAULT 0,
        total_orders INTEGER NOT NULL DEFAULT 0,
        revenue NUMERIC(12,2) NOT NULL DEFAULT 0,
        refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(week_start)
      )
    `);
    await neonDb.query(`
      CREATE TABLE IF NOT EXISTS cup_pouring_log (
        id SERIAL PRIMARY KEY,
        pour_date DATE NOT NULL,
        cups_24ct INTEGER NOT NULL DEFAULT 0,
        cups_12ct INTEGER NOT NULL DEFAULT 0,
        shrinkage INTEGER NOT NULL DEFAULT 76,
        sellable_cups INTEGER GENERATED ALWAYS AS (GREATEST(cups_24ct + cups_12ct - 76, 0)) STORED,
        logged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(pour_date)
      )
    `);

    // Indexes
    await neonDb.query(`CREATE INDEX IF NOT EXISTS idx_chewy_forecast_month ON demand_chewy_forecast(forecast_month)`);
    await neonDb.query(`CREATE INDEX IF NOT EXISTS idx_amazon_month ON demand_amazon_monthly(sales_month)`);
    await neonDb.query(`CREATE INDEX IF NOT EXISTS idx_shopify_week ON demand_shopify_weekly(week_start)`);
    await neonDb.query(`CREATE INDEX IF NOT EXISTS idx_pour_date ON cup_pouring_log(pour_date)`);

    res.json({ success: true, message: 'All forecast tables created' });
  } catch (err) {
    logger.error({ err }, 'Migration error');
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
