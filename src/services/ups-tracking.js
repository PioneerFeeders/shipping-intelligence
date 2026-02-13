const axios = require('axios');
const config = require('../config/env');
const logger = require('../utils/logger');
const { upsLimiter } = require('../utils/rate-limiter');
const { v4: uuidv4 } = require('uuid');

// Token cache
let cachedToken = null;
let tokenExpiry = 0;

/**
 * Get an OAuth access token from UPS.
 * Caches the token until it expires (with 60s buffer).
 */
async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry) {
    return cachedToken;
  }

  try {
    const auth = Buffer.from(`${config.ups.clientId}:${config.ups.clientSecret}`).toString('base64');

    const response = await axios.post(config.ups.tokenUrl, 'grant_type=client_credentials', {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 10000,
    });

    cachedToken = response.data.access_token;
    // Expire 60 seconds early to avoid edge cases
    const expiresIn = (response.data.expires_in || 3600) - 60;
    tokenExpiry = now + (expiresIn * 1000);

    logger.debug('UPS OAuth token refreshed');
    return cachedToken;
  } catch (err) {
    logger.error({ err }, 'Failed to get UPS OAuth token');
    throw err;
  }
}

/**
 * Get tracking details for a single tracking number.
 * Returns parsed tracking info including scheduled and actual delivery dates.
 */
async function getTrackingDetails(trackingNumber) {
  await upsLimiter.wait();

  try {
    const token = await getAccessToken();

    const response = await axios.get(`${config.ups.trackingUrl}/${trackingNumber}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'transId': uuidv4(),
        'transactionSrc': 'PioneerFeeders',
        'Content-Type': 'application/json',
      },
      timeout: 15000,
      params: {
        locale: 'en_US',
        returnSignature: 'false',
      },
    });

    return parseTrackingResponse(response.data, trackingNumber);
  } catch (err) {
    // Handle specific UPS error codes
    if (err.response) {
      const status = err.response.status;
      const errData = err.response.data;

      if (status === 404 || (errData?.response?.errors?.[0]?.code === '151044')) {
        logger.warn({ trackingNumber }, 'UPS tracking: No tracking info available yet');
        return { trackingNumber, status: 'not_found', scheduledDelivery: null, actualDelivery: null };
      }
    }

    logger.error({ err, trackingNumber }, 'Failed to get UPS tracking details');
    return { trackingNumber, status: 'error', scheduledDelivery: null, actualDelivery: null };
  }
}

/**
 * Parse the UPS tracking API response into a clean object.
 */
function parseTrackingResponse(data, trackingNumber) {
  const result = {
    trackingNumber,
    status: 'unknown',
    deliveryStatus: 'pending',
    scheduledDelivery: null,
    actualDelivery: null,
    lastActivity: null,
  };

  try {
    // Log raw response structure for debugging
    logger.info({ 
      trackingNumber, 
      topKeys: Object.keys(data || {}),
      raw: JSON.stringify(data).substring(0, 1000),
    }, 'UPS tracking raw response');

    // The response structure varies between API versions
    // Try the REST API v1 structure first
    const shipment = data?.trackResponse?.shipment?.[0] || data?.TrackResponse?.Shipment;
    if (!shipment) {
      // Check for warnings/errors in response (e.g., "no tracking info available")
      const warnings = data?.trackResponse?.shipment?.[0]?.warnings || 
                       data?.trackResponse?.warnings ||
                       data?.response?.errors;
      if (warnings) {
        logger.info({ trackingNumber, warnings: JSON.stringify(warnings).substring(0, 500) }, 'UPS tracking warnings');
      }
      logger.warn({ trackingNumber }, 'No shipment data in UPS tracking response');
      return result;
    }

    // Scheduled delivery date
    // Can be at shipment level or unavailable
    if (shipment.scheduledDeliveryDate) {
      result.scheduledDelivery = parseUpsDate(shipment.scheduledDeliveryDate);
    } else if (shipment.ScheduledDeliveryDate) {
      result.scheduledDelivery = parseUpsDate(shipment.ScheduledDeliveryDate);
    }

    // Package-level data
    const pkg = Array.isArray(shipment.package) ? shipment.package[0] :
                Array.isArray(shipment.Package) ? shipment.Package :
                shipment.package || shipment.Package;

    if (pkg) {
      const pkgData = Array.isArray(pkg) ? pkg[0] : pkg;

      // Actual delivery date
      if (pkgData.deliveryDate) {
        const delDate = Array.isArray(pkgData.deliveryDate) ? pkgData.deliveryDate[0] : pkgData.deliveryDate;
        if (delDate.date) {
          result.actualDelivery = parseUpsDate(delDate.date);
        }
      } else if (pkgData.DeliveryDate) {
        result.actualDelivery = parseUpsDate(pkgData.DeliveryDate);
      }

      // Check delivery indicator
      if (pkgData.deliveryIndicator === 'Y' || pkgData.DeliveryIndicator === 'Y') {
        result.deliveryStatus = 'delivered';
      }

      // Get latest activity for status
      const activities = pkgData.activity || pkgData.Activity || [];
      const latestActivity = Array.isArray(activities) ? activities[0] : activities;

      if (latestActivity) {
        const statusType = latestActivity.status?.type || latestActivity.Status?.Type;
        const statusDesc = latestActivity.status?.description || latestActivity.Status?.Description;

        result.lastActivity = {
          type: statusType,
          description: statusDesc,
          date: latestActivity.date || latestActivity.Date,
          time: latestActivity.time || latestActivity.Time,
        };

        // Map status type to our delivery_status enum
        switch (statusType) {
          case 'D': result.deliveryStatus = 'delivered'; break;
          case 'I': result.deliveryStatus = 'in_transit'; break;
          case 'P': result.deliveryStatus = 'in_transit'; break; // Picked up
          case 'M': result.deliveryStatus = 'pending'; break; // Manifest
          case 'X': result.deliveryStatus = 'exception'; break;
          case 'RS': result.deliveryStatus = 'returned'; break;
          default: result.deliveryStatus = 'in_transit';
        }

        // Build actual delivery timestamp if delivered
        if (result.deliveryStatus === 'delivered' && !result.actualDelivery) {
          const date = latestActivity.date || latestActivity.Date;
          const time = latestActivity.time || latestActivity.Time;
          if (date) {
            result.actualDelivery = parseUpsDateTime(date, time);
          }
        }
      }
    }

    result.status = 'ok';
  } catch (parseErr) {
    logger.error({ 
      parseErrMsg: parseErr?.message || String(parseErr), 
      parseErrStack: parseErr?.stack,
      trackingNumber,
    }, 'Error parsing UPS tracking response');
    result.status = 'parse_error';
  }

  return result;
}

/**
 * Parse UPS date format (YYYYMMDD) to ISO date string.
 */
function parseUpsDate(dateStr) {
  if (!dateStr || dateStr.length < 8) return null;
  const clean = dateStr.replace(/[^0-9]/g, '');
  if (clean.length < 8) return null;
  const year = clean.substring(0, 4);
  const month = clean.substring(4, 6);
  const day = clean.substring(6, 8);
  return `${year}-${month}-${day}T00:00:00Z`;
}

/**
 * Parse UPS date + time (YYYYMMDD + HHMMSS) to ISO timestamp.
 */
function parseUpsDateTime(dateStr, timeStr) {
  if (!dateStr) return null;
  const clean = dateStr.replace(/[^0-9]/g, '');
  if (clean.length < 8) return null;
  const year = clean.substring(0, 4);
  const month = clean.substring(4, 6);
  const day = clean.substring(6, 8);

  if (timeStr && timeStr.length >= 6) {
    const tClean = timeStr.replace(/[^0-9]/g, '');
    const hour = tClean.substring(0, 2);
    const min = tClean.substring(2, 4);
    const sec = tClean.substring(4, 6);
    return `${year}-${month}-${day}T${hour}:${min}:${sec}Z`;
  }

  return `${year}-${month}-${day}T00:00:00Z`;
}

module.exports = {
  getAccessToken,
  getTrackingDetails,
};
