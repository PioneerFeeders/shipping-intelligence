const db = require('../config/database');
const logger = require('../utils/logger');

/**
 * Insert a batch of invoice line items.
 */
async function insertLineItems(lineItems) {
  const client = await db.getClient();
  let insertedCount = 0;

  try {
    await client.query('BEGIN');

    for (const item of lineItems) {
      await client.query(`
        INSERT INTO invoice_line_items (
          tracking_number, invoice_number, invoice_date, ups_account_type,
          pickup_date, service, zone, receiver_zip,
          customer_weight, billed_weight, entered_dimensions, audited_dimensions,
          published_charge, incentive_credit, original_billed_total,
          fuel_surcharge, residential_surcharge, large_package_surcharge,
          das_extended, additional_handling, adjustment_amount, final_billed_total,
          receiver_name, receiver_company, receiver_city, receiver_state
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
      `, [
        item.trackingNumber, item.invoiceNumber, item.invoiceDate, item.upsAccountType,
        item.pickupDate, item.service, item.zone, item.receiverZip,
        item.customerWeight, item.billedWeight, item.enteredDimensions, item.auditedDimensions,
        item.publishedCharge, item.incentiveCredit, item.originalBilledTotal,
        item.fuelSurcharge, item.residentialSurcharge, item.largePackageSurcharge,
        item.dasExtended, item.additionalHandling, item.adjustmentAmount, item.finalBilledTotal,
        item.receiverName, item.receiverCompany, item.receiverCity, item.receiverState,
      ]);
      insertedCount++;
    }

    await client.query('COMMIT');
    return insertedCount;
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err }, 'Failed to insert invoice line items');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Match invoice line items to shipments by tracking number.
 * Returns { matched, unmatched } counts.
 */
async function matchToShipments(invoiceNumber) {
  // Update shipment_id on invoice_line_items where tracking number matches
  const { rowCount: matched } = await db.query(`
    UPDATE invoice_line_items ili
    SET shipment_id = s.id
    FROM shipments s
    WHERE ili.tracking_number = s.tracking_number
      AND ili.shipment_id IS NULL
      AND ($1 IS NULL OR ili.invoice_number = $1)
  `, [invoiceNumber]);

  // Count unmatched
  const { rows } = await db.query(`
    SELECT COUNT(*) as cnt FROM invoice_line_items
    WHERE shipment_id IS NULL
      AND ($1 IS NULL OR invoice_number = $1)
  `, [invoiceNumber]);
  const unmatched = parseInt(rows[0].cnt);

  return { matched, unmatched };
}

/**
 * Create an invoice upload record.
 */
async function createUploadRecord(uploadData) {
  const { invoiceNumber, upsAccountType, invoiceDate, invoiceTotal, lineItemCount } = uploadData;

  const { rows } = await db.query(`
    INSERT INTO invoice_uploads (invoice_number, ups_account_type, invoice_date, invoice_total, line_item_count)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `, [invoiceNumber, upsAccountType, invoiceDate, invoiceTotal, lineItemCount]);

  return rows[0];
}

/**
 * Update upload record with matching results.
 */
async function updateUploadRecord(id, matchedCount, unmatchedCount) {
  await db.query(`
    UPDATE invoice_uploads SET matched_count = $1, unmatched_count = $2, reconciled = TRUE
    WHERE id = $3
  `, [matchedCount, unmatchedCount, id]);
}

/**
 * Get unmatched invoice line items (for manual review).
 */
async function getUnmatched(invoiceNumber) {
  const { rows } = await db.query(`
    SELECT * FROM invoice_line_items
    WHERE shipment_id IS NULL
      AND ($1 IS NULL OR invoice_number = $1)
    ORDER BY pickup_date, tracking_number
  `, [invoiceNumber || null]);
  return rows;
}

module.exports = {
  insertLineItems,
  matchToShipments,
  createUploadRecord,
  updateUploadRecord,
  getUnmatched,
};
