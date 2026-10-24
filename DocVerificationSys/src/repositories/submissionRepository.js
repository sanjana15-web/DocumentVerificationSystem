'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');

class SubmissionRepository {
  /**
   * Generate a human-readable reference number like INV-2024-000042
   */
  async generateRefNumber() {
    const year = new Date().getFullYear();
    return `DOC-${year}-${uuidv4().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
  }

  async findById(id) {
    return db.queryOne(
      `SELECT s.*,
              u_sub.full_name  AS submitter_name,  u_sub.email AS submitter_email,
              u_rev.full_name  AS reviewer_name,   u_rev.email AS reviewer_email,
              u_apr.full_name  AS approver_name,   u_apr.email AS approver_email,
              dv.original_filename, dv.file_size_bytes, dv.version_number AS current_version_number,
              dv.processing_status AS doc_processing_status
       FROM   submissions s
       LEFT JOIN users u_sub ON s.submitter_id = u_sub.id
       LEFT JOIN users u_rev ON s.reviewer_id  = u_rev.id
       LEFT JOIN users u_apr ON s.approver_id  = u_apr.id
       LEFT JOIN document_versions dv ON s.current_version_id = dv.id
       WHERE  s.id = ?
       LIMIT  1`,
      [id]
    );
  }

  async findAll({ submitterId, reviewerId, approverId, status, page = 1, limit = 20, search, sortBy = 'created_at', sortDir = 'DESC' } = {}) {
    const conditions = [];
    const params = [];

    if (submitterId) { conditions.push('s.submitter_id = ?');  params.push(submitterId); }
    if (reviewerId)  { conditions.push('(s.reviewer_id = ? OR s.reviewer_id IS NULL)'); params.push(reviewerId); }
    if (approverId)  { conditions.push('(s.approver_id = ? OR s.approver_id IS NULL)'); params.push(approverId); }
    if (status) {
      if (Array.isArray(status)) {
        conditions.push(`s.status IN (${status.map(() => '?').join(',')})`);
        params.push(...status);
      } else {
        conditions.push('s.status = ?');
        params.push(status);
      }
    }
    if (search) {
      conditions.push('(s.ref_number LIKE ? OR s.title LIKE ? OR s.vendor_name LIKE ?)');
      const term = `%${search}%`;
      params.push(term, term, term);
    }

    const ALLOWED_SORT = ['created_at','updated_at','vendor_name','status','ref_number'];
    const ALLOWED_DIR  = ['ASC','DESC'];
    const orderBy = ALLOWED_SORT.includes(sortBy) ? `s.${sortBy}` : 's.created_at';
    const orderDir = ALLOWED_DIR.includes(sortDir.toUpperCase()) ? sortDir.toUpperCase() : 'DESC';

    const where  = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const offset = (page - 1) * limit;

    const rows = await db.query(
      `SELECT s.id, s.ref_number, s.title, s.status, s.vendor_name, s.doc_category, s.priority,
              s.created_at, s.updated_at, s.due_date,
              u_sub.full_name AS submitter_name,
              u_rev.full_name AS reviewer_name,
              u_apr.full_name AS approver_name,
              dv.version_number AS current_version_number
       FROM   submissions s
       LEFT JOIN users u_sub ON s.submitter_id = u_sub.id
       LEFT JOIN users u_rev ON s.reviewer_id  = u_rev.id
       LEFT JOIN users u_apr ON s.approver_id  = u_apr.id
       LEFT JOIN document_versions dv ON s.current_version_id = dv.id
       ${where}
       ORDER BY ${orderBy} ${orderDir}
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [{ total }] = await db.query(
      `SELECT COUNT(*) AS total FROM submissions s ${where}`,
      params
    );

    return { rows, total, page, limit, pages: Math.ceil(total / limit) };
  }

  async create({ submitterId, title, docCategory = 'invoice', vendorName, notes, priority = 'normal' }) {
    const id = uuidv4();
    const refNumber = await this.generateRefNumber();

    await db.query(
      `INSERT INTO submissions (id, ref_number, submitter_id, title, doc_category, vendor_name, notes, priority, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT')`,
      [id, refNumber, submitterId, title, docCategory, vendorName || null, notes || null, priority]
    );
    return this.findById(id);
  }

  async updateStatus(id, status, conn = null) {
    const exec = conn ? conn.execute.bind(conn) : db.query.bind(db);
    await exec(
      'UPDATE submissions SET status = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?',
      [status, id]
    );
  }

  async update(id, fields, conn = null) {
    const allowed = ['title', 'vendor_name', 'notes', 'priority', 'due_date', 'doc_category',
                     'reviewer_id', 'approver_id', 'current_version_id', 'rejection_reason'];
    const sets = [];
    const params = [];

    for (const [k, v] of Object.entries(fields)) {
      if (allowed.includes(k)) {
        sets.push(`${k} = ?`);
        params.push(v === undefined ? null : v);
      }
    }
    if (!sets.length) return;
    sets.push('updated_at = UTC_TIMESTAMP()');
    params.push(id);
    if (conn) await conn.execute(`UPDATE submissions SET ${sets.join(', ')} WHERE id = ?`, params);
    else await db.query(`UPDATE submissions SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  async countByStatus(submitterId = null) {
    const where = submitterId ? 'WHERE submitter_id = ?' : '';
    const params = submitterId ? [submitterId] : [];
    return db.query(
      `SELECT status, COUNT(*) AS count FROM submissions ${where} GROUP BY status`,
      params
    );
  }

  async findPendingApprovals(approverId = null) {
    const extra = approverId ? 'AND (s.approver_id = ? OR s.approver_id IS NULL)' : '';
    const params = approverId ? ['PENDING_APPROVAL', approverId] : ['PENDING_APPROVAL'];
    return db.query(
      `SELECT s.id, s.ref_number, s.title, s.vendor_name, s.created_at, s.updated_at,
              s.current_version_id, dv.original_filename,
              u_sub.full_name AS submitter_name,
              u_rev.full_name AS reviewer_name,
              ef_total.field_value AS total_amount,
              ef_currency.field_value AS currency
       FROM   submissions s
       LEFT JOIN users u_sub ON s.submitter_id = u_sub.id
       LEFT JOIN users u_rev ON s.reviewer_id  = u_rev.id
       LEFT JOIN document_versions dv ON s.current_version_id = dv.id
       LEFT JOIN extracted_fields ef_total    ON ef_total.document_version_id = dv.id    AND ef_total.field_name = 'total_amount'
       LEFT JOIN extracted_fields ef_currency ON ef_currency.document_version_id = dv.id AND ef_currency.field_name = 'currency'
       WHERE  s.status = ? ${extra}
       ORDER BY s.created_at ASC`,
      params
    );
  }

  async findReviewQueue(reviewerId = null) {
    const cond = reviewerId ? 'AND (s.reviewer_id = ? OR s.reviewer_id IS NULL)' : '';
    return db.query(
      `SELECT s.id, s.ref_number, s.title, s.vendor_name, s.status, s.priority, s.created_at,
              u_sub.full_name AS submitter_name
       FROM   submissions s
       LEFT JOIN users u_sub ON s.submitter_id = u_sub.id
       WHERE  s.status IN (?, ?, ?) ${cond}
       ORDER BY s.priority DESC, s.created_at ASC`,
      reviewerId
        ? ['IN_REVIEW', 'REVIEW_REQUIRED', 'NEEDS_REVIEW', reviewerId]
        : ['IN_REVIEW', 'REVIEW_REQUIRED', 'NEEDS_REVIEW']
    );
  }
}

module.exports = new SubmissionRepository();
