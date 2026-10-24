'use strict';

const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const config = require('../config/env');
const logger = require('../utils/logger');

// Allowed MIME types and their magic-byte signatures
const ALLOWED_TYPES = {
  'application/pdf': { extensions: ['.pdf'], magic: Buffer.from([0x25, 0x50, 0x44, 0x46]) },
  'image/jpeg':      { extensions: ['.jpg', '.jpeg'], magic: Buffer.from([0xFF, 0xD8, 0xFF]) },
  'image/png':       { extensions: ['.png'], magic: Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) },
};

function resolveStorageDir() {
  const dir = path.resolve(config.storage.path);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Returns a multer instance configured for invoice uploads.
 * Files are written to a temp location first, then validated before being moved.
 */
function createUploadMiddleware() {
  const storageDir = resolveStorageDir();

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, storageDir),
    filename: (req, file, cb) => {
      // Completely ignore user-provided filename — generate a UUID-based name
      const ext = ALLOWED_TYPES[file.mimetype]?.extensions[0] ?? '.bin';
      cb(null, `${uuidv4()}${ext}`);
    },
  });

  return multer({
    storage,
    limits: {
      fileSize: config.storage.maxFileSizeMb * 1024 * 1024,
      files: 1,
    },
    fileFilter: (req, file, cb) => {
      if (!ALLOWED_TYPES[file.mimetype]) {
        return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Unsupported file type'));
      }
      cb(null, true);
    },
  });
}

/**
 * Validate the uploaded file's magic bytes and return its SHA-256 hash.
 * Returns { valid: bool, hash: string, error: string? }
 */
async function validateAndHashFile(filePath, mimeType, originalFilename) {
  try {
    const fd  = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(8);
    fs.readSync(fd, buf, 0, 8, 0);
    fs.closeSync(fd);

    const typeInfo = ALLOWED_TYPES[mimeType];
    if (!typeInfo || !typeInfo.extensions.includes(path.extname(originalFilename || '').toLowerCase())) {
      return { valid: false, hash: null, error: 'File extension does not match a supported document type.' };
    }
    if (buf.length < typeInfo.magic.length || !buf.slice(0, typeInfo.magic.length).equals(typeInfo.magic)) {
      return { valid: false, hash: null, error: 'File content does not match the declared file type.' };
    }

    // Compute SHA-256
    const hash = await new Promise((resolve, reject) => {
      const h    = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', d => h.update(d));
      stream.on('end',  ()  => resolve(h.digest('hex')));
      stream.on('error', reject);
    });

    return { valid: true, hash };
  } catch (err) {
    logger.error('File validation error', { err: err.message, filePath });
    return { valid: false, hash: null, error: 'File validation failed' };
  }
}

/**
 * Prevent path traversal when constructing download paths.
 * Returns the safe absolute path or throws.
 */
function resolveStoragePath(storagePath) {
  const base     = path.resolve(config.storage.path);
  const resolved = path.resolve(storagePath);
  const relative = path.relative(base, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Path traversal attempt detected');
  }
  return resolved;
}

/**
 * Delete an uploaded file safely.
 */
function deleteFile(storagePath) {
  try {
    const resolved = resolveStoragePath(storagePath);
    if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
  } catch (err) {
    logger.error('Failed to delete file', { storagePath, err: err.message });
  }
}

module.exports = { createUploadMiddleware, validateAndHashFile, resolveStoragePath, deleteFile, resolveStorageDir, ALLOWED_TYPES };
