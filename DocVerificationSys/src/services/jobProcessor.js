'use strict';

/**
 * Durable in-process job processor for async OCR tasks.
 * Jobs are persisted in the database, so no work is lost on restart.
 * Each job is claimed with a lock so only one worker processes it.
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const ocrService = require('./ocrService');
const verificationEngine = require('./verificationEngine');
const { auditRepo, notifRepo } = require('../repositories/auditRepository');
const submissionRepo = require('../repositories/submissionRepository');
const { docVersionRepo } = require('../repositories/documentRepository');
const logger = require('../utils/logger');

const WORKER_ID = `worker-${process.pid}-${uuidv4().slice(0, 8)}`;
const POLL_INTERVAL_MS   = 5000;  // 5 seconds
const JOB_LOCK_TIMEOUT_S = 120;   // Jobs locked for >2 min are considered stale
const MAX_ATTEMPTS       = 3;

class JobProcessor {
  constructor() {
    this._timer = null;
    this._running = false;
  }

  start() {
    if (this._timer) return;
    logger.info('Job processor started', { workerId: WORKER_ID });
    this._timer = setInterval(() => this._pollOnce(), POLL_INTERVAL_MS);
    this._pollOnce();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Enqueue an OCR job for a document version.
   */
  static async enqueueOcr(documentVersionId, submissionId, conn = null) {
    const id = uuidv4();
    const exec = conn ? conn.execute.bind(conn) : db.query.bind(db);
    await exec(
      `INSERT INTO processing_jobs (id, job_type, payload, status, max_attempts)
       VALUES (?, 'ocr', ?, 'pending', ?)`,
      [id, JSON.stringify({ documentVersionId, submissionId }), MAX_ATTEMPTS]
    );
    logger.info('OCR job enqueued', { jobId: id, documentVersionId });
    return id;
  }

  async _pollOnce() {
    if (this._running) return;
    this._running = true;
    try {
      await this._recoverStaleJobs();
      await this._processNext();
    } catch (err) {
      logger.error('Job processor poll error', { err: err.message });
    } finally {
      this._running = false;
    }
  }

  /** Unlock jobs that have been stuck in processing longer than the timeout */
  async _recoverStaleJobs() {
    const exhausted = await db.transaction(async conn => {
      const [rows] = await conn.execute(
        `SELECT id, payload, attempts, max_attempts FROM processing_jobs
         WHERE status = 'processing'
           AND locked_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? SECOND)
         FOR UPDATE SKIP LOCKED`,
        [JOB_LOCK_TIMEOUT_S]
      );
      const failed = [];
      for (const job of rows) {
        const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
        if (job.attempts >= job.max_attempts) {
          await conn.execute(
            `UPDATE processing_jobs SET status = 'failed', locked_at = NULL, locked_by = NULL,
             error_message = 'Worker lease expired after the maximum number of attempts.', updated_at = UTC_TIMESTAMP()
             WHERE id = ?`,
            [job.id]
          );
          failed.push(payload.submissionId);
        } else {
          await conn.execute(
            `UPDATE processing_jobs SET status = 'pending', locked_at = NULL, locked_by = NULL,
             updated_at = UTC_TIMESTAMP() WHERE id = ?`,
            [job.id]
          );
        }
      }
      return failed;
    });
    for (const submissionId of exhausted) {
      await submissionRepo.updateStatus(submissionId, 'PROCESSING_FAILED');
    }
  }

  async _processNext() {
    const job = await db.transaction(async conn => {
      const [rows] = await conn.execute(
        `SELECT * FROM processing_jobs
         WHERE status = 'pending' AND attempts < max_attempts AND scheduled_at <= NOW()
         ORDER BY scheduled_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`
      );
      if (!rows.length) return null;
      const claimed = rows[0];
      await conn.execute(
        `UPDATE processing_jobs SET status = 'processing', locked_at = UTC_TIMESTAMP(), locked_by = ?,
         attempts = attempts + 1, updated_at = UTC_TIMESTAMP() WHERE id = ?`,
        [WORKER_ID, claimed.id]
      );
      return { ...claimed, attempts: claimed.attempts + 1 };
    });
    if (!job) return;
    logger.info('Processing job', { jobId: job.id, type: job.job_type, attempt: job.attempts });

    try {
      await this._executeJob(job);
      await db.query(
        `UPDATE processing_jobs SET status = 'completed', completed_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = ?`,
        [job.id]
      );
    } catch (err) {
      logger.error('Job execution failed', { jobId: job.id, err: err.message });
      const isFinal = job.attempts >= job.max_attempts;
      await db.query(
        `UPDATE processing_jobs
         SET status = ?, error_message = ?, locked_at = NULL, locked_by = NULL,
             scheduled_at = DATE_ADD(NOW(), INTERVAL 30 SECOND), updated_at = UTC_TIMESTAMP()
         WHERE id = ?`,
        [
          isFinal ? 'failed' : 'pending',
          err.message,
          job.id,
        ]
      );

      if (isFinal) {
        const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
        // Ensure submission is not stuck in PROCESSING
        await submissionRepo.updateStatus(payload.submissionId, 'PROCESSING_FAILED');
        const submission = await submissionRepo.findById(payload.submissionId);
        if (submission?.submitter_id) {
          await notifRepo.create({
            userId: submission.submitter_id,
            title: `Document processing failed: ${submission.ref_number}`,
            body: 'Your document could not be processed. Open the submission and upload a corrected file to retry.',
            notifType: 'error',
            entityType: 'submission',
            entityId: payload.submissionId,
          });
        }
        logger.error('Job permanently failed', { jobId: job.id, submissionId: payload.submissionId });
      }
    }
  }

  async _executeJob(job) {
    const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;

    if (job.job_type === 'ocr') {
      const { documentVersionId, submissionId } = payload;

      // Run OCR
      const result = await ocrService.processDocument(documentVersionId);
      if (!result.success) throw new Error(result.error || 'OCR failed');

      // Run verification automatically after OCR
      const verification = await verificationEngine.run(submissionId, documentVersionId, null);
      await submissionRepo.updateStatus(
        submissionId,
        verification.overall === 'NEEDS_REVIEW' ? 'NEEDS_REVIEW' : 'REVIEW_REQUIRED'
      );

      // Notify the submitter
      const submission = await submissionRepo.findById(submissionId);
      if (submission) {
        const notifications = [notifRepo.create({
          userId:     submission.submitter_id,
          title:      `Document processed: ${submission.ref_number}`,
          body:       'Your document has been processed and is now under review.',
          notifType:  'info',
          entityType: 'submission',
          entityId:   submissionId,
        })];
        const reviewers = submission.reviewer_id
          ? [{ id: submission.reviewer_id }]
          : await db.query("SELECT id FROM users WHERE role = 'reviewer' AND is_active = 1");
        for (const reviewer of reviewers) {
          notifications.push(notifRepo.create({
            userId: reviewer.id,
            title: `Ready for review: ${submission.ref_number}`,
            body: 'Document processing is complete and the submission is ready for review.',
            notifType: 'info',
            entityType: 'submission',
            entityId: submissionId,
          }));
        }
        await Promise.all(notifications);
      }
    } else {
      throw new Error(`Unknown job type: ${job.job_type}`);
    }
  }
}

module.exports = JobProcessor;
