'use strict';

const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth');
const { notifRepo } = require('../repositories/auditRepository');
const ocrService = require('../services/ocrService');
const aiService  = require('../services/aiService');
const verificationRepo = require('../repositories/auditRepository').verificationRepo;
const { extractedFieldRepo } = require('../repositories/documentRepository');

router.get('/notifications', requireAuth, async (req, res, next) => {
  try {
    const { rows, total } = await notifRepo.findByUser(req.user.id, { page: 1, limit: 30 });
    res.render('notifications', { title: 'Notifications', user: req.user, notifications: rows, total });
  } catch (err) { next(err); }
});

router.post('/notifications/:id/read', requireAuth, async (req, res, next) => {
  try {
    await notifRepo.markRead(req.params.id, req.user.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.post('/notifications/read-all', requireAuth, async (req, res, next) => {
  try {
    await notifRepo.markAllRead(req.user.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// Health endpoint
router.get('/health', async (req, res) => {
  const ocrHealth = await ocrService.healthCheck();
  res.json({
    status: 'ok',
    ai:     aiService.isAvailable ? 'configured' : 'not_configured',
    ocr:    ocrHealth.status || 'unknown',
    ts:     new Date().toISOString(),
  });
});

// AI explanation endpoint
router.post('/api/ai/explain-result', requireAuth, async (req, res, next) => {
  try {
    const { run_id, rule_id } = req.body;
    if (!run_id || !rule_id) return res.status(400).json({ error: 'run_id and rule_id required' });

    const results = await verificationRepo.findResultsByRun(run_id);
    const result  = results.find(r => r.rule_id === rule_id);
    if (!result) return res.status(404).json({ error: 'Result not found' });

    const run = await require('../config/database').queryOne(
      'SELECT submission_id, document_version_id FROM verification_runs WHERE id = ? LIMIT 1', [run_id]
    );
    if (!run) return res.status(404).json({ error: 'Result not found' });
    const submission = await require('../repositories/submissionRepository').findById(run.submission_id);
    if (!submission) return res.status(404).json({ error: 'Result not found' });
    const canView = req.user.role === 'admin' ||
      (req.user.role === 'submitter' && submission.submitter_id === req.user.id) ||
      (req.user.role === 'reviewer' && (!submission.reviewer_id || submission.reviewer_id === req.user.id)) ||
      (req.user.role === 'approver' && (!submission.approver_id || submission.approver_id === req.user.id));
    if (!canView) return res.status(403).json({ error: 'Access denied.' });

    const fields = await extractedFieldRepo.getFieldMap(run.document_version_id);
    const explanation = await aiService.explainVerificationResult(result, fields);
    if (!explanation) return res.json({ available: false, message: 'AI explanations are not configured.' });

    res.json({ available: true, explanation });
  } catch (err) { next(err); }
});

module.exports = router;
