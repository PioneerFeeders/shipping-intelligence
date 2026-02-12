CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    shopify_order_id BIGINT UNIQUE NOT NULL,
    shopify_order_number TEXT,
    shipstation_order_number TEXT,
    order_date TIMESTAMPTZ,
    customer_name TEXT,
    customer_email TEXT,
    items_json JSONB,
    item_revenue NUMERIC(10,2),
    total_cogs NUMERIC(10,2),
    shipping_paid_by_customer NUMERIC(10,2),
    shipping_method_selected TEXT,
    order_total NUMERIC(10,2),
    is_chewy_order BOOLEAN DEFAULT FALSE,
    package_count INTEGER DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_shopify_order_id ON orders(shopify_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_shipstation_order_number ON orders(shipstation_order_number);
CREATE INDEX IF NOT EXISTS idx_orders_order_date ON orders(order_date);
