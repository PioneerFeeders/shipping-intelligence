#!/usr/bin/env node
/**
 * Seed the demand forecast tables with initial data.
 * Run this AFTER deployment with:
 *   node src/scripts/seed-forecast.js https://shipping-intelligence-production.up.railway.app pioneer2026
 */

const BASE_URL = process.argv[2] || 'http://localhost:3000';
const PASSWORD = process.argv[3] || 'pioneer2026';

async function main() {
  // 1. Authenticate
  console.log('Authenticating...');
  const authRes = await fetch(`${BASE_URL}/dashboard/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const cookies = authRes.headers.getSetCookie?.() || [];
  const cookie = cookies.find(c => c.includes('dashboard_token'))?.split(';')[0] || '';
  if (!cookie) {
    // Fallback: use token header
    console.log('Using token header auth');
  }
  const headers = {
    'Content-Type': 'application/json',
    'Cookie': cookie,
    'x-dashboard-token': PASSWORD,
  };

  // 2. Run migration
  console.log('\n--- Running migration ---');
  const migRes = await fetch(`${BASE_URL}/dashboard/api/forecast/migrate`, { method: 'POST', headers });
  console.log('Migration:', await migRes.json());

  // 3. Seed Chewy forecast (from vendor_statement.xlsx)
  console.log('\n--- Seeding Chewy forecast ---');
  const chewyForecasts = [
    // HW25COUNT - 1 cup per SKU
    { sku: 'HW25COUNT', month: '2026-02-01', units: 164, source: 'seed' },
    { sku: 'HW25COUNT', month: '2026-03-01', units: 393, source: 'seed' },
    { sku: 'HW25COUNT', month: '2026-04-01', units: 403, source: 'seed' },
    { sku: 'HW25COUNT', month: '2026-05-01', units: 465, source: 'seed' },
    { sku: 'HW25COUNT', month: '2026-06-01', units: 509, source: 'seed' },
    { sku: 'HW25COUNT', month: '2026-07-01', units: 539, source: 'seed' },
    { sku: 'HW25COUNT', month: '2026-08-01', units: 267, source: 'seed' },
    // HW50COUNT - 2 cups per SKU
    { sku: 'HW50COUNT', month: '2026-02-01', units: 32, source: 'seed' },
    { sku: 'HW50COUNT', month: '2026-03-01', units: 78, source: 'seed' },
    { sku: 'HW50COUNT', month: '2026-04-01', units: 80, source: 'seed' },
    { sku: 'HW50COUNT', month: '2026-05-01', units: 91, source: 'seed' },
    { sku: 'HW50COUNT', month: '2026-06-01', units: 96, source: 'seed' },
    { sku: 'HW50COUNT', month: '2026-07-01', units: 104, source: 'seed' },
    { sku: 'HW50COUNT', month: '2026-08-01', units: 52, source: 'seed' },
    // HW75COUNT - 3 cups per SKU
    { sku: 'HW75COUNT', month: '2026-02-01', units: 12, source: 'seed' },
    { sku: 'HW75COUNT', month: '2026-03-01', units: 30, source: 'seed' },
    { sku: 'HW75COUNT', month: '2026-04-01', units: 31, source: 'seed' },
    { sku: 'HW75COUNT', month: '2026-05-01', units: 36, source: 'seed' },
    { sku: 'HW75COUNT', month: '2026-06-01', units: 39, source: 'seed' },
    { sku: 'HW75COUNT', month: '2026-07-01', units: 42, source: 'seed' },
    { sku: 'HW75COUNT', month: '2026-08-01', units: 21, source: 'seed' },
    // HW100COUNT - 4 cups per SKU
    { sku: 'HW100COUNT', month: '2026-02-01', units: 5, source: 'seed' },
    { sku: 'HW100COUNT', month: '2026-03-01', units: 13, source: 'seed' },
    { sku: 'HW100COUNT', month: '2026-04-01', units: 14, source: 'seed' },
    { sku: 'HW100COUNT', month: '2026-05-01', units: 16, source: 'seed' },
    { sku: 'HW100COUNT', month: '2026-06-01', units: 17, source: 'seed' },
    { sku: 'HW100COUNT', month: '2026-07-01', units: 19, source: 'seed' },
    { sku: 'HW100COUNT', month: '2026-08-01', units: 9, source: 'seed' },
  ];

  const chewyRes = await fetch(`${BASE_URL}/dashboard/api/forecast/chewy-ingest`, {
    method: 'POST', headers,
    body: JSON.stringify({ forecasts: chewyForecasts }),
  });
  console.log('Chewy:', await chewyRes.json());

  // 4. Seed Amazon monthly data (from SalesDashboard CSV)
  console.log('\n--- Seeding Amazon monthly data ---');
  const amazonMonths = [
    { month: '2025-04-01', units: 296, revenue: 4306.22, active_days: 21 },
    { month: '2025-05-01', units: 402, revenue: 5859.50, active_days: 29 },
    { month: '2025-06-01', units: 113, revenue: 1481.31, active_days: 15 },
    { month: '2025-07-01', units: 98, revenue: 1329.47, active_days: 18 },
    { month: '2025-08-01', units: 193, revenue: 2670.05, active_days: 29 },
    { month: '2025-09-01', units: 98, revenue: 1472.68, active_days: 27 },
    { month: '2025-10-01', units: 91, revenue: 1366.39, active_days: 14 },
  ];

  const amzRes = await fetch(`${BASE_URL}/dashboard/api/forecast/amazon-upload`, {
    method: 'POST', headers,
    body: JSON.stringify({ months: amazonMonths }),
  });
  console.log('Amazon:', await amzRes.json());

  // 5. Seed cup pouring log (from Google Sheet CSV)
  console.log('\n--- Seeding cup pouring log ---');
  const pours = [
    { date: '2024-07-18', cups_24ct: 800, cups_12ct: 1 },
    { date: '2024-07-25', cups_24ct: 717, cups_12ct: 120 },
    { date: '2024-08-01', cups_24ct: 864, cups_12ct: 1 },
    { date: '2024-08-08', cups_24ct: 800, cups_12ct: 80 },
    { date: '2024-08-15', cups_24ct: 773, cups_12ct: 30 },
    { date: '2024-08-22', cups_24ct: 778, cups_12ct: 64 },
    { date: '2024-08-29', cups_24ct: 770, cups_12ct: 1 },
    { date: '2024-09-05', cups_24ct: 760, cups_12ct: 80 },
    { date: '2024-09-12', cups_24ct: 801, cups_12ct: 59 },
    { date: '2024-09-19', cups_24ct: 760, cups_12ct: 80 },
    { date: '2024-09-26', cups_24ct: 840, cups_12ct: 72 },
    { date: '2024-10-03', cups_24ct: 575, cups_12ct: 1 },
    { date: '2024-10-10', cups_24ct: 795, cups_12ct: 82 },
    { date: '2024-10-17', cups_24ct: 840, cups_12ct: 91 },
    { date: '2024-10-24', cups_24ct: 840, cups_12ct: 70 },
    { date: '2024-10-31', cups_24ct: 861, cups_12ct: 81 },
    { date: '2024-11-07', cups_24ct: 805, cups_12ct: 58 },
    { date: '2024-11-27', cups_24ct: 510, cups_12ct: 80 },
    { date: '2024-12-12', cups_24ct: 760, cups_12ct: 79 },
    { date: '2024-12-19', cups_24ct: 502, cups_12ct: 87 },
    { date: '2024-12-26', cups_24ct: 750, cups_12ct: 0 },
    { date: '2025-01-01', cups_24ct: 810, cups_12ct: 90 },
    { date: '2025-01-02', cups_24ct: 600, cups_12ct: 0 },
    { date: '2025-01-07', cups_24ct: 900, cups_12ct: 0 },
    { date: '2025-01-08', cups_24ct: 760, cups_12ct: 120 },
    { date: '2025-01-09', cups_24ct: 850, cups_12ct: 0 },
    { date: '2025-01-16', cups_24ct: 760, cups_12ct: 80 },
    { date: '2025-01-21', cups_24ct: 640, cups_12ct: 0 },
    { date: '2025-01-23', cups_24ct: 804, cups_12ct: 80 },
    { date: '2025-01-30', cups_24ct: 630, cups_12ct: 2 },
    { date: '2025-02-06', cups_24ct: 800, cups_12ct: 103 },
    { date: '2025-02-13', cups_24ct: 712, cups_12ct: 80 },
    { date: '2025-02-27', cups_24ct: 700, cups_12ct: 80 },
    { date: '2025-03-06', cups_24ct: 800, cups_12ct: 36 },
    { date: '2025-03-13', cups_24ct: 800, cups_12ct: 80 },
    { date: '2025-03-27', cups_24ct: 800, cups_12ct: 37 },
    { date: '2025-04-03', cups_24ct: 840, cups_12ct: 1 },
    { date: '2025-04-10', cups_24ct: 840, cups_12ct: 80 },
    { date: '2025-04-17', cups_24ct: 840, cups_12ct: 80 },
    { date: '2025-04-24', cups_24ct: 840, cups_12ct: 1 },
    { date: '2025-05-01', cups_24ct: 900, cups_12ct: 1 },
    { date: '2025-05-08', cups_24ct: 864, cups_12ct: 1 },
    { date: '2025-05-15', cups_24ct: 878, cups_12ct: 1 },
    { date: '2025-05-22', cups_24ct: 860, cups_12ct: 1 },
    { date: '2025-05-29', cups_24ct: 899, cups_12ct: 1 },
    { date: '2025-06-05', cups_24ct: 900, cups_12ct: 1 },
    { date: '2025-06-12', cups_24ct: 857, cups_12ct: 1 },
    { date: '2025-06-19', cups_24ct: 840, cups_12ct: 1 },
    { date: '2025-06-26', cups_24ct: 851, cups_12ct: 1 },
    { date: '2025-07-03', cups_24ct: 857, cups_12ct: 1 },
    { date: '2025-07-10', cups_24ct: 845, cups_12ct: 1 },
    { date: '2025-07-17', cups_24ct: 700, cups_12ct: 1 },
    { date: '2025-07-24', cups_24ct: 864, cups_12ct: 1 },
    { date: '2025-07-31', cups_24ct: 850, cups_12ct: 1 },
    { date: '2025-08-07', cups_24ct: 850, cups_12ct: 1 },
    { date: '2025-08-14', cups_24ct: 691, cups_12ct: 1 },
    { date: '2025-08-21', cups_24ct: 840, cups_12ct: 1 },
    { date: '2025-08-28', cups_24ct: 857, cups_12ct: 1 },
    { date: '2025-09-04', cups_24ct: 1000, cups_12ct: 1 },
    { date: '2025-09-10', cups_24ct: 864, cups_12ct: 1 },
    { date: '2025-09-18', cups_24ct: 840, cups_12ct: 1 },
    { date: '2025-09-25', cups_24ct: 840, cups_12ct: 1 },
    { date: '2025-10-02', cups_24ct: 800, cups_12ct: 0 },
    { date: '2025-10-09', cups_24ct: 1291, cups_12ct: 0 },
    { date: '2025-10-16', cups_24ct: 1144, cups_12ct: 0 },
    { date: '2025-11-13', cups_24ct: 884, cups_12ct: 0 },
    { date: '2025-12-11', cups_24ct: 900, cups_12ct: 0 },
    { date: '2026-01-01', cups_24ct: 850, cups_12ct: 0 },
    { date: '2026-01-07', cups_24ct: 900, cups_12ct: 0 },
    { date: '2026-01-16', cups_24ct: 900, cups_12ct: 0 },
  ];

  const pourRes = await fetch(`${BASE_URL}/dashboard/api/forecast/pour-sync`, {
    method: 'POST', headers,
    body: JSON.stringify({ pours }),
  });
  console.log('Pours:', await pourRes.json());

  // 6. Trigger Shopify backfill
  console.log('\n--- Triggering Shopify 12-month backfill ---');
  console.log('(This may take a few minutes due to API rate limiting)');
  const shopRes = await fetch(`${BASE_URL}/dashboard/api/forecast/shopify-backfill`, {
    method: 'POST', headers,
  });
  console.log('Shopify:', await shopRes.json());

  console.log('\n=== Seed complete! ===');
}

main().catch(console.error);
