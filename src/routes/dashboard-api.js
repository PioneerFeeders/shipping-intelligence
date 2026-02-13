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
