const express = require('express');
const router = express.Router();
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const fs = require('fs');
const logger = require('../utils/logger');
const invoiceModel = require('../models/invoice');
const { getAccountTypeFromInvoice } = require('../utils/ups-account');

// Configure multer for file uploads
const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 10 * 1024 * 1024 } });

/**
 * POST /invoices/upload
 * 
 * Accepts a parsed UPS invoice CSV file.
 * Loads it into invoice_line_items and runs matching.
 */
router.post('/upload', upload.single('invoice'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const csvContent = fs.readFileSync(req.file.path, 'utf-8');

    // Parse CSV
    const records = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    if (records.length === 0) {
      return res.status(400).json({ error: 'CSV file is empty' });
    }

    logger.info({ rowCount: records.length, file: req.file.originalname }, 'Parsing invoice CSV');

    // Determine account type from first record's invoice number
    const firstRecord = records[0];
    const invoiceNumber = firstRecord['Invoice Number'] || firstRecord.invoice_number;
    const upsAccountType = getAccountTypeFromInvoice(invoiceNumber);
    const invoiceDate = firstRecord['Invoice Date'] || firstRecord.invoice_date;
    const invoiceTotal = parseFloat(firstRecord['Invoice Total'] || firstRecord.invoice_total || 0);

    // Transform records to our schema
    const lineItems = records.map(row => ({
      trackingNumber: row['Tracking Number'] || row.tracking_number,
      invoiceNumber: row['Invoice Number'] || row.invoice_number,
      invoiceDate: parseInvoiceDate(row['Invoice Date'] || row.invoice_date),
      upsAccountType,
      pickupDate: parseInvoiceDate(row['Pickup Date'] || row.pickup_date),
      service: row['Service'] || row.service,
      zone: row['Zone'] || row.zone,
      receiverZip: row['Receiver ZIP'] || row['ZIP Code'] || row.receiver_zip,
      customerWeight: parseNum(row['Customer Weight'] || row.customer_weight),
      billedWeight: parseNum(row['Billed Weight'] || row.billed_weight),
      enteredDimensions: row['Entered Dimensions'] || row.entered_dimensions,
      auditedDimensions: row['Audited Dimensions'] || row.audited_dimensions || null,
      publishedCharge: parseNum(row['Published Charge'] || row.published_charge),
      incentiveCredit: parseNum(row['Incentive Credit'] || row.incentive_credit),
      originalBilledTotal: parseNum(row['Original Billed Total'] || row.original_billed_total),
      fuelSurcharge: parseNum(row['Fuel Surcharge'] || row.fuel_surcharge),
      residentialSurcharge: parseNum(row['Residential Surcharge'] || row.residential_surcharge),
      largePackageSurcharge: parseNum(row['Large Package Surcharge'] || row.large_package_surcharge),
      dasExtended: parseNum(row['DAS Extended'] || row.das_extended),
      additionalHandling: parseNum(row['Additional Handling'] || row.additional_handling),
      adjustmentAmount: parseNum(row['Adjustment Amount'] || row.adjustment_amount),
      finalBilledTotal: parseNum(row['Final Billed Total'] || row.final_billed_total),
      receiverName: row['Receiver Name'] || row.receiver_name,
      receiverCompany: row['Receiver Company'] || row.receiver_company,
      receiverCity: row['Receiver City'] || row.receiver_city,
      receiverState: row['Receiver State'] || row.receiver_state,
    }));

    // Insert line items
    const insertedCount = await invoiceModel.insertLineItems(lineItems);

    // Create upload record
    const uploadRecord = await invoiceModel.createUploadRecord({
      invoiceNumber,
      upsAccountType,
      invoiceDate: parseInvoiceDate(invoiceDate),
      invoiceTotal,
      lineItemCount: insertedCount,
    });

    // Run matching
    const { matched, unmatched } = await invoiceModel.matchToShipments(invoiceNumber);

    // Update upload record
    await invoiceModel.updateUploadRecord(uploadRecord.id, matched, unmatched);

    logger.info({
      invoiceNumber,
      upsAccountType,
      inserted: insertedCount,
      matched,
      unmatched,
    }, 'Invoice processed');

    // Clean up temp file
    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      invoiceNumber,
      upsAccountType,
      lineItems: insertedCount,
      matched,
      unmatched,
      uploadId: uploadRecord.id,
    });

  } catch (err) {
    logger.error({ err }, 'Failed to process invoice upload');
    // Clean up temp file on error
    if (req.file?.path) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
    }
    res.status(500).json({ error: 'Failed to process invoice', details: err.message });
  }
});

/**
 * GET /invoices/unmatched
 * Returns invoice line items that couldn't be matched to shipments.
 */
router.get('/unmatched', async (req, res) => {
  try {
    const invoiceNumber = req.query.invoice_number || null;
    const unmatched = await invoiceModel.getUnmatched(invoiceNumber);
    res.json({ count: unmatched.length, items: unmatched });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch unmatched items');
    res.status(500).json({ error: err.message });
  }
});

// Helper: parse number, return null if invalid
function parseNum(val) {
  if (val === undefined || val === null || val === '') return null;
  const num = parseFloat(String(val).replace(/,/g, ''));
  return isNaN(num) ? null : num;
}

// Helper: parse various date formats from UPS invoice
function parseInvoiceDate(dateStr) {
  if (!dateStr) return null;
  // Handle "February 7, 2026" format
  const parsed = new Date(dateStr);
  if (!isNaN(parsed.getTime())) return parsed.toISOString().split('T')[0];
  // Handle MM/DD/YYYY format
  const parts = dateStr.split('/');
  if (parts.length === 3) {
    return `${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
  }
  return null;
}

module.exports = router;
