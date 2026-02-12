CREATE TABLE IF NOT EXISTS invoice_uploads (
    id SERIAL PRIMARY KEY,
    invoice_number TEXT,
    ups_account_type TEXT,
    invoice_date DATE,
    invoice_total NUMERIC(12,2),
    line_item_count INTEGER,
    matched_count INTEGER DEFAULT 0,
    unmatched_count INTEGER DEFAULT 0,
    uploaded_at TIMESTAMPTZ DEFAULT NOW(),
    reconciled BOOLEAN DEFAULT FALSE
);
