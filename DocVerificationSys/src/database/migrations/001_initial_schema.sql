-- Migration 001: Initial Schema
-- Document Verification & Approval System
-- Run in order. All timestamps are stored in UTC.

SET FOREIGN_KEY_CHECKS = 0;
SET time_zone = '+00:00';

-- ─── Migration Tracking ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  version       VARCHAR(50)  NOT NULL UNIQUE,
  applied_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Users ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              CHAR(36)      NOT NULL PRIMARY KEY COMMENT 'UUID v4',
  email           VARCHAR(254)  NOT NULL UNIQUE,
  password_hash   VARCHAR(255)  NOT NULL,
  full_name       VARCHAR(200)  NOT NULL,
  role            ENUM('submitter','reviewer','approver','admin') NOT NULL DEFAULT 'submitter',
  is_active       TINYINT(1)    NOT NULL DEFAULT 1,
  must_change_pwd TINYINT(1)    NOT NULL DEFAULT 0,
  last_login_at   DATETIME      NULL,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_users_email (email),
  INDEX idx_users_role  (role),
  INDEX idx_users_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Sessions (express-mysql-session) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  session_id  VARCHAR(128)  NOT NULL PRIMARY KEY,
  expires     INT UNSIGNED  NOT NULL,
  data        MEDIUMTEXT    NULL,
  INDEX idx_sessions_expires (expires)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Application Settings ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_settings (
  `key`         VARCHAR(100)   NOT NULL PRIMARY KEY,
  `value`       TEXT           NOT NULL,
  description   VARCHAR(500)   NULL,
  updated_by    CHAR(36)       NULL,
  updated_at    DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Submissions ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS submissions (
  id              CHAR(36)      NOT NULL PRIMARY KEY,
  ref_number      VARCHAR(30)   NOT NULL UNIQUE COMMENT 'Human-readable reference, e.g. INV-2024-000042',
  submitter_id    CHAR(36)      NOT NULL,
  reviewer_id     CHAR(36)      NULL,
  approver_id     CHAR(36)      NULL,
  title           VARCHAR(500)  NOT NULL,
  doc_category    VARCHAR(100)  NOT NULL DEFAULT 'invoice',
  vendor_name     VARCHAR(500)  NULL,
  status          ENUM(
    'DRAFT',
    'PROCESSING',
    'REVIEW_REQUIRED',
    'IN_REVIEW',
    'CHANGES_REQUESTED',
    'PENDING_APPROVAL',
    'APPROVED',
    'REJECTED',
    'PROCESSING_FAILED'
  ) NOT NULL DEFAULT 'DRAFT',
  current_version_id  CHAR(36)  NULL,
  rejection_reason    TEXT      NULL,
  priority        ENUM('low','normal','high') NOT NULL DEFAULT 'normal',
  due_date        DATE          NULL,
  notes           TEXT          NULL,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  FOREIGN KEY (submitter_id)  REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (reviewer_id)   REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (approver_id)   REFERENCES users(id) ON DELETE SET NULL,

  INDEX idx_submissions_submitter (submitter_id),
  INDEX idx_submissions_reviewer  (reviewer_id),
  INDEX idx_submissions_approver  (approver_id),
  INDEX idx_submissions_status    (status),
  INDEX idx_submissions_ref       (ref_number),
  INDEX idx_submissions_created   (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Document Versions ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS document_versions (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  submission_id       CHAR(36)      NOT NULL,
  version_number      INT UNSIGNED  NOT NULL,
  original_filename   VARCHAR(500)  NOT NULL,
  storage_filename    VARCHAR(500)  NOT NULL COMMENT 'Server-generated safe filename',
  storage_path        VARCHAR(1000) NOT NULL,
  mime_type           VARCHAR(100)  NOT NULL,
  file_size_bytes     BIGINT UNSIGNED NOT NULL,
  file_hash_sha256    CHAR(64)      NOT NULL,
  uploaded_by         CHAR(36)      NOT NULL,
  ocr_result_id       CHAR(36)      NULL,
  processing_status   ENUM('pending','processing','completed','failed') NOT NULL DEFAULT 'pending',
  processing_error    TEXT          NULL,
  created_at          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE RESTRICT,
  FOREIGN KEY (uploaded_by)   REFERENCES users(id)       ON DELETE RESTRICT,

  UNIQUE KEY uk_submission_version (submission_id, version_number),
  INDEX idx_docver_submission (submission_id),
  INDEX idx_docver_hash       (file_hash_sha256),
  INDEX idx_docver_status     (processing_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Back-reference: submissions.current_version_id -> document_versions.id
ALTER TABLE submissions ADD CONSTRAINT fk_sub_current_ver
  FOREIGN KEY (current_version_id) REFERENCES document_versions(id) ON DELETE SET NULL;

-- ─── OCR Results ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ocr_results (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  document_version_id CHAR(36)      NOT NULL UNIQUE,
  raw_text            LONGTEXT      NULL,
  page_count          INT UNSIGNED  NULL,
  extraction_method   ENUM('embedded_text','tesseract','hybrid') NULL,
  avg_confidence      DECIMAL(5,2)  NULL COMMENT 'Overall OCR confidence 0-100',
  processing_ms       INT UNSIGNED  NULL,
  service_version     VARCHAR(50)   NULL,
  created_at          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (document_version_id) REFERENCES document_versions(id) ON DELETE CASCADE,
  INDEX idx_ocr_docver (document_version_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Extracted Fields ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS extracted_fields (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  ocr_result_id       CHAR(36)      NOT NULL,
  document_version_id CHAR(36)      NOT NULL,
  field_name          VARCHAR(100)  NOT NULL,
  field_value         TEXT          NULL,
  confidence          DECIMAL(5,2)  NULL COMMENT '0-100',
  is_corrected        TINYINT(1)    NOT NULL DEFAULT 0,
  original_value      TEXT          NULL COMMENT 'Pre-correction value',
  corrected_by        CHAR(36)      NULL,
  corrected_at        DATETIME      NULL,
  correction_reason   TEXT          NULL,
  data_type           VARCHAR(50)   NULL COMMENT 'string|date|decimal|integer|boolean',
  created_at          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  FOREIGN KEY (ocr_result_id)       REFERENCES ocr_results(id)         ON DELETE CASCADE,
  FOREIGN KEY (document_version_id) REFERENCES document_versions(id)   ON DELETE CASCADE,
  FOREIGN KEY (corrected_by)        REFERENCES users(id)                ON DELETE SET NULL,

  INDEX idx_ef_ocr_result (ocr_result_id),
  INDEX idx_ef_docver     (document_version_id),
  INDEX idx_ef_field_name (field_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Invoice Line Items ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_line_items (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  extracted_field_id  CHAR(36)      NULL COMMENT 'Parent extracted field if applicable',
  document_version_id CHAR(36)      NOT NULL,
  line_number         INT UNSIGNED  NOT NULL,
  description         TEXT          NULL,
  quantity            DECIMAL(15,4) NULL,
  unit_price          DECIMAL(15,4) NULL,
  amount              DECIMAL(15,4) NULL,
  currency            CHAR(3)       NULL,
  confidence          DECIMAL(5,2)  NULL,
  created_at          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (document_version_id) REFERENCES document_versions(id) ON DELETE CASCADE,
  INDEX idx_line_items_docver (document_version_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Verification Runs ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS verification_runs (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  submission_id       CHAR(36)      NOT NULL,
  document_version_id CHAR(36)      NOT NULL,
  triggered_by        CHAR(36)      NULL COMMENT 'NULL = system-triggered',
  status              ENUM('running','completed','failed') NOT NULL DEFAULT 'running',
  overall_result      ENUM('PASS','FAIL','WARNING','NOT_CHECKED') NULL,
  rule_set_version    VARCHAR(50)   NOT NULL DEFAULT '1.0',
  completed_at        DATETIME      NULL,
  created_at          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (submission_id)       REFERENCES submissions(id)       ON DELETE CASCADE,
  FOREIGN KEY (document_version_id) REFERENCES document_versions(id) ON DELETE CASCADE,
  FOREIGN KEY (triggered_by)        REFERENCES users(id)             ON DELETE SET NULL,

  INDEX idx_vrun_submission (submission_id),
  INDEX idx_vrun_docver     (document_version_id),
  INDEX idx_vrun_created    (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Verification Results ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS verification_results (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  run_id              CHAR(36)      NOT NULL,
  rule_id             VARCHAR(100)  NOT NULL,
  rule_name           VARCHAR(200)  NOT NULL,
  rule_version        VARCHAR(20)   NOT NULL DEFAULT '1.0',
  status              ENUM('PASS','FAIL','WARNING','NOT_CHECKED') NOT NULL,
  severity            ENUM('info','low','medium','high','critical') NOT NULL DEFAULT 'medium',
  explanation         TEXT          NULL,
  affected_fields     JSON          NULL COMMENT 'Array of field names',
  actual_value        TEXT          NULL,
  expected_value      TEXT          NULL,
  created_at          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (run_id) REFERENCES verification_runs(id) ON DELETE CASCADE,

  INDEX idx_vres_run     (run_id),
  INDEX idx_vres_rule    (rule_id),
  INDEX idx_vres_status  (status),
  INDEX idx_vres_severity (severity)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Review Assignments ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS review_assignments (
  id              CHAR(36)    NOT NULL PRIMARY KEY,
  submission_id   CHAR(36)    NOT NULL,
  assigned_to     CHAR(36)    NOT NULL,
  assigned_by     CHAR(36)    NULL,
  role_context    ENUM('reviewer','approver') NOT NULL DEFAULT 'reviewer',
  assigned_at     DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at    DATETIME    NULL,
  is_active       TINYINT(1)  NOT NULL DEFAULT 1,

  FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_to)   REFERENCES users(id)       ON DELETE CASCADE,
  FOREIGN KEY (assigned_by)   REFERENCES users(id)       ON DELETE SET NULL,

  INDEX idx_ra_submission  (submission_id),
  INDEX idx_ra_assigned_to (assigned_to),
  INDEX idx_ra_active      (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Field Corrections (audit trail for OCR corrections) ──────────────────────
CREATE TABLE IF NOT EXISTS field_corrections (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  submission_id       CHAR(36)      NOT NULL,
  document_version_id CHAR(36)      NOT NULL,
  field_name          VARCHAR(100)  NOT NULL,
  original_value      TEXT          NULL,
  corrected_value     TEXT          NULL,
  corrected_by        CHAR(36)      NOT NULL,
  correction_reason   TEXT          NULL,
  created_at          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (submission_id)       REFERENCES submissions(id)       ON DELETE CASCADE,
  FOREIGN KEY (document_version_id) REFERENCES document_versions(id) ON DELETE CASCADE,
  FOREIGN KEY (corrected_by)        REFERENCES users(id)             ON DELETE RESTRICT,

  INDEX idx_fc_submission (submission_id),
  INDEX idx_fc_corrected_by (corrected_by)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Review Comments ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS review_comments (
  id              CHAR(36)    NOT NULL PRIMARY KEY,
  submission_id   CHAR(36)    NOT NULL,
  author_id       CHAR(36)    NOT NULL,
  comment_type    ENUM('internal','clarification_request','clarification_response','return_reason','general') NOT NULL DEFAULT 'general',
  body            TEXT        NOT NULL,
  is_visible_to_submitter TINYINT(1) NOT NULL DEFAULT 0,
  parent_id       CHAR(36)    NULL COMMENT 'For threaded replies',
  created_at      DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id)     REFERENCES users(id)       ON DELETE RESTRICT,
  FOREIGN KEY (parent_id)     REFERENCES review_comments(id) ON DELETE SET NULL,

  INDEX idx_rc_submission (submission_id),
  INDEX idx_rc_author     (author_id),
  INDEX idx_rc_type       (comment_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Approval Decisions ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS approval_decisions (
  id              CHAR(36)    NOT NULL PRIMARY KEY,
  submission_id   CHAR(36)    NOT NULL,
  approver_id     CHAR(36)    NOT NULL,
  decision        ENUM('approved','rejected') NOT NULL,
  reason          TEXT        NULL,
  decision_notes  TEXT        NULL,
  verification_run_id CHAR(36) NULL COMMENT 'Run at time of decision',
  exception_used  TINYINT(1)  NOT NULL DEFAULT 0,
  exception_rule  VARCHAR(100) NULL,
  exception_reason TEXT       NULL,
  created_at      DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (submission_id)       REFERENCES submissions(id)        ON DELETE RESTRICT,
  FOREIGN KEY (approver_id)         REFERENCES users(id)              ON DELETE RESTRICT,
  FOREIGN KEY (verification_run_id) REFERENCES verification_runs(id)  ON DELETE SET NULL,

  INDEX idx_ad_submission (submission_id),
  INDEX idx_ad_approver   (approver_id),
  INDEX idx_ad_decision   (decision)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Audit Events ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_events (
  id              CHAR(36)      NOT NULL PRIMARY KEY,
  actor_id        CHAR(36)      NULL COMMENT 'NULL for system events',
  actor_email     VARCHAR(254)  NULL COMMENT 'Snapshot at time of event',
  action          VARCHAR(100)  NOT NULL,
  entity_type     VARCHAR(100)  NOT NULL,
  entity_id       VARCHAR(36)   NULL,
  description     TEXT          NULL,
  metadata        JSON          NULL,
  ip_address      VARCHAR(45)   NULL,
  user_agent      VARCHAR(500)  NULL,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_ae_actor     (actor_id),
  INDEX idx_ae_action    (action),
  INDEX idx_ae_entity    (entity_type, entity_id),
  INDEX idx_ae_created   (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Notifications ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id              CHAR(36)      NOT NULL PRIMARY KEY,
  user_id         CHAR(36)      NOT NULL,
  title           VARCHAR(300)  NOT NULL,
  body            TEXT          NULL,
  notif_type      VARCHAR(100)  NOT NULL DEFAULT 'info',
  entity_type     VARCHAR(100)  NULL,
  entity_id       CHAR(36)      NULL,
  is_read         TINYINT(1)    NOT NULL DEFAULT 0,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_notif_user    (user_id),
  INDEX idx_notif_read    (is_read),
  INDEX idx_notif_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Processing Jobs (durable async queue) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS processing_jobs (
  id              CHAR(36)      NOT NULL PRIMARY KEY,
  job_type        VARCHAR(100)  NOT NULL,
  payload         JSON          NOT NULL,
  status          ENUM('pending','processing','completed','failed','cancelled') NOT NULL DEFAULT 'pending',
  attempts        TINYINT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts    TINYINT UNSIGNED NOT NULL DEFAULT 3,
  error_message   TEXT          NULL,
  locked_at       DATETIME      NULL,
  locked_by       VARCHAR(100)  NULL,
  scheduled_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at    DATETIME      NULL,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_pj_status     (status),
  INDEX idx_pj_scheduled  (scheduled_at),
  INDEX idx_pj_type       (job_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Default App Settings ─────────────────────────────────────────────────────
INSERT IGNORE INTO app_settings (`key`, `value`, description) VALUES
  ('max_file_size_mb',        '20',                          'Maximum upload file size in megabytes'),
  ('allowed_mime_types',      'application/pdf,image/jpeg,image/png,image/tiff', 'Comma-separated allowed MIME types'),
  ('max_page_count',          '50',                          'Maximum pages per document'),
  ('duplicate_check_enabled', 'true',                        'Enable duplicate invoice detection'),
  ('amount_tolerance_pct',    '0.01',                        'Allowed rounding tolerance for amount checks (percentage)'),
  ('require_po_reference',    'false',                       'Require purchase order reference on invoices'),
  ('auto_assign_reviewer',    'false',                       'Automatically assign available reviewer on submission'),
  ('ocr_confidence_threshold','60',                          'Minimum OCR confidence to auto-populate a field (0-100)');

SET FOREIGN_KEY_CHECKS = 1;

-- Record migration
INSERT IGNORE INTO schema_migrations (version) VALUES ('001_initial_schema');
