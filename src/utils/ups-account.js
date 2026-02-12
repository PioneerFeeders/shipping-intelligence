/**
 * Determine UPS account type from tracking number prefix.
 * 
 * NDA account (R1833C066): tracking numbers start with 1ZR1833C
 * Ground account (J9299A036): tracking numbers start with 1ZJ9299A
 * 
 * Returns 'nda', 'ground', or null if not a recognized UPS tracking number.
 */
function getUpsAccountType(trackingNumber) {
  if (!trackingNumber) return null;
  const upper = trackingNumber.toUpperCase();
  if (upper.startsWith('1ZR1833C')) return 'nda';
  if (upper.startsWith('1ZJ9299A')) return 'ground';
  return null;
}

/**
 * Check if a tracking number is a UPS tracking number (starts with 1Z).
 */
function isUpsTracking(trackingNumber) {
  if (!trackingNumber) return false;
  return trackingNumber.toUpperCase().startsWith('1Z');
}

/**
 * Determine UPS account type from an invoice number.
 * Invoice numbers contain the account number: e.g., 0000R1833C066
 */
function getAccountTypeFromInvoice(invoiceNumber) {
  if (!invoiceNumber) return null;
  const upper = invoiceNumber.toUpperCase();
  if (upper.includes('R1833C')) return 'nda';
  if (upper.includes('J9299A')) return 'ground';
  return null;
}

/**
 * Check if an order number indicates a Chewy order.
 */
function isChewyOrder(orderNumber) {
  if (!orderNumber) return false;
  return orderNumber.toUpperCase().includes('CH');
}

module.exports = {
  getUpsAccountType,
  isUpsTracking,
  getAccountTypeFromInvoice,
  isChewyOrder,
};
