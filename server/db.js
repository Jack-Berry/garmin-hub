// Opens the Garmin Hub SQLite DB read-only so the API can never corrupt
// ingest's data. Path resolves relative to the repo root.
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.resolve(__dirname, '..', 'data', 'garmin.db');

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
db.pragma('foreign_keys = ON');

module.exports = db;
