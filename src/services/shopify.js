const axios = require('axios');
const config = require('../config/env');
const logger = require('../utils/logger');
const { shopifyLimiter } = require('../utils/rate-limiter');

const shopifyClient = axios.create({
  baseURL: `https://${config.shopify.storeUrl}/admin/api/${config.shopify.apiVersion}`,
  headers: {
    'X-Shopify-Access-Token': config.shopify.accessToken,
    'Content-Type': 'application/json',
  },
  timeout: 15000,
});

/**
 * Get a Shopify order by ID.
 * The order ID is the long numeric Shopify ID (e.g., 6608984637748).
 */
async function getOrder(shopifyOrderId) {
  await shopifyLimiter.wait();
  try {
    const response = await shopifyClient.get(`/orders/${shopifyOrderId}.json`);
    return response.data.order;
  } catch (err) {
    // Handle 404 gracefully (order might not exist)
    if (err.response && err.response.status === 404) {
      logger.warn({ shopifyOrderId }, 'Shopify order not found');
      return null;
    }
    logger.error({ err, shopifyOrderId }, 'Failed to fetch Shopify order');
    throw err;
  }
}

/**
 * Get the COGS (cost) for a single inventory item.
 * Each product variant has an inventory_item_id. The cost is on the InventoryItem resource.
 */
async function getInventoryItemCost(inventoryItemId) {
  await shopifyLimiter.wait();
  try {
    const response = await shopifyClient.get(`/inventory_items/${inventoryItemId}.json`);
    const cost = response.data.inventory_item?.cost;
    return cost ? parseFloat(cost) : null;
  } catch (err) {
    logger.warn({ err, inventoryItemId }, 'Failed to fetch inventory item cost');
    return null;
  }
}

/**
 * Get COGS for all line items in an order.
 * Returns an array of line items enriched with their cost.
 * 
 * Shopify order line_items don't include COGS directly.
 * We need to look up each variant's inventory_item_id, then fetch the cost.
 * Fortunately, line_items include variant_id, and we can batch inventory item lookups.
 */
async function getOrderWithCogs(shopifyOrderId) {
  const order = await getOrder(shopifyOrderId);
  if (!order) return null;

  const lineItems = [];
  let totalCogs = 0;

  for (const item of order.line_items || []) {
    let itemCost = null;

    // Try to get COGS from the variant's inventory item
    if (item.variant_id) {
      try {
        // Get the variant to find inventory_item_id
        await shopifyLimiter.wait();
        const variantResp = await shopifyClient.get(`/variants/${item.variant_id}.json`);
        const inventoryItemId = variantResp.data.variant?.inventory_item_id;

        if (inventoryItemId) {
          itemCost = await getInventoryItemCost(inventoryItemId);
        }
      } catch (err) {
        logger.warn({ err, variantId: item.variant_id }, 'Could not look up COGS for variant');
      }
    }

    const lineItemData = {
      name: item.name,
      sku: item.sku,
      quantity: item.quantity,
      price: parseFloat(item.price),
      cogs: itemCost,
      variant_id: item.variant_id,
      product_id: item.product_id,
    };

    lineItems.push(lineItemData);

    if (itemCost !== null) {
      totalCogs += itemCost * item.quantity;
    }
  }

  // Extract shipping info
  const shippingLines = order.shipping_lines || [];
  const shippingPaid = shippingLines.reduce((sum, line) => sum + parseFloat(line.price || 0), 0);
  const shippingMethod = shippingLines.length > 0 ? shippingLines[0].title : null;

  return {
    shopifyOrderId: order.id,
    shopifyOrderNumber: order.name, // e.g., "#26276"
    orderDate: order.created_at,
    customerName: `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim() || order.shipping_address?.name,
    customerEmail: order.customer?.email || order.email,
    lineItems,
    itemRevenue: lineItems.reduce((sum, item) => sum + (item.price * item.quantity), 0),
    totalCogs: totalCogs || null,
    shippingPaid,
    shippingMethod,
    orderTotal: parseFloat(order.total_price),
  };
}

module.exports = {
  getOrder,
  getInventoryItemCost,
  getOrderWithCogs,
};
