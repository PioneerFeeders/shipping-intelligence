const db = require('../config/database');
const logger = require('../utils/logger');

/**
 * Find a shipment by tracking number.
 */
async function findByTrackingNumber(trackingNumber) {
  const { rows } = await db.query(
    'SELECT * FROM shipments WHERE tracking_number = $1',
    [trackingNumber]
  );
  return rows[0] || null;
}

/**
 * Create a new shipment. Uses tracking_number UNIQUE constraint to prevent duplicates.
 */
async function create(shipmentData) {
  const {
    orderId, shipstationShipmentId, shipstationLabelId,
    trackingNumber, carrierCode, serviceCode, upsAccountType,
    shipDate, dimensionsLength, dimensionsWidth, dimensionsHeight,
    weightEntered, labelCost, promisedDeliveryDate,
    shipToName, shipToCity, shipToState, shipToZip, isResidential,
  } = shipmentData;

  const { rows } = await db.query(`
    INSERT INTO shipments (
      order_id, shipstation_shipment_id, shipstation_label_id,
      tracking_number, carrier_code, service_code, ups_account_type,
      ship_date, dimensions_length, dimensions_width, dimensions_height,
      weight_entered, label_cost, promised_delivery_date,
      ship_to_name, ship_to_city, ship_to_state, ship_to_zip, is_residential
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
    ON CONFLICT (tracking_number) DO UPDATE SET
      order_id = COALESCE(EXCLUDED.order_id, shipments.order_id),
      carrier_code = COALESCE(EXCLUDED.carrier_code, shipments.carrier_code),
      service_code = COALESCE(EXCLUDED.service_code, shipments.service_code),
      label_cost = COALESCE(EXCLUDED.label_cost, shipments.label_cost),
      promised_delivery_date = COALESCE(EXCLUDED.promised_delivery_date, shipments.promised_delivery_date),
      updated_at = NOW()
    RETURNING *
  `, [
    orderId, shipstationShipmentId, shipstationLabelId,
    trackingNumber, carrierCode, serviceCode, upsAccountType,
    shipDate, dimensionsLength, dimensionsWidth, dimensionsHeight,
    weightEntered, labelCost, promisedDeliveryDate,
    shipToName, shipToCity, shipToState, shipToZip, isResidential,
  ]);

  return rows[0];
}

/**
 * Update delivery tracking info for a shipment.
 */
async function updateTracking(trackingNumber, trackingData) {
  const { deliveryStatus, actualDeliveryDate, promisedDeliveryDate, isLate } = trackingData;

  const { rows } = await db.query(`
    UPDATE shipments SET
      delivery_status = COALESCE($1, delivery_status),
      actual_delivery_date = COALESCE($2, actual_delivery_date),
      promised_delivery_date = COALESCE($3, promised_delivery_date),
      is_late = $4,
      updated_at = NOW()
    WHERE tracking_number = $5
    RETURNING *
  `, [deliveryStatus, actualDeliveryDate, promisedDeliveryDate, isLate, trackingNumber]);

  return rows[0] || null;
}

/**
 * Get all undelivered UPS shipments for tracking polling.
 * Only gets shipments shipped within the last 30 days.
 */
async function getUndeliveredUpsShipments() {
  const { rows } = await db.query(`
    SELECT id, tracking_number, promised_delivery_date, ship_date
    FROM shipments
    WHERE carrier_code = 'ups'
      AND delivery_status NOT IN ('delivered', 'returned')
      AND is_voided = FALSE
      AND ship_date > NOW() - INTERVAL '30 days'
    ORDER BY ship_date ASC
  `);
  return rows;
}

/**
 * Mark a shipment as voided.
 */
async function markVoided(trackingNumber) {
  const { rows } = await db.query(
    'UPDATE shipments SET is_voided = TRUE, updated_at = NOW() WHERE tracking_number = $1 RETURNING *',
    [trackingNumber]
  );
  return rows[0] || null;
}

module.exports = {
  findByTrackingNumber,
  create,
  updateTracking,
  getUndeliveredUpsShipments,
  markVoided,
};
