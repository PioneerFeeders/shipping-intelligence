-- ============================================================
-- DEMAND FORECAST TABLES
-- Run against Neon PostgreSQL
-- ============================================================

-- Chewy demand forecasts (from vendor statement Excel)
-- Stores physical cup equivalents per month
CREATE TABLE IF NOT EXISTS demand_chewy_forecast (
  id SERIAL PRIMARY KEY,
  forecast_month DATE NOT NULL,         -- first of month, e.g. 2026-03-01
  sku VARCHAR(30) NOT NULL,             -- HW25COUNT, HW50COUNT, etc.
  sku_units INTEGER NOT NULL DEFAULT 0, -- raw SKU units from Chewy
  cups_per_sku INTEGER NOT NULL DEFAULT 1, -- 1,2,3,4 based on SKU
  physical_cups INTEGER NOT NULL DEFAULT 0, -- sku_units * cups_per_sku
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source VARCHAR(50) DEFAULT 'manual',  -- 'manual', 'n8n_email', 'api'
  UNIQUE(forecast_month, sku)
);

-- Amazon monthly sales (from CSV uploads)
CREATE TABLE IF NOT EXISTS demand_amazon_monthly (
  id SERIAL PRIMARY KEY,
  sales_month DATE NOT NULL,            -- first of month
  units_sold INTEGER NOT NULL DEFAULT 0,
  revenue NUMERIC(12,2) NOT NULL DEFAULT 0,
  active_days INTEGER NOT NULL DEFAULT 0,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(sales_month)
);

-- Shopify weekly cup sales (backfilled + refreshed)
CREATE TABLE IF NOT EXISTS demand_shopify_weekly (
  id SERIAL PRIMARY KEY,
  week_start DATE NOT NULL,             -- Monday of the week
  hornworm_cups INTEGER NOT NULL DEFAULT 0,
  silkworm_cups INTEGER NOT NULL DEFAULT 0,
  total_orders INTEGER NOT NULL DEFAULT 0,
  revenue NUMERIC(12,2) NOT NULL DEFAULT 0,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(week_start)
);

-- Cup pouring log (synced from Google Sheet)
CREATE TABLE IF NOT EXISTS cup_pouring_log (
  id SERIAL PRIMARY KEY,
  pour_date DATE NOT NULL,
  cups_24ct INTEGER NOT NULL DEFAULT 0, -- main hornworm cups
  cups_12ct INTEGER NOT NULL DEFAULT 0, -- small hornworm cups (negligible)
  shrinkage INTEGER NOT NULL DEFAULT 76, -- 40 food + 36 holdback
  sellable_cups INTEGER GENERATED ALWAYS AS (GREATEST(cups_24ct + cups_12ct - 76, 0)) STORED,
  logged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(pour_date)
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_chewy_forecast_month ON demand_chewy_forecast(forecast_month);
CREATE INDEX IF NOT EXISTS idx_amazon_month ON demand_amazon_monthly(sales_month);
CREATE INDEX IF NOT EXISTS idx_shopify_week ON demand_shopify_weekly(week_start);
CREATE INDEX IF NOT EXISTS idx_pour_date ON cup_pouring_log(pour_date);
