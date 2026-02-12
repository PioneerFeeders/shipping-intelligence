CREATE TABLE IF NOT EXISTS shipments (
    id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES orders(id),
    shipstation_shipment_id TEXT,
    shipstation_label_id TEXT,
    tracking_number TEXT UNIQUE NOT NULL,
    carrier_code TEXT,
    service_code TEXT,
    ups_account_type TEXT,
    ship_date TIMESTAMPTZ,
    dimensions_length NUMERIC(6,2),
    dimensions_width NUMERIC(6,2),
    dimensions_height NUMERIC(6,2),
    weight_entered NUMERIC(8,2),
    label_cost NUMERIC(10,2),
    promised_delivery_date TIMESTAMPTZ,
    actual_delivery_date TIMESTAMPTZ,
    delivery_status TEXT DEFAULT 'pending',
    is_late BOOLEAN,
    ship_to_name TEXT,
    ship_to_city TEXT,
    ship_to_state TEXT,
    ship_to_zip TEXT,
    is_residential BOOLEAN,
    is_multi_package BOOLEAN DEFAULT FALSE,
    split_revenue NUMERIC(10,2),
    split_cogs NUMERIC(10,2),
    split_shipping_paid NUMERIC(10,2),
    is_voided BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shipments_tracking_number ON shipments(tracking_number);
CREATE INDEX IF NOT EXISTS idx_shipments_order_id ON shipments(order_id);
CREATE INDEX IF NOT EXISTS idx_shipments_ship_date ON shipments(ship_date);
CREATE INDEX IF NOT EXISTS idx_shipments_delivery_status ON shipments(delivery_status);
CREATE INDEX IF NOT EXISTS idx_shipments_carrier_code ON shipments(carrier_code);
