'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');

class DocumentVersionRepository {
  async create({ submissionId, originalFilename, storageFilename, storagePath, mimeType, fileSizeBytes, fileHashSha256, uploadedBy }, conn = null) {
    const id = uuidv4();
    const exec = conn ? conn.execute.bind(conn) : db.query.bind(db);

    // Get next version number
    const nextVersionResult = conn
      ? await conn.execute('SELECT COALESCE(MAX(version_number), 0) + 1 AS next_ver FROM document_versions WHERE submission_id = ? FOR UPDATE', [submissionId])
      : await db.query('SELECT COALESCE(MAX(version_number), 0) + 1 AS next_ver FROM document_versions WHERE submission_id = ?', [submissionId]);
    const row = conn ? nextVersionResult[0][0] : nextVersionResult[0];
    const versionNumber = row.next_ver;

    await exec(
      `INSERT INTO document_versions
         (id, submission_id, version_number, original_filename, storage_filename, storage_path,
          mime_type, file_size_bytes, file_hash_sha256, uploaded_by, processing_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [id, submissionId, versionNumber, originalFilename, storageFilename, storagePath,
       mimeType, fileSizeBytes, fileHashSha256, uploadedBy]
    );

    if (conn) {
      return {
        id, submission_id: submissionId, version_number: versionNumber,
        original_filename: originalFilename, storage_filename: storageFilename,
        storage_path: storagePath, mime_type: mimeType, file_size_bytes: fileSizeBytes,
        file_hash_sha256: fileHashSha256, uploaded_by: uploadedBy, processing_status: 'pending',
      };
    }
    return this.findById(id);
  }

  async findById(id) {
    return db.queryOne(
      `SELECT dv.*, u.full_name AS uploader_name, u.email AS uploader_email
       FROM   document_versions dv
       JOIN   users u ON dv.uploaded_by = u.id
       WHERE  dv.id = ?
       LIMIT  1`,
      [id]
    );
  }

  async findBySubmission(submissionId) {
    return db.query(
      `SELECT dv.*, u.full_name AS uploader_name
       FROM   document_versions dv
       JOIN   users u ON dv.uploaded_by = u.id
       WHERE  dv.submission_id = ?
       ORDER BY dv.version_number ASC`,
      [submissionId]
    );
  }

  async findByHash(hash, excludeId = null) {
    const cond = excludeId ? 'AND dv.id != ?' : '';
    const params = excludeId ? [hash, excludeId] : [hash];
    return db.query(
      `SELECT dv.*, s.ref_number, s.vendor_name, s.status AS submission_status
       FROM   document_versions dv
       JOIN   submissions s ON dv.submission_id = s.id
       WHERE  dv.file_hash_sha256 = ? ${cond}`,
      params
    );
  }

  async updateProcessingStatus(id, status, error = null, conn = null) {
    const exec = conn ? conn.execute.bind(conn) : db.query.bind(db);
    await exec('UPDATE document_versions SET processing_status = ?, processing_error = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?',
      [status, error, id]);
  }

  async linkOcrResult(docVersionId, ocrResultId, conn = null) {
    const exec = conn ? conn.execute.bind(conn) : db.query.bind(db);
    await exec(
      'UPDATE document_versions SET ocr_result_id = ? WHERE id = ?',
      [ocrResultId, docVersionId]
    );
  }
}

// ─── OCR Results Repository ────────────────────────────────────────────────────
class OcrResultRepository {
  async create({ documentVersionId, rawText, pageCount, extractionMethod, avgConfidence, processingMs, serviceVersion }, conn = null) {
    const id = uuidv4();
    const exec = conn ? conn.execute.bind(conn) : db.query.bind(db);
    await exec(
      `INSERT INTO ocr_results (id, document_version_id, raw_text, page_count, extraction_method, avg_confidence, processing_ms, service_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, documentVersionId, rawText || null, pageCount || null, extractionMethod || null,
       avgConfidence || null, processingMs || null, serviceVersion || null]
    );
    if (conn) return { id, document_version_id: documentVersionId, raw_text: rawText || null, page_count: pageCount || null, extraction_method: extractionMethod || null, avg_confidence: avgConfidence || null, processing_ms: processingMs || null, service_version: serviceVersion || null };
    return this.findByDocumentVersion(documentVersionId);
  }

  async findByDocumentVersion(documentVersionId) {
    return db.queryOne(
      'SELECT * FROM ocr_results WHERE document_version_id = ? LIMIT 1',
      [documentVersionId]
    );
  }
}

// ─── Extracted Fields Repository ──────────────────────────────────────────────
class ExtractedFieldRepository {
  async bulkCreate(fields, conn = null) {
    if (!fields.length) return;
    const exec = conn ? conn.execute.bind(conn) : db.query.bind(db);
    for (const f of fields) {
      await exec(
        `INSERT INTO extracted_fields
           (id, ocr_result_id, document_version_id, field_name, field_value, confidence, data_type,
            source_text, page_number, extraction_method)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), f.ocrResultId, f.documentVersionId, f.fieldName,
         f.fieldValue === undefined || f.fieldValue === null ? null : String(f.fieldValue),
         f.confidence ?? null, f.dataType || 'string', f.sourceText || null,
         f.pageNumber || null, f.extractionMethod || null]
      );
    }
  }

  async findByDocumentVersion(documentVersionId) {
    return db.query(
      'SELECT * FROM extracted_fields WHERE document_version_id = ? ORDER BY field_name',
      [documentVersionId]
    );
  }

  async findByField(documentVersionId, fieldName) {
    return db.queryOne(
      'SELECT * FROM extracted_fields WHERE document_version_id = ? AND field_name = ? LIMIT 1',
      [documentVersionId, fieldName]
    );
  }

  async correctField({ id, correctedValue, correctedBy, correctionReason }, conn = null) {
    const current = conn
      ? (await conn.execute('SELECT * FROM extracted_fields WHERE id = ? LIMIT 1 FOR UPDATE', [id]))[0][0]
      : await db.queryOne('SELECT * FROM extracted_fields WHERE id = ? LIMIT 1', [id]);
    if (!current) throw new Error('Field not found');

    const exec = conn ? conn.execute.bind(conn) : db.query.bind(db);
    await exec(
      `UPDATE extracted_fields
       SET field_value = ?, original_value = COALESCE(original_value, field_value),
           is_corrected = 1, corrected_by = ?, corrected_at = UTC_TIMESTAMP(),
           correction_reason = ?, updated_at = UTC_TIMESTAMP()
       WHERE id = ?`,
      [correctedValue, correctedBy, correctionReason || null, id]
    );

    return { before: current.field_value, after: correctedValue };
  }

  async getFieldMap(documentVersionId) {
    const rows = await this.findByDocumentVersion(documentVersionId);
    return rows.reduce((acc, r) => { acc[r.field_name] = r; return acc; }, {});
  }
}

// ─── Line Items Repository ─────────────────────────────────────────────────────
class LineItemRepository {
  async bulkCreate(documentVersionId, items, conn = null) {
    const exec = conn ? conn.execute.bind(conn) : db.query.bind(db);
    for (const item of items) {
      await exec(
        `INSERT INTO invoice_line_items
           (id, document_version_id, line_number, description, quantity, unit_price, amount, currency, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), documentVersionId, item.line_number, item.description || null,
         item.quantity || null, item.unit_price || null, item.amount || null,
         item.currency || null, item.confidence || null]
      );
    }
  }

  async findByDocumentVersion(documentVersionId) {
    return db.query(
      'SELECT * FROM invoice_line_items WHERE document_version_id = ? ORDER BY line_number',
      [documentVersionId]
    );
  }
}

module.exports = {
  docVersionRepo:   new DocumentVersionRepository(),
  ocrResultRepo:    new OcrResultRepository(),
  extractedFieldRepo: new ExtractedFieldRepository(),
  lineItemRepo:     new LineItemRepository(),
};
