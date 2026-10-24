-- Align stored invoice aliases with common header and financial-summary labels.
UPDATE document_types
SET fields_json = JSON_SET(
  fields_json,
  '$[2].aliases', JSON_ARRAY('buyer name', 'buyer', 'bill to', 'bill to / recipient', 'recipient', 'billed to', 'billed to (client / organization)', 'customer'),
  '$[3].aliases', JSON_ARRAY('invoice date', 'issue date', 'date of invoice', 'dated', 'date'),
  '$[6].aliases', JSON_ARRAY('tax amount', 'total tax', 'sales tax amount', 'sales tax', 'state & local sales tax', 'gst amount', 'vat amount', 'tax', 'vat', 'gst'),
  '$[9].aliases', JSON_ARRAY('currency', 'billing currency'),
  '$[10].aliases', JSON_ARRAY('purchase order', 'purchase order ref', 'purchase order no', 'purchase order number', 'po number', 'po #')
)
WHERE id = 'invoice'
  AND JSON_UNQUOTE(JSON_EXTRACT(fields_json, '$[2].id')) = 'buyer_name'
  AND JSON_UNQUOTE(JSON_EXTRACT(fields_json, '$[3].id')) = 'invoice_date'
  AND JSON_UNQUOTE(JSON_EXTRACT(fields_json, '$[9].id')) = 'currency'
  AND JSON_UNQUOTE(JSON_EXTRACT(fields_json, '$[10].id')) = 'purchase_order_reference';

INSERT IGNORE INTO schema_migrations (version) VALUES ('006_invoice_header_and_summary_aliases');
