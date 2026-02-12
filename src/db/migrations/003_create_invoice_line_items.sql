CREATE TABLE IF NOT EXISTS invoice_line_items (
    id SERIAL PRIMARY KEY,
    shipment_id INTEGER REFERENCES shipments(id),
    tracking_number TEXT NOT NULL,
    invoice_number TEXT,
    invoice_date DATE,
    ups_account_type TEXT,
    pickup_date DATE,
    service TEXT,
    zone TEXT,
    receiver_zip TEXT,
    customer_weight NUMERIC(8,2),
    billed_weight NUMERIC(8,2),
    entered_dimensions TEXT,
    audited_dimensions TEXT,
    published_charge NUMERIC(10,2),
    incentive_credit NUMERIC(10,2),
    original_billed_total NUMERIC(10,2),
    fuel_surcharge NUMERIC(10,2),
    residential_surcharge NUMERIC(10,2),
    large_package_surcharge NUMERIC(10,2),
    das_extended NUMERIC(10,2),
    additional_handling NUMERIC(10,2),
    adjustment_amount NUMERIC(10,2),
    final_billed_total NUMERIC(10,2),
    receiver_name TEXT,
    receiver_company TEXT,
    receiver_city TEXT,
    receiver_state TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoice_tracking ON invoice_line_items(tracking_number);
CREATE INDEX IF NOT EXISTS idx_invoice_shipment_id ON invoice_line_items(shipment_id);
CREATE INDEX IF NOT EXISTS idx_invoice_invoice_number ON invoice_line_items(invoice_number);
CREATE INDEX IF NOT EXISTS idx_invoice_invoice_date ON invoice_line_items(invoice_date);
