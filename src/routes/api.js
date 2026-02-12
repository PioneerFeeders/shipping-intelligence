const express = require('express');
const router = express.Router();
const db = require('../config/database');
const logger = require('../utils/logger');

/**
 * GET /api/shipments
 * Query shipments with optional filters.
 */
router.get('/shipments', async (req, res) => {
  try {
    const { start_date, end_date, carrier, ups_account, status, limit = 100, offset = 0 } = req.query;

    let where = ['s.is_voided = FALSE'];
    let params = [];
    let paramIdx = 1;

    if (start_date) {
      where.push(`s.ship_date >= $${paramIdx++}`);
      params.push(start_date);
    }
    if (end_date) {
      where.push(`s.ship_date <= $${paramIdx++}`);
      params.push(end_date);
    }
    if (carrier) {
      where.push(`s.carrier_code = $${paramIdx++}`);
      params.push(carrier);
    }
    if (ups_account) {
      where.push(`s.ups_account_type = $${paramIdx++}`);
      params.push(ups_account);
    }
    if (status) {
      where.push(`s.delivery_status = $${paramIdx++}`);
      params.push(status);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const { rows } = await db.query(`
      SELECT s.*, o.shopify_order_number, o.customer_name, o.order_date
      FROM shipments s
      LEFT JOIN orders o ON s.order_id = o.id
      ${whereClause}
      ORDER BY s.ship_date DESC
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `, [...params, parseInt(limit), parseInt(offset)]);

    // Get total count
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) as total FROM shipments s ${whereClause}`,
      params
    );

    res.json({
      shipments: rows,
      total: parseInt(countRows[0].total),
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (err) {
    logger.error({ err }, 'Failed to query shipments');
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/reconciliation
 * Returns the full reconciliation view for a date range.
 */
router.get('/reconciliation', async (req, res) => {
  try {
    const { start_date, end_date, invoice_number } = req.query;

    let where = [];
    let params = [];
    let paramIdx = 1;

    if (start_date) {
      where.push(`ship_date >= $${paramIdx++}`);
      params.push(start_date);
    }
    if (end_date) {
      where.push(`ship_date <= $${paramIdx++}`);
      params.push(end_date);
    }
    if (invoice_number) {
      where.push(`invoice_number = $${paramIdx++}`);
      params.push(invoice_number);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const { rows } = await db.query(
      `SELECT * FROM reconciliation_weekly ${whereClause} ORDER BY ship_date DESC`,
      params
    );

    // Compute summary stats
    const summary = {
      totalShipments: rows.length,
      totalLabelCost: rows.reduce((sum, r) => sum + (parseFloat(r.label_cost) || 0), 0),
      totalBilled: rows.reduce((sum, r) => sum + (parseFloat(r.final_billed_total) || 0), 0),
      totalCostDelta: rows.reduce((sum, r) => sum + (parseFloat(r.cost_delta) || 0), 0),
      totalShippingMargin: rows.reduce((sum, r) => sum + (parseFloat(r.shipping_margin) || 0), 0),
      lateDeliveries: rows.filter(r => r.is_late).length,
      claimEligible: rows.filter(r => r.claim_eligible).length,
      dimensionDiscrepancies: rows.filter(r => r.has_dimension_discrepancy).length,
      withInvoice: rows.filter(r => r.invoice_number).length,
      withoutInvoice: rows.filter(r => !r.invoice_number).length,
    };

    res.json({ summary, data: rows });
  } catch (err) {
    logger.error({ err }, 'Failed to query reconciliation');
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/orders
 * Query orders.
 */
router.get('/orders', async (req, res) => {
  try {
    const { start_date, end_date, limit = 100, offset = 0 } = req.query;

    let where = [];
    let params = [];
    let paramIdx = 1;

    if (start_date) {
      where.push(`order_date >= $${paramIdx++}`);
      params.push(start_date);
    }
    if (end_date) {
      where.push(`order_date <= $${paramIdx++}`);
      params.push(end_date);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const { rows } = await db.query(
      `SELECT * FROM orders ${whereClause} ORDER BY order_date DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    res.json({ orders: rows });
  } catch (err) {
    logger.error({ err }, 'Failed to query orders');
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/stats
 * Quick summary stats for the dashboard.
 */
router.get('/stats', async (req, res) => {
  try {
    const [orders, shipments, invoiceItems] = await Promise.all([
      db.query('SELECT COUNT(*) as cnt FROM orders'),
      db.query('SELECT COUNT(*) as cnt FROM shipments WHERE is_voided = FALSE'),
      db.query('SELECT COUNT(*) as cnt FROM invoice_line_items'),
    ]);

    const [undelivered] = await Promise.all([
      db.query("SELECT COUNT(*) as cnt FROM shipments WHERE delivery_status NOT IN ('delivered','returned') AND is_voided = FALSE AND carrier_code = 'ups'"),
    ]);

    res.json({
      totalOrders: parseInt(orders.rows[0].cnt),
      totalShipments: parseInt(shipments.rows[0].cnt),
      totalInvoiceItems: parseInt(invoiceItems.rows[0].cnt),
      undeliveredUpsShipments: parseInt(undelivered.rows[0].cnt),
    });
  } catch (err) {
    logger.error({ err }, 'Failed to get stats');
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
