'use strict';

const { verificationRepo } = require('../repositories/auditRepository');
const { extractedFieldRepo } = require('../repositories/documentRepository');
const submissionRepo = require('../repositories/submissionRepository');
const documentTypeRepo = require('../repositories/documentTypeRepository');
const { validateFields, parseDecimal } = require('../document-types/registry');
const logger = require('../utils/logger');

const RULE_VERSION = '1.0';

class VerificationEngine {
  async run(submissionId, documentVersionId, triggeredBy = null) {
    logger.info('Running verification', { submissionId, documentVersionId });
    const submission = await submissionRepo.findById(submissionId);
    if (!submission) throw new Error('Submission not found for verification.');
    const documentType = await documentTypeRepo.findById(submission.doc_category);
    if (!documentType) throw new Error(`Document type "${submission.doc_category}" is not configured.`);
    const runId = await verificationRepo.createRun({
      submissionId, documentVersionId, triggeredBy,
      ruleSetVersion: documentType.schema_version,
    });

    try {
      const fieldMap = await extractedFieldRepo.getFieldMap(documentVersionId);
      if (submission.doc_category === 'invoice') {
        const invoiceFieldNames = [
          'vendor_name', 'buyer_name', 'invoice_number', 'invoice_date', 'due_date',
          'currency', 'subtotal', 'discount', 'tax_rate', 'tax_amount',
          'total_amount', 'purchase_order_reference',
        ];
        logger.info('Invoice verification inputs', {
          stage: 'verification',
          submissionId,
          documentVersionId,
          fields: Object.fromEntries(invoiceFieldNames.map(fieldName => [
            fieldName,
            fieldMap[fieldName]?.field_value ?? null,
          ])),
        });
      }
      const results = validateFields(submission.doc_category, fieldMap, { schema: documentType });
      if (submission.doc_category === 'invoice') {
        results.push(...await this._checkDuplicateInvoice(submissionId, fieldMap));
        results.push(await this._checkPurchaseOrderReference(fieldMap));
      }
      const configuredRules = await require('../config/database').query(
        'SELECT rule_id, is_enabled FROM verification_rules WHERE document_type_id = ?',
        [documentType.id]
      );
      const ruleStates = new Map(configuredRules.map(rule => [rule.rule_id, Boolean(rule.is_enabled)]));
      const activeResults = results.filter(result =>
        !ruleStates.has(result.ruleId) || ruleStates.get(result.ruleId)
      );

      for (const result of activeResults) {
        await verificationRepo.saveResult({
          runId,
          ruleId: result.ruleId,
          ruleName: result.ruleName,
          ruleVersion: result.ruleVersion || documentType.schema_version || RULE_VERSION,
          status: result.status,
          severity: result.severity,
          explanation: result.explanation,
          affectedFields: result.affectedFields,
          actualValue: result.actualValue,
          expectedValue: result.expectedValue,
        });
      }

      const overall = activeResults.some(result => result.status === 'FAIL') ? 'FAIL'
        : activeResults.some(result => result.status === 'NEEDS_REVIEW') ? 'NEEDS_REVIEW'
        : activeResults.some(result => result.status === 'WARNING') ? 'WARNING' : 'PASS';

      await verificationRepo.completeRun(runId, overall);
      logger.info('Verification complete', {
        stage: 'verification',
        runId,
        overall,
        submissionId,
        failedRuleIds: activeResults.filter(result => result.status === 'FAIL').map(result => result.ruleId),
      });
      return { runId, overall, results: activeResults };
    } catch (err) {
      logger.error('Verification engine error', { stage: 'verification', err: err.message, runId, submissionId });
      await verificationRepo.failRun(runId);
      throw err;
    }
  }

  async _checkDuplicateInvoice(submissionId, fields) {
    const invoiceNumber = String(fields.invoice_number?.field_value || '').trim();
    const vendorName = String(fields.vendor_name?.field_value || '').trim();
    if (!invoiceNumber || !vendorName) return [];

    const db = require('../config/database');
    const candidates = await db.query(
      `SELECT s.id AS request_id, s.ref_number, ef_inv.field_value AS invoice_number, ef_vendor.field_value AS vendor_name
       FROM submissions s
       JOIN document_versions dv ON s.current_version_id = dv.id
       JOIN extracted_fields ef_inv ON ef_inv.document_version_id = dv.id AND ef_inv.field_name = 'invoice_number'
       JOIN extracted_fields ef_vendor ON ef_vendor.document_version_id = dv.id AND ef_vendor.field_name = 'vendor_name'
       WHERE s.id <> ? AND s.status IN ('APPROVED', 'IN_REVIEW')`,
      [submissionId]
    );
    const normalize = value => value.toLowerCase().replace(/[\s\-_,.]/g, '');
    const matches = candidates.filter(row =>
      normalize(row.invoice_number || '') === normalize(invoiceNumber) &&
      normalize(row.vendor_name || '') === normalize(vendorName));

    if (!matches.length) return [{
      ruleId: 'DUPLICATE_INVOICE', ruleName: 'Potential duplicate invoice', ruleVersion: RULE_VERSION,
      status: 'PASS', severity: 'info', explanation: 'No matching supplier and invoice number were found in the current records.',
    }];

    return [{
      ruleId: 'DUPLICATE_INVOICE', ruleName: 'Potential duplicate invoice', ruleVersion: RULE_VERSION,
      status: 'WARNING', severity: 'critical',
      explanation: `Possible duplicate invoice found in request(s): ${matches.map(row => `${row.ref_number} (ID: ${row.request_id})`).join(', ')}. A reviewer must verify.`,
      affectedFields: ['invoice_number', 'vendor_name'],
      actualValue: `${vendorName} / ${invoiceNumber}`,
      expectedValue: matches.map(row => row.request_id).join(', '),
    }];
  }

  async _checkPurchaseOrderReference(fields) {
    const purchaseOrder = String(fields.purchase_order_reference?.field_value || '').trim();
    if (!purchaseOrder) return {
      ruleId: 'PURCHASE_ORDER_REFERENCE', ruleName: 'Purchase order reference comparison',
      ruleVersion: RULE_VERSION, status: 'NOT_CHECKED', severity: 'info',
      explanation: 'No purchase order reference was found on the invoice.',
    };

    const db = require('../config/database');
    const reference = await db.queryOne(
      `SELECT record_data, source_name FROM reference_records
       WHERE organization_id = 'default' AND document_type_id = 'purchase_order'
         AND reference_key = ? AND is_active = 1 LIMIT 1`,
      [purchaseOrder]
    );
    if (!reference) return {
      ruleId: 'PURCHASE_ORDER_REFERENCE', ruleName: 'Purchase order reference comparison',
      ruleVersion: RULE_VERSION, status: 'NEEDS_REVIEW', severity: 'medium',
      explanation: 'Reference verification unavailable — no trusted reference record is configured.',
      affectedFields: ['purchase_order_reference'],
      actualValue: purchaseOrder,
    };

    const record = typeof reference.record_data === 'string' ? JSON.parse(reference.record_data) : reference.record_data;
    const differences = [];
    const unverifiedFields = [];
    let comparableFields = 0;
    const invoiceVendor = String(fields.vendor_name?.field_value || '').trim();
    const referenceVendor = String(record.supplier_name || '').trim();
    if (invoiceVendor && referenceVendor) {
      comparableFields += 1;
      if (invoiceVendor.localeCompare(referenceVendor, undefined, { sensitivity: 'accent' }) !== 0) {
        differences.push('vendor_name');
      }
    } else {
      unverifiedFields.push('vendor_name');
    }
    const invoiceTotal = parseDecimal(fields.total_amount?.field_value);
    const referenceTotal = Number(record.total_amount);
    if (Number.isFinite(invoiceTotal) && Number.isFinite(referenceTotal)) {
      comparableFields += 1;
      if (Math.abs(invoiceTotal - referenceTotal) > 0.02) differences.push('total_amount');
    } else {
      unverifiedFields.push('total_amount');
    }
    const status = differences.length ? 'FAIL'
      : (unverifiedFields.length || !comparableFields) ? 'NEEDS_REVIEW' : 'PASS';
    return {
      ruleId: 'PURCHASE_ORDER_REFERENCE', ruleName: 'Purchase order reference comparison',
      ruleVersion: RULE_VERSION, status,
      severity: status === 'FAIL' ? 'high' : status === 'PASS' ? 'info' : 'medium',
      explanation: status === 'FAIL'
        ? `Invoice details differ from the trusted purchase order record from ${reference.source_name}.`
        : status === 'PASS'
          ? `Invoice details matched the trusted purchase order record from ${reference.source_name}.`
          : `A trusted purchase order record exists, but these fields could not be compared: ${unverifiedFields.join(', ')}.`,
      affectedFields: differences.length ? differences : unverifiedFields.length ? unverifiedFields : ['purchase_order_reference'],
      actualValue: purchaseOrder,
    };
  }
}

module.exports = new VerificationEngine();
