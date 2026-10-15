const fs = require('fs/promises');
const path = require('path');

const HOURS = 60 * 60 * 1000;
const THRESHOLDS = {
  ingest: 6 * HOURS, debrief: 6 * HOURS, weekly: 8 * 24 * HOURS,
  backup: 26 * HOURS, offsite: 48 * HOURS,
};

const validTime = (value) => {
  const time = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? time : null;
};

const iso = (value) => {
  const time = validTime(value);
  return time == null ? null : new Date(time).toISOString();
};

async function readJobFile(dir, job) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(dir, `${job}.json`), 'utf8'));
    if (value.job !== job || typeof value.ok !== 'boolean' || validTime(value.finished_at) == null) return null;
    return value;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function newestDump(dir) {
  try {
    const names = (await fs.readdir(dir)).filter((name) => /^garminhub-.*\.dump$/.test(name));
    const dumps = await Promise.all(names.map(async (name) => {
      const stats = await fs.stat(path.join(dir, name));
      return { time: stats.mtimeMs, size: stats.size };
    }));
    return dumps.filter((dump) => dump.size > 0).sort((a, b) => b.time - a.time)[0] || null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function fileCheck(name, file, now, maxAge, successTime) {
  if (!file) return { name, state: 'unknown', last_success: successTime || null, reason: 'No status recorded' };
  const lastSuccess = file.ok ? iso(file.finished_at) : successTime || null;
  if (!file.ok) return { name, state: 'warn', last_success: lastSuccess, reason: file.message || 'Last run failed' };
  if (now - validTime(file.finished_at) > maxAge) {
    return { name, state: 'warn', last_success: lastSuccess, reason: `Last success is over ${maxAge / HOURS} hours old` };
  }
  return { name, state: 'ok', last_success: lastSuccess, reason: 'Healthy' };
}

function londonParts(now) {
  const values = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now));
  return Object.fromEntries(values.map(({ type, value }) => [type, value]));
}

async function buildStatus({ db, statusDir, backupDir, now = Date.now(), notificationStatus }) {
  const london = londonParts(now);
  const today = `${london.year}-${london.month}-${london.day}`;
  const [ingestRow, briefRow, ingestFile, debriefFile, weeklyFile, backupFile, offsiteFile, dump] = await Promise.all([
    db.get('SELECT last_run_at, ok, summary FROM ingest_state WHERE id = 1'),
    db.get("SELECT created_at FROM coach_notes WHERE note_type = 'daily' AND date_range_end = $1 ORDER BY created_at DESC LIMIT 1", [today]),
    readJobFile(statusDir, 'ingest'), readJobFile(statusDir, 'debrief'),
    readJobFile(statusDir, 'weekly'), readJobFile(statusDir, 'backup'),
    readJobFile(statusDir, 'offsite'), newestDump(backupDir),
  ]);

  let ingest;
  const ingestSuccess = ingestRow?.ok ? iso(ingestRow.last_run_at) : null;
  if (!ingestFile) {
    ingest = { name: 'ingest', state: 'unknown', last_success: ingestSuccess, reason: 'No host job status recorded' };
  } else if (ingestRow && ingestRow.ok === false) {
    ingest = { name: 'ingest', state: 'warn', last_success: null, reason: ingestRow.summary || 'Last ingest failed' };
  } else {
    ingest = fileCheck('ingest', ingestFile, now, THRESHOLDS.ingest, ingestSuccess);
    const runTime = validTime(ingestRow?.last_run_at);
    if (ingest.state === 'ok' && runTime != null && now - runTime > THRESHOLDS.ingest) {
      ingest = { name: 'ingest', state: 'warn', last_success: ingestSuccess, reason: 'Last ingest is over 6 hours old' };
    }
  }

  const afterCutoff = Number(london.hour) > 10 || (Number(london.hour) === 10 && Number(london.minute) >= 30);
  const brief = briefRow
    ? { name: 'brief', state: 'ok', last_success: iso(briefRow.created_at), reason: 'Today\'s brief exists' }
    : afterCutoff
      ? { name: 'brief', state: 'warn', last_success: null, reason: 'Today\'s brief is missing after 10:30 London time' }
      : { name: 'brief', state: 'ok', last_success: null, reason: 'Not due until 10:30 London time' };

  const dumpSuccess = dump ? new Date(dump.time).toISOString() : null;
  let backup = fileCheck('backup', backupFile, now, THRESHOLDS.backup, dumpSuccess);
  if (backup.state === 'ok' && (!dump || now - dump.time > THRESHOLDS.backup)) {
    backup = dump
      ? { name: 'backup', state: 'warn', last_success: dumpSuccess, reason: 'Newest dump is over 26 hours old' }
      : { name: 'backup', state: 'unknown', last_success: null, reason: 'No backup dump found' };
  }
  const offsite = fileCheck('offsite', offsiteFile, now, THRESHOLDS.offsite, null);
  const debrief = fileCheck('debrief', debriefFile, now, THRESHOLDS.debrief, null);
  const weekly = fileCheck('weekly', weeklyFile, now, THRESHOLDS.weekly, null);
  return { checks: [ingest, debrief, brief, weekly, backup, offsite],
    notifications: notificationStatus ? notificationStatus() : { enabled: false, reason: 'APNs is not configured' } };
}

function createHealthHandler(database, timeoutMs = 2000) {
  return async (req, res) => {
    let timer;
    try {
      await Promise.race([
        database.get('SELECT 1 AS ok'),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('database timeout')), timeoutMs); }),
      ]);
      clearTimeout(timer);
      res.json({ ok: true });
    } catch (_) {
      clearTimeout(timer);
      res.status(503).json({ ok: false });
    }
  };
}

function createStatusHandler(options) {
  return async (req, res) => {
    try {
      res.json(await buildStatus(options));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  };
}

module.exports = { THRESHOLDS, buildStatus, createHealthHandler, createStatusHandler, londonParts };
