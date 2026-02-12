const cron = require('node-cron');
const logger = require('../utils/logger');
const shipmentModel = require('../models/shipment');
const upsTracking = require('../services/ups-tracking');

/**
 * Daily UPS tracking poller.
 * Checks all undelivered UPS shipments for delivery status updates.
 * 
 * Runs every day at 8:00 AM EST (13:00 UTC).
 */
function startTrackingPoller() {
  cron.schedule('0 13 * * *', async () => {
    logger.info('Starting daily UPS tracking poll');
    await pollAllUndelivered();
  }, {
    timezone: 'America/New_York',
  });

  logger.info('UPS tracking poller scheduled: daily at 8:00 AM EST');
}

/**
 * Poll all undelivered UPS shipments.
 * Can also be called manually.
 */
async function pollAllUndelivered() {
  try {
    const shipments = await shipmentModel.getUndeliveredUpsShipments();
    logger.info({ count: shipments.length }, 'Polling undelivered UPS shipments');

    let updated = 0;
    let delivered = 0;
    let errors = 0;

    for (const shipment of shipments) {
      try {
        const tracking = await upsTracking.getTrackingDetails(shipment.tracking_number);

        if (tracking.status === 'error' || tracking.status === 'not_found') {
          continue;
        }

        // Determine if late
        let isLate = null;
        if (tracking.actualDelivery && shipment.promised_delivery_date) {
          isLate = new Date(tracking.actualDelivery) > new Date(shipment.promised_delivery_date);
        }

        const result = await shipmentModel.updateTracking(shipment.tracking_number, {
          deliveryStatus: tracking.deliveryStatus,
          actualDeliveryDate: tracking.actualDelivery,
          promisedDeliveryDate: tracking.scheduledDelivery || shipment.promised_delivery_date,
          isLate,
        });

        if (result) {
          updated++;
          if (tracking.deliveryStatus === 'delivered') {
            delivered++;
          }
        }
      } catch (err) {
        errors++;
        logger.error({ err, trackingNumber: shipment.tracking_number }, 'Error polling shipment');
      }
    }

    logger.info({
      polled: shipments.length,
      updated,
      delivered,
      errors,
    }, 'Tracking poll complete');

    return { polled: shipments.length, updated, delivered, errors };
  } catch (err) {
    logger.error({ err }, 'Tracking poll failed');
    throw err;
  }
}

module.exports = { startTrackingPoller, pollAllUndelivered };
