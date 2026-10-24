'use strict';

function statusBadge(status) {
  const map = {
    DRAFT: ['badge-draft', '📝 Draft'],
    PROCESSING: ['badge-processing', '⏳ Processing'],
    UPLOADED: ['badge-processing', '📄 Uploaded'],
    REVIEW_REQUIRED: ['badge-review-req', '👁 Review Required'],
    NEEDS_REVIEW: ['badge-review-req', '⚠ Needs Review'],
    IN_REVIEW: ['badge-in-review', '✏️ In Review'],
    CHANGES_REQUESTED: ['badge-changes-req', '↩ Changes Requested'],
    CLARIFICATION_REQUIRED: ['badge-changes-req', '↩ Clarification Required'],
    RESUBMITTED: ['badge-processing', '↻ Resubmitted'],
    PENDING_APPROVAL: ['badge-pending-appr', '⏳ Pending Approval'],
    APPROVED: ['badge-approved', '✅ Approved'],
    REJECTED: ['badge-rejected', '❌ Rejected'],
    PROCESSING_FAILED: ['badge-failed', '🔴 Failed'],
  };
  const [className, label] = map[status] || ['badge-draft', status];
  return `<span class="badge ${className}">${label}</span>`;
}

function verStatusBadge(status) {
  const map = {
    PASS: ['badge-pass', '✓ Pass'],
    FAIL: ['badge-fail', '✗ Fail'],
    WARNING: ['badge-warning', '⚠ Warning'],
    NOT_CHECKED: ['badge-notcheck', '— N/A'],
    NEEDS_REVIEW: ['badge-warning', '⚠ Needs Review'],
  };
  const [className, label] = map[status] || ['badge-notcheck', status];
  return `<span class="badge ${className}">${label}</span>`;
}

function severityBadge(severity) {
  const classes = {
    critical: 'badge-critical',
    high: 'badge-high',
    medium: 'badge-medium',
    low: 'badge-low',
    info: 'badge-info',
  };
  return `<span class="badge ${classes[severity] || 'badge-info'}">${severity}</span>`;
}

function roleBadge(role) {
  return `<span class="badge badge-role-${role}">${role}</span>`;
}

function fmtDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return date.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function fmtBytes(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function confClass(confidence) {
  if (!confidence) return 'conf-low';
  if (confidence >= 80) return 'conf-high';
  if (confidence >= 60) return 'conf-med';
  return 'conf-low';
}

module.exports = {
  statusBadge,
  verStatusBadge,
  severityBadge,
  roleBadge,
  fmtDate,
  fmtDateTime,
  fmtBytes,
  confClass,
};
