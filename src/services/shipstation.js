const axios = require('axios');
const config = require('../config/env');
const logger = require('../utils/logger');
const { shipstationLimiter } = require('../utils/rate-limiter');

// V1 API uses Basic auth
const v1Auth = Buffer.from(`${config.shipstation.apiKey}:${config.shipstation.apiSecret}`).toString('base64');

const v1Client = axios.create({
  baseURL: config.shipstation.baseUrl,
  headers: {
    'Authorization': `Basic ${v1Auth}`,
    'Content-Type': 'application/json',
  },
  timeout: 30000,
});

/**
 * Fetch shipment data from the webhook resource_url.
 * The resource_url points to the V1 /shipments endpoint with filters.
 */
async function fetchShipmentsFromWebhook(resourceUrl) {
  await shipstationLimiter.wait();
  try {
    const response = await axios.get(resourceUrl, {
      headers: {
        'Authorization': `Basic ${v1Auth}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    const data = response.data;
    // V1 returns { shipments: [...], total, page, pages }
    return data.shipments || [];
  } catch (err) {
    logger.error({ err, url: resourceUrl }, 'Failed to fetch shipments from webhook resource_url');
    throw err;
  }
}

/**
 * Get a single order by ShipStation orderId.
 * Returns the full order object including items and external order ID.
 */
async function getOrder(orderId) {
  await shipstationLimiter.wait();
  try {
    const response = await v1Client.get(`/orders/${orderId}`);
    return response.data;
  } catch (err) {
    logger.error({ err, orderId }, 'Failed to fetch ShipStation order');
    throw err;
  }
}

// V2 API uses API-Key header
const v2Client = axios.create({
  baseURL: 'https://api.shipstation.com/v2',
  headers: {
    'API-Key': config.shipstation.v2ApiKey,
    'Content-Type': 'application/json',
  },
  timeout: 30000,
});

/**
 * Fetch labels from V2 webhook resource_url.
 * V2 LABEL_CREATED_V2 provides a URL like:
 *   https://api.shipstation.com/v2/labels?batch_id=se-XXXXX
 */
async function fetchLabelsFromV2Webhook(resourceUrl) {
  await shipstationLimiter.wait();
  try {
    const response = await axios.get(resourceUrl, {
      headers: {
        'API-Key': config.shipstation.v2ApiKey,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    const data = response.data;
    logger.info({ responseKeys: Object.keys(data) }, 'V2 webhook response structure');

    // V2 may return { labels: [...] } or { data: [...] } or just an array
    if (Array.isArray(data)) return data;
    if (data.labels) return Array.isArray(data.labels) ? data.labels : [data.labels];
    if (data.data) return Array.isArray(data.data) ? data.data : [data.data];

    // Single label response
    if (data.label_id || data.tracking_number) return [data];

    logger.warn({ data: JSON.stringify(data).substring(0, 500) }, 'Unexpected V2 labels response structure');
    return [];
  } catch (err) {
    logger.error({ err, url: resourceUrl }, 'Failed to fetch labels from V2 webhook');
    throw err;
  }
}

/**
 * Get a V2 shipment by ID.
 */
async function getV2Shipment(shipmentId) {
  await shipstationLimiter.wait();
  try {
    const response = await v2Client.get(`/shipments/${shipmentId}`);
    return response.data;
  } catch (err) {
    logger.warn({ err, shipmentId }, 'Failed to fetch V2 shipment');
    return null;
  }
}

/**
 * Search V1 orders by order number to find Shopify external order ID.
 */
async function searchOrdersByNumber(orderNumber) {
  await shipstationLimiter.wait();
  try {
    const response = await v1Client.get('/orders', {
      params: { orderNumber, pageSize: 1 },
    });
    return response.data.orders || [];
  } catch (err) {
    logger.warn({ err, orderNumber }, 'Failed to search V1 orders by number');
    return [];
  }
}

/**
 * List shipments with filters.
 * Useful for backfill or manual queries.
 */
async function listShipments(params = {}) {
  await shipstationLimiter.wait();
  try {
    const response = await v1Client.get('/shipments', {
      params: {
        includeShipmentItems: true,
        pageSize: 100,
        ...params,
      },
    });
    return response.data;
  } catch (err) {
    logger.error({ err, params }, 'Failed to list shipments');
    throw err;
  }
}

module.exports = {
  fetchShipmentsFromWebhook,
  fetchLabelsFromV2Webhook,
  getOrder,
  getV2Shipment,
  searchOrdersByNumber,
  listShipments,
};
