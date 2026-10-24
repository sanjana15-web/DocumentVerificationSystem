'use strict';

/**
 * Valid status transitions for submissions.
 * Key = current status, Value = set of allowed next statuses.
 *
 * Never trust the client to provide valid transitions.
 * Always enforce through this map.
 */
const TRANSITIONS = {
  DRAFT:              new Set(['PROCESSING', 'DRAFT']),
  UPLOADED:           new Set(['PROCESSING', 'PROCESSING_FAILED']),
  PROCESSING:         new Set(['REVIEW_REQUIRED', 'NEEDS_REVIEW', 'PROCESSING_FAILED']),
  REVIEW_REQUIRED:    new Set(['IN_REVIEW', 'CHANGES_REQUESTED', 'PENDING_APPROVAL', 'PROCESSING']),
  NEEDS_REVIEW:       new Set(['IN_REVIEW', 'CHANGES_REQUESTED', 'PENDING_APPROVAL']),
  IN_REVIEW:          new Set(['CHANGES_REQUESTED', 'CLARIFICATION_REQUIRED', 'PENDING_APPROVAL', 'REVIEW_REQUIRED']),
  CHANGES_REQUESTED:  new Set(['PROCESSING', 'IN_REVIEW']),
  CLARIFICATION_REQUIRED: new Set(['IN_REVIEW', 'PROCESSING']),
  RESUBMITTED:        new Set(['PROCESSING']),
  PENDING_APPROVAL:   new Set(['APPROVED', 'REJECTED', 'IN_REVIEW', 'CHANGES_REQUESTED']),
  APPROVED:           new Set([]), // terminal
  REJECTED:           new Set(['PROCESSING']), // can resubmit after rejection
  PROCESSING_FAILED:  new Set(['PROCESSING']), // can retry
};

const UPLOADABLE_STATUSES = new Set(['DRAFT', 'CHANGES_REQUESTED', 'REJECTED', 'PROCESSING_FAILED']);

function isValidTransition(fromStatus, toStatus) {
  return TRANSITIONS[fromStatus]?.has(toStatus) ?? false;
}

function canUploadDocument(status) {
  return UPLOADABLE_STATUSES.has(status);
}

function assertValidTransition(fromStatus, toStatus) {
  if (!isValidTransition(fromStatus, toStatus)) {
    const { AppError } = require('../middleware/errorHandler');
    throw new AppError(
      `Invalid status transition from ${fromStatus} to ${toStatus}.`,
      409
    );
  }
}

module.exports = { TRANSITIONS, isValidTransition, canUploadDocument, assertValidTransition };
