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
  getOrder,
  listShipments,
};
