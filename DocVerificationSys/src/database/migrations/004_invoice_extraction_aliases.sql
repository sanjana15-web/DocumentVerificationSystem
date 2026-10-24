-- Keep the persisted invoice schema aligned with the aliases used by OCR.
UPDATE document_types
SET fields_json = JSON_SET(
  fields_json,
  '$[0].aliases', JSON_ARRAY('invoice number', 'invoice no', 'invoice #', 'invoice id'),
  '$[1].aliases', JSON_ARRAY('supplier name', 'supplier', 'vendor name', 'vendor', 'seller', 'bill from'),
  '$[2].aliases', JSON_ARRAY('buyer name', 'buyer', 'bill to', 'billed to', 'customer'),
  '$[3].aliases', JSON_ARRAY('invoice date', 'date of invoice', 'dated', 'date'),
  '$[4].aliases', JSON_ARRAY('payment due date', 'due date'),
  '$[5].aliases', JSON_ARRAY('subtotal', 'sub total', 'net amount'),
  '$[6].aliases', JSON_ARRAY('tax amount', 'total tax', 'sales tax', 'gst amount', 'vat amount', 'tax', 'vat', 'gst'),
  '$[7].aliases', JSON_ARRAY('discount'),
  '$[8].aliases', JSON_ARRAY('grand total', 'invoice total', 'amount payable', 'total amount', 'amount due', 'total due', 'balance due', 'total')
)
WHERE id = 'invoice'
  AND JSON_UNQUOTE(JSON_EXTRACT(fields_json, '$[0].id')) = 'invoice_number'
  AND JSON_UNQUOTE(JSON_EXTRACT(fields_json, '$[8].id')) = 'total_amount';

INSERT IGNORE INTO schema_migrations (version) VALUES ('004_invoice_extraction_aliases');
