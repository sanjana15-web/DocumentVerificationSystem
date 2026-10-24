-- Migration 002: configurable document type registry and richer extraction metadata.
ALTER TABLE submissions
  MODIFY COLUMN status ENUM(
    'DRAFT',
    'UPLOADED',
    'PROCESSING',
    'REVIEW_REQUIRED',
    'NEEDS_REVIEW',
    'IN_REVIEW',
    'CHANGES_REQUESTED',
    'CLARIFICATION_REQUIRED',
    'RESUBMITTED',
    'PENDING_APPROVAL',
    'APPROVED',
    'REJECTED',
    'PROCESSING_FAILED'
  ) NOT NULL DEFAULT 'DRAFT';

ALTER TABLE verification_results
  MODIFY COLUMN status ENUM('PASS','FAIL','WARNING','NEEDS_REVIEW','NOT_CHECKED') NOT NULL;

ALTER TABLE verification_runs
  MODIFY COLUMN overall_result ENUM('PASS','FAIL','WARNING','NEEDS_REVIEW','NOT_CHECKED') NULL;

ALTER TABLE document_versions
  ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

ALTER TABLE extracted_fields
  ADD COLUMN source_text TEXT NULL AFTER data_type,
  ADD COLUMN page_number INT UNSIGNED NULL AFTER source_text,
  ADD COLUMN extraction_method VARCHAR(40) NULL AFTER page_number;

CREATE TABLE IF NOT EXISTS document_types (
  id             VARCHAR(80) NOT NULL PRIMARY KEY,
  display_name   VARCHAR(150) NOT NULL,
  category       VARCHAR(100) NOT NULL,
  description    VARCHAR(500) NULL,
  schema_version VARCHAR(30) NOT NULL,
  fields_json    JSON NOT NULL,
  is_enabled     TINYINT(1) NOT NULL DEFAULT 1,
  updated_by     CHAR(36) NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_document_type_updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_document_types_enabled (is_enabled),
  INDEX idx_document_types_category (category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reference_records (
  id               CHAR(36) NOT NULL PRIMARY KEY,
  organization_id  VARCHAR(80) NOT NULL DEFAULT 'default',
  document_type_id VARCHAR(80) NOT NULL,
  reference_key    VARCHAR(255) NOT NULL,
  record_data      JSON NOT NULL,
  source_name      VARCHAR(255) NOT NULL,
  source_reference VARCHAR(255) NULL,
  created_by       CHAR(36) NOT NULL,
  verified_by      CHAR(36) NOT NULL,
  verified_at      DATETIME NOT NULL,
  is_active        TINYINT(1) NOT NULL DEFAULT 1,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (document_type_id) REFERENCES document_types(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE RESTRICT,
  UNIQUE KEY uk_reference_record (organization_id, document_type_id, reference_key),
  INDEX idx_reference_active (organization_id, document_type_id, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS verification_rules (
  id               CHAR(36) NOT NULL PRIMARY KEY,
  document_type_id VARCHAR(80) NOT NULL,
  rule_id          VARCHAR(100) NOT NULL,
  rule_name        VARCHAR(200) NOT NULL,
  rule_version     VARCHAR(30) NOT NULL,
  config_json      JSON NULL,
  is_enabled       TINYINT(1) NOT NULL DEFAULT 1,
  requires_human   TINYINT(1) NOT NULL DEFAULT 0,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (document_type_id) REFERENCES document_types(id) ON DELETE RESTRICT,
  UNIQUE KEY uk_verification_rule (document_type_id, rule_id),
  INDEX idx_verification_rules_enabled (document_type_id, is_enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO schema_migrations (version) VALUES ('002_document_type_registry');
