'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const router  = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const { createUploadMiddleware } = require('../middleware/upload');
const ctrl = require('../controllers/submissionController');

const upload = createUploadMiddleware();
const assistantLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many assistant questions. Wait a minute and try again.' },
});

// Dashboard
router.get('/dashboard', requireAuth, ctrl.showDashboard);

// Submission list
router.get('/',           requireAuth, ctrl.listSubmissions);
router.get('/list',       requireAuth, ctrl.listSubmissions);

// New submission
router.get('/new',        requireAuth, requireRole('submitter', 'admin'), ctrl.showNewSubmission);
router.post('/',          requireAuth, requireRole('submitter', 'admin'), ctrl.newSubmissionValidation, ctrl.createSubmission);

// Upload document
router.get('/:id/upload', requireAuth, requireRole('submitter', 'admin'), ctrl.showUpload);
router.post('/:id/upload', requireAuth, requireRole('submitter', 'admin'), upload.single('document'), ctrl.handleUpload);

// Submission detail
router.get('/:id',        requireAuth, ctrl.showSubmission);
router.post('/:id/assistant', requireAuth, assistantLimiter, ctrl.askSubmissionAssistant);
router.post('/:id/assistant/summary', requireAuth, assistantLimiter, ctrl.generateSubmissionSummary);
router.post('/:id/assistant/draft-correction', requireAuth, assistantLimiter, ctrl.draftClarificationMessage);

// Secure download
router.get('/:id/versions/:versionId/download', requireAuth, ctrl.downloadDocument);

// Field correction (reviewer/admin only — enforced in controller)
router.post('/:id/fields/:fieldId/correct', requireAuth, ctrl.correctField);

// Clarification
router.post('/:id/clarify',  requireAuth, ctrl.requestClarification);
router.post('/:id/respond',  requireAuth, ctrl.respondClarification);

// Review actions
router.post('/:id/start-review', requireAuth, ctrl.startReview);
router.post('/:id/forward',  requireAuth, ctrl.forwardForApproval);

// Approval
router.get('/:id/decide',    requireAuth, ctrl.showApprovalPage);
router.post('/:id/decide',   requireAuth, ctrl.processDecision);
router.post('/:id/assign',   requireAuth, requireRole('admin'), ctrl.assignReviewers);

module.exports = router;
