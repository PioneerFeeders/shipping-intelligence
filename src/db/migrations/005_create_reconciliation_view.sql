CREATE OR REPLACE VIEW reconciliation_weekly AS
SELECT
    -- Order info
    o.shopify_order_number,
    o.shipstation_order_number,
    o.order_date,
    o.customer_name,
    o.items_json,
    o.item_revenue,
    o.total_cogs,
    o.shipping_paid_by_customer,
    o.shipping_method_selected,
    o.order_total,
    o.is_chewy_order,
    o.package_count,

    -- Shipment info
    s.id AS shipment_id,
    s.tracking_number,
    s.carrier_code,
    s.service_code,
    s.ups_account_type,
    s.ship_date,
    s.dimensions_length,
    s.dimensions_width,
    s.dimensions_height,
    s.weight_entered AS ss_weight_entered,
    s.label_cost,
    s.promised_delivery_date,
    s.actual_delivery_date,
    s.delivery_status,
    s.ship_to_name,
    s.ship_to_city,
    s.ship_to_state,
    s.ship_to_zip,
    s.is_residential,
    s.is_multi_package,
    s.split_revenue,
    s.split_cogs,
    s.split_shipping_paid,

    -- Invoice info
    i.id AS invoice_line_item_id,
    i.invoice_number,
    i.invoice_date,
    i.service AS ups_service_description,
    i.zone AS ups_zone,
    i.customer_weight AS ups_customer_weight,
    i.billed_weight AS ups_billed_weight,
    i.entered_dimensions AS ups_entered_dimensions,
    i.audited_dimensions AS ups_audited_dimensions,
    i.published_charge,
    i.incentive_credit,
    i.original_billed_total,
    i.fuel_surcharge,
    i.residential_surcharge,
    i.large_package_surcharge,
    i.das_extended,
    i.additional_handling,
    i.adjustment_amount,
    i.final_billed_total,

    -- Computed: Weight analysis (3 weights)
    (i.customer_weight - s.weight_entered) AS weight_delta_entry_vs_ups,
    (i.billed_weight - s.weight_entered) AS weight_delta_billed_vs_entered,
    (i.billed_weight - i.customer_weight) AS weight_delta_billed_vs_submitted,

    -- Computed: Dimension discrepancy
    CASE WHEN i.audited_dimensions IS NOT NULL
         AND i.audited_dimensions != ''
         AND i.audited_dimensions != i.entered_dimensions
    THEN TRUE ELSE FALSE END AS has_dimension_discrepancy,

    -- Computed: Cost analysis
    (i.final_billed_total - s.label_cost) AS cost_delta,
    (s.split_shipping_paid - COALESCE(i.final_billed_total, s.label_cost)) AS shipping_margin,

    -- Computed: Late delivery
    CASE WHEN s.actual_delivery_date IS NOT NULL
         AND s.promised_delivery_date IS NOT NULL
         AND s.actual_delivery_date > s.promised_delivery_date
    THEN TRUE ELSE FALSE END AS is_late,

    -- Computed: Claim eligible (late + UPS carrier)
    CASE WHEN s.actual_delivery_date IS NOT NULL
         AND s.promised_delivery_date IS NOT NULL
         AND s.actual_delivery_date > s.promised_delivery_date
         AND s.carrier_code = 'ups'
    THEN TRUE ELSE FALSE END AS claim_eligible

FROM shipments s
JOIN orders o ON s.order_id = o.id
LEFT JOIN invoice_line_items i ON s.tracking_number = i.tracking_number
WHERE s.is_voided = FALSE;
