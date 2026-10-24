-- Keep optional invoice dates and discounts optional in previously seeded schemas.
UPDATE document_types
SET fields_json = JSON_SET(
  fields_json,
  '$[4].required', FALSE,
  '$[7].required', FALSE
)
WHERE id = 'invoice'
  AND JSON_UNQUOTE(JSON_EXTRACT(fields_json, '$[4].id')) = 'due_date'
  AND JSON_UNQUOTE(JSON_EXTRACT(fields_json, '$[7].id')) = 'discount';

-- Earlier OCR persistence stringified Python nulls as the literal "null".
-- Only reset untouched extraction rows with the missing-value markers.
UPDATE extracted_fields
SET field_value = NULL
WHERE field_value = 'null'
  AND is_corrected = 0
  AND original_value IS NULL
  AND source_text IS NULL
  AND confidence = 0;

INSERT IGNORE INTO schema_migrations (version) VALUES ('003_invoice_optional_fields');
