-- Persist a separate tax-rate field without conflating it with the tax amount.
UPDATE document_types
SET fields_json = JSON_SET(
  fields_json,
  '$[6].aliases', JSON_ARRAY('tax amount', 'total tax', 'sales tax amount', 'sales tax', 'state & local sales tax', 'gst amount', 'vat amount', 'cgst', 'sgst', 'igst', 'tax', 'vat', 'gst')
)
WHERE id = 'invoice'
  AND JSON_UNQUOTE(JSON_EXTRACT(fields_json, '$[6].id')) = 'tax_amount';

UPDATE document_types
SET fields_json = JSON_ARRAY_APPEND(
  fields_json,
  '$',
  JSON_OBJECT(
    'id', 'tax_rate',
    'label', 'Tax rate',
    'type', 'string',
    'required', false,
    'aliases', JSON_ARRAY('tax rate', 'gst rate', 'rate (%)')
  )
)
WHERE id = 'invoice'
  AND JSON_SEARCH(fields_json, 'one', 'tax_rate', NULL, '$[*].id') IS NULL;

INSERT IGNORE INTO schema_migrations (version) VALUES ('007_invoice_tax_rate_field');
