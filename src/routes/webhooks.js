const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const shipstationService = require('../services/shipstation');
const shopifyService = require('../services/shopify');
const upsTracking = require('../services/ups-tracking');
const orderModel = require('../models/order');
const shipmentModel = require('../models/shipment');
const { getUpsAccountType, isUpsTracking, isChewyOrder } = require('../utils/ups-account');

/**
 * POST /webhooks/shipstation
 * 
 * Receives ShipStation SHIP_NOTIFY webhook.
 * Returns 200 immediately, processes async.
 */
router.post('/shipstation', async (req, res) => {
  const { resource_url, resource_type } = req.body;

  logger.info({ resource_type, resource_url }, 'Received ShipStation webhook');

  // Respond immediately — ShipStation requires response within 10 seconds
  res.status(200).json({ received: true });

  // Process asynchronously
  if (resource_type !== 'SHIP_NOTIFY') {
    logger.info({ resource_type }, 'Ignoring non-SHIP_NOTIFY webhook');
    return;
  }

  if (!resource_url) {
    logger.error('SHIP_NOTIFY webhook missing resource_url');
    return;
  }

  try {
    await processShipNotify(resource_url);
  } catch (err) {
    logger.error({ err, resource_url }, 'Error processing SHIP_NOTIFY webhook');
  }
});

/**
 * Process a SHIP_NOTIFY webhook by fetching shipment data and enriching it.
 */
async function processShipNotify(resourceUrl) {
  // Step 1: Fetch shipments from ShipStation
  const shipments = await shipstationService.fetchShipmentsFromWebhook(resourceUrl);
  logger.info({ count: shipments.length }, 'Fetched shipments from ShipStation');

  for (const ssShipment of shipments) {
    try {
      await processOneShipment(ssShipment);
    } catch (err) {
      logger.error({
        err,
        trackingNumber: ssShipment.trackingNumber,
        orderId: ssShipment.orderId,
      }, 'Error processing individual shipment');
      // Continue processing other shipments in the batch
    }
  }
}

/**
 * Process a single shipment from ShipStation.
 */
async function processOneShipment(ssShipment) {
  const trackingNumber = ssShipment.trackingNumber;

  // Skip voided labels
  if (ssShipment.voided) {
    logger.info({ trackingNumber }, 'Skipping voided shipment');
    // If we already have this shipment, mark it voided
    await shipmentModel.markVoided(trackingNumber);
    return;
  }

  // Skip if no tracking number
  if (!trackingNumber) {
    logger.warn({ shipmentId: ssShipment.shipmentId }, 'Shipment has no tracking number, skipping');
    return;
  }

  // Check if we already processed this shipment
  const existing = await shipmentModel.findByTrackingNumber(trackingNumber);
  if (existing && !existing.is_voided) {
    logger.info({ trackingNumber }, 'Shipment already exists, skipping');
    return;
  }

  logger.info({
    trackingNumber,
    orderNumber: ssShipment.orderNumber,
    carrier: ssShipment.carrierCode,
  }, 'Processing shipment');

  // Step 2: Get the full order from ShipStation to get external_order_id
  let ssOrder = null;
  let shopifyOrderId = null;

  if (ssShipment.orderId) {
    ssOrder = await shipstationService.getOrder(ssShipment.orderId);
    
    if (ssOrder) {
      // Extract Shopify order ID from externalOrderId
      // ShipStation stores it as "6608984637748" or "6608984637748-7587786555700"
      const externalId = ssOrder.externalOrderId || ssOrder.advancedOptions?.customField1;
      if (externalId) {
        // Take just the order ID part (before any dash)
        shopifyOrderId = parseInt(externalId.split('-')[0]);
      }
    }
  }

  // Determine if Chewy order
  const orderNumber = ssShipment.orderNumber || ssOrder?.orderNumber;
  const chewy = isChewyOrder(orderNumber);

  // Step 3: Create or update order with Shopify enrichment
  let order = null;

  if (shopifyOrderId) {
    // Check if order already exists in our DB
    order = await orderModel.findByShopifyId(shopifyOrderId);

    if (!order) {
      // Fetch from Shopify and create
      if (!chewy || true) { // Always create order record for sales data
        try {
          const shopifyData = await shopifyService.getOrderWithCogs(shopifyOrderId);

          if (shopifyData) {
            order = await orderModel.upsert({
              shopifyOrderId: shopifyData.shopifyOrderId,
              shopifyOrderNumber: shopifyData.shopifyOrderNumber,
              shipstationOrderNumber: orderNumber,
              orderDate: shopifyData.orderDate,
              customerName: shopifyData.customerName,
              customerEmail: shopifyData.customerEmail,
              itemsJson: shopifyData.lineItems,
              itemRevenue: shopifyData.itemRevenue,
              totalCogs: shopifyData.totalCogs,
              shippingPaidByCustomer: shopifyData.shippingPaid,
              shippingMethodSelected: shopifyData.shippingMethod,
              orderTotal: shopifyData.orderTotal,
              isChewyOrder: chewy,
            });

            logger.info({
              orderId: order.id,
              shopifyOrderNumber: shopifyData.shopifyOrderNumber,
              cogs: shopifyData.totalCogs,
            }, 'Created/updated order with Shopify data');
          }
        } catch (err) {
          logger.error({ err, shopifyOrderId }, 'Failed to enrich from Shopify, creating basic order');
          // Create a basic order without Shopify enrichment
          order = await orderModel.upsert({
            shopifyOrderId,
            shipstationOrderNumber: orderNumber,
            isChewyOrder: chewy,
          });
        }
      }
    }
  }

  // If this is a Chewy order, skip shipment creation (no shipping cost tracking)
  if (chewy) {
    logger.info({ orderNumber, trackingNumber }, 'Chewy order — skipping shipment record');
    return;
  }

  // Step 4: Determine UPS account type
  const upsAccountType = getUpsAccountType(trackingNumber);

  // Step 5: Parse shipment details
  const weight = ssShipment.weight || {};
  let weightLbs = null;
  if (weight.value && weight.value > 0) {
    weightLbs = weight.units === 'ounces'
      ? weight.value / 16
      : weight.value; // assume pounds
  }

  const dims = ssShipment.dimensions || {};

  // Step 6: Create shipment record
  const shipment = await shipmentModel.create({
    orderId: order?.id || null,
    shipstationShipmentId: String(ssShipment.shipmentId),
    shipstationLabelId: ssShipment.labelId ? String(ssShipment.labelId) : null,
    trackingNumber,
    carrierCode: ssShipment.carrierCode,
    serviceCode: ssShipment.serviceCode,
    upsAccountType,
    shipDate: ssShipment.shipDate,
    dimensionsLength: dims.length || null,
    dimensionsWidth: dims.width || null,
    dimensionsHeight: dims.height || null,
    weightEntered: weightLbs,
    labelCost: ssShipment.shipmentCost || 0,
    promisedDeliveryDate: null, // Will be set by UPS tracking call below
    shipToName: ssShipment.shipTo?.name,
    shipToCity: ssShipment.shipTo?.city,
    shipToState: ssShipment.shipTo?.state,
    shipToZip: ssShipment.shipTo?.postalCode,
    isResidential: ssShipment.shipTo?.residential || false,
  });

  logger.info({
    shipmentId: shipment.id,
    trackingNumber,
    carrier: ssShipment.carrierCode,
    service: ssShipment.serviceCode,
    labelCost: ssShipment.shipmentCost,
  }, 'Created shipment record');

  // Step 7: Update package count if order has multiple shipments
  if (order) {
    await orderModel.updatePackageCount(order.id);
  }

  // Step 8: Get UPS promised delivery date (async, non-blocking)
  if (isUpsTracking(trackingNumber)) {
    try {
      const tracking = await upsTracking.getTrackingDetails(trackingNumber);

      if (tracking.scheduledDelivery) {
        await shipmentModel.updateTracking(trackingNumber, {
          deliveryStatus: tracking.deliveryStatus,
          actualDeliveryDate: tracking.actualDelivery,
          promisedDeliveryDate: tracking.scheduledDelivery,
          isLate: null, // Can't determine yet if not delivered
        });
        logger.info({
          trackingNumber,
          promisedDelivery: tracking.scheduledDelivery,
        }, 'Updated UPS promised delivery date');
      }
    } catch (err) {
      logger.warn({ err, trackingNumber }, 'Could not get UPS tracking info (will retry in daily poll)');
    }
  }
}

module.exports = router;
