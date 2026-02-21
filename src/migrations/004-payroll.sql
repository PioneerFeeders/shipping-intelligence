-- ============================================================
-- PAYROLL TABLES — Run this against your ops-dashboard Postgres
-- ============================================================

-- Employees table
CREATE TABLE IF NOT EXISTS payroll_employees (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  pay_type VARCHAR(10) NOT NULL CHECK (pay_type IN ('hourly', 'fixed')),
  hourly_rate NUMERIC(10,2),          -- NULL for fixed employees
  weekly_fixed NUMERIC(10,2),         -- NULL for hourly employees
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Weekly payroll entries
CREATE TABLE IF NOT EXISTS payroll_weeks (
  id SERIAL PRIMARY KEY,
  week_start DATE NOT NULL,           -- Monday of the week
  employee_id INTEGER NOT NULL REFERENCES payroll_employees(id),
  hours NUMERIC(5,2),                 -- NULL for fixed employees
  pay NUMERIC(10,2) NOT NULL,         -- Calculated or fixed amount
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(week_start, employee_id)
);

-- Index for fast week lookups
CREATE INDEX IF NOT EXISTS idx_payroll_weeks_start ON payroll_weeks(week_start);

-- Seed employees
INSERT INTO payroll_employees (name, pay_type, hourly_rate, weekly_fixed) VALUES
  ('Justin',  'fixed',  NULL,  500.00),
  ('Andrea',  'hourly', 15.00, NULL),
  ('Jeremy',  'hourly', 14.00, NULL),
  ('Gabe',    'hourly', 15.00, NULL),
  ('Ami',     'hourly', 14.00, NULL),
  ('Sarah',   'fixed',  NULL,  250.00)
ON CONFLICT DO NOTHING;
