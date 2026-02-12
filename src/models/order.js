const db = require('../config/database');
const logger = require('../utils/logger');

/**
 * Find an order by Shopify order ID.
 */
async function findByShopifyId(shopifyOrderId) {
  const { rows } = await db.query(
    'SELECT * FROM orders WHERE shopify_order_id = $1',
    [shopifyOrderId]
  );
  return rows[0] || null;
}

/**
 * Find an order by ShipStation order number.
 */
async function findByShipstationNumber(orderNumber) {
  const { rows } = await db.query(
    'SELECT * FROM orders WHERE shipstation_order_number = $1',
    [orderNumber]
  );
  return rows[0] || null;
}

/**
 * Create or update an order.
 * Uses Shopify order ID as the unique key for upsert.
 */
async function upsert(orderData) {
  const {
    shopifyOrderId, shopifyOrderNumber, shipstationOrderNumber,
    orderDate, customerName, customerEmail, itemsJson,
    itemRevenue, totalCogs, shippingPaidByCustomer,
    shippingMethodSelected, orderTotal, isChewyOrder,
  } = orderData;

  const { rows } = await db.query(`
    INSERT INTO orders (
      shopify_order_id, shopify_order_number, shipstation_order_number,
      order_date, customer_name, customer_email, items_json,
      item_revenue, total_cogs, shipping_paid_by_customer,
      shipping_method_selected, order_total, is_chewy_order
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    ON CONFLICT (shopify_order_id) DO UPDATE SET
      shopify_order_number = COALESCE(EXCLUDED.shopify_order_number, orders.shopify_order_number),
      shipstation_order_number = COALESCE(EXCLUDED.shipstation_order_number, orders.shipstation_order_number),
      customer_name = COALESCE(EXCLUDED.customer_name, orders.customer_name),
      customer_email = COALESCE(EXCLUDED.customer_email, orders.customer_email),
      items_json = COALESCE(EXCLUDED.items_json, orders.items_json),
      item_revenue = COALESCE(EXCLUDED.item_revenue, orders.item_revenue),
      total_cogs = COALESCE(EXCLUDED.total_cogs, orders.total_cogs),
      shipping_paid_by_customer = COALESCE(EXCLUDED.shipping_paid_by_customer, orders.shipping_paid_by_customer),
      shipping_method_selected = COALESCE(EXCLUDED.shipping_method_selected, orders.shipping_method_selected),
      order_total = COALESCE(EXCLUDED.order_total, orders.order_total),
      updated_at = NOW()
    RETURNING *
  `, [
    shopifyOrderId, shopifyOrderNumber, shipstationOrderNumber,
    orderDate, customerName, customerEmail, JSON.stringify(itemsJson),
    itemRevenue, totalCogs, shippingPaidByCustomer,
    shippingMethodSelected, orderTotal, isChewyOrder || false,
  ]);

  return rows[0];
}

/**
 * Update the package count for an order and recalculate split fields on all shipments.
 */
async function updatePackageCount(orderId) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Count non-voided shipments for this order
    const { rows: countRows } = await client.query(
      'SELECT COUNT(*) as cnt FROM shipments WHERE order_id = $1 AND is_voided = FALSE',
      [orderId]
    );
    const packageCount = parseInt(countRows[0].cnt) || 1;

    // Update order
    await client.query(
      'UPDATE orders SET package_count = $1, updated_at = NOW() WHERE id = $2',
      [packageCount, orderId]
    );

    // Get order financials for splitting
    const { rows: orderRows } = await client.query(
      'SELECT item_revenue, total_cogs, shipping_paid_by_customer FROM orders WHERE id = $1',
      [orderId]
    );
    const order = orderRows[0];

    if (order && packageCount > 0) {
      const splitRevenue = order.item_revenue ? (parseFloat(order.item_revenue) / packageCount) : null;
      const splitCogs = order.total_cogs ? (parseFloat(order.total_cogs) / packageCount) : null;
      const splitShipping = order.shipping_paid_by_customer ? (parseFloat(order.shipping_paid_by_customer) / packageCount) : null;
      const isMulti = packageCount > 1;

      // Update all shipments for this order
      await client.query(`
        UPDATE shipments SET
          is_multi_package = $1,
          split_revenue = $2,
          split_cogs = $3,
          split_shipping_paid = $4,
          updated_at = NOW()
        WHERE order_id = $5 AND is_voided = FALSE
      `, [isMulti, splitRevenue, splitCogs, splitShipping, orderId]);
    }

    await client.query('COMMIT');
    logger.info({ orderId, packageCount }, 'Updated package count and split fields');
    return packageCount;
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err, orderId }, 'Failed to update package count');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  findByShopifyId,
  findByShipstationNumber,
  upsert,
  updatePackageCount,
};
