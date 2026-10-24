'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');

class AuditRepository {
  async log({ actorId, actorEmail, action, entityType, entityId, description, metadata, ipAddress, userAgent } = {}, conn = null) {
    const exec = conn ? conn.execute.bind(conn) : db.query.bind(db);
    await exec(
      `INSERT INTO audit_events (id, actor_id, actor_email, action, entity_type, entity_id,
                                  description, metadata, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(),
        actorId   || null,
        actorEmail || null,
        action,
        entityType,
        entityId   || null,
        description || null,
        metadata ? JSON.stringify(metadata) : null,
        ipAddress  || null,
        userAgent  || null,
      ]
    );
  }

  async findAll({ entityType, entityId, actorId, action, page = 1, limit = 50, dateFrom, dateTo } = {}) {
    const conds = [];
    const params = [];

    if (entityType) { conds.push('entity_type = ?'); params.push(entityType); }
    if (entityId)   { conds.push('entity_id = ?');   params.push(entityId); }
    if (actorId)    { conds.push('actor_id = ?');     params.push(actorId); }
    if (action)     { conds.push('action = ?');       params.push(action); }
    if (dateFrom)   { conds.push('created_at >= ?');  params.push(dateFrom); }
    if (dateTo)     { conds.push('created_at <= ?');  params.push(dateTo); }

    const where  = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const offset = (page - 1) * limit;

    const rows = await db.query(
      `SELECT * FROM audit_events ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [{ total }] = await db.query(
      `SELECT COUNT(*) AS total FROM audit_events ${where}`,
      params
    );

    return { rows, total, page, limit, pages: Math.ceil(total / limit) };
  }
}

class NotificationRepository {
  async create({ userId, title, body, notifType = 'info', entityType, entityId }) {
    const id = uuidv4();
    await db.query(
      `INSERT INTO notifications (id, user_id, title, body, notif_type, entity_type, entity_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, userId, title, body || null, notifType, entityType || null, entityId || null]
    );
    return id;
  }

  async findByUser(userId, { onlyUnread = false, page = 1, limit = 20 } = {}) {
    const where = onlyUnread ? 'WHERE user_id = ? AND is_read = 0' : 'WHERE user_id = ?';
    const offset = (page - 1) * limit;
    const rows = await db.query(
      `SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );
    const [{ total }] = await db.query(
      `SELECT COUNT(*) AS total FROM notifications ${where}`, [userId]
    );
    return { rows, total };
  }

  async markRead(id, userId) {
    await db.query(
      'UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?',
      [id, userId]
    );
  }

  async markAllRead(userId) {
    await db.query(
      'UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0',
      [userId]
    );
  }

  async countUnread(userId) {
    const [row] = await db.query(
      'SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0',
      [userId]
    );
    return row.count;
  }
}

class ReviewCommentRepository {
  async create({ submissionId, authorId, commentType, body, isVisibleToSubmitter = false, parentId }, conn = null) {
    const id = uuidv4();
    const exec = conn ? conn.execute.bind(conn) : db.query.bind(db);
    await exec(
      `INSERT INTO review_comments (id, submission_id, author_id, comment_type, body, is_visible_to_submitter, parent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, submissionId, authorId, commentType, body, isVisibleToSubmitter ? 1 : 0, parentId || null]
    );
    if (conn) return { id, submission_id: submissionId, author_id: authorId, comment_type: commentType, body };
    return this.findById(id);
  }

  async findById(id) {
    return db.queryOne(
      `SELECT rc.*, u.full_name AS author_name, u.role AS author_role
       FROM review_comments rc
       JOIN users u ON rc.author_id = u.id
       WHERE rc.id = ? LIMIT 1`,
      [id]
    );
  }

  async findBySubmission(submissionId, { viewerRole, viewerId } = {}) {
    // Submitters only see comments marked visible
    let visFilter = '';
    if (viewerRole === 'submitter') {
      visFilter = 'AND rc.is_visible_to_submitter = 1';
    }
    return db.query(
      `SELECT rc.*, u.full_name AS author_name, u.role AS author_role
       FROM   review_comments rc
       JOIN   users u ON rc.author_id = u.id
       WHERE  rc.submission_id = ? ${visFilter}
       ORDER BY rc.created_at ASC`,
      [submissionId]
    );
  }
}

class ApprovalRepository {
  async create({ submissionId, approverId, decision, reason, decisionNotes, verificationRunId }, conn = null) {
    const id = uuidv4();
    const exec = conn ? conn.execute.bind(conn) : db.query.bind(db);
    await exec(
      `INSERT INTO approval_decisions
         (id, submission_id, approver_id, decision, reason, decision_notes, verification_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, submissionId, approverId, decision, reason || null, decisionNotes || null, verificationRunId || null]
    );
    if (conn) return { id, submission_id: submissionId, approver_id: approverId, decision };
    return this.findById(id);
  }

  async findById(id) {
    return db.queryOne(
      `SELECT ad.*, u.full_name AS approver_name FROM approval_decisions ad
       JOIN users u ON ad.approver_id = u.id WHERE ad.id = ? LIMIT 1`,
      [id]
    );
  }

  async findBySubmission(submissionId) {
    return db.query(
      `SELECT ad.*, u.full_name AS approver_name
       FROM   approval_decisions ad
       JOIN   users u ON ad.approver_id = u.id
       WHERE  ad.submission_id = ?
       ORDER BY ad.created_at DESC`,
      [submissionId]
    );
  }
}

class VerificationRepository {
  async createRun({ submissionId, documentVersionId, triggeredBy, ruleSetVersion = '1.0' }) {
    const id = uuidv4();
    await db.query(
      `INSERT INTO verification_runs (id, submission_id, document_version_id, triggered_by, status, rule_set_version)
       VALUES (?, ?, ?, ?, 'running', ?)`,
      [id, submissionId, documentVersionId, triggeredBy || null, ruleSetVersion]
    );
    return id;
  }

  async completeRun(runId, overallResult) {
    await db.query(
      `UPDATE verification_runs SET status = 'completed', overall_result = ?, completed_at = UTC_TIMESTAMP()
       WHERE id = ?`,
      [overallResult, runId]
    );
  }

  async failRun(runId) {
    await db.query(
      `UPDATE verification_runs SET status = 'failed', completed_at = UTC_TIMESTAMP() WHERE id = ?`,
      [runId]
    );
  }

  async saveResult({ runId, ruleId, ruleName, ruleVersion = '1.0', status, severity, explanation, affectedFields, actualValue, expectedValue }) {
    const id = uuidv4();
    await db.query(
      `INSERT INTO verification_results
         (id, run_id, rule_id, rule_name, rule_version, status, severity, explanation,
          affected_fields, actual_value, expected_value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, runId, ruleId, ruleName, ruleVersion, status, severity,
       explanation || null,
       affectedFields ? JSON.stringify(affectedFields) : null,
       actualValue !== undefined ? String(actualValue) : null,
       expectedValue !== undefined ? String(expectedValue) : null]
    );
  }

  async findLatestRun(submissionId, documentVersionId = null) {
    if (documentVersionId) {
      return db.queryOne(
        `SELECT * FROM verification_runs
         WHERE submission_id = ? AND document_version_id = ?
         ORDER BY created_at DESC LIMIT 1`,
        [submissionId, documentVersionId]
      );
    }
    return db.queryOne(
      `SELECT * FROM verification_runs WHERE submission_id = ? ORDER BY created_at DESC LIMIT 1`,
      [submissionId]
    );
  }

  async findResultsByRun(runId) {
    return db.query(
      'SELECT * FROM verification_results WHERE run_id = ? ORDER BY severity DESC, rule_id',
      [runId]
    );
  }

  async findRunsBySubmission(submissionId) {
    return db.query(
      'SELECT * FROM verification_runs WHERE submission_id = ? ORDER BY created_at DESC',
      [submissionId]
    );
  }
}

class FieldCorrectionRepository {
  async create({ submissionId, documentVersionId, fieldName, originalValue, correctedValue, correctedBy, correctionReason }, conn = null) {
    const id = uuidv4();
    const exec = conn ? conn.execute.bind(conn) : db.query.bind(db);
    await exec(
      `INSERT INTO field_corrections
         (id, submission_id, document_version_id, field_name, original_value, corrected_value, corrected_by, correction_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, submissionId, documentVersionId, fieldName, originalValue || null,
       correctedValue || null, correctedBy, correctionReason || null]
    );
  }

  async findBySubmission(submissionId) {
    return db.query(
      `SELECT fc.*, u.full_name AS corrector_name
       FROM   field_corrections fc
       JOIN   users u ON fc.corrected_by = u.id
       WHERE  fc.submission_id = ?
       ORDER BY fc.created_at DESC`,
      [submissionId]
    );
  }
}

module.exports = {
  auditRepo:          new AuditRepository(),
  notifRepo:          new NotificationRepository(),
  commentRepo:        new ReviewCommentRepository(),
  approvalRepo:       new ApprovalRepository(),
  verificationRepo:   new VerificationRepository(),
  fieldCorrectionRepo: new FieldCorrectionRepository(),
};
