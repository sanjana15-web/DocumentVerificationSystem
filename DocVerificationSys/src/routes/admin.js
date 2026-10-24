'use strict';

const express = require('express');
const router  = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const ctrl = require('../controllers/adminController');

router.use(requireAuth, requireRole('admin'));

router.get('/',             ctrl.showAdminDashboard);
router.get('/users',        ctrl.showUsers);
router.get('/users/new',    ctrl.showCreateUser);
router.post('/users',       ctrl.createUserValidation, ctrl.createUser);
router.get('/users/:id/edit', ctrl.showEditUser);
router.post('/users/:id',   ctrl.updateUser);

router.get('/audit',        ctrl.showAuditLog);
router.get('/settings',     ctrl.showSettings);
router.post('/settings',    ctrl.updateSettings);
router.get('/document-types', ctrl.showDocumentTypes);
router.post('/document-types/:id', ctrl.updateDocumentType);
router.get('/references', ctrl.showReferences);
router.post('/references', ctrl.createReference);
router.post('/references/:id/deactivate', ctrl.deactivateReference);

module.exports = router;
