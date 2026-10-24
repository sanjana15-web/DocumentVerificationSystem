-- Recognize combined issuer/recipient labels and specific financial headings.
UPDATE document_types
SET fields_json = JSON_SET(
  fields_json,
  '$[1].aliases', JSON_ARRAY('supplier name', 'supplier', 'vendor name', 'vendor', 'seller', 'bill from', 'issuer', 'issuer / vendor'),
  '$[2].aliases', JSON_ARRAY('buyer name', 'buyer', 'bill to', 'bill to / recipient', 'recipient', 'billed to', 'customer'),
  '$[6].aliases', JSON_ARRAY('tax amount', 'total tax', 'sales tax amount', 'sales tax', 'gst amount', 'vat amount', 'tax', 'vat', 'gst'),
  '$[8].aliases', JSON_ARRAY('grand total', 'invoice total', 'amount payable', 'total amount due', 'total amount', 'amount due', 'total due', 'balance due', 'total'),
  '$[10].aliases', JSON_ARRAY('purchase order', 'purchase order no', 'purchase order number', 'po number', 'po #')
)
WHERE id = 'invoice'
  AND JSON_UNQUOTE(JSON_EXTRACT(fields_json, '$[1].id')) = 'vendor_name'
  AND JSON_UNQUOTE(JSON_EXTRACT(fields_json, '$[2].id')) = 'buyer_name'
  AND JSON_UNQUOTE(JSON_EXTRACT(fields_json, '$[10].id')) = 'purchase_order_reference';

INSERT IGNORE INTO schema_migrations (version) VALUES ('005_invoice_composite_label_aliases');
