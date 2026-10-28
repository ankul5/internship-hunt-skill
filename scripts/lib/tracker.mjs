// sync-tracker: check the tracker files, propose repairs, and apply only the repairs the user approved.
//   check  -> issues (read-only)
//   plan   -> the same issues with proposed fixes, saved to tracker/repair-plan-<stamp>.json with the file hashes it saw
//   apply  -> refuses if any file changed since the plan; backs up; applies the selected fixes; refuses if the result has
//             any validation error the files did not already have; appends every change to tracker/audit.jsonl
// Rows are never deleted and IDs never renumbered. A deleted row found in a backup is proposed for restoring.
import { join } from 'node:path';
import { existsSync, readFileSync, readdirSync, mkdirSync, appendFileSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseCsv, serializeCsv } from './csv.mjs';
import { loadCsvSchemas, checkCsv, isoNow, TYPE_CHECKS } from './data.mjs';
import { readJson, writeAtomic, nextNum, fmtId, RefusedError } from './ingest.mjs';
import { writeJournaled, recoverJournal, JOURNAL } from './journal.mjs';
import { canonicalUrl } from './scoring.mjs';
import { requireWords } from './outbound.mjs';

const FILES = ['jobs.csv', 'applications.csv', 'email-events.csv', 'search-history.csv', 'run-history.csv'];
const STALE_HOURS = 2;
const PLACEHOLDER = /^(n\/a|na|tbd|null|none|unknown\?)$/i;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const fileText = (dir, n) => (existsSync(join(dir, n)) ? readFileSync(join(dir, n), 'utf8').replace(/^﻿/, '') : null);
const hours = (a, b) => (Date.parse(b) - Date.parse(a)) / 3600000;

function parse(text, spec) {
  const rows = parseCsv(text ?? '');
  const header = spec.columns.map((c) => c.name);
  const ok = (rows[0] ?? []).join(',') === header.join(',');
  const records = ok ? rows.slice(1).map((r, i) => ({ line: i + 2, cells: r.length, rec: Object.fromEntries(header.map((h, k) => [h, r[k] ?? ''])) })) : [];
  return { ok, header, records };
}

/** Backups of one file, newest first. */
function backupsOf(dir, name) {
  const b = join(dir, 'backups');
  if (!existsSync(b)) return [];
  return readdirSync(b).filter((f) => f.startsWith(`${name}.`) && /^\d{8}T\d{6}Z$/.test(f.slice(name.length + 1))).sort().reverse().map((f) => join('backups', f));
}

/** Every issue in the tracker, with a proposed fix where one is safe to describe. Read-only. */
export function check(dir, { now = isoNow() } = {}) {
  const S = loadCsvSchemas();
  const issues = [];
  let n = 0;
  const add = (o) => issues.push({ id: `I${++n}`, severity: 'error', ...o });

  if (existsSync(join(dir, JOURNAL))) add({ file: JOURNAL, kind: 'interrupted_write', message: 'an earlier write stopped part-way; the journal holds the intended result', fix: { op: 'finish_write', risky: false, why: 'every file is either untouched or already written; the journal finishes the same write (it refuses if a file changed since)' } });

  const T = {};
  for (const name of FILES) {
    const spec = S[name];
    const text = fileText(dir, name);
    if (text == null) { add({ file: name, kind: 'missing_file', message: `${name} does not exist`, fix: null, manual: 'copy the blank file from templates/data or restore it from backups/' }); continue; }
    const t = parse(text, spec);
    T[name] = { ...t, text, sha: sha(text) };
    if (!t.ok) {
      const bk = backupsOf(dir, name).find((p) => parse(fileText(dir, p), spec).ok);
      add({ file: name, kind: 'bad_header', message: `${name}: the header does not match the schema, so no row can be read safely`,
        fix: bk ? { op: 'restore_file', backup: bk, risky: true, why: `restore the latest readable backup (${bk}); the current file is kept as backups/${name}.broken-<time> so nothing is lost. Rows added after that backup must be re-entered from the broken copy.` } : null,
        manual: bk ? null : 'no readable backup exists; fix the header by hand with the user' });
      continue;
    }
    const ids = new Set();
    for (const r of t.records) {
      const { rec, line } = r;
      if (r.cells !== t.header.length) add({ file: name, line, record_id: rec[spec.idField], kind: 'cell_count', message: `line ${line} has ${r.cells} cells, expected ${t.header.length}`, fix: null, manual: 'a comma or quote is wrong on this line; fix it by hand' });
      for (const col of spec.columns) {
        const v = rec[col.name];
        if (v !== '' && v !== v.trim()) add({ file: name, line, record_id: rec[spec.idField], kind: 'whitespace', message: `${col.name} has leading/trailing spaces`, fix: { op: 'set_field', file: name, id: rec[spec.idField], field: col.name, from: v, to: v.trim(), risky: false } });
        if (PLACEHOLDER.test(v)) add({ file: name, line, record_id: rec[spec.idField], kind: 'placeholder', message: `${col.name} is "${v}"; unknown must be an empty cell`,
          ...(col.required ? { fix: null, manual: `${col.name} is required: find the real value` } : { fix: { op: 'set_field', file: name, id: rec[spec.idField], field: col.name, from: v, to: '', risky: false } }) });
      }
      if (ids.has(rec[spec.idField])) add({ file: name, line, record_id: rec[spec.idField], kind: 'duplicate_id', message: `${spec.idField} ${rec[spec.idField]} appears twice`, fix: null, manual: 'IDs are never renumbered automatically: decide with the user which row is real' });
      ids.add(rec[spec.idField]);
      if (rec.created_at && rec.updated_at && TYPE_CHECKS.datetime(rec.created_at) && TYPE_CHECKS.datetime(rec.updated_at) && rec.updated_at < rec.created_at) add({ file: name, line, record_id: rec[spec.idField], severity: 'warning', kind: 'timestamp_order', message: `updated_at ${rec.updated_at} is before created_at ${rec.created_at}`, fix: null, manual: 'check the row history' });
      for (const col of spec.columns.filter((c) => c.type === 'datetime')) {
        const v = rec[col.name];
        if (TYPE_CHECKS.datetime(v) && hours(now, v) > 24) add({ file: name, line, record_id: rec[spec.idField], severity: 'warning', kind: 'future_timestamp', message: `${col.name} ${v} is in the future`, fix: null, manual: 'probably a wrong timezone or a typo' });
      }
    }
    T[name].ids = ids;
  }

  // Schema checks (types, enums, required fields, references) not already reported above.
  const idSets = Object.fromEntries(Object.entries(T).filter(([, t]) => t.ok).map(([n, t]) => [n, t.ids]));
  for (const [name, t] of Object.entries(T)) {
    if (!t.ok) continue;
    for (const e of checkCsv(name, t.text, S[name], idSets)) {
      if (/leading\/trailing whitespace|uses placeholder|duplicate \w+_id|cells, expected/.test(e)) continue;
      const line = Number((e.match(/^line (\d+)/) ?? [])[1]) || null;
      add({ file: name, line, record_id: line ? t.records.find((r) => r.line === line)?.rec[S[name].idField] : null, kind: 'schema', message: e, fix: null, manual: 'needs the real value; never fill it with a guess' });
    }
  }

  // Rows that existed in a backup but are gone now, and disallowed status moves since the latest backup.
  for (const [name, t] of Object.entries(T)) {
    if (!t.ok) continue;
    const spec = S[name];
    const seenBackup = new Map();
    for (const p of backupsOf(dir, name)) {
      const b = parse(fileText(dir, p), spec);
      if (!b.ok) continue;
      for (const r of b.records) if (!seenBackup.has(r.rec[spec.idField])) seenBackup.set(r.rec[spec.idField], { rec: r.rec, backup: p });
    }
    for (const [id, { rec, backup }] of seenBackup) {
      if (!t.ids.has(id)) add({ file: name, record_id: id, kind: 'row_deleted', message: `${id} is in ${backup} but missing now (rows are never deleted)`, fix: { op: 'restore_row', file: name, id, row: rec, backup, risky: true, why: 'append the row exactly as it was in the backup' } });
    }
    const latest = backupsOf(dir, name).map((p) => ({ p, b: parse(fileText(dir, p), spec) })).find((x) => x.b.ok);
    if (latest && spec.transitions && Object.keys(spec.transitions).length) {
      const prev = new Map(latest.b.records.map((r) => [r.rec[spec.idField], r.rec]));
      for (const r of t.records) {
        const before = prev.get(r.rec[spec.idField]);
        if (!before) continue;
        const a = before[spec.statusField], b = r.rec[spec.statusField];
        if (a !== b && !(spec.transitions[a] ?? []).includes(b)) add({ file: name, line: r.line, record_id: r.rec[spec.idField], kind: 'disallowed_transition', message: `${spec.statusField} moved ${a} -> ${b} since ${latest.p}, which the lifecycle does not allow`, fix: null, manual: 'a move outside the lifecycle needs the user\'s explicit instruction and a note; restore the old status or add the note with the user' });
        for (const f of ['created_at', 'discovered_at']) if (before[f] && r.rec[f] && before[f] !== r.rec[f]) add({ file: name, line: r.line, record_id: r.rec[spec.idField], kind: 'changed_creation_time', message: `${f} changed from ${before[f]} to ${r.rec[f]}`, fix: { op: 'set_field', file: name, id: r.rec[spec.idField], field: f, from: r.rec[f], to: before[f], risky: true, why: 'creation times never change' } });
      }
    }
  }

  // Duplicates and conflicts across rows.
  const jobs = T['jobs.csv']?.ok ? T['jobs.csv'].records.map((r) => r.rec) : [];
  const apps = T['applications.csv']?.ok ? T['applications.csv'].records.map((r) => r.rec) : [];
  const evs = T['email-events.csv']?.ok ? T['email-events.csv'].records.map((r) => r.rec) : [];
  const RANK = { applied: 5, shortlisted: 4, verified: 3, discovered: 2, rejected: 1, expired: 1, archived: 0 };
  const groups = new Map();
  for (const j of jobs.filter((x) => x.status !== 'archived')) for (const k of [`k:${j.dedupe_key}`, `u:${canonicalUrl(j.source_url)}`]) groups.set(k, [...(groups.get(k) ?? []), j]);
  const reported = new Set();
  for (const [k, g] of groups) {
    if (g.length < 2) continue;
    const ids = g.map((j) => j.job_id).sort().join(',');
    if (reported.has(ids)) continue;
    reported.add(ids);
    const keep = [...g].sort((a, b) => (RANK[b.status] - RANK[a.status]) || (a.job_id < b.job_id ? -1 : 1))[0];
    for (const d of g.filter((j) => j !== keep)) {
      const userOwned = ['shortlisted', 'applied'].includes(d.status) || apps.some((a) => a.job_id === d.job_id);
      add({ file: 'jobs.csv', record_id: d.job_id, kind: 'duplicate_job', message: `${d.job_id} duplicates ${keep.job_id} (same ${k.startsWith('k:') ? 'company, title and location' : 'posting URL'})`,
        ...(userOwned ? { fix: null, manual: `${d.job_id} is ${d.status}${apps.some((a) => a.job_id === d.job_id) ? ' and has an application' : ''}; merge it with the user` }
          : { fix: { op: 'set_status', file: 'jobs.csv', id: d.job_id, from: d.status, to: 'archived', note: `[duplicate of ${keep.job_id}]`, risky: true, why: `archive the duplicate (never delete); ${keep.job_id} is kept` } }) });
    }
  }
  const byMsg = new Map();
  for (const e of evs.filter((x) => x.provider_message_id)) byMsg.set(e.provider_message_id, [...(byMsg.get(e.provider_message_id) ?? []), e]);
  for (const [mid, g] of byMsg) {
    if (g.length < 2) continue;
    for (const d of g.slice(1)) add({ file: 'email-events.csv', record_id: d.event_id, kind: 'duplicate_message', message: `${d.event_id} records the same message (${mid}) as ${g[0].event_id}`,
      ...(d.direction === 'inbound' && d.status === 'received' ? { fix: { op: 'set_status', file: 'email-events.csv', id: d.event_id, from: 'received', to: 'processed', note: `duplicate of ${g[0].event_id}`, risky: true, why: 'close the duplicate so it is not reviewed twice; the row stays' } } : { fix: null, manual: 'both rows have been acted on; decide with the user which one is real' }) });
  }
  for (const e of evs.filter((x) => x.application_id)) {
    const a = apps.find((x) => x.application_id === e.application_id);
    if (a && e.job_id && e.job_id !== a.job_id) add({ file: 'email-events.csv', record_id: e.event_id, kind: 'conflict', message: `${e.event_id} names ${e.job_id} but ${a.application_id} is for ${a.job_id}`, fix: { op: 'set_field', file: 'email-events.csv', id: e.event_id, field: 'job_id', from: e.job_id, to: a.job_id, risky: true, why: 'the application is the stronger link' } });
  }
  const activeByJob = new Map();
  for (const a of apps.filter((x) => !['withdrawn', 'rejected', 'declined', 'accepted'].includes(x.status))) activeByJob.set(a.job_id, [...(activeByJob.get(a.job_id) ?? []), a.application_id]);
  for (const [j, ids] of activeByJob) if (ids.length > 1) add({ file: 'applications.csv', record_id: ids[1], kind: 'conflict', message: `${j} has ${ids.length} open applications (${ids.join(', ')})`, fix: null, manual: 'withdraw the extra one with the user' });
  for (const a of apps.filter((x) => ['submitted', 'acknowledged', 'interview', 'assessment', 'offer', 'accepted'].includes(x.status))) {
    const j = jobs.find((x) => x.job_id === a.job_id);
    if (j && !['applied', 'archived'].includes(j.status)) add({ file: 'jobs.csv', record_id: j.job_id, severity: 'warning', kind: 'conflict', message: `${a.application_id} is ${a.status} but ${j.job_id} is ${j.status}`,
      ...((S['jobs.csv'].transitions[j.status] ?? []).includes('applied') ? { fix: { op: 'set_status', file: 'jobs.csv', id: j.job_id, from: j.status, to: 'applied', note: `[applied, from ${a.application_id}]`, risky: false } } : { fix: null, manual: `${j.status} cannot move to applied; decide with the user` }) });
  }

  // Lock and runs left behind by a crash.
  const sync = existsSync(join(dir, 'sync-state.json')) ? readJson(join(dir, 'sync-state.json')) : null;
  if (sync?.lock?.holder && sync.lock.acquired_at && hours(sync.lock.acquired_at, now) > STALE_HOURS) add({ file: 'sync-state.json', record_id: sync.lock.holder, kind: 'stale_lock', message: `the lock has been held by ${sync.lock.holder} since ${sync.lock.acquired_at}`, fix: { op: 'release_lock', holder: sync.lock.holder, risky: true, why: 'only if no other session is running' } });
  if (T['run-history.csv']?.ok) for (const r of T['run-history.csv'].records.map((x) => x.rec)) {
    if (r.outcome === 'in_progress' && r.run_id !== sync?.lock?.holder && hours(r.started_at, now) > STALE_HOURS) add({ file: 'run-history.csv', record_id: r.run_id, severity: 'warning', kind: 'stuck_run', message: `${r.run_id} has been in_progress since ${r.started_at}`, fix: { op: 'set_status', file: 'run-history.csv', id: r.run_id, from: 'in_progress', to: 'aborted', note: 'marked aborted by sync-tracker: the run never finished', risky: false } });
  }

  return { checked_at: now, ok: !issues.some((i) => i.severity === 'error'), files: Object.fromEntries(Object.entries(T).map(([n, t]) => [n, { rows: t.records.length, readable: t.ok }])), issues,
    summary: { errors: issues.filter((i) => i.severity === 'error').length, warnings: issues.filter((i) => i.severity === 'warning').length, fixable: issues.filter((i) => i.fix).length, manual: issues.filter((i) => !i.fix).length } };
}

const hashes = (dir) => Object.fromEntries([...FILES, 'sync-state.json'].map((n) => [n, existsSync(join(dir, n)) ? sha(readFileSync(join(dir, n), 'utf8')) : null]));

/** Save the proposed repairs. Changes nothing in the tracker. */
export function plan(dir, { now = isoNow() } = {}) {
  const c = check(dir, { now });
  const p = { created_at: now, file_hashes: hashes(dir), fixes: c.issues.filter((i) => i.fix).map((i) => ({ issue: i.id, file: i.file, record_id: i.record_id ?? null, message: i.message, ...i.fix })), manual: c.issues.filter((i) => !i.fix).map((i) => ({ issue: i.id, file: i.file, record_id: i.record_id ?? null, message: i.message, manual: i.manual })) };
  p.plan_hash = sha(JSON.stringify(p));
  mkdirSync(join(dir, 'tracker'), { recursive: true });
  const rel = `tracker/repair-plan-${now.replace(/[-:]/g, '')}.json`;
  writeAtomic(join(dir, rel), JSON.stringify(p, null, 2) + '\n');
  return { plan_path: rel, plan_hash: p.plan_hash, fixes: p.fixes.map(({ row, ...f }) => f), manual: p.manual, changed: false,
    instructions: 'Show the user every fix (risky ones first, with why) and every manual item. Apply only what they approve: apply <plan_path> --plan-hash <plan_hash> --only I1,I2 --note "<their words>".' };
}

/** Apply the approved fixes from a saved plan. */
export function apply(dir, planRel, { planHash, only = null, note, now = isoNow() }) {
  const words = requireWords(note, 'applying repairs');
  if (!/^tracker\/repair-plan-\d{8}T\d{6}Z\.json$/.test(planRel ?? '')) throw new Error('give the plan path printed by plan (tracker/repair-plan-<time>.json)');
  const p = readJson(join(dir, planRel));
  const { plan_hash, ...body } = p;
  if (plan_hash !== sha(JSON.stringify(body)) || planHash !== plan_hash) throw new RefusedError('the plan hash does not match: apply exactly the plan the user saw (run plan again)');
  const cur = hashes(dir);
  const changed = Object.keys(cur).filter((n) => cur[n] !== p.file_hashes[n]);
  if (changed.length) throw new RefusedError(`files changed since the plan was made (${changed.join(', ')}); run plan again and show the user the new plan`);
  const picked = only ? p.fixes.filter((f) => only.includes(f.issue)) : p.fixes;
  if (only) { const unknown = only.filter((id) => !p.fixes.some((f) => f.issue === id)); if (unknown.length) throw new Error(`not fixes in this plan: ${unknown.join(', ')}`); }
  if (!picked.length) throw new RefusedError('no fixes selected');

  const S = loadCsvSchemas();
  const audit = [];
  const log = (e) => audit.push({ at: now, plan: planRel, approval: words, ...e });
  const syncP = join(dir, 'sync-state.json');

  // Whole-file operations first; they replace what the row operations would read.
  for (const f of picked.filter((x) => x.op === 'finish_write')) { const r = recoverJournal(dir); log({ issue: f.issue, op: 'finish_write', result: r }); }
  for (const f of picked.filter((x) => x.op === 'restore_file')) {
    const stamp = now.replace(/[-:]/g, '');
    mkdirSync(join(dir, 'backups'), { recursive: true });
    copyFileSync(join(dir, f.file), join(dir, 'backups', `${f.file}.broken-${stamp}`));
    writeAtomic(join(dir, f.file), readFileSync(join(dir, f.backup), 'utf8'));
    log({ issue: f.issue, op: 'restore_file', file: f.file, from_backup: f.backup, kept_broken_copy: `backups/${f.file}.broken-${stamp}` });
  }

  const tables = {};
  const tbl = (name) => {
    if (!tables[name]) {
      const t = parse(fileText(dir, name), S[name]);
      if (!t.ok) throw new RefusedError(`${name} cannot be read; restore it first (restore_file fix)`);
      tables[name] = { header: t.header, records: t.records.map((r) => r.rec), before: checkCsv(name, fileText(dir, name), S[name]) };
    }
    return tables[name];
  };
  for (const f of picked.filter((x) => ['set_field', 'set_status', 'restore_row'].includes(x.op))) {
    const spec = S[f.file];
    const t = tbl(f.file);
    if (f.op === 'restore_row') {
      if (t.records.some((r) => r[spec.idField] === f.id)) { log({ issue: f.issue, op: 'restore_row', file: f.file, id: f.id, result: 'already present; skipped' }); continue; }
      t.records.push({ ...f.row });
      log({ issue: f.issue, op: 'restore_row', file: f.file, id: f.id, from_backup: f.backup });
      continue;
    }
    const r = t.records.find((x) => x[spec.idField] === f.id);
    if (!r) throw new RefusedError(`${f.id} not found in ${f.file}`);
    const field = f.op === 'set_status' ? spec.statusField : f.field;
    if (r[field] !== f.from) throw new RefusedError(`${f.id}.${field} is "${r[field]}", not "${f.from}" as planned; run plan again`);
    if (f.op === 'set_status' && !(spec.transitions[f.from] ?? []).includes(f.to)) throw new RefusedError(`${f.from} -> ${f.to} is not an allowed move for ${f.file}`);
    r[field] = f.to;
    if (f.note) { if ('notes' in r) r.notes = [r.notes, f.note].filter(Boolean).join(' | ').slice(0, 1000); else if ('summary' in r) r.summary = `${r.summary} | ${f.note}`.slice(0, 300); }
    if ('updated_at' in r) r.updated_at = now;
    if (f.file === 'run-history.csv' && f.to === 'aborted') r.ended_at = r.ended_at || now;
    log({ issue: f.issue, op: f.op, file: f.file, id: f.id, field, before: f.from, after: f.to });
  }

  // A repair may leave old problems in place, but it may not add one.
  const texts = Object.fromEntries(Object.entries(tables).map(([n, t]) => [n, serializeCsv(t.header, t.records)]));
  for (const [n, txt] of Object.entries(texts)) {
    const after = checkCsv(n, txt, S[n]);
    const fresh = after.filter((e) => !tables[n].before.includes(e));
    if (fresh.length) throw new RefusedError(`refusing to write ${n}; the repair would add problems:\n${fresh.join('\n')}`);
  }
  if (Object.keys(texts).length) writeJournaled(dir, texts, now);

  for (const f of picked.filter((x) => x.op === 'release_lock')) {
    const s = readJson(syncP);
    if (s.lock?.holder !== f.holder) { log({ issue: f.issue, op: 'release_lock', result: `lock is now ${s.lock?.holder ?? 'free'}; left alone` }); continue; }
    writeAtomic(syncP, JSON.stringify({ ...s, lock: { holder: null, acquired_at: null } }, null, 2) + '\n');
    log({ issue: f.issue, op: 'release_lock', before: f.holder, after: null });
  }

  mkdirSync(join(dir, 'tracker'), { recursive: true });
  for (const a of audit) appendFileSync(join(dir, 'tracker', 'audit.jsonl'), `${JSON.stringify(a)}\n`);
  recordRun(dir, `sync-tracker: applied ${audit.length} repair(s) from ${planRel}`, now);
  return { applied: audit.length, audit_log: 'tracker/audit.jsonl', changes: audit, not_applied: p.fixes.filter((f) => !picked.includes(f)).map((f) => f.issue), recheck: check(dir, { now }).summary };
}

/** A completed run-history row for the repair, if run-history is readable. */
function recordRun(dir, summary, now) {
  const S = loadCsvSchemas();
  const t = parse(fileText(dir, 'run-history.csv'), S['run-history.csv']);
  if (!t.ok) return;
  const records = t.records.map((r) => r.rec);
  records.push({ run_id: fmtId('run', nextNum(records, 'run_id')), started_at: now, ended_at: now, harness: 'claude-code', skill: 'sync-tracker', outcome: 'completed', summary, rows_created: '0', rows_updated: '0', approvals_requested: '1', approvals_granted: '1', error: '', notes: '' });
  const txt = serializeCsv(t.header, records);
  if (checkCsv('run-history.csv', txt, S['run-history.csv']).length <= checkCsv('run-history.csv', fileText(dir, 'run-history.csv'), S['run-history.csv']).length) writeJournaled(dir, { 'run-history.csv': txt }, now);
}
