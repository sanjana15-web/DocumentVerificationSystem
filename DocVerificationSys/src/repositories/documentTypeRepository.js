'use strict';

const db = require('../config/database');

function mapType(row) {
  if (!row) return null;
  let fields = row.fields_json;
  if (typeof fields === 'string') fields = JSON.parse(fields);
  if (!Array.isArray(fields)) throw new Error(`Invalid field schema for document type "${row.id}".`);
  return { ...row, name: row.display_name, fields, is_enabled: Boolean(row.is_enabled) };
}

class DocumentTypeRepository {
  async findById(id) {
    const row = await db.queryOne('SELECT * FROM document_types WHERE id = ? LIMIT 1', [id]);
    return mapType(row);
  }

  async findEnabled() {
    const rows = await db.query('SELECT * FROM document_types WHERE is_enabled = 1 ORDER BY category, display_name');
    return rows.map(mapType);
  }

  async findAll() {
    const rows = await db.query('SELECT * FROM document_types ORDER BY category, display_name');
    return rows.map(mapType);
  }

  async update({ id, displayName, description, enabled, fields, updatedBy }, conn = null) {
    const exec = conn ? conn.execute.bind(conn) : db.query.bind(db);
    await exec(
      `UPDATE document_types
       SET display_name = ?, description = ?, is_enabled = ?, fields_json = ?, updated_by = ?
       WHERE id = ?`,
      [displayName, description || null, enabled ? 1 : 0, JSON.stringify(fields), updatedBy, id]
    );
  }
}

module.exports = new DocumentTypeRepository();
