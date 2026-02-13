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

  // Process asynchronously — accept both V1 and V2 event types
  const isV1 = resource_type === 'SHIP_NOTIFY';
  const isV2 = resource_type === 'LABEL_CREATED_V2';

  if (!isV1 && !isV2) {
    logger.info({ resource_type }, 'Ignoring unhandled webhook type');
    return;
  }

  if (!resource_url) {
    logger.error({ resource_type }, 'Webhook missing resource_url');
    return;
  }

  try {
    if (isV2) {
      await processLabelCreatedV2(resource_url);
    } else {
      await processShipNotify(resource_url);
    }
  } catch (err) {
    logger.error({ err, resource_url, resource_type }, 'Error processing webhook');
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
    }
  }
}

/**
 * Process a V2 LABEL_CREATED_V2 webhook.
 * The resource_url points to the V2 labels endpoint.
 * 
 * Strategy: Get the tracking number from V2, then use V1 API to get full
 * shipment details (since V1 has richer data including order linkage).
 */
async function processLabelCreatedV2(resourceUrl) {
  const labels = await shipstationService.fetchLabelsFromV2Webhook(resourceUrl);
  logger.info({ count: labels.length }, 'Fetched labels from ShipStation V2');

  for (const label of labels) {
    try {
      // Log the full V2 label structure so we can see what's available
      logger.info({ v2Label: JSON.stringify(label).substring(0, 2000) }, 'V2 label raw data');

      const trackingNumber = label.tracking_number;
      if (!trackingNumber) {
        logger.warn({ labelId: label.label_id }, 'V2 label has no tracking number, skipping');
        continue;
      }

      // Check if voided
      if (label.voided || label.is_voided) {
        logger.info({ trackingNumber }, 'V2 label is voided, skipping');
        await shipmentModel.markVoided(trackingNumber);
        continue;
      }

      // Strategy: Use V1 API to find shipment by tracking number
      // This gives us the full order linkage, dimensions, weight, etc.
      logger.info({ trackingNumber }, 'Looking up shipment in V1 API by tracking number');
      
      let v1Shipment = null;
      try {
        const v1Results = await shipstationService.listShipments({
          trackingNumber: trackingNumber,
        });
        const v1Shipments = v1Results.shipments || [];
        if (v1Shipments.length > 0) {
          v1Shipment = v1Shipments[0];
          logger.info({
            trackingNumber,
            orderId: v1Shipment.orderId,
            orderNumber: v1Shipment.orderNumber,
          }, 'Found shipment in V1 API');
        }
      } catch (err) {
        logger.warn({ err, trackingNumber }, 'V1 shipment lookup failed');
      }

      // Extract Shopify order ID from V2 label
      // external_shipment_id format: "6642760450356-7623999750452" where first part is Shopify order ID
      // external_order_id is NOT reliable (ShipStation may store other data there)
      let shopifyIdFromV2 = null;
      if (label.external_shipment_id) {
        shopifyIdFromV2 = label.external_shipment_id.split('-')[0];
        logger.info({ shopifyIdFromV2, external_shipment_id: label.external_shipment_id }, 'Extracted Shopify order ID from V2 external_shipment_id');
      }

      if (v1Shipment) {
        // We have full V1 data — use the existing processOneShipment flow
        // Pass through the Shopify order ID from V2
        if (shopifyIdFromV2) {
          v1Shipment._shopifyOrderIdFromV2 = shopifyIdFromV2;
        }
        await processOneShipment(v1Shipment);
      } else {
        // Fallback: build from V2 data only
        logger.info({ trackingNumber }, 'No V1 shipment found, using V2 data only');
        
        const normalized = {
          shipmentId: label.label_id || label.shipment_id,
          labelId: label.label_id,
          trackingNumber,
          carrierCode: label.carrier_code,
          serviceCode: label.service_code,
          shipDate: label.ship_date || label.created_at,
          voided: false,
          shipmentCost: label.shipment_cost?.amount || label.charge?.amount || 0,
          orderNumber: null,
          orderId: null,
          weight: label.weight || label.package_weight || {},
          dimensions: label.dimensions || label.package_dimensions || {},
          shipTo: label.ship_to || {},
        };

        // Try V2 shipment endpoint for more details
        if (label.shipment_id) {
          try {
            const v2Shipment = await shipstationService.getV2Shipment(label.shipment_id);
            if (v2Shipment) {
              logger.info({ v2Shipment: JSON.stringify(v2Shipment).substring(0, 2000) }, 'V2 shipment raw data');
              normalized.orderId = v2Shipment.order_id || v2Shipment.orderId;
              normalized.orderNumber = v2Shipment.order_number || v2Shipment.orderNumber;
              if (!normalized.weight?.value && v2Shipment.weight) normalized.weight = v2Shipment.weight;
              if (!normalized.dimensions?.length && v2Shipment.dimensions) normalized.dimensions = v2Shipment.dimensions;
              if (!normalized.shipTo?.name && v2Shipment.ship_to) normalized.shipTo = v2Shipment.ship_to;
            }
          } catch (err) {
            logger.warn({ err, shipmentId: label.shipment_id }, 'V2 shipment lookup failed');
          }
        }

        await processOneShipment(normalized);
      }
    } catch (err) {
      logger.error({
        err,
        trackingNumber: label.tracking_number,
        labelId: label.label_id,
      }, 'Error processing V2 label');
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
  if (existing && !existing.is_voided && existing.order_id) {
    logger.info({ trackingNumber }, 'Shipment already exists with order linked, skipping');
    return;
  }
  if (existing && !existing.is_voided && !existing.order_id) {
    logger.info({ trackingNumber }, 'Shipment exists but missing order link, re-processing');
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
    logger.info({ ssOrderId: ssShipment.orderId }, 'Fetching ShipStation order for Shopify linkage');
    ssOrder = await shipstationService.getOrder(ssShipment.orderId);
    
    if (ssOrder) {
      // Extract Shopify order ID from externalOrderId
      // ShipStation stores it as "6608984637748" or "6608984637748-7587786555700"
      const externalId = ssOrder.externalOrderId || ssOrder.advancedOptions?.customField1;
      logger.info({ externalId, orderKey: ssOrder.orderKey }, 'ShipStation order external ID');
      if (externalId) {
        // Take just the order ID part (before any dash)
        const candidate = externalId.split('-')[0];
        // Only use if it looks like a numeric Shopify order ID
        if (/^\d+$/.test(candidate) && candidate.length > 5) {
          shopifyOrderId = parseInt(candidate);
        } else {
          logger.info({ externalId }, 'V1 externalOrderId is not a Shopify ID, skipping');
        }
      }
    } else {
      logger.warn({ ssOrderId: ssShipment.orderId }, 'ShipStation getOrder returned null');
    }
  }

  // Fallback: use Shopify order ID from V2 label if V1 didn't provide it
  if (!shopifyOrderId && ssShipment._shopifyOrderIdFromV2) {
    shopifyOrderId = parseInt(ssShipment._shopifyOrderIdFromV2);
    logger.info({ shopifyOrderId }, 'Using Shopify order ID from V2 label data');
  }

  // Fallback 2: try orderKey from V1 (format: "shopifyOrderId-lineItemId")
  if (!shopifyOrderId && ssOrder?.orderKey) {
    const keyCandidate = ssOrder.orderKey.split('-')[0];
    if (/^\d+$/.test(keyCandidate) && keyCandidate.length > 5) {
      shopifyOrderId = parseInt(keyCandidate);
      logger.info({ shopifyOrderId, orderKey: ssOrder.orderKey }, 'Using Shopify order ID from V1 orderKey');
    }
  }

  logger.info({ shopifyOrderId, hasOrder: !!ssOrder }, 'Shopify order ID resolution');

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
