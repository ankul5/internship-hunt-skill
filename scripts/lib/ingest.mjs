// Persists search results: IDs, dedupe, scoring, validated atomic CSV writes.
// Input format: skills/run-search/references/ingest-format.md. Data rules: references/data-model.md.
import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv, serializeCsv } from './csv.mjs';
import { loadCsvSchemas, checkCsv, isoNow, TYPE_CHECKS } from './data.mjs';
import { dedupeKey, canonicalUrl, evaluate } from './scoring.mjs';
import { writeJournaled, recoverJournal } from './journal.mjs';

export class RefusedError extends Error {}

const REMOTE = ['onsite', 'hybrid', 'remote', 'unknown'];
const EMPLOYMENT = ['internship', 'co-op', 'apprenticeship', 'other', 'unknown'];
const SOURCE_KIND = ['job_board', 'company_site', 'search_engine', 'referral', 'user_provided'];
const SEARCH_STATUS = ['completed', 'partial', 'failed'];
const HARNESS = ['claude-code', 'codex', 'kimi-code', 'other', 'unknown'];
const MERGE_FIELDS = ['location', 'remote_type', 'employment_type', 'duration', 'start_date', 'stipend_text', 'posted_date', 'deadline', 'eligibility_text', 'qualifications_text', 'apply_url'];
const KEY_FIELDS = ['location', 'remote_type', 'employment_type', 'duration', 'start_date', 'stipend_text', 'posted_date', 'deadline'];
const USER_OWNED = ['shortlisted', 'applied', 'archived'];
const AUTO = '[auto-rejected]';

const str = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
const oneOf = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
export const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));
const isUnknownEnum = (k, v) => (k === 'remote_type' || k === 'employment_type' ? v === 'unknown' || v === '' : v === '');

export function writeAtomic(path, content) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

export function readTable(dir, name, spec) {
  const header = spec.columns.map((c) => c.name);
  const p = join(dir, name);
  if (!existsSync(p)) return { header, records: [] };
  const rows = parseCsv(readFileSync(p, 'utf8').replace(/^﻿/, ''));
  if ((rows[0] ?? []).join(',') !== header.join(',')) throw new Error(`${name}: header does not match the schema; validate the file and restore from backups/ before searching`);
  return { header, records: rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']))) };
}

/** Results the source returned: the caller's count if given, else the jobs recorded from it. */
const resultCount = (s) => (Number.isInteger(s.result_count) && s.result_count >= 0 ? s.result_count : s.jobs);

export const nextNum = (records, field) => records.reduce((m, r) => Math.max(m, parseInt(String(r[field]).split('-')[1], 10) || 0), 0) + 1;
export const fmtId = (prefix, n) => `${prefix}-${String(n).padStart(4, '0')}`;

/** Minimal readiness rule until the setup wizard defines setup_complete. */
export function checkReadiness(profile) {
  const missing = [];
  if (!profile || typeof profile !== 'object') return { ready: false, missing: ['profile file unreadable'] };
  if (!profile.updated_at) missing.push('profile has never been saved (updated_at is null)');
  if (!profile.identity?.full_name) missing.push('identity.full_name');
  if (!profile.preferences?.target_roles?.length) missing.push('preferences.target_roles');
  if (!(profile.skills?.length || profile.education?.length || profile.experience?.length || profile.projects?.length)) missing.push('at least one of skills, education, experience, projects');
  if (!profile.resume?.source_path) missing.push('resume.source_path');
  return { ready: missing.length === 0, missing };
}

export function listJobs(dir, statuses = null) {
  const schemas = loadCsvSchemas();
  return readTable(dir, 'jobs.csv', schemas['jobs.csv']).records
    .filter((r) => !statuses || statuses.includes(r.status))
    .map((r) => ({ job_id: r.job_id, status: r.status, company: r.company, title: r.title, source_url: r.source_url, apply_url: r.apply_url, deadline: r.deadline, last_checked_at: r.last_checked_at }));
}

export function ingest(dir, input, opts = {}) {
  const now = opts.now ?? isoNow();
  const today = opts.today ?? now.slice(0, 10);
  recoverJournal(dir);
  const schemas = loadCsvSchemas();
  const J = schemas['jobs.csv'], S = schemas['search-history.csv'], R = schemas['run-history.csv'];

  const profile = readJson(join(dir, 'candidate-profile.json'));
  const ready = checkReadiness(profile);
  if (!ready.ready) throw new RefusedError(`profile not ready: ${ready.missing.join('; ')}`);

  const syncPath = join(dir, 'sync-state.json');
  const sync = readJson(syncPath);
  if (sync.lock?.holder) throw new RefusedError(`sync-state lock is held by ${sync.lock.holder} since ${sync.lock.acquired_at}; ask the user before clearing it`);

  if (!Array.isArray(input?.searches) || !input.searches.length) throw new Error('input.searches must list at least one search that was attempted');
  if (!Array.isArray(input.jobs)) throw new Error('input.jobs must be an array (may be empty)');

  const jobsT = readTable(dir, 'jobs.csv', J);
  const searchT = readTable(dir, 'search-history.csv', S);
  const runT = readTable(dir, 'run-history.csv', R);

  let nJob = nextNum(jobsT.records, 'job_id'), nSearch = nextNum(searchT.records, 'search_id');
  const runId = fmtId('run', nextNum(runT.records, 'run_id'));

  // ---- searches ----
  const searches = new Map();
  for (const s of input.searches) {
    const problems = [];
    if (!str(s.key)) problems.push('key');
    if (!str(s.source_name)) problems.push('source_name');
    if (!str(s.query)) problems.push('query');
    if (!SEARCH_STATUS.includes(s.status)) problems.push(`status must be one of ${SEARCH_STATUS.join('/')}`);
    if (['failed', 'partial'].includes(s.status) && !str(s.error)) problems.push('error is required for failed/partial searches');
    if (problems.length) throw new Error(`invalid search ${JSON.stringify(s.key ?? s.source_name ?? '?')}: ${problems.join('; ')}`);
    if (searches.has(s.key)) throw new Error(`duplicate search key ${s.key}`);
    searches.set(s.key, { ...s, id: fmtId('srch', nSearch++), jobs: 0, newJobs: 0 });
  }

  // ---- lock ----
  writeAtomic(syncPath, JSON.stringify({ ...sync, lock: { holder: runId, acquired_at: now } }, null, 2) + '\n');
  try {
    const newIds = new Set();
    const stats = { new: 0, updated: 0, unchanged: 0, duplicates_in_batch: 0 };
    const decisions = [], skipped = [];

    input.jobs.forEach((j, i) => {
      const label = `jobs[${i}] ${str(j.company) || '?'} / ${str(j.title) || '?'}`;
      const problems = [];
      const search = searches.get(j.search_key);
      if (!search) problems.push('unknown search_key');
      else if (search.status === 'failed') problems.push('its search failed; results from a failed search are not accepted');
      if (!/^https?:\/\/\S+$/.test(str(j.source_url))) problems.push('source_url missing or invalid');
      if (!str(j.company)) problems.push('company missing');
      if (!str(j.title)) problems.push('title missing');
      if (!SOURCE_KIND.includes(j.source_kind)) problems.push(`source_kind must be one of ${SOURCE_KIND.join('/')}`);
      if (problems.length) { skipped.push({ index: i, label, reason: problems.join('; ') }); return; }

      const extra = [];
      const date = (k) => { const v = str(j[k]); if (!v) return ''; if (TYPE_CHECKS.date(v)) return v; extra.push(`invalid ${k} dropped`); return ''; };
      const f = {
        company: str(j.company), title: str(j.title), location: str(j.location),
        remote_type: oneOf(j.remote_type, REMOTE, 'unknown'), employment_type: oneOf(j.employment_type, EMPLOYMENT, 'unknown'),
        duration: str(j.duration), start_date: date('start_date'), stipend_text: str(j.stipend_text),
        posted_date: date('posted_date'), deadline: date('deadline'),
        eligibility_text: str(j.eligibility_text), qualifications_text: str(j.qualifications_text),
        apply_url: /^https?:\/\/\S+$/.test(str(j.apply_url)) ? str(j.apply_url) : '',
      };
      const opened = j.opened_source === true;
      const notes = str(j.verification_notes);
      const verified = opened && !!notes;
      if (opened && !notes) extra.push('opened_source was reported without verification_notes, so the listing stays unverified');
      const colNames = new Set(J.columns.map((c) => c.name));
      const providedUnverified = Array.isArray(j.unverified_fields) ? j.unverified_fields.filter((c) => colNames.has(c)) : null;

      const cu = canonicalUrl(str(j.source_url)), ca = canonicalUrl(f.apply_url);
      const key = dedupeKey(f.company, f.title, f.location);
      const [kc, kt, kl] = key.split('|');
      const match = jobsT.records.find((r) => {
        const ru = canonicalUrl(r.source_url), ra = canonicalUrl(r.apply_url);
        if (cu && (cu === ru || cu === ra)) return true;
        if (ca && (ca === ru || ca === ra)) return true;
        if (r.dedupe_key === key) return true;
        const [rc, rt, rl] = r.dedupe_key.split('|');
        return rc === kc && rt === kt && (!rl || !kl);
      });

      const evalExtras = { eligibility: j.eligibility, skills: j.skills, keywords: j.keywords, industry: j.industry };
      const missingNote = (rec) => ['location', 'deadline', 'stipend_text', 'eligibility_text'].filter((k) => !rec[k]).map((k) => k.replace('_text', '')).join(', ');
      const uncertainty = (rec) => [str(j.uncertainties), ...extra, missingNote(rec) ? `not stated: ${missingNote(rec)}` : ''].filter(Boolean).join('; ');
      const closedNow = (rec) => j.closed === true || (rec.deadline && rec.deadline < today);

      if (!match) {
        const rec = { job_id: fmtId('job', nJob++), ...f };
        const ev = evaluate(profile, { ...rec, ...evalExtras }, { provisional: !verified });
        rec.status = closedNow(rec) ? 'expired' : ev.eligibility === 'fail' ? 'rejected' : verified ? 'verified' : 'discovered';
        Object.assign(rec, {
          source_name: str(j.source_name) || search.source_name, source_kind: j.source_kind, source_url: str(j.source_url),
          discovered_at: now, last_checked_at: now, last_verified_at: verified ? now : '', verification_notes: verified ? notes : '',
          unverified_fields: (providedUnverified ?? (verified ? [] : KEY_FIELDS.filter((k) => !isUnknownEnum(k, rec[k])))).join(';'),
          uncertainties: uncertainty(rec), eligibility_check: ev.eligibility, fit_score: String(ev.score ?? ''), fit_rationale: ev.rationale,
          dedupe_key: key, search_id: search.id, updated_at: now,
          notes: ev.eligibility === 'fail' && rec.status === 'rejected' ? `${AUTO} ${ev.failReasons.join('; ')}` : '',
        });
        jobsT.records.push(rec);
        newIds.add(rec.job_id);
        search.jobs++; search.newJobs++; stats.new++;
        decisions.push({ job_id: rec.job_id, action: 'new', status: rec.status, eligibility_check: rec.eligibility_check, fit_score: rec.fit_score });
        return;
      }

      // ---- existing record: safe merge ----
      const stable = (r) => JSON.stringify({ ...r, last_checked_at: '', last_verified_at: '' });
      const old = match, before = stable(old);
      const changes = [];
      for (const k of MERGE_FIELDS) {
        if (isUnknownEnum(k, f[k])) continue;
        if (isUnknownEnum(k, old[k])) old[k] = f[k];
        else if (old[k] !== f[k] && opened) { changes.push(`${k} ${old[k]} -> ${f[k]}`); old[k] = f[k]; }
      }
      old.dedupe_key = dedupeKey(old.company, old.title, old.location);
      old.last_checked_at = now;
      if (verified) {
        old.last_verified_at = now; old.verification_notes = notes;
        old.unverified_fields = (providedUnverified ?? []).join(';');
      }
      if (opened) old.uncertainties = uncertainty(old);

      if (opened) {
        const ev = evaluate(profile, { ...old, ...evalExtras }, { provisional: !verified && old.status === 'discovered' });
        old.eligibility_check = ev.eligibility; old.fit_score = String(ev.score ?? ''); old.fit_rationale = ev.rationale;
        const userOwned = USER_OWNED.includes(old.status) || (old.status === 'rejected' && !old.notes.includes(AUTO));
        let desired = null;
        if (closedNow(old)) desired = 'expired';
        else if (!userOwned && old.status !== 'expired') desired = ev.eligibility === 'fail' ? 'rejected' : verified ? 'verified' : old.status === 'rejected' ? 'discovered' : null;
        if (old.status === 'expired' && !closedNow(old)) old.uncertainties = [old.uncertainties, 'listing looks open again; confirm manually'].filter(Boolean).join('; ');
        if (desired && desired !== old.status) {
          const autoRestore = old.status === 'rejected' && old.notes.includes(AUTO) && desired !== 'rejected';
          if (autoRestore || (schemas['jobs.csv'].transitions[old.status] ?? []).includes(desired)) {
            if (autoRestore) old.notes = old.notes.replace(AUTO, '[auto-restored]');
            if (desired === 'rejected') old.notes = [old.notes, `${AUTO} ${ev.failReasons.join('; ')}`].filter(Boolean).join(' ');
            old.status = desired;
          }
        }
      } else if (closedNow(old) && !['expired', 'applied', 'archived', 'rejected'].includes(old.status) && (schemas['jobs.csv'].transitions[old.status] ?? []).includes('expired')) {
        old.status = 'expired';
      }
      if (changes.length) old.notes = [old.notes, `[${today}] changed: ${changes.join('; ')}`].filter(Boolean).join(' ');

      const changed = stable(old) !== before;
      if (changed) old.updated_at = now;
      const dup = newIds.has(old.job_id);
      search.jobs++;
      if (dup) stats.duplicates_in_batch++; else if (changed) stats.updated++; else stats.unchanged++;
      decisions.push({ job_id: old.job_id, action: dup ? 'duplicate_in_batch' : changed ? 'updated' : 'unchanged', status: old.status, eligibility_check: old.eligibility_check, fit_score: old.fit_score });
    });

    // ---- search + run rows ----
    for (const s of searches.values()) {
      const failed = s.status === 'failed';
      searchT.records.push({
        search_id: s.id, run_id: runId, executed_at: TYPE_CHECKS.datetime(str(s.executed_at)) ? s.executed_at : now,
        source_name: str(s.source_name), query: str(s.query), filters: str(s.filters), status: s.status,
        result_count: failed ? '' : String(resultCount(s)),
        new_job_count: failed ? '' : String(s.newJobs), error: str(s.error), notes: str(s.notes),
      });
    }
    const all = [...searches.values()];
    const failedS = all.filter((s) => s.status === 'failed');
    const outcome = failedS.length === all.length ? 'failed' : all.some((s) => s.status !== 'completed') ? 'partial' : 'completed';
    runT.records.push({
      run_id: runId, started_at: TYPE_CHECKS.datetime(str(input.run?.started_at)) ? input.run.started_at : now, ended_at: now,
      harness: oneOf(input.run?.harness, HARNESS, 'unknown'), skill: 'run-search', outcome,
      summary: `${all.length} searches (${failedS.length} failed); ${stats.new} new, ${stats.updated} updated, ${stats.unchanged} unchanged, ${stats.duplicates_in_batch} duplicates in batch, ${skipped.length} skipped`,
      rows_created: String(stats.new), rows_updated: String(stats.updated), approvals_requested: '0', approvals_granted: '0',
      error: outcome === 'failed' ? failedS.map((s) => `${s.source_name}: ${str(s.error)}`).join(' | ').slice(0, 300) : '', notes: '',
    });

    // ---- validate everything before touching disk ----
    const ids = (t, f) => new Set(t.records.map((r) => r[f]));
    const sets = { 'search-history.csv': ids(searchT, 'search_id'), 'run-history.csv': ids(runT, 'run_id') };
    const texts = { 'jobs.csv': serializeCsv(jobsT.header, jobsT.records), 'search-history.csv': serializeCsv(searchT.header, searchT.records), 'run-history.csv': serializeCsv(runT.header, runT.records) };
    const errs = [
      ...checkCsv('jobs.csv', texts['jobs.csv'], J, sets).map((e) => `jobs.csv: ${e}`),
      ...checkCsv('search-history.csv', texts['search-history.csv'], S, sets).map((e) => `search-history.csv: ${e}`),
      ...checkCsv('run-history.csv', texts['run-history.csv'], R, sets).map((e) => `run-history.csv: ${e}`),
    ];
    if (errs.length) throw new Error(`refusing to write; validation failed:\n${errs.join('\n')}`);

    // ---- backup, then atomic writes ----
    writeJournaled(dir, texts, now);

    const fresh = readJson(syncPath);
    fresh.last_run_id = runId; fresh.last_job_search_at = now; fresh.lock = { holder: null, acquired_at: null };
    fresh.sources = fresh.sources ?? {};
    for (const s of all) if (s.status !== 'failed') fresh.sources[str(s.source_name)] = { ...(fresh.sources[str(s.source_name)] ?? {}), last_searched_at: now };
    writeAtomic(syncPath, JSON.stringify(fresh, null, 2) + '\n');

    const touched = decisions.map((d) => d.job_id);
    const byId = new Map(jobsT.records.map((r) => [r.job_id, r]));
    return {
      run_id: runId, outcome,
      sources_searched: all.map((s) => ({ source_name: s.source_name, query: s.query, status: s.status, result_count: s.status === 'failed' ? null : resultCount(s), recorded_jobs: s.status === 'failed' ? null : s.jobs, new_jobs: s.status === 'failed' ? null : s.newJobs, error: str(s.error) || null })),
      inaccessible_sources: failedS.map((s) => ({ source_name: s.source_name, error: str(s.error) })),
      stats, decisions, skipped,
      unverified: touched.filter((id) => byId.get(id).status === 'discovered'),
      expired: touched.filter((id) => byId.get(id).status === 'expired'),
      rejected: touched.filter((id) => byId.get(id).status === 'rejected'),
    };
  } catch (e) {
    const cur = readJson(syncPath);
    if (cur.lock?.holder === runId) writeAtomic(syncPath, JSON.stringify({ ...cur, lock: { holder: null, acquired_at: null } }, null, 2) + '\n');
    throw e;
  }
}
