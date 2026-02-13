const express = require('express');
const router = express.Router();
const db = require('../config/database');
const neonDb = require('../config/neon');
const shopifyService = require('../services/shopify');
const logger = require('../utils/logger');
const config = require('../config/env');

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
function requireAuth(req, res, next) {
  const token = req.cookies?.dashboard_token || req.headers['x-dashboard-token'];
  if (token === config.dashboardPassword) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

router.post('/auth', express.json(), (req, res) => {
  const { password } = req.body;
  if (password === config.dashboardPassword) {
    res.cookie('dashboard_token', password, {
      httpOnly: true,
      secure: config.nodeEnv === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      sameSite: 'strict',
    });
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Invalid password' });
});

router.use(requireAuth);

// ============================================================
// SHIPPING STATS
// ============================================================
router.get('/shipping/summary', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    let where = ['s.is_voided = FALSE'];
    let params = [];
    let idx = 1;

    if (start_date) { where.push(`s.ship_date >= $${idx++}`); params.push(start_date); }
    if (end_date) { where.push(`s.ship_date <= $${idx++}`); params.push(end_date); }

    const wc = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { rows } = await db.query(`
      SELECT
        COUNT(*) as total_shipments,
        COUNT(DISTINCT s.order_id) as total_orders,
        COALESCE(SUM(s.label_cost), 0) as total_label_cost,
        COALESCE(SUM(s.split_revenue), 0) as total_revenue,
        COALESCE(SUM(s.split_cogs), 0) as total_cogs,
        COALESCE(SUM(s.split_shipping_paid), 0) as total_shipping_paid,
        COUNT(CASE WHEN s.delivery_status = 'delivered' THEN 1 END) as delivered,
        COUNT(CASE WHEN s.delivery_status = 'in_transit' THEN 1 END) as in_transit,
        COUNT(CASE WHEN s.delivery_status = 'pending' THEN 1 END) as pending,
        COUNT(CASE WHEN s.delivery_status = 'exception' THEN 1 END) as exceptions,
        COUNT(CASE WHEN s.is_late = TRUE THEN 1 END) as late_deliveries,
        COALESCE(AVG(s.label_cost), 0) as avg_label_cost
      FROM shipments s
      ${wc}
    `, params);

    res.json(rows[0]);
  } catch (err) {
    logger.error({ err }, 'Dashboard: shipping summary error');
    res.status(500).json({ error: err.message });
  }
});

router.get('/shipping/daily', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    let where = ['s.is_voided = FALSE'];
    let params = [];
    let idx = 1;

    if (start_date) { where.push(`s.ship_date >= $${idx++}`); params.push(start_date); }
    if (end_date) { where.push(`s.ship_date <= $${idx++}`); params.push(end_date); }

    const wc = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { rows } = await db.query(`
      SELECT
        DATE(s.ship_date) as date,
        COUNT(*) as shipments,
        COALESCE(SUM(s.label_cost), 0) as label_cost,
        COALESCE(SUM(s.split_revenue), 0) as revenue,
        COUNT(DISTINCT s.order_id) as orders
      FROM shipments s
      ${wc}
      GROUP BY DATE(s.ship_date)
      ORDER BY date
    `, params);

    res.json(rows);
  } catch (err) {
    logger.error({ err }, 'Dashboard: shipping daily error');
    res.status(500).json({ error: err.message });
  }
});

router.get('/shipping/by-service', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    let where = ['s.is_voided = FALSE'];
    let params = [];
    let idx = 1;

    if (start_date) { where.push(`s.ship_date >= $${idx++}`); params.push(start_date); }
    if (end_date) { where.push(`s.ship_date <= $${idx++}`); params.push(end_date); }

    const wc = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { rows } = await db.query(`
      SELECT
        s.service_code,
        COUNT(*) as shipments,
        COALESCE(SUM(s.label_cost), 0) as total_cost,
        COALESCE(AVG(s.label_cost), 0) as avg_cost
      FROM shipments s
      ${wc}
      GROUP BY s.service_code
      ORDER BY shipments DESC
    `, params);

    res.json(rows);
  } catch (err) {
    logger.error({ err }, 'Dashboard: shipping by service error');
    res.status(500).json({ error: err.message });
  }
});

router.get('/shipping/by-state', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    let where = ['s.is_voided = FALSE', 's.ship_to_state IS NOT NULL'];
    let params = [];
    let idx = 1;

    if (start_date) { where.push(`s.ship_date >= $${idx++}`); params.push(start_date); }
    if (end_date) { where.push(`s.ship_date <= $${idx++}`); params.push(end_date); }

    const wc = `WHERE ${where.join(' AND ')}`;

    const { rows } = await db.query(`
      SELECT
        s.ship_to_state as state,
        COUNT(*) as shipments,
        COALESCE(SUM(s.label_cost), 0) as total_cost
      FROM shipments s
      ${wc}
      GROUP BY s.ship_to_state
      ORDER BY shipments DESC
    `, params);

    res.json(rows);
  } catch (err) {
    logger.error({ err }, 'Dashboard: shipping by state error');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SHOPIFY SALES
// ============================================================
router.get('/sales/summary', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    if (!start_date || !end_date) {
      return res.status(400).json({ error: 'start_date and end_date required' });
    }

    // Fetch orders from Shopify with date filter
    const orders = await fetchShopifyOrders(start_date, end_date);

    // Process tag-based analytics
    const analytics = processOrderAnalytics(orders);
    res.json(analytics);
  } catch (err) {
    logger.error({ err }, 'Dashboard: sales summary error');
    res.status(500).json({ error: err.message });
  }
});

router.get('/sales/daily', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    if (!start_date || !end_date) {
      return res.status(400).json({ error: 'start_date and end_date required' });
    }

    const orders = await fetchShopifyOrders(start_date, end_date);
    const daily = processDailySales(orders);
    res.json(daily);
  } catch (err) {
    logger.error({ err }, 'Dashboard: sales daily error');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// BREEDING STATS (Neon DB)
// ============================================================
router.get('/breeding/eggs', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    let where = [];
    let params = [];
    let idx = 1;

    if (start_date) { where.push(`collection_date >= $${idx++}`); params.push(start_date); }
    if (end_date) { where.push(`collection_date <= $${idx++}`); params.push(end_date); }

    const wc = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { rows } = await neonDb.query(`
      SELECT
        collection_date::date as date,
        SUM(weight_grams::numeric) as total_weight,
        SUM(egg_count) as total_eggs
      FROM egg_collections
      ${wc}
      GROUP BY collection_date::date
      ORDER BY date
    `, params);

    // Also get summary
    const { rows: summary } = await neonDb.query(`
      SELECT
        COUNT(*) as total_collections,
        COALESCE(SUM(weight_grams::numeric), 0) as total_weight,
        COALESCE(SUM(egg_count), 0) as total_eggs,
        COALESCE(AVG(weight_grams::numeric), 0) as avg_weight,
        COALESCE(AVG(egg_count), 0) as avg_eggs
      FROM egg_collections
      ${wc}
    `, params);

    res.json({ daily: rows, summary: summary[0] });
  } catch (err) {
    logger.error({ err }, 'Dashboard: breeding eggs error');
    res.status(500).json({ error: err.message });
  }
});

router.get('/breeding/prepupae', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    let where = [];
    let params = [];
    let idx = 1;

    if (start_date) { where.push(`date >= $${idx++}`); params.push(start_date); }
    if (end_date) { where.push(`date <= $${idx++}`); params.push(end_date); }

    const wc = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // Daily totals
    const { rows: daily } = await neonDb.query(`
      SELECT
        date::date as date,
        SUM(count) as total_collected,
        SUM(COALESCE(dead_count, 0)) as total_dead,
        SUM(count) - SUM(COALESCE(dead_count, 0)) as total_alive,
        CASE WHEN SUM(count) > 0 
          THEN ROUND(SUM(COALESCE(dead_count, 0))::numeric / SUM(count) * 100, 1)
          ELSE 0 END as mortality_rate
      FROM collection_entries
      ${wc}
      GROUP BY date::date
      ORDER BY date
    `, params);

    // By shelf mortality
    const { rows: byShelf } = await neonDb.query(`
      SELECT
        shelf_number,
        SUM(count) as total_collected,
        SUM(COALESCE(dead_count, 0)) as total_dead,
        CASE WHEN SUM(count) > 0 
          THEN ROUND(SUM(COALESCE(dead_count, 0))::numeric / SUM(count) * 100, 1)
          ELSE 0 END as mortality_rate,
        COUNT(*) as collection_count
      FROM collection_entries
      ${wc}
      GROUP BY shelf_number
      ORDER BY shelf_number
    `, params);

    // Summary
    const { rows: summary } = await neonDb.query(`
      SELECT
        COUNT(*) as total_entries,
        COALESCE(SUM(count), 0) as total_collected,
        COALESCE(SUM(COALESCE(dead_count, 0)), 0) as total_dead,
        CASE WHEN SUM(count) > 0 
          THEN ROUND(SUM(COALESCE(dead_count, 0))::numeric / SUM(count) * 100, 1)
          ELSE 0 END as mortality_rate
      FROM collection_entries
      ${wc}
    `, params);

    res.json({ daily, byShelf, summary: summary[0] });
  } catch (err) {
    logger.error({ err }, 'Dashboard: breeding prepupae error');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// EGG PRODUCTION PREDICTION MODEL
// ============================================================

/**
 * Egg production curve per female moth.
 * Night 1-2 after emergence: mating (0 eggs)
 * Night 3: egg laying begins
 * Night 8: peak
 * Night 12: 85% produced
 * Night 15: moth dies
 * 
 * We model this as a gamma-like distribution.
 * Total = 750 eggs per female.
 */
function getEggCurve() {
  // Relative weights for each night after emergence (nights 1-15)
  // Night 1-2: mating, no eggs
  // Night 3: laying begins
  // Night 8: peak
  // Night 12: ~85% cumulative
  // Night 15: done
  const rawWeights = [
    0,      // night 1 (mating)
    0,      // night 2 (mating peak)
    0.02,   // night 3 (laying begins)
    0.04,   // night 4
    0.07,   // night 5
    0.10,   // night 6
    0.13,   // night 7
    0.15,   // night 8 (peak)
    0.14,   // night 9
    0.12,   // night 10
    0.09,   // night 11
    0.06,   // night 12 (85% cumulative reached)
    0.04,   // night 13
    0.03,   // night 14
    0.01,   // night 15 (moth dies)
  ];

  // Normalize to sum to 1.0
  const total = rawWeights.reduce((a, b) => a + b, 0);
  return rawWeights.map(w => w / total);
}

const EGG_CURVE = getEggCurve();
const EGGS_PER_FEMALE = 750;
const PRE_EMERGENCE_MORTALITY = 0.10;  // 10% die before emerging
const FEMALE_RATIO = 0.50;
// Emergence spread: 33% on day 4, 33% day 5, 33% day 6 after harvest
const EMERGENCE_DAYS = [
  { dayOffset: 4, fraction: 0.33 },
  { dayOffset: 5, fraction: 0.34 },
  { dayOffset: 6, fraction: 0.33 },
];

/**
 * Normalize any date value (Date object, string, etc) to YYYY-MM-DD string.
 * Handles Postgres date objects, ISO strings, and JS Date objects.
 */
function normDate(d) {
  if (!d) return null;
  if (typeof d === 'string') {
    // Already a string — take first 10 chars (YYYY-MM-DD)
    if (d.length >= 10) return d.substring(0, 10);
    return d;
  }
  if (d instanceof Date) {
    // Use UTC to avoid timezone shifts
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  // Fallback: try converting
  return new Date(d).toISOString().split('T')[0];
}

router.get('/breeding/egg-prediction', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    if (!start_date || !end_date) {
      return res.status(400).json({ error: 'start_date and end_date required' });
    }

    // We need pre-pupae data from 25 days before start_date
    // because harvests from ~20 days prior still produce eggs in our window
    const lookbackDate = new Date(start_date);
    lookbackDate.setDate(lookbackDate.getDate() - 25);
    const lookbackStr = lookbackDate.toISOString().split('T')[0];

    // Also look ahead: harvests during our window produce eggs after end_date
    // but we want to show predictions within our window
    const { rows: prepupaeData } = await neonDb.query(`
      SELECT
        date::date as date,
        SUM(count) as total_collected,
        SUM(COALESCE(dead_count, 0)) as total_dead
      FROM collection_entries
      WHERE date >= $1 AND date <= $2
      GROUP BY date::date
      ORDER BY date
    `, [lookbackStr, end_date]);

    // Get actual egg data for comparison
    const { rows: actualEggs } = await neonDb.query(`
      SELECT
        collection_date::date as date,
        SUM(egg_count) as total_eggs,
        SUM(weight_grams::numeric) as total_weight
      FROM egg_collections
      WHERE collection_date >= $1 AND collection_date <= $2
      GROUP BY collection_date::date
      ORDER BY date
    `, [start_date, end_date]);

    // Build prediction: for each day's harvest, distribute eggs across future days
    const predictedByDate = {};

    for (const harvest of prepupaeData) {
      const harvestDate = new Date(harvest.date);
      const alive = parseInt(harvest.total_collected) - parseInt(harvest.total_dead);
      if (alive <= 0) continue;

      const surviving = alive * (1 - PRE_EMERGENCE_MORTALITY);
      const females = surviving * FEMALE_RATIO;

      // For each emergence day spread
      for (const emergence of EMERGENCE_DAYS) {
        const femalesEmerging = females * emergence.fraction;
        if (femalesEmerging < 1) continue;

        const emergenceDate = new Date(harvestDate);
        emergenceDate.setDate(emergenceDate.getDate() + emergence.dayOffset);

        // Distribute eggs across the 15 nights after emergence
        for (let night = 0; night < EGG_CURVE.length; night++) {
          const eggDate = new Date(emergenceDate);
          eggDate.setDate(eggDate.getDate() + night + 1);

          const dateStr = normDate(eggDate);

          // Only include dates within our display window
          if (dateStr >= start_date && dateStr <= end_date) {
            const eggsToday = femalesEmerging * EGGS_PER_FEMALE * EGG_CURVE[night];
            predictedByDate[dateStr] = (predictedByDate[dateStr] || 0) + eggsToday;
          }
        }
      }
    }

    // Build actual eggs map — normalize date keys
    const actualByDate = {};
    for (const row of actualEggs) {
      const key = normDate(row.date);
      actualByDate[key] = {
        eggs: parseInt(row.total_eggs),
        weight: parseFloat(row.total_weight),
      };
    }

    // Merge into a single timeline — fill all dates in range
    const allDates = [];
    const current = new Date(start_date);
    const endD = new Date(end_date);
    while (current <= endD) {
      allDates.push(normDate(current));
      current.setDate(current.getDate() + 1);
    }

    // Build raw timeline first
    const rawTimeline = allDates.map(date => ({
      date,
      predicted: Math.round(predictedByDate[date] || 0),
      actual: actualByDate[date]?.eggs || 0,
      actualWeight: actualByDate[date]?.weight || 0,
      isReal: !!(actualByDate[date]?.eggs), // true if there was a real collection
    }));

    // Interpolation: distribute collection-day totals evenly across preceding skipped days
    // Walk forward, tracking skipped days. When we hit a real collection, 
    // split it evenly across (skipped_count + 1) days.
    const timeline = [...rawTimeline];
    let skippedStart = null; // index of first skipped day in current run

    for (let i = 0; i < timeline.length; i++) {
      if (timeline[i].isReal && timeline[i].actual > 0) {
        // Real collection day — check if there were skipped days before it
        if (skippedStart !== null) {
          const totalDays = i - skippedStart + 1; // skipped days + this collection day
          const perDay = Math.round(timeline[i].actual / totalDays);

          // Distribute evenly to skipped days (mark as interpolated)
          for (let j = skippedStart; j < i; j++) {
            timeline[j].actual = perDay;
            timeline[j].isReal = false;
            timeline[j].isInterpolated = true;
          }
          // Adjust the collection day itself to the same even share
          timeline[i].actual = perDay;
          timeline[i].isInterpolated = false;
        }
        skippedStart = null;
      } else {
        // No collection this day
        if (skippedStart === null) skippedStart = i;
      }
    }

    // Summary stats — use the interpolated actuals for comparison
    const totalPredicted = timeline.reduce((s, d) => s + d.predicted, 0);
    const totalActual = timeline.reduce((s, d) => s + d.actual, 0);
    const accuracy = totalPredicted > 0 ? ((totalActual / totalPredicted) * 100).toFixed(1) : null;

    res.json({
      timeline,
      summary: {
        totalPredicted,
        totalActual,
        accuracy,
        variance: totalActual - totalPredicted,
        variancePct: totalPredicted > 0 ? (((totalActual - totalPredicted) / totalPredicted) * 100).toFixed(1) : null,
      },
      model: {
        eggsPerFemale: EGGS_PER_FEMALE,
        preEmergenceMortality: PRE_EMERGENCE_MORTALITY,
        femaleRatio: FEMALE_RATIO,
        emergenceDayOffset: '4-6',
        eggLayingCurve: 'gamma-like, peaks night 8, 85% by night 12',
      },
    });
  } catch (err) {
    logger.error({ err }, 'Dashboard: egg prediction error');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SHOPIFY HELPERS
// ============================================================

/**
 * Fetch all orders from Shopify for a date range.
 * Uses pagination to get all orders.
 */
async function fetchShopifyOrders(startDate, endDate) {
  const axios = require('axios');
  const { shopifyLimiter } = require('../utils/rate-limiter');

  const baseURL = `https://${config.shopify.storeUrl}/admin/api/${config.shopify.apiVersion}`;
  const headers = {
    'X-Shopify-Access-Token': config.shopify.accessToken,
    'Content-Type': 'application/json',
  };

  let allOrders = [];
  let url = `${baseURL}/orders.json?status=any&created_at_min=${startDate}T00:00:00Z&created_at_max=${endDate}T23:59:59Z&limit=250&fields=id,name,created_at,line_items,shipping_lines,total_price,customer,tags,source_name`;

  while (url) {
    await shopifyLimiter.wait();
    try {
      const response = await axios.get(url, { headers, timeout: 30000 });
      const orders = response.data.orders || [];
      allOrders = allOrders.concat(orders);

      // Check for pagination
      const linkHeader = response.headers['link'];
      if (linkHeader && linkHeader.includes('rel="next"')) {
        const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        url = match ? match[1] : null;
      } else {
        url = null;
      }
    } catch (err) {
      logger.error({ err }, 'Failed to fetch Shopify orders for dashboard');
      break;
    }
  }

  logger.info({ count: allOrders.length, startDate, endDate }, 'Fetched Shopify orders for dashboard');
  return allOrders;
}

/**
 * Extract product tags from line items.
 * Shopify order line_items don't include product tags directly,
 * so we cache product tag lookups.
 */
const productTagCache = new Map();

async function getProductTags(productId) {
  if (!productId) return [];
  if (productTagCache.has(productId)) return productTagCache.get(productId);

  const axios = require('axios');
  const { shopifyLimiter } = require('../utils/rate-limiter');

  try {
    await shopifyLimiter.wait();
    const baseURL = `https://${config.shopify.storeUrl}/admin/api/${config.shopify.apiVersion}`;
    const response = await axios.get(`${baseURL}/products/${productId}.json?fields=tags`, {
      headers: {
        'X-Shopify-Access-Token': config.shopify.accessToken,
      },
      timeout: 10000,
    });

    const tags = (response.data.product?.tags || '')
      .split(',')
      .map(t => t.trim().toLowerCase())
      .filter(Boolean);

    productTagCache.set(productId, tags);
    return tags;
  } catch (err) {
    logger.warn({ productId, err: err.message }, 'Failed to fetch product tags');
    productTagCache.set(productId, []);
    return [];
  }
}

/**
 * Process order analytics using product tags.
 */
async function processOrderAnalytics(orders) {
  const result = {
    totalOrders: orders.length,
    totalRevenue: 0,
    totalShippingPaid: 0,
    byChannel: {},
    byTier: { 'tier-retail': { orders: 0, revenue: 0, cups: 0 }, 'tier-wholesale': { orders: 0, revenue: 0, cups: 0 } },
    byProductType: {},
    cupsSold: { hornworm: 0, silkworm: 0, waxworm: 0, other: 0, total: 0 },
    supplyBreakdown: {},
  };

  // Collect all unique product IDs first, then batch fetch tags
  const productIds = new Set();
  for (const order of orders) {
    for (const item of order.line_items || []) {
      if (item.product_id) productIds.add(item.product_id);
    }
  }

  // Pre-fetch all product tags
  const tagPromises = [];
  for (const pid of productIds) {
    tagPromises.push(getProductTags(pid));
  }
  await Promise.all(tagPromises);

  // Now process each order
  for (const order of orders) {
    const orderRevenue = parseFloat(order.total_price || 0);
    result.totalRevenue += orderRevenue;

    const shippingPaid = (order.shipping_lines || []).reduce((sum, l) => sum + parseFloat(l.price || 0), 0);
    result.totalShippingPaid += shippingPaid;

    // Track channels and tiers at order level
    const orderChannels = new Set();
    const orderTiers = new Set();

    for (const item of order.line_items || []) {
      const tags = productTagCache.get(item.product_id) || [];
      const qty = item.quantity || 1;
      const lineRevenue = parseFloat(item.price || 0) * qty;

      // Determine channel
      const channel = getChannel(tags);
      orderChannels.add(channel);

      // Determine tier
      const tier = tags.includes('tier-wholesale') ? 'tier-wholesale' : 'tier-retail';
      orderTiers.add(tier);

      // Channel breakdown
      if (!result.byChannel[channel]) {
        result.byChannel[channel] = { orders: 0, revenue: 0, cups: 0, items: 0 };
      }
      result.byChannel[channel].revenue += lineRevenue;
      result.byChannel[channel].items += qty;

      // Cup counting
      const cupCount = getCupCount(tags);
      const productType = getProductType(tags);

      if (cupCount > 0 && productType) {
        const totalCups = qty * cupCount;

        result.byChannel[channel].cups += totalCups;

        // By product type
        if (!result.byProductType[productType]) {
          result.byProductType[productType] = { cups: 0, revenue: 0, orders: 0 };
        }
        result.byProductType[productType].cups += totalCups;
        result.byProductType[productType].revenue += lineRevenue;

        // Cup totals
        if (productType === 'hornworm-cup') result.cupsSold.hornworm += totalCups;
        else if (productType === 'silkworm-cup') result.cupsSold.silkworm += totalCups;
        else if (productType === 'waxworm-cup') result.cupsSold.waxworm += totalCups;
        else result.cupsSold.other += totalCups;
        result.cupsSold.total += totalCups;
      }

      // Supply breakdown
      if (tags.includes('supply')) {
        const supplyType = getSupplyType(tags);
        if (!result.supplyBreakdown[supplyType]) {
          result.supplyBreakdown[supplyType] = { revenue: 0, items: 0, cups: 0 };
        }
        result.supplyBreakdown[supplyType].revenue += lineRevenue;
        result.supplyBreakdown[supplyType].items += qty;
        if (cupCount > 0) {
          result.supplyBreakdown[supplyType].cups += qty * cupCount;
        }
      }
    }

    // Count orders per channel (order level)
    for (const ch of orderChannels) {
      if (result.byChannel[ch]) result.byChannel[ch].orders++;
    }

    // Count orders per tier
    for (const tier of orderTiers) {
      if (result.byTier[tier]) {
        result.byTier[tier].orders++;
      }
    }
  }

  // Calculate tier revenue from channels
  for (const [channel, data] of Object.entries(result.byChannel)) {
    if (channel === 'wholesale') {
      result.byTier['tier-wholesale'].revenue += data.revenue;
      result.byTier['tier-wholesale'].cups += data.cups;
    } else {
      result.byTier['tier-retail'].revenue += data.revenue;
      result.byTier['tier-retail'].cups += data.cups;
    }
  }

  return result;
}

/**
 * Process daily sales breakdown.
 */
async function processDailySales(orders) {
  // Pre-fetch all product tags
  const productIds = new Set();
  for (const order of orders) {
    for (const item of order.line_items || []) {
      if (item.product_id) productIds.add(item.product_id);
    }
  }
  await Promise.all([...productIds].map(pid => getProductTags(pid)));

  const dailyMap = {};

  for (const order of orders) {
    const date = order.created_at.substring(0, 10);
    if (!dailyMap[date]) {
      dailyMap[date] = { date, orders: 0, revenue: 0, cups: 0, hornwormCups: 0, silkwormCups: 0 };
    }

    dailyMap[date].orders++;
    dailyMap[date].revenue += parseFloat(order.total_price || 0);

    for (const item of order.line_items || []) {
      const tags = productTagCache.get(item.product_id) || [];
      const cupCount = getCupCount(tags);
      const productType = getProductType(tags);
      const qty = item.quantity || 1;

      if (cupCount > 0) {
        const totalCups = qty * cupCount;
        dailyMap[date].cups += totalCups;
        if (productType === 'hornworm-cup') dailyMap[date].hornwormCups += totalCups;
        if (productType === 'silkworm-cup') dailyMap[date].silkwormCups += totalCups;
      }
    }
  }

  return Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));
}

// ============================================================
// TAG PARSING HELPERS
// ============================================================

function getChannel(tags) {
  if (tags.includes('wholesale')) return 'wholesale';
  if (tags.includes('chewy')) return 'chewy';
  if (tags.includes('amazon-pioneer')) return 'amazon-pioneer';
  if (tags.includes('amazon-upnorth')) return 'amazon-upnorth';
  if (tags.includes('ebay')) return 'ebay';
  if (tags.includes('tradeshow')) return 'tradeshow';
  return 'retail';
}

function getProductType(tags) {
  const types = ['hornworm-cup', 'silkworm-cup', 'waxworm-cup', 'superworm-cup', 'mealworm-cup', 'bsfl-cup'];
  return types.find(t => tags.includes(t)) || null;
}

function getCupCount(tags) {
  const cupTag = tags.find(t => t.startsWith('cup-count-'));
  if (!cupTag) return 0;
  const num = parseInt(cupTag.replace('cup-count-', ''));
  return isNaN(num) ? 0 : num;
}

function getSupplyType(tags) {
  const types = ['supply-food-cup', 'supply-stamped-cup', 'supply-diet', 'supply-eggs', 'supply-egg-cup', 'supply-heatpack', 'supply-merch', 'supply-other'];
  return types.find(t => tags.includes(t)) || 'supply-other';
}

module.exports = router;
