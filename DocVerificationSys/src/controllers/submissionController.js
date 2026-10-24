'use strict';

const path = require('path');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');

const submissionRepo = require('../repositories/submissionRepository');
const { docVersionRepo, extractedFieldRepo, ocrResultRepo, lineItemRepo } = require('../repositories/documentRepository');
const { auditRepo, notifRepo, verificationRepo, fieldCorrectionRepo, commentRepo, approvalRepo } = require('../repositories/auditRepository');
const { validateAndHashFile, resolveStoragePath } = require('../middleware/upload');
const JobProcessor = require('../services/jobProcessor');
const verificationEngine = require('../services/verificationEngine');
const aiService = require('../services/aiService');
const { assertValidTransition, canUploadDocument } = require('../services/statusTransitions');
const { AppError } = require('../middleware/errorHandler');
const db = require('../config/database');
const logger = require('../utils/logger');
const config = require('../config/env');
const fs = require('fs');
const { DOCUMENT_TYPES } = require('../document-types/registry');
const documentTypeRepo = require('../repositories/documentTypeRepository');

// ─── Submission list ───────────────────────────────────────────────────────────
async function listSubmissions(req, res, next) {
  try {
    const { role, id: userId } = req.user;
    const { status, search, page = 1, sort = 'created_at', dir = 'DESC' } = req.query;
    const selectedStatus = status === 'review_queue' && ['reviewer', 'admin'].includes(role)
      ? ['REVIEW_REQUIRED', 'NEEDS_REVIEW', 'IN_REVIEW']
      : status || null;

    // Build query based on role
    const opts = {
      page:    parseInt(page, 10) || 1,
      limit:   20,
      sortBy:  sort,
      sortDir: dir,
      search:  search || null,
      status:  selectedStatus,
    };

    if (role === 'submitter')       opts.submitterId = userId;
    else if (role === 'reviewer')   opts.reviewerId  = userId;
    else if (role === 'approver')   opts.approverId  = userId;
    // admin sees all

    const { rows, total, pages } = await submissionRepo.findAll(opts);

    res.render('submissions/list', {
      title: 'Submissions',
      submissions: rows, total, pages,
      currentPage: opts.page,
      filters: { status, search, sort, dir },
      user: req.user,
      flash: req.session.flash && (delete req.session.flash, req.session.flash) || null,
    });
  } catch (err) { next(err); }
}

// ─── New submission form ───────────────────────────────────────────────────────
async function showNewSubmission(req, res, next) {
  try {
    res.render('submissions/new', {
      title: 'New Submission',
      user: req.user,
      documentTypes: await documentTypeRepo.findEnabled(),
      errors: [],
      values: {},
    });
  } catch (err) { next(err); }
}

const newSubmissionValidation = [
  body('title').trim().isLength({ min: 3, max: 500 }).withMessage('Title must be 3–500 characters'),
  body('vendor_name').trim().isLength({ max: 500 }).optional(),
  body('doc_category').custom(value => DOCUMENT_TYPES.some(type => type.id === value)).withMessage('Invalid document category'),
  body('priority').isIn(['low', 'normal', 'high']).withMessage('Invalid priority'),
];

async function createSubmission(req, res, next) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).render('submissions/new', {
        title: 'New Submission', user: req.user,
        documentTypes: await documentTypeRepo.findEnabled(),
        errors: errors.array(), values: req.body,
      });
    }

    const { title, vendor_name, doc_category, priority, notes } = req.body;
    const docType = await documentTypeRepo.findById(doc_category);
    if (!docType || !docType.is_enabled) throw new AppError('This document type is not currently enabled.', 400);
    const submission = await submissionRepo.create({
      submitterId: req.user.id,
      title, vendorName: vendor_name, docCategory: doc_category, priority, notes,
    });

    await auditRepo.log({
      actorId: req.user.id, actorEmail: req.user.email,
      action: 'submission.created', entityType: 'submission', entityId: submission.id,
      description: `Created submission ${submission.ref_number}`,
      ipAddress: req.ip,
    });

    res.redirect(`/submissions/${submission.id}/upload`);
  } catch (err) { next(err); }
}

// ─── Upload document ──────────────────────────────────────────────────────────
async function showUpload(req, res, next) {
  try {
    const submission = await getSubmissionOrFail(req.params.id, req.user);
    if (req.user.role !== 'admin' && submission.submitter_id !== req.user.id) {
      throw new AppError('Only the submission owner may upload a document.', 403);
    }
    if (!canUploadDocument(submission.status)) {
      req.session.flash = {
        type: 'info',
        message: submission.current_version_id
          ? `The document has already been uploaded. Its current status is ${submission.status.replace(/_/g, ' ')}.`
          : `A document cannot be uploaded while this submission is ${submission.status.replace(/_/g, ' ')}.`,
      };
      return res.redirect(`/submissions/${submission.id}`);
    }
    const versions   = await docVersionRepo.findBySubmission(submission.id);

    res.render('submissions/upload', {
      title: 'Upload Document',
      user: req.user, submission, versions,
      maxFileSizeMb: config.storage.maxFileSizeMb,
      errors: [],
    });
  } catch (err) { next(err); }
}

async function handleUpload(req, res, next) {
  const uploadedPath = req.file?.path;
  let databaseCommitted = false;
  try {
    const submission = await getSubmissionOrFail(req.params.id, req.user);

    if (!req.file) throw new AppError('No file uploaded.', 400);
    if (req.user.role !== 'admin' && submission.submitter_id !== req.user.id) {
      throw new AppError('Only the submission owner may upload a document.', 403);
    }
    if (!canUploadDocument(submission.status)) {
      if (uploadedPath && fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath);
      req.session.flash = {
        type: 'info',
        message: submission.current_version_id
          ? `The document has already been uploaded. Its current status is ${submission.status.replace(/_/g, ' ')}.`
          : `A document cannot be uploaded while this submission is ${submission.status.replace(/_/g, ' ')}.`,
      };
      return res.redirect(`/submissions/${submission.id}`);
    }

    // Validate file signature
    const { valid, hash, error } = await validateAndHashFile(uploadedPath, req.file.mimetype, req.file.originalname);
    if (!valid) {
      fs.unlinkSync(uploadedPath);
      throw new AppError(error || 'File validation failed.', 400);
    }

    // Check for exact duplicate by hash
    const hashDups = await docVersionRepo.findByHash(hash, submission.current_version_id);
    let dupWarning = null;
    if (hashDups.length > 0) {
      dupWarning = `This file appears to be identical to a previously uploaded document (${hashDups[0].ref_number}).`;
    }

    // Create document version record (within a transaction)
    let newVersion;
    await db.transaction(async (conn) => {
      const [rows] = await conn.execute('SELECT * FROM submissions WHERE id = ? FOR UPDATE', [submission.id]);
      const lockedSubmission = rows[0];
      if (!lockedSubmission || lockedSubmission.current_version_id !== submission.current_version_id ||
          lockedSubmission.status !== submission.status) {
        throw new AppError('Submission changed while the document was being uploaded. Reload and try again.', 409);
      }
      assertValidTransition(lockedSubmission.status, 'PROCESSING');
      newVersion = await docVersionRepo.create({
        submissionId:     submission.id,
        originalFilename: req.file.originalname,
        storageFilename:  path.basename(uploadedPath),
        storagePath:      uploadedPath,
        mimeType:         req.file.mimetype,
        fileSizeBytes:    req.file.size,
        fileHashSha256:   hash,
        uploadedBy:       req.user.id,
      }, conn);

      await submissionRepo.update(submission.id, { current_version_id: newVersion.id }, conn);
      await submissionRepo.updateStatus(submission.id, 'PROCESSING', conn);
      await JobProcessor.enqueueOcr(newVersion.id, submission.id, conn);
    });
    databaseCommitted = true;

    await auditRepo.log({
      actorId: req.user.id, actorEmail: req.user.email,
      action: 'document.uploaded', entityType: 'document_version', entityId: newVersion.id,
      description: `Uploaded version ${newVersion.version_number} for ${submission.ref_number}`,
      metadata: { fileSize: req.file.size, mimeType: req.file.mimetype, hash },
      ipAddress: req.ip,
    });

    req.session.flash = {
      type: 'success',
      message: `Document uploaded (v${newVersion.version_number}). OCR processing started.${dupWarning ? ' ⚠ ' + dupWarning : ''}`,
    };
    res.redirect(`/submissions/${submission.id}`);
  } catch (err) {
    if (!databaseCommitted && uploadedPath && fs.existsSync(uploadedPath)) {
      try { fs.unlinkSync(uploadedPath); }
      catch (cleanupError) { logger.error('Unable to remove rejected upload', { err: cleanupError.message }); }
    }
    if (err.statusCode === 409) {
      const latestSubmission = await submissionRepo.findById(req.params.id);
      if (latestSubmission && !canUploadDocument(latestSubmission.status)) {
        req.session.flash = {
          type: 'info',
          message: latestSubmission.current_version_id
            ? `The document has already been uploaded. Its current status is ${latestSubmission.status.replace(/_/g, ' ')}.`
            : `A document cannot be uploaded while this submission is ${latestSubmission.status.replace(/_/g, ' ')}.`,
        };
        return res.redirect(`/submissions/${latestSubmission.id}`);
      }
    }
    if (err.isOperational) {
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(err.statusCode || 400).json({ error: err.message });
      }
      try {
        const submission = await submissionRepo.findById(req.params.id);
        return res.status(err.statusCode || 400).render('submissions/upload', {
          title: 'Upload Document', user: req.user, submission,
          versions: await docVersionRepo.findBySubmission(req.params.id),
          maxFileSizeMb: config.storage.maxFileSizeMb,
          errors: [{ msg: err.message }],
        });
      } catch { /* fall through */ }
    }
    next(err);
  }
}

// ─── Submission detail ─────────────────────────────────────────────────────────
async function showSubmission(req, res, next) {
  try {
    const submission = await getSubmissionOrFail(req.params.id, req.user);
    const versions   = await docVersionRepo.findBySubmission(submission.id);
    const currentVersion = versions.find(version => version.id === submission.current_version_id) || null;
    const comments   = await commentRepo.findBySubmission(submission.id, {
      viewerRole: req.user.role, viewerId: req.user.id,
    });
    const corrections = await fieldCorrectionRepo.findBySubmission(submission.id);
    const decisions = await approvalRepo.findBySubmission(submission.id);
    let reviewers = [], approvers = [];
    if (req.user.role === 'admin') {
      reviewers = await db.query("SELECT id, full_name, email FROM users WHERE role = 'reviewer' AND is_active = 1 ORDER BY full_name");
      approvers = await db.query("SELECT id, full_name, email FROM users WHERE role = 'approver' AND is_active = 1 ORDER BY full_name");
    }

    let fields = [], verRun = null, verResults = [], lineItems = [], ocrResult = null;
    if (submission.current_version_id) {
      fields    = await extractedFieldRepo.findByDocumentVersion(submission.current_version_id);
      lineItems = await lineItemRepo.findByDocumentVersion(submission.current_version_id);
      ocrResult = await ocrResultRepo.findByDocumentVersion(submission.current_version_id);
      verRun    = await verificationRepo.findLatestRun(submission.id, submission.current_version_id);
      if (verRun) verResults = await verificationRepo.findResultsByRun(verRun.id);
    }
    const currentFields = new Map(fields.map(field => [field.field_name, field.field_value]));
    const versionComparisons = await Promise.all(
      versions.filter(version => version.id !== submission.current_version_id).map(async version => {
        const oldFields = await extractedFieldRepo.findByDocumentVersion(version.id);
        const oldMap = new Map(oldFields.map(field => [field.field_name, field.field_value]));
        const names = new Set([...oldMap.keys(), ...currentFields.keys()]);
        return {
          version,
          fields: [...names].sort().map(name => ({
            name,
            previousValue: oldMap.get(name) ?? null,
            currentValue: currentFields.get(name) ?? null,
          })),
        };
      })
    );

    const flash = req.session.flash || null;
    delete req.session.flash;

    res.render('submissions/detail', {
      title: `${submission.ref_number} — ${submission.title}`,
      user: req.user, submission, versions, currentVersion, fields, verRun, verResults, lineItems, comments,
      reviewers, approvers, decisions, flash, ocrResult, versionComparisons, corrections,
    });
  } catch (err) { next(err); }
}

async function askSubmissionAssistant(req, res, next) {
  try {
    if (!['reviewer', 'approver', 'admin'].includes(req.user.role)) {
      throw new AppError('The document assistant is available to reviewers and approvers.', 403);
    }
    const question = typeof req.body.question === 'string' ? req.body.question.trim() : '';
    if (!question || question.length > 1000) {
      throw new AppError('Enter a question of no more than 1,000 characters.', 400);
    }
    const submission = await getSubmissionOrFail(req.params.id, req.user);
    if (!submission.current_version_id) {
      return res.status(409).json({ error: 'Upload a document before asking the assistant.' });
    }
    if (!aiService.isAvailable) {
      return res.status(503).json({ error: 'The AI assistant is not configured. Configure an AI provider in .env and restart DocVerify.' });
    }
    const [fieldMap, run, ocrResult, comments] = await Promise.all([
      extractedFieldRepo.getFieldMap(submission.current_version_id),
      verificationRepo.findLatestRun(submission.id, submission.current_version_id),
      ocrResultRepo.findByDocumentVersion(submission.current_version_id),
      commentRepo.findBySubmission(submission.id, { viewerRole: req.user.role, viewerId: req.user.id }),
    ]);
    const verificationResults = run ? await verificationRepo.findResultsByRun(run.id) : [];
    let answer;
    try {
      answer = await aiService.answerSubmissionQuestion({
        question, submission, fieldMap, verificationResults, comments,
        rawText: ocrResult?.raw_text || '',
      });
    } catch (err) {
      if (err.code === 'AI_SERVICE_UNAVAILABLE') {
        return res.status(502).json({ error: err.message });
      }
      throw err;
    }
    if (!answer) {
      return res.status(502).json({ error: 'The AI assistant could not provide an answer. Please try again.' });
    }
    res.json({ answer });
  } catch (err) { next(err); }
}

// ─── AI-drafted correction message ───────────────────────────────────────────
async function draftClarificationMessage(req, res, next) {
  try {
    if (!['reviewer', 'approver', 'admin'].includes(req.user.role)) {
      throw new AppError('Drafting a correction message requires a reviewer or approver account.', 403);
    }
    const submission = await getSubmissionOrFail(req.params.id, req.user);
    if (!submission.current_version_id) {
      return res.status(409).json({ error: 'Upload a document before drafting a correction message.' });
    }
    if (!aiService.isAvailable) {
      return res.status(503).json({ error: 'AI drafting is not configured. Configure an AI provider in .env and restart DocVerify.' });
    }
    const [fieldMap, run, comments] = await Promise.all([
      extractedFieldRepo.getFieldMap(submission.current_version_id),
      verificationRepo.findLatestRun(submission.id, submission.current_version_id),
      commentRepo.findBySubmission(submission.id, { viewerRole: req.user.role, viewerId: req.user.id }),
    ]);
    const verificationResults = run ? await verificationRepo.findResultsByRun(run.id) : [];
    let draft;
    try {
      draft = await aiService.draftCorrectionMessage({ submission, fieldMap, verificationResults, comments });
    } catch (err) {
      if (err.code === 'AI_SERVICE_UNAVAILABLE') {
        return res.status(502).json({ error: err.message });
      }
      throw err;
    }
    if (!draft) {
      return res.status(502).json({ error: 'The AI could not generate a draft. Please try again or write the message manually.' });
    }
    res.json({ draft });
  } catch (err) { next(err); }
}

async function generateSubmissionSummary(req, res, next) {
  try {
    if (!['reviewer', 'approver', 'admin'].includes(req.user.role)) {
      throw new AppError('The document summary is available to reviewers and approvers.', 403);
    }
    const submission = await getSubmissionOrFail(req.params.id, req.user);
    if (!submission.current_version_id) {
      return res.status(409).json({ error: 'Upload a document before generating its summary.' });
    }
    if (!aiService.isAvailable) {
      return res.status(503).json({ error: 'AI summaries are not configured. Configure an AI provider in .env and restart DocVerify.' });
    }

    const [fieldMap, run, ocrResult, comments] = await Promise.all([
      extractedFieldRepo.getFieldMap(submission.current_version_id),
      verificationRepo.findLatestRun(submission.id, submission.current_version_id),
      ocrResultRepo.findByDocumentVersion(submission.current_version_id),
      commentRepo.findBySubmission(submission.id, { viewerRole: req.user.role, viewerId: req.user.id }),
    ]);
    if (!ocrResult) {
      return res.status(409).json({ error: 'The summary will be available after document processing is complete.' });
    }
    const verificationResults = run ? await verificationRepo.findResultsByRun(run.id) : [];
    const summary = await aiService.summarizeSubmission({
      submission, fieldMap, verificationResults, comments, rawText: ocrResult.raw_text || '',
    });
    if (!summary) {
      return res.status(502).json({ error: 'The AI summary could not be generated. Please try again.' });
    }
    res.json({ summary });
  } catch (err) {
    if (err.code === 'AI_SERVICE_UNAVAILABLE') {
      return res.status(502).json({ error: err.message });
    }
    next(err);
  }
}

// ─── Secure document download ──────────────────────────────────────────────────
async function downloadDocument(req, res, next) {
  try {
    const version = await docVersionRepo.findById(req.params.versionId);
    if (!version) return res.status(404).render('errors/404', { user: req.user, title: 'Not Found', message: 'Document not found.' });

    // Access control — verify user can access this document
    const submission = await submissionRepo.findById(version.submission_id);
    if (!submission) return res.status(404).render('errors/404', { user: req.user, title: 'Not Found', message: 'Submission not found.' });

    canAccessSubmission(req.user, submission);

    const safePath = resolveStoragePath(version.storage_path);
    if (!fs.existsSync(safePath)) {
      return res.status(404).render('errors/404', { user: req.user, title: 'Not Found', message: 'File not found on storage.' });
    }

    const safeFilename = path.basename(version.original_filename).replace(/[\r\n]/g, '_');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(safeFilename)}`);
    res.setHeader('Content-Type', version.mime_type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(safePath);
  } catch (err) { next(err); }
}

// ─── Field correction ──────────────────────────────────────────────────────────
async function correctField(req, res, next) {
  try {
    const { fieldId } = req.params;
    const { corrected_value, correction_reason } = req.body;
    const submissionId = req.params.id;

    const submission = await getSubmissionOrFail(submissionId, req.user);
    const submitterEditingOwn = req.user.role === 'submitter' && req.user.id === submission.submitter_id;
    if (!['reviewer', 'admin'].includes(req.user.role) && !submitterEditingOwn) {
      throw new AppError('Not authorized.', 403);
    }
    if (submitterEditingOwn && submission.status !== 'CHANGES_REQUESTED') {
      throw new AppError('Submitters can only correct fields after a reviewer requests changes.', 409);
    }
    if (!submitterEditingOwn && !['IN_REVIEW', 'REVIEW_REQUIRED', 'NEEDS_REVIEW'].includes(submission.status)) {
      throw new AppError('Corrections can only be made while the submission is in review.', 409);
    }

    const { extractedFieldRepo: ef } = require('../repositories/documentRepository');
    if (typeof corrected_value !== 'string' || corrected_value.length > 2000) {
      throw new AppError('Corrected value must be no more than 2,000 characters.', 400);
    }
    if (typeof correction_reason !== 'string' || !correction_reason.trim()) {
      throw new AppError('A reason is required for field corrections.', 400);
    }
    const correction = await db.transaction(async conn => {
      const [submissionRows] = await conn.execute(
        'SELECT submitter_id, reviewer_id, status, current_version_id FROM submissions WHERE id = ? FOR UPDATE',
        [submissionId]
      );
      const currentSubmission = submissionRows[0];
      if (!currentSubmission || currentSubmission.current_version_id !== submission.current_version_id) {
        throw new AppError('Submission changed while the correction was being saved. Reload and try again.', 409);
      }
      if (submitterEditingOwn) {
        if (currentSubmission.submitter_id !== req.user.id || currentSubmission.status !== 'CHANGES_REQUESTED') {
          throw new AppError('Submitters can only correct fields after a reviewer requests changes.', 409);
        }
      } else {
        if (!['IN_REVIEW', 'REVIEW_REQUIRED', 'NEEDS_REVIEW'].includes(currentSubmission.status)) {
          throw new AppError('Corrections can only be made while the submission is in review.', 409);
        }
        if (req.user.role !== 'admin' && currentSubmission.reviewer_id && currentSubmission.reviewer_id !== req.user.id) {
          throw new AppError('This submission is assigned to another reviewer.', 403);
        }
      }
      const [rows] = await conn.execute(
        'SELECT field_name FROM extracted_fields WHERE id = ? AND document_version_id = ? FOR UPDATE',
        [fieldId, submission.current_version_id]
      );
      const fieldRow = rows[0];
      if (!fieldRow) throw new AppError('Field not found on the current document version.', 404);
      const values = await ef.correctField({
        id: fieldId, correctedValue: corrected_value,
        correctedBy: req.user.id, correctionReason: correction_reason.trim(),
      }, conn);
      await fieldCorrectionRepo.create({
        submissionId, documentVersionId: submission.current_version_id,
        fieldName: fieldRow.field_name, originalValue: values.before,
        correctedValue: corrected_value, correctedBy: req.user.id,
        correctionReason: correction_reason.trim(),
      }, conn);
      await auditRepo.log({
        actorId: req.user.id, actorEmail: req.user.email,
        action: 'field.corrected', entityType: 'extracted_field', entityId: fieldId,
        metadata: { fieldName: fieldRow.field_name, before: values.before, after: corrected_value },
        ipAddress: req.ip,
      }, conn);
      if (submitterEditingOwn) {
        assertValidTransition(currentSubmission.status, 'IN_REVIEW');
        await submissionRepo.updateStatus(submissionId, 'IN_REVIEW', conn);
      }
      return { ...values, fieldName: fieldRow.field_name };
    });

    await verificationEngine.run(submissionId, submission.current_version_id, req.user.id);

    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.json({ success: true, before: correction.before, after: correction.after });
    }
    req.session.flash = { type: 'success', message: 'Field corrected.' };
    res.redirect(`/submissions/${submissionId}`);
  } catch (err) { next(err); }
}

// ─── Request clarification ────────────────────────────────────────────────────
async function requestClarification(req, res, next) {
  try {
    const { id: submissionId } = req.params;
    const { message } = req.body;

    if (!['reviewer', 'approver', 'admin'].includes(req.user.role)) throw new AppError('Not authorized.', 403);
    if (typeof message !== 'string' || !message.trim() || message.length > 4000) {
      throw new AppError('Enter a clarification message of no more than 4,000 characters.', 400);
    }

    const submission = await getSubmissionOrFail(submissionId, req.user);
    const isApproverReturn = req.user.role === 'approver';
    if (isApproverReturn && submission.status !== 'PENDING_APPROVAL') {
      throw new AppError('Only a pending submission can be returned by an approver.', 409);
    }
    if (req.user.role === 'reviewer' &&
        !['IN_REVIEW', 'REVIEW_REQUIRED', 'NEEDS_REVIEW'].includes(submission.status)) {
      throw new AppError('Only a submission under review can be returned for clarification.', 409);
    }
    if (req.user.role === 'approver' && submission.approver_id && submission.approver_id !== req.user.id) {
      throw new AppError('This submission is assigned to another approver.', 403);
    }

    await db.transaction(async conn => {
      const [rows] = await conn.execute('SELECT status, reviewer_id, approver_id FROM submissions WHERE id = ? FOR UPDATE', [submissionId]);
      if (!rows.length) throw new AppError('Submission not found.', 404);
      if (isApproverReturn && rows[0].approver_id && rows[0].approver_id !== req.user.id) {
        throw new AppError('This submission is assigned to another approver.', 403);
      }
      if (!isApproverReturn && req.user.role === 'reviewer' &&
          rows[0].reviewer_id && rows[0].reviewer_id !== req.user.id) {
        throw new AppError('This submission is assigned to another reviewer.', 403);
      }
      assertValidTransition(rows[0].status, 'CHANGES_REQUESTED');
      await commentRepo.create({
        submissionId, authorId: req.user.id, commentType: 'clarification_request',
        body: message.trim(), isVisibleToSubmitter: true,
      }, conn);
      await submissionRepo.updateStatus(submissionId, 'CHANGES_REQUESTED', conn);
      await auditRepo.log({
        actorId: req.user.id, actorEmail: req.user.email,
        action: isApproverReturn ? 'approval.resubmission_requested' : 'review.clarification_requested',
        entityType: 'submission', entityId: submissionId,
        description: isApproverReturn ? 'Approver returned submission for resubmission' : 'Clarification requested from submitter',
        ipAddress: req.ip,
      }, conn);
    });

    await notifRepo.create({
      userId: submission.submitter_id,
      title: `${isApproverReturn ? 'Resubmission requested' : 'Clarification requested'}: ${submission.ref_number}`,
      body: message.trim().slice(0, 200),
      notifType: 'warning',
      entityType: 'submission', entityId: submissionId,
    });

    req.session.flash = { type: 'info', message: isApproverReturn
      ? 'Submission returned to the submitter for resubmission.'
      : 'Clarification request sent to submitter.' };
    res.redirect(`/submissions/${submissionId}`);
  } catch (err) { next(err); }
}

// ─── Submit clarification response ────────────────────────────────────────────
async function respondClarification(req, res, next) {
  try {
    const { id: submissionId } = req.params;
    const { response_message } = req.body;

    if (!response_message?.trim()) throw new AppError('Response message is required.', 400);

    const submission = await getSubmissionOrFail(submissionId, req.user);
    if (submission.submitter_id !== req.user.id) throw new AppError('Not authorized.', 403);
    if (submission.status !== 'CHANGES_REQUESTED') throw new AppError('No clarification is currently requested.', 409);

    await db.transaction(async conn => {
      const [rows] = await conn.execute('SELECT submitter_id, status FROM submissions WHERE id = ? FOR UPDATE', [submissionId]);
      if (!rows.length || rows[0].submitter_id !== req.user.id) throw new AppError('Access denied.', 403);
      if (rows[0].status !== 'CHANGES_REQUESTED') throw new AppError('No clarification is currently requested.', 409);
      await commentRepo.create({
        submissionId, authorId: req.user.id, commentType: 'clarification_response',
        body: response_message.trim(), isVisibleToSubmitter: true,
      }, conn);
      assertValidTransition(rows[0].status, 'IN_REVIEW');
      await submissionRepo.updateStatus(submissionId, 'IN_REVIEW', conn);
      await auditRepo.log({
        actorId: req.user.id, actorEmail: req.user.email,
        action: 'submission.clarification_responded', entityType: 'submission', entityId: submissionId,
        ipAddress: req.ip,
      }, conn);
    });

    const reviewers = submission.reviewer_id
      ? [{ id: submission.reviewer_id }]
      : await db.query("SELECT id FROM users WHERE role = 'reviewer' AND is_active = 1");
    await Promise.all(reviewers.map(reviewer => notifRepo.create({
      userId: reviewer.id,
      title: `Submitter responded: ${submission.ref_number}`,
      body: response_message.trim().slice(0, 200),
      notifType: 'info',
      entityType: 'submission', entityId: submissionId,
    })));

    req.session.flash = { type: 'success', message: 'Response submitted.' };
    res.redirect(`/submissions/${submissionId}`);
  } catch (err) { next(err); }
}

// ─── Forward for approval ──────────────────────────────────────────────────────
async function startReview(req, res, next) {
  try {
    const { id: submissionId } = req.params;
    if (!['reviewer', 'admin'].includes(req.user.role)) throw new AppError('Not authorized.', 403);
    const submission = await getSubmissionOrFail(submissionId, req.user);
    if (!submission.current_version_id) throw new AppError('Upload a document before starting the review.', 409);

    await db.transaction(async conn => {
      const [rows] = await conn.execute(
        'SELECT status, reviewer_id FROM submissions WHERE id = ? FOR UPDATE',
        [submissionId]
      );
      const current = rows[0];
      if (!current) throw new AppError('Submission not found.', 404);
      if (req.user.role !== 'admin' && current.reviewer_id && current.reviewer_id !== req.user.id) {
        throw new AppError('This submission is assigned to another reviewer.', 403);
      }
      if (!['REVIEW_REQUIRED', 'NEEDS_REVIEW'].includes(current.status)) {
        throw new AppError('This submission is not ready to start a review.', 409);
      }
      assertValidTransition(current.status, 'IN_REVIEW');
      await submissionRepo.updateStatus(submissionId, 'IN_REVIEW', conn);
      await auditRepo.log({
        actorId: req.user.id, actorEmail: req.user.email,
        action: 'review.started', entityType: 'submission', entityId: submissionId,
        ipAddress: req.ip,
      }, conn);
    });

    req.session.flash = { type: 'info', message: 'Review started. Check the document and extracted values, then record your findings.' };
    res.redirect(`/submissions/${submissionId}`);
  } catch (err) { next(err); }
}

async function forwardForApproval(req, res, next) {
  try {
    const { id: submissionId } = req.params;
    if (!['reviewer', 'admin'].includes(req.user.role)) throw new AppError('Not authorized.', 403);

    const reviewSummary = typeof req.body.review_summary === 'string' ? req.body.review_summary.trim() : '';
    if (!reviewSummary || reviewSummary.length > 4000) {
      throw new AppError('Add a reviewer summary of no more than 4,000 characters before forwarding.', 400);
    }
    const submission = await getSubmissionOrFail(submissionId, req.user);
    if (!submission.current_version_id) throw new AppError('Upload a document before forwarding it for approval.', 409);
    const forwardState = await db.transaction(async conn => {
      const [rows] = await conn.execute(
        'SELECT status, reviewer_id, approver_id, submitter_id FROM submissions WHERE id = ? FOR UPDATE',
        [submissionId]
      );
      const current = rows[0];
      if (!current) throw new AppError('Submission not found.', 404);
      if (req.user.role !== 'admin' && current.reviewer_id && current.reviewer_id !== req.user.id) {
        throw new AppError('This submission is assigned to another reviewer.', 403);
      }
      assertValidTransition(current.status, 'PENDING_APPROVAL');
      await commentRepo.create({
        submissionId, authorId: req.user.id, commentType: 'general',
        body: `Reviewer summary: ${reviewSummary}`, isVisibleToSubmitter: true,
      }, conn);
      await submissionRepo.updateStatus(submissionId, 'PENDING_APPROVAL', conn);
      await auditRepo.log({
        actorId: req.user.id, actorEmail: req.user.email,
        action: 'review.forwarded_for_approval', entityType: 'submission', entityId: submissionId,
        description: reviewSummary,
        ipAddress: req.ip,
      }, conn);
      return { approverId: current.approver_id, submitterId: current.submitter_id };
    });

    const approverRows = forwardState.approverId
      ? [{ id: forwardState.approverId }]
      : await db.query("SELECT id FROM users WHERE role = 'approver' AND is_active = 1");
    await Promise.all(approverRows.map(approver => notifRepo.create({
      userId: approver.id,
      title: `Ready for approval: ${submission.ref_number}`,
      body: `${req.user.full_name} completed the review. ${reviewSummary.slice(0, 160)}`,
      notifType: 'info',
      entityType: 'submission', entityId: submissionId,
    })));

    if (forwardState.submitterId) {
      await notifRepo.create({
        userId: forwardState.submitterId,
        title: `Forwarded for approval: ${submission.ref_number}`,
        body: 'Your submission has passed reviewer review and is now pending approval.',
        notifType: 'success',
        entityType: 'submission', entityId: submissionId,
      });
    }

    req.session.flash = { type: 'success', message: 'Submission forwarded for approval.' };
    res.redirect(`/submissions/${submissionId}`);
  } catch (err) { next(err); }
}

// ─── Approval / Rejection ─────────────────────────────────────────────────────
async function showApprovalPage(req, res, next) {
  try {
    const submission = await getSubmissionOrFail(req.params.id, req.user);
    if (req.user.role !== 'approver' && req.user.role !== 'admin') throw new AppError('Not authorized.', 403);
    if (submission.status !== 'PENDING_APPROVAL') throw new AppError('This submission is not pending approval.', 409);
    if (req.user.role === 'approver' && submission.approver_id && submission.approver_id !== req.user.id) {
      throw new AppError('This submission is assigned to another approver.', 403);
    }

    let verRun = null, verResults = [], fields = [], currentVersion = null, ocrResult = null;
    if (submission.current_version_id) {
      [currentVersion, fields, ocrResult, verRun] = await Promise.all([
        docVersionRepo.findById(submission.current_version_id),
        extractedFieldRepo.findByDocumentVersion(submission.current_version_id),
        ocrResultRepo.findByDocumentVersion(submission.current_version_id),
        verificationRepo.findLatestRun(submission.id, submission.current_version_id),
      ]);
      if (verRun) verResults = await verificationRepo.findResultsByRun(verRun.id);
    }

    const history    = await commentRepo.findBySubmission(submission.id, { viewerRole: req.user.role });
    const decisions  = await require('../repositories/auditRepository').approvalRepo.findBySubmission(submission.id);
    const corrections = await fieldCorrectionRepo.findBySubmission(submission.id);

    res.render('approval/decision', {
      title: `Review approval — ${submission.ref_number}`,
      user: req.user, submission, currentVersion, ocrResult, fields, verRun, verResults, history, decisions, corrections,
    });
  } catch (err) { next(err); }
}

async function processDecision(req, res, next) {
  try {
    const { id: submissionId } = req.params;
    const { decision, reason, notes } = req.body;

    if (!['approver', 'admin'].includes(req.user.role)) throw new AppError('Not authorized.', 403);
    if (!['approved', 'rejected'].includes(decision)) throw new AppError('Invalid decision.', 400);
    if (decision === 'rejected' && !reason?.trim()) throw new AppError('Rejection reason is required.', 400);

    await db.transaction(async (conn) => {
      // Re-fetch inside transaction for optimistic lock
      const [subRow] = await conn.execute(
        'SELECT * FROM submissions WHERE id = ? FOR UPDATE', [submissionId]
      );
      const submission = subRow[0];
      if (!submission) throw new AppError('Submission not found.', 404);

      // Server enforces all approval rules
      if (submission.status !== 'PENDING_APPROVAL') {
        throw new AppError(`Submission is not pending approval (current: ${submission.status}).`, 409);
      }
      if (submission.submitter_id === req.user.id) {
        throw new AppError('You cannot approve your own submission.', 403);
      }
      if (req.user.role !== 'admin' && submission.approver_id && submission.approver_id !== req.user.id) {
        throw new AppError('This submission is assigned to another approver.', 403);
      }

      const newStatus = decision === 'approved' ? 'APPROVED' : 'REJECTED';

      await conn.execute(
        'UPDATE submissions SET status = ?, rejection_reason = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?',
        [newStatus, decision === 'rejected' ? reason : null, submissionId]
      );

      // Record decision
      const { approvalRepo } = require('../repositories/auditRepository');
      const [runs] = await conn.execute(
        'SELECT id FROM verification_runs WHERE submission_id = ? ORDER BY created_at DESC LIMIT 1',
        [submissionId]
      );
      await approvalRepo.create({
        submissionId, approverId: req.user.id,
        decision, reason: reason?.trim(),
        decisionNotes: notes?.trim(),
        verificationRunId: runs[0]?.id,
      }, conn);
    });

    const submission = await submissionRepo.findById(submissionId);
    if (submission?.submitter_id) {
      await notifRepo.create({
        userId:     submission.submitter_id,
        title:      `Submission ${decision}: ${submission.ref_number}`,
        body:       decision === 'rejected' ? `Rejected: ${reason}` : 'Your submission has been approved.',
        notifType:  decision === 'approved' ? 'success' : 'error',
        entityType: 'submission', entityId: submissionId,
      });
    }
    if (submission?.reviewer_id) {
      await notifRepo.create({
        userId: submission.reviewer_id,
        title: `Submission ${decision}: ${submission.ref_number}`,
        body: decision === 'approved'
          ? 'The approver approved the submission.'
          : `The approver rejected the submission: ${reason}`,
        notifType: decision === 'approved' ? 'success' : 'error',
        entityType: 'submission', entityId: submissionId,
      });
    }

    await auditRepo.log({
      actorId: req.user.id, actorEmail: req.user.email,
      action: `submission.${decision}`, entityType: 'submission', entityId: submissionId,
      description: decision === 'rejected' ? `Rejected: ${reason}` : 'Approved',
      metadata: { decision, reason, notes },
      ipAddress: req.ip,
    });

    req.session.flash = { type: decision === 'approved' ? 'success' : 'error', message: `Submission ${decision}.` };
    res.redirect(`/submissions/${submissionId}`);
  } catch (err) { next(err); }
}

async function assignReviewers(req, res, next) {
  try {
    const submission = await submissionRepo.findById(req.params.id);
    if (!submission) throw new AppError('Submission not found.', 404);
    const reviewerId = req.body.reviewer_id || null;
    const approverId = req.body.approver_id || null;
    if (!reviewerId && !approverId) throw new AppError('Select a reviewer or approver.', 400);

    for (const [id, role] of [[reviewerId, 'reviewer'], [approverId, 'approver']]) {
      if (!id) continue;
      const assignee = await require('../repositories/userRepository').findById(id);
      if (!assignee || assignee.role !== role || !assignee.is_active) {
        throw new AppError(`Select an active ${role}.`, 400);
      }
      if (assignee.id === submission.submitter_id) {
        throw new AppError('A submitter cannot review or approve their own submission.', 400);
      }
    }

    await db.transaction(async conn => {
      const [rows] = await conn.execute('SELECT id FROM submissions WHERE id = ? FOR UPDATE', [submission.id]);
      if (!rows.length) throw new AppError('Submission not found.', 404);
      await conn.execute(
        'UPDATE submissions SET reviewer_id = ?, approver_id = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?',
        [reviewerId, approverId, submission.id]
      );
      for (const [id, role] of [[reviewerId, 'reviewer'], [approverId, 'approver']]) {
        await conn.execute(
          'UPDATE review_assignments SET is_active = 0, completed_at = UTC_TIMESTAMP() WHERE submission_id = ? AND role_context = ? AND is_active = 1',
          [submission.id, role]
        );
        if (id) {
          await conn.execute(
            `INSERT INTO review_assignments (id, submission_id, assigned_to, assigned_by, role_context)
             VALUES (?, ?, ?, ?, ?)`,
            [uuidv4(), submission.id, id, req.user.id, role]
          );
        }
      }
    });

    await auditRepo.log({
      actorId: req.user.id, actorEmail: req.user.email,
      action: 'review.assignment_updated', entityType: 'submission', entityId: submission.id,
      metadata: { reviewerId, approverId }, ipAddress: req.ip,
    });
    req.session.flash = { type: 'success', message: 'Reviewer assignments updated.' };
    res.redirect(`/submissions/${submission.id}`);
  } catch (err) { next(err); }
}

// ─── Dashboard ─────────────────────────────────────────────────────────────────
async function showDashboard(req, res, next) {
  try {
    const { role, id: userId } = req.user;

    let stats = {}, recent = [], queue = [];

    if (role === 'submitter') {
      const counts = await submissionRepo.countByStatus(userId);
      const statusMap = Object.fromEntries(counts.map(r => [r.status, Number(r.count)]));
      stats = { total: Object.values(statusMap).reduce((a, b) => a + b, 0), ...statusMap };
      const { rows } = await submissionRepo.findAll({ submitterId: userId, page: 1, limit: 5 });
      recent = rows;

    } else if (role === 'reviewer') {
      queue  = await submissionRepo.findReviewQueue(userId);
      const counts = await submissionRepo.countByStatus();
      stats = { inReview: queue.filter(s => s.status === 'IN_REVIEW').length,
                reviewRequired: queue.filter(s => ['REVIEW_REQUIRED', 'NEEDS_REVIEW'].includes(s.status)).length };

    } else if (role === 'approver') {
      queue  = await submissionRepo.findPendingApprovals(userId);
      stats = { pending: queue.length };

    } else if (role === 'admin') {
      const counts = await submissionRepo.countByStatus();
      stats = Object.fromEntries(counts.map(r => [r.status, Number(r.count)]));
      stats.total = Object.values(stats).reduce((a, b) => a + b, 0);
      const userCounts = await require('../repositories/userRepository').countByRole();
      stats.users = userCounts;
      const turnaround = await db.queryOne(
        `SELECT ROUND(AVG(TIMESTAMPDIFF(MINUTE, s.created_at, decisions.completed_at)) / 60, 1) AS average_hours
         FROM submissions s
         JOIN (
           SELECT submission_id, MAX(created_at) AS completed_at
           FROM approval_decisions
           GROUP BY submission_id
         ) decisions ON decisions.submission_id = s.id
         WHERE s.status IN ('APPROVED', 'REJECTED') AND decisions.completed_at >= s.created_at`
      );
      const corrections = await db.queryOne(
        `SELECT COUNT(DISTINCT s.id) AS processed,
                COUNT(DISTINCT CASE WHEN fc.submission_id IS NOT NULL THEN s.id END) AS corrected
         FROM submissions s
         LEFT JOIN field_corrections fc ON fc.submission_id = s.id
         WHERE s.status NOT IN ('DRAFT', 'PROCESSING', 'PROCESSING_FAILED')`
      );
      stats.averageTurnaroundHours = Number(turnaround?.average_hours) || 0;
      stats.correctionRate = Number(corrections?.processed)
        ? Math.round(Number(corrections.corrected) / Number(corrections.processed) * 100)
        : 0;
      stats.topFailingFields = await db.query(
        `SELECT affected.field_name, COUNT(*) AS failure_count
         FROM verification_results vr
         JOIN JSON_TABLE(vr.affected_fields, '$[*]' COLUMNS(field_name VARCHAR(100) PATH '$')) affected
         WHERE vr.status = 'FAIL'
         GROUP BY affected.field_name
         ORDER BY failure_count DESC, affected.field_name
         LIMIT 5`
      );
      const { rows: recentEvents } = await auditRepo.findAll({ page: 1, limit: 10 });
      recent = recentEvents;
    }

    const flash = req.session.flash || null;
    delete req.session.flash;

    res.render('dashboard/index', {
      title: 'Dashboard',
      user: req.user, stats, recent, queue, flash,
    });
  } catch (err) { next(err); }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function getSubmissionOrFail(id, user) {
  const submission = await submissionRepo.findById(id);
  if (!submission) throw new AppError('Submission not found.', 404);
  canAccessSubmission(user, submission);
  return submission;
}

function canAccessSubmission(user, submission) {
  if (user.role === 'admin') return true;
  if (user.role === 'reviewer' &&
      (!submission.reviewer_id || submission.reviewer_id === user.id)) return true;
  if (user.role === 'approver' &&
      (!submission.approver_id || submission.approver_id === user.id)) return true;
  if (user.role === 'submitter' && submission.submitter_id !== user.id) {
    throw new AppError('Access denied.', 403);
  }
  if (user.role === 'submitter') return true;
  throw new AppError('Access denied.', 403);
}

module.exports = {
  listSubmissions, showNewSubmission, newSubmissionValidation, createSubmission,
  showUpload, handleUpload, showSubmission, downloadDocument,
  correctField, requestClarification, respondClarification,
  startReview, forwardForApproval, showApprovalPage, processDecision, assignReviewers, showDashboard,
  askSubmissionAssistant, generateSubmissionSummary, draftClarificationMessage,
};
