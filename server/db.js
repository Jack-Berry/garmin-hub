// Postgres pools for the Garmin Hub API. Two pools preserve the old SQLite
// db/writeDb split, now enforced by Postgres itself: `db` connects as the
// SELECT-only role, `writeDb` as the DML-only role (no DDL on either).
const { Pool, types } = require('pg');

// int8 (bigint) arrives as text by default; parse to Number so the API keeps
// its numeric id shapes. This matches better-sqlite3, which also returned JS
// numbers — including its loss of precision on ids beyond 2^53 (the negative
// ical schedule-id hashes), which is unchanged, not introduced, here.
types.setTypeParser(20, (v) => Number(v));

// Date/time columns are real Postgres types (stage 5a), but the API contract
// (and every string assumption downstream) predates that — so parse them back
// to the exact legacy string shapes instead of node-pg's default Date objects:
//   date        -> 'YYYY-MM-DD'          (wire format, passthrough)
//   timestamp   -> 'YYYY-MM-DD HH:MM:SS' (wire format, passthrough)
//   timestamptz -> ISO-8601 Z            (what new Date().toISOString() wrote)
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1114, (v) => v);
types.setTypeParser(1184, (v) => new Date(v).toISOString());

const RO_DSN = process.env.DATABASE_URL_RO
  || 'postgres://garminhub_ro:garminhub_ro@localhost:5432/garminhub';
const RW_DSN = process.env.DATABASE_URL_RW
  || 'postgres://garminhub_rw:garminhub_rw@localhost:5432/garminhub';

// Thin helpers so call-sites stay tidy: all() -> rows, get() -> first row
// (undefined if none), run() -> the full result (rowCount, rows).
const wrap = (pool) => ({
  all: async (sql, params) => (await pool.query(sql, params)).rows,
  get: async (sql, params) => (await pool.query(sql, params)).rows[0],
  run: (sql, params) => pool.query(sql, params),
  end: () => pool.end(),
});

module.exports = {
  db: wrap(new Pool({ connectionString: RO_DSN })),
  writeDb: wrap(new Pool({ connectionString: RW_DSN })),
};
