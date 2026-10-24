'use strict';

const axios = require('axios');
const config = require('../config/env');
const logger = require('../utils/logger');
const { docVersionRepo, ocrResultRepo, extractedFieldRepo, lineItemRepo } = require('../repositories/documentRepository');
const { auditRepo } = require('../repositories/auditRepository');
const db = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const { canonicalFieldId, parseDate, parseDecimal, normalizeDecimal } = require('../document-types/registry');

class OcrService {
  /**
   * Submit a document version for OCR processing.
   * Updates processing status, calls the Python service, persists results.
   */
  async processDocument(documentVersionId, triggeredBy = null) {
    const docVer = await docVersionRepo.findById(documentVersionId);
    if (!docVer) throw new AppError('Document version not found', 404);

    logger.info('Starting OCR processing', { docVersionId: documentVersionId });

    if (docVer.processing_status === 'completed' && docVer.ocr_result_id) {
      return { success: true, ocrResult: await ocrResultRepo.findByDocumentVersion(documentVersionId), fieldsExtracted: 0 };
    }

    await docVersionRepo.updateProcessingStatus(documentVersionId, 'processing');

    const submission = await require('../repositories/submissionRepository').findById(docVer.submission_id);
    if (!submission) throw new AppError('Submission not found for document version.', 404);

    let ocrResponse;
    try {
      ocrResponse = await this._callOcrService(docVer.storage_path, docVer.mime_type, documentVersionId, submission.doc_category);
    } catch (err) {
      const status = err.response?.status;
      const detail = typeof err.response?.data?.detail === 'string' ? err.response.data.detail : '';
      const message = status === 401
        ? 'OCR service authentication failed (HTTP 401). Check that the Node and Python OCR_SERVICE_API_KEY values match.'
        : status === 422
          ? `Document extraction failed${detail ? `: ${detail}` : ' because the document could not be read.'}`
          : status === 503
            ? `OCR engine failed${detail ? `: ${detail}` : ' or is unavailable.'}`
        : status
          ? `OCR service failed (HTTP ${status})${detail ? `: ${detail}` : '.'}`
          : err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT'
            ? 'OCR service timed out before extraction completed.'
            : `OCR service could not be reached: ${err.message}`;
      logger.error('Document processing failed', {
        stage: 'ocr',
        status,
        code: err.code,
        docVersionId: documentVersionId,
        error: message,
      });
      await this._markProcessingFailed(documentVersionId, triggeredBy, 'ocr', message);
      return { success: false, error: message };
    }

    const schema = await require('../repositories/documentTypeRepository').findById(submission.doc_category);
    if (!schema) {
      const message = `Extraction failed: document type "${submission.doc_category}" is not configured.`;
      await this._markProcessingFailed(documentVersionId, triggeredBy, 'extraction', message);
      throw new Error(message);
    }
    if (typeof ocrResponse.raw_text !== 'string' || !ocrResponse.raw_text.trim() ||
        !Number.isInteger(ocrResponse.page_count) || !ocrResponse.fields || typeof ocrResponse.fields !== 'object') {
      const message = 'Extraction failed: the OCR service returned an incomplete response.';
      await this._markProcessingFailed(documentVersionId, triggeredBy, 'extraction', message);
      throw new Error(message);
    }
    const allowedMethods = ['embedded_text', 'tesseract', 'hybrid'];
    if (!allowedMethods.includes(ocrResponse.extraction_method) ||
        !Number.isFinite(Number(ocrResponse.avg_confidence)) ||
        Number(ocrResponse.avg_confidence) < 0 || Number(ocrResponse.avg_confidence) > 100) {
      const message = 'Extraction failed: the OCR service returned invalid extraction metadata.';
      await this._markProcessingFailed(documentVersionId, triggeredBy, 'extraction', message);
      throw new Error(message);
    }
    const schemaByCanonicalId = new Map();
    for (const spec of schema.fields) {
      const canonicalId = canonicalFieldId(spec.id);
      if (schemaByCanonicalId.has(canonicalId)) {
        logger.warn('Duplicate document field IDs map to one canonical field', {
          stage: 'field_mapping',
          documentType: submission.doc_category,
          canonicalField: canonicalId,
        });
      } else {
        schemaByCanonicalId.set(canonicalId, spec);
      }
    }
    const responseByCanonicalId = new Map();
    for (const [fieldId, info] of Object.entries(ocrResponse.fields)) {
      const canonicalId = canonicalFieldId(fieldId);
      if (!responseByCanonicalId.has(canonicalId) || fieldId === canonicalId) {
        responseByCanonicalId.set(canonicalId, info);
      }
      if (fieldId !== canonicalId) {
        logger.info('Mapped OCR field alias to canonical field', {
          stage: 'field_mapping',
          documentType: submission.doc_category,
          sourceField: fieldId,
          canonicalField: canonicalId,
        });
      }
    }
    const normalizedFields = Object.fromEntries([...schemaByCanonicalId].map(([canonicalId, spec]) => {
      const info = responseByCanonicalId.get(canonicalId);
      if (!info || typeof info !== 'object') {
        return [canonicalId, { value: null, confidence: 0, data_type: spec.type }];
      }
      let value = info.value === null || info.value === undefined ? null : String(info.value).slice(0, 2000);
      if (value !== null && spec.type === 'date') value = parseDate(value) || value;
      if (value !== null && spec.type === 'decimal') {
        const normalized = normalizeDecimal(value);
        if (normalized !== null) value = normalized;
      }
      const confidence = Number(info.confidence);
      const pageNumber = Number(info.page_number);
      const method = allowedMethods.includes(info.extraction_method) ? info.extraction_method : ocrResponse.extraction_method;
      return [canonicalId, {
        value,
        confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(100, confidence)) : 0,
        data_type: spec.type,
        source_text: typeof info.source_text === 'string' ? info.source_text.slice(0, 2000) : null,
        page_number: Number.isInteger(pageNumber) && pageNumber > 0 && pageNumber <= ocrResponse.page_count ? pageNumber : null,
        extraction_method: method,
      }];
    }));
    ocrResponse.fields = normalizedFields;
    const missingRequiredFields = [...schemaByCanonicalId]
      .filter(([fieldId, spec]) => spec.required && !normalizedFields[fieldId]?.value)
      .map(([fieldId]) => fieldId);
    const invalidFormatFields = [...schemaByCanonicalId]
      .filter(([fieldId, spec]) => {
        const value = normalizedFields[fieldId]?.value;
        if (!value) return false;
        return spec.type === 'date' ? !parseDate(value)
          : spec.type === 'decimal' ? parseDecimal(value) === null : false;
      })
      .map(([fieldId]) => fieldId);
    if (missingRequiredFields.length || invalidFormatFields.length) {
      logger.warn('Document extraction requires review', {
        stage: 'extraction',
        docVersionId: documentVersionId,
        missingRequiredFields,
        invalidFormatFields,
      });
    }
    const invoiceDiagnosticFields = [
      'vendor_name', 'buyer_name', 'invoice_number', 'invoice_date', 'due_date',
      'currency', 'subtotal', 'discount', 'tax_rate', 'tax_amount',
      'total_amount', 'purchase_order_reference',
    ];
    logger.info('Normalized OCR invoice fields', {
      stage: 'field_mapping',
      docVersionId: documentVersionId,
      fields: Object.fromEntries(invoiceDiagnosticFields.map(fieldName => [
        fieldName,
        {
          value: normalizedFields[fieldName]?.value ?? null,
          sourceText: normalizedFields[fieldName]?.source_text ?? null,
        },
      ])),
      missingRequiredFields,
      invalidFormatFields,
    });

    let persisted;
    try {
      persisted = await db.transaction(async conn => {
        const ocrResult = await ocrResultRepo.create({
          documentVersionId,
          rawText: ocrResponse.raw_text,
          pageCount: ocrResponse.page_count,
          extractionMethod: ocrResponse.extraction_method,
          avgConfidence: ocrResponse.avg_confidence,
          processingMs: ocrResponse.processing_ms,
          serviceVersion: ocrResponse.service_version,
        }, conn);
        const fields = Object.entries(ocrResponse.fields).map(([name, info]) => ({
          ocrResultId: ocrResult.id,
          documentVersionId,
          fieldName: name,
          fieldValue: info.value,
          confidence: info.confidence,
          dataType: info.data_type || 'string',
          sourceText: info.source_text,
          pageNumber: info.page_number,
          extractionMethod: info.extraction_method || ocrResponse.extraction_method,
        }));
        await extractedFieldRepo.bulkCreate(fields, conn);
        if (Array.isArray(ocrResponse.line_items) && ocrResponse.line_items.length) {
          await lineItemRepo.bulkCreate(documentVersionId, ocrResponse.line_items, conn);
        }
        await docVersionRepo.linkOcrResult(documentVersionId, ocrResult.id, conn);
        await docVersionRepo.updateProcessingStatus(documentVersionId, 'completed', null, conn);
        return { ocrResult, fields };
      });
    } catch (err) {
      const message = `Extraction persistence failed: ${err.message}`;
      await this._markProcessingFailed(documentVersionId, triggeredBy, 'persistence', message);
      throw new Error(message, { cause: err });
    }

    await auditRepo.log({
      actorId:    triggeredBy,
      action:     'ocr.completed',
      entityType: 'document_version',
      entityId:   documentVersionId,
      description: `OCR completed via ${ocrResponse.extraction_method}`,
      metadata:   { avgConfidence: ocrResponse.avg_confidence, pageCount: ocrResponse.page_count },
    });

    logger.info('OCR processing complete', {
      stage: 'extraction',
      docVersionId: documentVersionId,
      fieldsFound: persisted.fields.filter(field => field.fieldValue !== null && field.fieldValue !== '').length,
      fieldsExpected: persisted.fields.length,
    });
    return { success: true, ocrResult: persisted.ocrResult, fieldsExtracted: persisted.fields.length };
  }

  async _markProcessingFailed(documentVersionId, triggeredBy, stage, message) {
    logger.error('Document processing failed', { stage, docVersionId: documentVersionId, error: message });
    await docVersionRepo.updateProcessingStatus(documentVersionId, 'failed', message);
    await auditRepo.log({
      actorId: triggeredBy,
      action: 'ocr.failed',
      entityType: 'document_version',
      entityId: documentVersionId,
      description: message,
    });
  }

  async _callOcrService(storagePath, mimeType, documentVersionId, documentType) {
    const FormData = require('form-data');
    const fs       = require('fs');
    const { resolveStoragePath } = require('../middleware/upload');
    const resolvedPath = resolveStoragePath(storagePath);
    const schema = await require('../repositories/documentTypeRepository').findById(documentType);
    if (!schema) throw new Error(`Document type "${documentType}" is not configured.`);

    const form = new FormData();
    form.append('file', fs.createReadStream(resolvedPath));
    form.append('mime_type', mimeType);
    form.append('document_version_id', documentVersionId);
    form.append('document_type', schema.id);
    form.append('fields_json', JSON.stringify(schema.fields));

    const resp = await axios.post(`${config.ocr.url}/extract`, form, {
      headers: {
        ...form.getHeaders(),
        'X-API-Key': config.ocr.apiKey,
      },
      timeout: config.ocr.timeoutMs,
      maxBodyLength: config.storage.maxFileSizeMb * 1024 * 1024 * 2,
    });

    if (!resp.data || typeof resp.data !== 'object' || resp.data.success !== true) {
      throw new Error('Invalid response from OCR service');
    }
    return resp.data;
  }

  /**
   * Check if the OCR service is healthy.
   */
  async healthCheck() {
    try {
      const resp = await axios.get(`${config.ocr.url}/health`, {
        timeout: 5000,
        headers: { 'X-API-Key': config.ocr.apiKey },
      });
      return resp.data;
    } catch {
      return { status: 'unavailable' };
    }
  }
}

module.exports = new OcrService();
