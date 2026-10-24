'use strict';

const { body, validationResult } = require('express-validator');
const userRepo = require('../repositories/userRepository');
const { auditRepo, notifRepo } = require('../repositories/auditRepository');
const submissionRepo = require('../repositories/submissionRepository');
const db = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const documentTypeRepo = require('../repositories/documentTypeRepository');
const bcrypt = require('bcrypt');
const config = require('../config/env');
const { v4: uuidv4 } = require('uuid');
const { parseDecimal } = require('../document-types/registry');

async function showUsers(req, res, next) {
  try {
    const { role, search, page = 1 } = req.query;
    const result = await userRepo.findAll({ role, search, page: Math.max(1, parseInt(page, 10) || 1), limit: 30 });
    res.render('admin/users', {
      title: 'User Management', user: req.user,
      users: result.rows, total: result.total, pages: result.pages,
      currentPage: result.page, filters: { role, search },
      flash: req.session.flash && (() => { const f = req.session.flash; delete req.session.flash; return f; })() || null,
    });
  } catch (err) { next(err); }
}

async function showCreateUser(req, res) {
  res.render('admin/create-user', {
    title: 'Create User', user: req.user, errors: [], values: {},
  });
}

const createUserValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('full_name').trim().isLength({ min: 2, max: 200 }).withMessage('Full name required'),
  body('role').isIn(['submitter', 'reviewer', 'approver', 'admin']).withMessage('Invalid role'),
  body('password').isLength({ min: 10 }).matches(/[A-Z]/).matches(/[a-z]/).matches(/[0-9]/)
    .withMessage('Password must be 10+ characters and include uppercase, lowercase, and a number.'),
];

async function createUser(req, res, next) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).render('admin/create-user', {
        title: 'Create User', user: req.user,
        errors: errors.array(), values: req.body,
      });
    }

    const { email, full_name, role, password } = req.body;

    const existing = await userRepo.findByEmail(email);
    if (existing) {
      return res.status(400).render('admin/create-user', {
        title: 'Create User', user: req.user,
        errors: [{ msg: 'A user with this email already exists.' }], values: req.body,
      });
    }

    const passwordHash = await bcrypt.hash(password, config.security.bcryptRounds);
    const newUser = await userRepo.create({ email, fullName: full_name, role, passwordHash, mustChangePwd: true });

    await auditRepo.log({
      actorId: req.user.id, actorEmail: req.user.email,
      action: 'admin.user_created', entityType: 'user', entityId: newUser.id,
      description: `Created user ${email} with role ${role}`,
      ipAddress: req.ip,
    });

    req.session.flash = { type: 'success', message: `User ${email} created.` };
    res.redirect('/admin/users');
  } catch (err) { next(err); }
}

async function showEditUser(req, res, next) {
  try {
    const target = await userRepo.findById(req.params.id);
    if (!target) throw new AppError('User not found.', 404);
    res.render('admin/edit-user', {
      title: 'Edit User', user: req.user, target,
      errors: [],
    });
  } catch (err) { next(err); }
}

async function updateUser(req, res, next) {
  try {
    const { id } = req.params;

    // Admin cannot demote themselves
    if (id === req.user.id && req.body.role && req.body.role !== req.user.role) {
      throw new AppError('You cannot change your own role.', 403);
    }
    if (id === req.user.id && req.body.is_active === '0') {
      throw new AppError('You cannot deactivate your own account.', 403);
    }

    const target = await userRepo.findById(id);
    if (!target) throw new AppError('User not found.', 404);

    const updates = {};
    if (req.body.full_name !== undefined) {
      const fullName = String(req.body.full_name).trim();
      if (fullName.length < 2 || fullName.length > 200) throw new AppError('Full name must be 2-200 characters.', 400);
      updates.fullName = fullName;
    }
    if (req.body.role !== undefined) {
      if (!['submitter', 'reviewer', 'approver', 'admin'].includes(req.body.role)) throw new AppError('Invalid role.', 400);
      updates.role = req.body.role;
    }
    if (req.body.is_active !== undefined) updates.isActive = req.body.is_active === '1';
    if (target.role === 'admin' &&
        (updates.role && updates.role !== 'admin' || updates.isActive === false)) {
      const otherActiveAdmins = await db.queryOne(
        "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1 AND id <> ?",
        [id]
      );
      if (Number(otherActiveAdmins.count) === 0) throw new AppError('At least one active administrator must remain.', 409);
    }

    await userRepo.update(id, updates);

    await auditRepo.log({
      actorId: req.user.id, actorEmail: req.user.email,
      action: 'admin.user_updated', entityType: 'user', entityId: id,
      metadata: updates, ipAddress: req.ip,
    });

    req.session.flash = { type: 'success', message: 'User updated.' };
    res.redirect('/admin/users');
  } catch (err) { next(err); }
}

async function showAuditLog(req, res, next) {
  try {
    const { entityType, action, page = 1, dateFrom, dateTo } = req.query;
    const result = await auditRepo.findAll({
      entityType, action, page: parseInt(page, 10) || 1, limit: 50, dateFrom, dateTo,
    });
    res.render('admin/audit-log', {
      title: 'Audit Log', user: req.user,
      events: result.rows, total: result.total, pages: result.pages,
      currentPage: result.page, filters: { entityType, action, dateFrom, dateTo },
    });
  } catch (err) { next(err); }
}

async function showSettings(req, res, next) {
  try {
    const rows = await db.query('SELECT * FROM app_settings ORDER BY `key`');
    const settings = Object.fromEntries(rows.map(r => [r.key, r]));
    const flash = req.session.flash || null;
    delete req.session.flash;
    res.render('admin/settings', {
      title: 'System Settings', user: req.user, settings, flash,
    });
  } catch (err) { next(err); }
}

async function updateSettings(req, res, next) {
  try {
    const allowed = [
      'max_file_size_mb', 'allowed_mime_types', 'max_page_count',
      'duplicate_check_enabled', 'amount_tolerance_pct', 'require_po_reference',
      'auto_assign_reviewer', 'ocr_confidence_threshold',
    ];

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        await db.query(
          'UPDATE app_settings SET `value` = ?, updated_by = ? WHERE `key` = ?',
          [req.body[key], req.user.id, key]
        );
      }
    }

    await auditRepo.log({
      actorId: req.user.id, actorEmail: req.user.email,
      action: 'admin.settings_updated', entityType: 'settings',
      metadata: req.body, ipAddress: req.ip,
    });

    req.session.flash = { type: 'success', message: 'Settings updated.' };
    res.redirect('/admin/settings');
  } catch (err) { next(err); }
}

async function showAdminDashboard(req, res, next) {
  try {
    const counts  = await submissionRepo.countByStatus();
    const userCnt = await userRepo.countByRole();
    const { rows: recentAudit } = await auditRepo.findAll({ page: 1, limit: 15 });

    const jobStats = await db.query(
      "SELECT status, COUNT(*) AS cnt FROM processing_jobs GROUP BY status"
    );

    res.render('admin/dashboard', {
      title: 'Admin Dashboard', user: req.user,
      submissionCounts: counts, userCounts: userCnt,
      recentAudit, jobStats,
    });
  } catch (err) { next(err); }
}

async function showDocumentTypes(req, res, next) {
  try {
    const documentTypes = await documentTypeRepo.findAll();
    const rules = await db.query('SELECT document_type_id, rule_id, rule_name, is_enabled, requires_human FROM verification_rules ORDER BY document_type_id, rule_name');
    const rulesByType = new Map();
    for (const rule of rules) {
      if (!rulesByType.has(rule.document_type_id)) rulesByType.set(rule.document_type_id, []);
      rulesByType.get(rule.document_type_id).push(rule);
    }
    const flash = req.session.flash || null;
    delete req.session.flash;
    res.render('admin/document-types', { title: 'Document Types', user: req.user, documentTypes, rulesByType, flash });
  } catch (err) { next(err); }
}

async function updateDocumentType(req, res, next) {
  try {
    const documentType = await documentTypeRepo.findById(req.params.id);
    if (!documentType) throw new AppError('Document type not found.', 404);
    const requested = req.body.required_fields;
    const requiredIds = new Set(
      (Array.isArray(requested) ? requested : requested ? [requested] : []).map(String)
    );
    const knownIds = new Set(documentType.fields.map(field => field.id));
    if ([...requiredIds].some(id => !knownIds.has(id))) {
      throw new AppError('The required-field selection contains an unknown field.', 400);
    }
    const fields = documentType.fields.map(field => ({ ...field, required: requiredIds.has(field.id) }));
    const requestedRules = req.body.enabled_rules;
    const enabledRuleIds = new Set(
      (Array.isArray(requestedRules) ? requestedRules : requestedRules ? [requestedRules] : []).map(String)
    );
    const knownRules = await db.query(
      'SELECT rule_id FROM verification_rules WHERE document_type_id = ?',
      [documentType.id]
    );
    const knownRuleIds = new Set(knownRules.map(rule => rule.rule_id));
    if ([...enabledRuleIds].some(id => !knownRuleIds.has(id)) ||
        !enabledRuleIds.has('AUTHENTICITY_MANUAL_REVIEW')) {
      throw new AppError('Unknown validation rule or required manual authenticity review disabled.', 400);
    }
    await db.transaction(async conn => {
      await documentTypeRepo.update({
        id: documentType.id,
        displayName: documentType.display_name,
        description: documentType.description,
        enabled: req.body.enabled === '1',
        fields,
        updatedBy: req.user.id,
      }, conn);
      for (const ruleId of knownRuleIds) {
        await conn.execute(
          'UPDATE verification_rules SET is_enabled = ? WHERE document_type_id = ? AND rule_id = ?',
          [enabledRuleIds.has(ruleId) ? 1 : 0, documentType.id, ruleId]
        );
      }
    });
    await auditRepo.log({
      actorId: req.user.id, actorEmail: req.user.email,
      action: 'admin.document_type_updated', entityType: 'document_type', entityId: documentType.id,
      metadata: { enabled: req.body.enabled === '1', requiredFields: [...requiredIds], enabledRules: [...enabledRuleIds] }, ipAddress: req.ip,
    });
    req.session.flash = { type: 'success', message: `${documentType.display_name} settings saved.` };
    res.redirect('/admin/document-types');
  } catch (err) { next(err); }
}

async function showReferences(req, res, next) {
  try {
    const references = await db.query(
      `SELECT rr.*, creator.full_name AS creator_name, verifier.full_name AS verifier_name
       FROM reference_records rr
       JOIN users creator ON rr.created_by = creator.id
       JOIN users verifier ON rr.verified_by = verifier.id
       ORDER BY rr.created_at DESC LIMIT 200`
    );
    const flash = req.session.flash || null;
    delete req.session.flash;
    res.render('admin/references', { title: 'Trusted Reference Records', user: req.user, references, flash });
  } catch (err) { next(err); }
}

async function createReference(req, res, next) {
  try {
    const referenceKey = String(req.body.reference_key || '').trim();
    const supplierName = String(req.body.supplier_name || '').trim();
    const sourceName = String(req.body.source_name || '').trim();
    const totalAmount = parseDecimal(String(req.body.total_amount || ''));
    if (!referenceKey || referenceKey.length > 255 || !supplierName || supplierName.length > 255 ||
        !sourceName || sourceName.length > 255 || totalAmount === null || totalAmount < 0) {
      throw new AppError('Enter a valid purchase order reference, supplier, non-negative total, and source name.', 400);
    }
    const id = uuidv4();
    await db.query(
      `INSERT INTO reference_records
       (id, organization_id, document_type_id, reference_key, record_data, source_name, source_reference,
        created_by, verified_by, verified_at)
       VALUES (?, 'default', 'purchase_order', ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
      [id, referenceKey, JSON.stringify({
        purchase_order_number: referenceKey,
        supplier_name: supplierName,
        total_amount: totalAmount.toFixed(2),
        currency: String(req.body.currency || '').trim().toUpperCase() || null,
      }), sourceName, String(req.body.source_reference || '').trim() || null, req.user.id, req.user.id]
    );
    await auditRepo.log({
      actorId: req.user.id, actorEmail: req.user.email,
      action: 'admin.reference_record_created', entityType: 'reference_record', entityId: id,
      metadata: { documentType: 'purchase_order', referenceKey, sourceName }, ipAddress: req.ip,
    });
    req.session.flash = { type: 'success', message: 'Trusted reference record added.' };
    res.redirect('/admin/references');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return next(new AppError('An active reference with this type and key already exists.', 409));
    next(err);
  }
}

async function deactivateReference(req, res, next) {
  try {
    const result = await db.query(
      'UPDATE reference_records SET is_active = 0 WHERE id = ? AND is_active = 1',
      [req.params.id]
    );
    if (!result.affectedRows) throw new AppError('Active reference record not found.', 404);
    await auditRepo.log({
      actorId: req.user.id, actorEmail: req.user.email,
      action: 'admin.reference_record_deactivated', entityType: 'reference_record', entityId: req.params.id,
      ipAddress: req.ip,
    });
    req.session.flash = { type: 'success', message: 'Reference record deactivated.' };
    res.redirect('/admin/references');
  } catch (err) { next(err); }
}

module.exports = {
  showUsers, showCreateUser, createUserValidation, createUser,
  showEditUser, updateUser, showAuditLog, showSettings, updateSettings, showAdminDashboard,
  showDocumentTypes, updateDocumentType, showReferences, createReference, deactivateReference,
};
