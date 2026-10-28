// Application preparation: gates, fact checks, versioned documents, tracker writes.
// Package format: skills/apply/references/package-format.md. Data rules: references/data-model.md.
// Never submits, emails, or messages. Writes only inside the private data directory.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { serializeCsv } from './csv.mjs';
import { loadCsvSchemas, checkCsv, isoNow } from './data.mjs';
import { makePdfs } from './pdf.mjs';
import { readTable, writeAtomic, nextNum, fmtId, readJson, checkReadiness, RefusedError } from './ingest.mjs';
import { writeJournaled, recoverJournal } from './journal.mjs';

const CONFIRMED = ['resume', 'user_stated'];
const LISTS = ['education', 'experience', 'projects', 'skills', 'certifications'];
const KINDS = ['general', 'eligibility', 'declaration', 'demographic'];
const SENSITIVE = ['eligibility', 'declaration', 'demographic'];
const LEVELS = ['essential', 'preferred'];
const REQ_STATUS = ['met', 'partial', 'gap'];
const ORIGINS = ['fetched', 'user_provided'];
export const ID_APP = /^app-\d{4,}$/, ID_JOB = /^job-\d{4,}$/;
const CLOSED = ['withdrawn', 'rejected', 'declined', 'accepted'];
const EDITABLE = ['drafting', 'ready_for_review'];

export const str = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
const norm = (s) => ` ${String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
export const sha = (s) => createHash('sha256').update(s).digest('hex');
const rel = (...p) => p.join('/');

// ---------------------------------------------------------------- profile access

const pathTokens = (p) => String(p).match(/[^.[\]]+/g) ?? [];

/** Resolve a profile path such as experience[0].highlights[1]. Returns { ok, value, reason }. */
export function resolveRef(profile, ref) {
  const t = pathTokens(ref);
  if (!t.length) return { ok: false, reason: 'empty path' };
  let cur = profile;
  for (const k of t) {
    if (cur == null || typeof cur !== 'object' || !(k in cur)) return { ok: false, reason: `"${ref}" does not exist in the profile` };
    cur = cur[k];
  }
  if (cur == null || cur === '') return { ok: false, reason: `"${ref}" is empty in the profile` };
  if (LISTS.includes(t[0])) {
    const entry = profile[t[0]]?.[Number(t[1])];
    if (!entry || !CONFIRMED.includes(entry.provenance)) return { ok: false, reason: `"${ref}" is not a confirmed fact (provenance ${entry?.provenance ?? 'missing'})` };
  } else if (t[0] === 'identity') {
    const keys = t.map((_, i) => t.slice(0, i + 1).join('.'));
    if (!keys.some((k) => CONFIRMED.includes(profile.provenance?.[k]))) return { ok: false, reason: `"${ref}" is not confirmed (no provenance entry)` };
  } else return { ok: false, reason: `"${ref}" is not a citable profile path (use education, experience, projects, skills, certifications or identity)` };
  return { ok: true, value: cur };
}

const flat = (v) => (v == null ? [] : typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(flat) : typeof v === 'object' ? Object.values(v).flatMap(flat) : [String(v)]);

/** All text of confirmed profile facts. Excludes unconfirmed entries, open_questions, and provenance. */
export function confirmedText(profile) {
  const parts = [...flat(profile.identity)];
  for (const l of LISTS) for (const e of profile[l] ?? []) if (CONFIRMED.includes(e.provenance)) parts.push(...flat({ ...e, provenance: undefined }));
  parts.push(...flat(profile.preferences?.target_roles), ...flat(profile.preferences?.industries));
  return parts.join('\n');
}

export const confirmedProfile = (profile) => ({
  ...profile,
  ...Object.fromEntries(LISTS.map((l) => [l, (profile[l] ?? []).filter((e) => CONFIRMED.includes(e.provenance))])),
  open_questions: undefined,
});

// ---------------------------------------------------------------- unsupported-claim scan

const ALLOW = new Set(('january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday ' +
  'i i\'m i\'ve i\'d i\'ll english').split(' '));
const CLAIM_VERBS = ['led', 'lead', 'leading', 'managed', 'directed', 'architected', 'founded', 'owned', 'spearheaded', 'increased', 'reduced', 'improved', 'boosted', 'saved', 'optimized', 'optimised', 'launched', 'scaled', 'mentored', 'published', 'won', 'awarded'];
const tokenSet = (text) => new Set((String(text).toLowerCase().match(/[a-z0-9][a-z0-9+#.'-]*/g) ?? []).flatMap((t) => { const c = t.replace(/[.'-]+$/, ''); return [c, ...c.split('-'), c.replace(/'s$/, ''), c.replace(/s$/, '')]; }));
const digitSet = (text) => new Set((String(text).match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((d) => d.replace(/,/g, '')));

/**
 * Returns the claims in `text` that the evidence does not support:
 *  - numbers absent from the evidence,
 *  - capitalised or mixed-case terms (employers, tools, certifications) absent from the evidence,
 *  - achievement verbs (led, increased...) when `verbs` is given and the source text lacks them.
 */
export function unsupportedClaims(text, evidence, { verbs = null } = {}) {
  const out = [];
  const ev = tokenSet(evidence), nums = digitSet(evidence);
  for (const m of String(text).matchAll(/\d[\d,]*(?:\.\d+)?%?/g)) {
    const d = m[0].replace(/[,%]/g, '');
    if (!nums.has(d)) out.push(`number "${m[0]}"`);
  }
  for (const m of String(text).matchAll(/[A-Za-z][A-Za-z0-9+#.'-]*/g)) {
    const raw = m[0].replace(/[.'-]+$/, '');
    if (raw.length < 2 || ALLOW.has(raw.toLowerCase())) continue;
    const before = String(text).slice(0, m.index);
    const sentenceStart = /(^|[.!?:•*-]|\n)\s*$/.test(before);
    const mixed = /[a-z][A-Z]|\d|^[A-Z]{2,}/.test(raw);
    if (!((/^[A-Z]/.test(raw) && !sentenceStart) || mixed)) continue;
    const low = raw.toLowerCase();
    const parts = low.split('-');
    if (!(ev.has(low) || ev.has(low.replace(/s$/, '')) || parts.every((p) => ev.has(p)))) out.push(`term "${raw}"`);
  }
  if (verbs != null) {
    const src = tokenSet(verbs);
    for (const m of String(text).toLowerCase().matchAll(/[a-z]+/g)) if (CLAIM_VERBS.includes(m[0]) && !src.has(m[0])) out.push(`claim verb "${m[0]}" (not in the cited source)`);
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------- storage helpers

export const jobText = (job, descriptions) => [job.company, job.title, job.location, job.duration, job.start_date, job.stipend_text, job.eligibility_text, job.qualifications_text, job.verification_notes, ...descriptions.map((d) => d.text)].filter(Boolean).join('\n');

const appDir = (dir, appId) => join(dir, 'tailored', appId);
export const versions = (dir, appId) => (existsSync(appDir(dir, appId)) ? readdirSync(appDir(dir, appId)).filter((f) => /^v\d+$/.test(f)).map((f) => Number(f.slice(1))).sort((a, b) => a - b) : []);
export const verDir = (dir, appId, v) => join(appDir(dir, appId), `v${v}`);
export const readIf = (p) => (existsSync(p) ? readFileSync(p, 'utf8').replace(/^﻿/, '') : null);
export const readMeta = (dir, appId, v) => { const t = readIf(join(verDir(dir, appId, v), 'meta.json')); return t ? JSON.parse(t) : {}; };
export const writeText = (p, t) => { mkdirSync(join(p, '..'), { recursive: true }); writeAtomic(p, t.endsWith('\n') ? t : `${t}\n`); };

export function loadAll(dir) {
  const S = loadCsvSchemas();
  return { S, jobsT: readTable(dir, 'jobs.csv', S['jobs.csv']), appsT: readTable(dir, 'applications.csv', S['applications.csv']), runT: readTable(dir, 'run-history.csv', S['run-history.csv']) };
}

/** Validate then back up and atomically write the given tables. */
export function commit(dir, S, tables, now) {
  const jobsT = tables['jobs.csv'] ?? readTable(dir, 'jobs.csv', S['jobs.csv']);
  const appsT = tables['applications.csv'] ?? readTable(dir, 'applications.csv', S['applications.csv']);
  const ids = (t, f) => new Set(t.records.map((r) => r[f]));
  const sets = { 'jobs.csv': ids(jobsT, 'job_id'), 'applications.csv': ids(appsT, 'application_id') };
  const texts = Object.fromEntries(Object.entries(tables).map(([n, t]) => [n, serializeCsv(t.header, t.records)]));
  const errs = Object.entries(texts).flatMap(([n, txt]) => checkCsv(n, txt, S[n], sets).map((e) => `${n}: ${e}`));
  if (errs.length) throw new Error(`refusing to write; validation failed:\n${errs.join('\n')}`);
  writeJournaled(dir, texts, now);
}

/** Lock, run-history row (in_progress), work, then finish the row and release the lock. An interrupted earlier write is finished first. */
export function withRun(dir, summary, now, work, { skill = 'apply' } = {}) {
  recoverJournal(dir);
  const { S, runT } = loadAll(dir);
  const profile = readJson(join(dir, 'candidate-profile.json'));
  const ready = checkReadiness(profile);
  if (!ready.ready) throw new RefusedError(`profile not ready: ${ready.missing.join('; ')}`);
  const syncPath = join(dir, 'sync-state.json');
  const sync = readJson(syncPath);
  if (sync.lock?.holder) throw new RefusedError(`sync-state lock is held by ${sync.lock.holder} since ${sync.lock.acquired_at}; ask the user before clearing it`);
  const runId = fmtId('run', nextNum(runT.records, 'run_id'));
  const row = { run_id: runId, started_at: now, ended_at: '', harness: 'claude-code', skill, outcome: 'in_progress', summary, rows_created: '0', rows_updated: '0', approvals_requested: '0', approvals_granted: '0', error: '', notes: '' };
  runT.records.push(row);
  commit(dir, S, { 'run-history.csv': runT }, now);
  writeAtomic(syncPath, JSON.stringify({ ...sync, lock: { holder: runId, acquired_at: now } }, null, 2) + '\n');
  const release = () => { const cur = readJson(syncPath); if (cur.lock?.holder === runId) writeAtomic(syncPath, JSON.stringify({ ...cur, last_run_id: runId, lock: { holder: null, acquired_at: null } }, null, 2) + '\n'); };
  const finish = (patch) => { const t = loadAll(dir); const r = t.runT.records.find((x) => x.run_id === runId); Object.assign(r, { ended_at: now }, patch); commit(dir, t.S, { 'run-history.csv': t.runT }, now); };
  try {
    const res = work({ runId, profile });
    finish({ outcome: 'completed', rows_created: String(res.created ?? 0), rows_updated: String(res.updated ?? 0), summary: res.summary ?? summary, ...(res.run ?? {}) });
    release();
    return { run_id: runId, ...res.result };
  } catch (e) {
    try { finish({ outcome: 'failed', error: String(e.message).split('\n')[0].slice(0, 300) }); } catch { /* keep the original error */ }
    release();
    throw e;
  }
}

// ---------------------------------------------------------------- commands

export const checkId = (id, re, what) => { if (!re.test(id ?? '')) throw new Error(`${what} id "${id}" is not valid`); };
export const jobOf = (jobsT, id) => { const j = jobsT.records.find((r) => r.job_id === id); if (!j) throw new Error(`no such job: ${id}`); return j; };
export const appOf = (appsT, id) => { const a = appsT.records.find((r) => r.application_id === id); if (!a) throw new Error(`no such application: ${id}`); return a; };

/** Shortlisted jobs (the user's approved list) and any applications already started for them. */
export function listApprovable(dir) {
  const { jobsT, appsT } = loadAll(dir);
  return jobsT.records.filter((j) => j.status === 'shortlisted').map((j) => ({
    job_id: j.job_id, company: j.company, title: j.title, source_url: j.source_url, deadline: j.deadline || null,
    applications: appsT.records.filter((a) => a.job_id === j.job_id).map((a) => ({ application_id: a.application_id, status: a.status, versions: versions(dir, a.application_id).length })),
  }));
}

/** Record the user's approval of a job: verified (or a user override of rejected) becomes shortlisted. */
export function approveJob(dir, jobId, note, { now = isoNow() } = {}) {
  checkId(jobId, ID_JOB, 'job');
  if (!str(note)) throw new RefusedError('approving a job needs the user\'s words as --note');
  return withRun(dir, `apply: approve ${jobId}`, now, () => {
    const { S, jobsT } = loadAll(dir);
    const j = jobOf(jobsT, jobId);
    if (j.status === 'shortlisted') return { updated: 0, result: { job_id: jobId, status: 'shortlisted', changed: false } };
    if (!['verified', 'rejected'].includes(j.status)) throw new RefusedError(`${jobId} is ${j.status}; only a verified job (or a rejected one the user overrides) can be approved. ${j.status === 'discovered' ? 'Open the posting and verify it first.' : ''}`.trim());
    if (!j.last_verified_at || !j.verification_notes) throw new RefusedError(`${jobId} has no verification (last_verified_at / verification_notes); verify the posting first`);
    j.status = 'shortlisted'; j.updated_at = now;
    j.notes = [j.notes, `[user-approved ${now}] ${str(note)}`].filter(Boolean).join(' | ');
    commit(dir, S, { 'jobs.csv': jobsT }, now);
    return { updated: 1, result: { job_id: jobId, status: 'shortlisted', changed: true } };
  });
}

function descriptionSources(dir, appId, v, job) {
  const out = [];
  if (str(job.qualifications_text) || str(job.eligibility_text)) out.push({ origin: 'jobs.csv', fetched_at: job.last_verified_at || null, text: [job.eligibility_text, job.qualifications_text].filter(Boolean).join('\n'), stale: !job.last_verified_at });
  const file = readIf(join(verDir(dir, appId, v), 'job-description.txt'));
  const m = readMeta(dir, appId, v);
  if (file) out.push({ origin: m.description?.origin ?? 'unknown', url: m.description?.url ?? null, fetched_at: m.description?.fetched_at ?? null, text: file, stale: !!m.description?.carried_from, carried_from: m.description?.carried_from ?? null });
  return out;
}

/** Gate a job, then create (or reuse) its application row and a new version folder. */
export function startApplication(dir, jobId, { now = isoNow() } = {}) {
  checkId(jobId, ID_JOB, 'job');
  return withRun(dir, `apply: start ${jobId}`, now, ({ profile }) => {
    const { S, jobsT, appsT } = loadAll(dir);
    const job = jobOf(jobsT, jobId);
    if (job.status !== 'shortlisted') {
      const why = { rejected: 'it is rejected', expired: 'it is expired', discovered: 'it is not verified or approved yet', verified: 'the user has not approved it yet (approve-job records that)', applied: 'it is already applied', archived: 'it is archived' }[job.status] ?? `its status is ${job.status}`;
      throw new RefusedError(`${jobId} is not an approved job: ${why}. Only shortlisted jobs can be prepared.`);
    }
    const existing = appsT.records.filter((a) => a.job_id === jobId && !CLOSED.includes(a.status));
    const done = existing.find((a) => !['drafting', 'ready_for_review', 'approved'].includes(a.status));
    if (done) throw new RefusedError(`${done.application_id} for ${jobId} is already ${done.status}; nothing to prepare`);
    let app = existing[0], created = 0, updated = 0;
    if (!app) {
      app = { application_id: fmtId('app', nextNum(appsT.records, 'application_id')), job_id: jobId, status: 'drafting', created_at: now, updated_at: now };
      for (const c of appsT.header) app[c] ??= '';
      appsT.records.push(app); created = 1;
    } else if (app.status === 'approved') {
      Object.assign(app, { status: 'drafting', approved_at: '', approval_note: '', updated_at: now, notes: [app.notes, `[approval cleared ${now}: new version started]`].filter(Boolean).join(' | ') }); updated = 1;
    }
    const prev = versions(dir, app.application_id).at(-1) ?? 0;
    const v = prev + 1;
    const vd = verDir(dir, app.application_id, v);
    mkdirSync(vd, { recursive: true });
    writeText(join(vd, 'job-snapshot.json'), JSON.stringify(job, null, 2));
    const meta = { version: v, job_id: jobId, started_at: now, prepared_at: null, files: {} };
    if (prev) {
      const old = readIf(join(verDir(dir, app.application_id, prev), 'job-description.txt'));
      if (old) { writeText(join(vd, 'job-description.txt'), old); meta.description = { ...readMeta(dir, app.application_id, prev).description, carried_from: `v${prev}` }; }
    }
    writeText(join(vd, 'meta.json'), JSON.stringify(meta, null, 2));
    if (created || updated) commit(dir, S, { 'applications.csv': appsT }, now);
    const sources = descriptionSources(dir, app.application_id, v, job);
    return {
      created, updated, summary: `apply: started ${app.application_id} v${v} for ${jobId}`,
      result: {
        application_id: app.application_id, version: v, folder: rel('tailored', app.application_id, `v${v}`), status: app.status,
        job: { job_id: jobId, company: job.company, title: job.title, source_url: job.source_url, apply_url: job.apply_url || null, deadline: job.deadline || null, last_verified_at: job.last_verified_at, uncertainties: job.uncertainties || null, unverified_fields: job.unverified_fields || null },
        description: { status: sources.length ? 'available' : 'missing', sources: sources.map(({ text, ...s }) => ({ ...s, chars: text.length })),
          next: sources.some((s) => !s.stale) ? 'Re-open the source_url to refresh it if you can; otherwise prepare from what is on file.' : 'Re-open the source_url and run set-description, or ask the user to paste the posting text. prepare refuses without a description.' },
        profile: confirmedProfile(profile),
      },
    };
  });
}

/** Store the posting text the agent fetched or the user pasted for this version. */
export function setDescription(dir, appId, file, { origin, url = null, now = isoNow() } = {}) {
  checkId(appId, ID_APP, 'application');
  if (!ORIGINS.includes(origin)) throw new Error(`--origin must be ${ORIGINS.join(' or ')}`);
  const text = readFileSync(file, 'utf8').replace(/^﻿/, '').trim();
  if (text.length < 40) throw new RefusedError('the description is too short to be a job posting (under 40 characters)');
  const { appsT } = loadAll(dir);
  appOf(appsT, appId);
  const v = versions(dir, appId).at(-1);
  if (!v) throw new RefusedError(`${appId} has no version folder; run start first`);
  const vd = verDir(dir, appId, v);
  writeText(join(vd, 'job-description.txt'), text);
  const meta = readMeta(dir, appId, v);
  meta.description = { origin, url, fetched_at: now };
  writeText(join(vd, 'meta.json'), JSON.stringify(meta, null, 2));
  return { application_id: appId, version: v, origin, chars: text.length, folder: rel('tailored', appId, `v${v}`) };
}

/** Record something the user said for this application (an answer, a correction, a declaration). */
export function addInput(dir, appId, key, text, quote, { now = isoNow() } = {}) {
  checkId(appId, ID_APP, 'application');
  if (!/^[a-z0-9_]{2,40}$/.test(key ?? '')) throw new Error('--key must be 2-40 characters of a-z, 0-9, _');
  if (!str(text) || !str(quote)) throw new RefusedError('both --text (the value) and --quote (the user\'s own words) are required');
  const { appsT } = loadAll(dir);
  appOf(appsT, appId);
  const p = join(appDir(dir, appId), 'user-input.json');
  const cur = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  cur[key] = { value: str(text), user_words: str(quote), recorded_at: now };
  writeText(p, JSON.stringify(cur, null, 2));
  return { application_id: appId, key, recorded_at: now };
}

export const readInputs = (dir, appId) => { const t = readIf(join(appDir(dir, appId), 'user-input.json')); return t ? JSON.parse(t) : {}; };

// ---------------------------------------------------------------- prepare

function checkPackage(pkg, { profile, job, sources, inputs }) {
  const errs = [];
  const evidenceAll = confirmedText(profile);
  const inputText = Object.values(inputs).map((i) => i.value).join('\n');
  const posting = jobText(job, sources);
  const quoteHay = norm(posting);
  const fail = (where, msg) => errs.push(`${where}: ${msg}`);

  // analysis
  const an = pkg.analysis ?? {};
  if (!Array.isArray(an.requirements) || !an.requirements.length) fail('analysis.requirements', 'list the posting\'s requirements (at least one)');
  (an.requirements ?? []).forEach((r, i) => {
    const w = `analysis.requirements[${i}]`;
    if (!str(r.text)) fail(w, 'text is required');
    if (!LEVELS.includes(r.level)) fail(w, `level must be ${LEVELS.join(' or ')}`);
    if (!REQ_STATUS.includes(r.status)) fail(w, `status must be ${REQ_STATUS.join('/')}`);
    const q = norm(r.source_quote).trim();
    if (q.length < 4) fail(w, 'source_quote is required: quote the posting');
    else if (!quoteHay.includes(` ${q} `)) fail(w, `source_quote not found in the posting text on file ("${str(r.source_quote).slice(0, 60)}"); do not invent requirements`);
    const ev = r.evidence ?? [];
    if (r.status === 'met' && !ev.length) fail(w, 'status "met" needs evidence (profile paths)');
    for (const e of ev) { const x = resolveRef(profile, e); if (!x.ok) fail(`${w}.evidence`, x.reason); }
  });
  (an.strongest_evidence ?? []).forEach((s, i) => {
    if (!str(s.claim) || !(s.evidence ?? []).length) fail(`analysis.strongest_evidence[${i}]`, 'claim and evidence are required');
    for (const e of s.evidence ?? []) { const x = resolveRef(profile, e); if (!x.ok) fail(`analysis.strongest_evidence[${i}]`, x.reason); }
    for (const c of unsupportedClaims(s.claim ?? '', evidenceAll)) fail(`analysis.strongest_evidence[${i}]`, `unsupported ${c}`);
  });

  // resume
  const rs = pkg.resume;
  if (!rs || typeof rs !== 'object') fail('resume', 'is required');
  else {
    const seen = new Set();
    for (const [sec, listName] of [['education', 'education'], ['experience', 'experience'], ['projects', 'projects']]) {
      (rs[sec] ?? []).forEach((e, i) => {
        const w = `resume.${sec}[${i}]`;
        const x = resolveRef(profile, e.ref);
        if (!x.ok) { fail(w, x.reason); return; }
        if (!String(e.ref).startsWith(`${listName}[`) || pathTokens(e.ref).length !== 2) fail(w, `ref must be a whole ${listName} entry like ${listName}[0]`);
        if (seen.has(e.ref)) fail(w, `${e.ref} is listed twice`);
        seen.add(e.ref);
        for (const c of e.include_coursework ?? []) if (!(x.value.coursework ?? []).includes(c)) fail(w, `coursework "${c}" is not in the profile entry`);
        (e.bullets ?? []).forEach((b, k) => {
          const bw = `${w}.bullets[${k}]`;
          if (!str(b.text)) { fail(bw, 'text is required'); return; }
          const src = resolveRef(profile, b.source);
          if (!src.ok) { fail(bw, `source: ${src.reason}`); return; }
          if (typeof src.value !== 'string') fail(bw, 'source must point to a text value such as experience[0].highlights[0]');
          else if (!String(b.source).startsWith(`${e.ref}.`)) fail(bw, `source must belong to ${e.ref}`);
          else {
            const entryText = flat({ ...x.value, provenance: undefined }).join('\n');
            for (const c of unsupportedClaims(b.text, `${src.value}\n${entryText}`)) fail(bw, `unsupported ${c}`);
            for (const c of unsupportedClaims(b.text, '', { verbs: src.value }).filter((c) => c.startsWith('claim verb'))) fail(bw, `unsupported ${c}`);
          }
        });
      });
    }
    if (!(rs.education ?? []).length && !(rs.experience ?? []).length && !(rs.projects ?? []).length) fail('resume', 'include at least one education, experience or project entry');
    const have = new Map((profile.skills ?? []).filter((s) => CONFIRMED.includes(s.provenance)).map((s) => [s.name.toLowerCase(), s.name]));
    for (const s of rs.skills ?? []) if (!have.has(String(s).toLowerCase())) fail('resume.skills', `"${s}" is not a confirmed skill in the profile`);
    for (const k of Object.keys(rs)) if (!['education', 'experience', 'projects', 'skills'].includes(k)) fail('resume', `unknown section "${k}" (contact details and dates come from the profile, not the package)`);
  }

  // cover letter
  const cl = pkg.cover_letter;
  if (!cl || !Array.isArray(cl.paragraphs) || !cl.paragraphs.length) fail('cover_letter', 'paragraphs[] is required');
  else {
    if (!(cl.uses ?? []).length) fail('cover_letter', 'uses[] must cite the profile paths the letter relies on');
    for (const u of cl.uses ?? []) { const x = resolveRef(profile, u); if (!x.ok) fail('cover_letter.uses', x.reason); }
    cl.paragraphs.forEach((p, i) => { for (const c of unsupportedClaims(p, `${evidenceAll}\n${posting}\n${inputText}`)) fail(`cover_letter.paragraphs[${i}]`, `unsupported ${c} (not in the confirmed profile, the posting, or the user's input)`); });
  }

  // answers
  (pkg.answers ?? []).forEach((a, i) => {
    const w = `answers[${i}]`;
    if (!str(a.question)) fail(w, 'question is required (copy it from the form)');
    if (!KINDS.includes(a.kind)) fail(w, `kind must be ${KINDS.join('/')}`);
    if (!str(a.answer)) return;
    const src = String(a.source ?? '');
    if (src.startsWith('user:')) {
      if (!inputs[src.slice(5)]) fail(w, `source ${src} has not been recorded with add-input`);
      else if (SENSITIVE.includes(a.kind) && norm(inputs[src.slice(5)].value) !== norm(a.answer)) fail(w, `a ${a.kind} answer must repeat the user's recorded value exactly`);
    } else if (src) {
      const x = resolveRef(profile, src);
      if (!x.ok) fail(w, `source: ${x.reason}`);
      else if (a.kind !== 'general' && !src.startsWith('identity.work_authorization')) fail(w, `a ${a.kind} answer needs the user's own recorded answer (user:<key>)`);
    } else fail(w, 'an answer needs a source (a profile path or user:<key>); otherwise leave it empty so it is marked NEEDS USER INPUT');
    if (!SENSITIVE.includes(a.kind)) for (const c of unsupportedClaims(a.answer, `${evidenceAll}\n${posting}\n${inputText}`)) fail(w, `unsupported ${c}`);
  });

  // recruiter message
  const rm = pkg.recruiter_message;
  if (rm) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str(rm.to))) fail('recruiter_message.to', 'a valid email address is required');
    if (!(rm.user_provided === true || /^https?:\/\/\S+$/.test(str(rm.contact_source_url)))) fail('recruiter_message', 'the recipient needs contact_source_url (a page that publishes it) or user_provided: true; never guess an address');
    if (!str(rm.subject) || !str(rm.body)) fail('recruiter_message', 'subject and body are required');
    for (const c of unsupportedClaims(rm.body ?? '', `${evidenceAll}\n${posting}\n${inputText}`)) fail('recruiter_message.body', `unsupported ${c}`);
  }
  return errs;
}

const dateRange = (e) => [e.start_date, e.end_date ?? (e.start_date ? 'present' : null)].filter(Boolean).join(' - ');

function renderResume(profile, rs) {
  const id = profile.identity;
  const links = Object.entries(id.links ?? {}).flatMap(([k, v]) => (k === 'other' ? v : [v])).filter(Boolean);
  const L = [`# ${id.full_name}`, '', [id.email, id.phone, id.location, ...links].filter(Boolean).join(' | '), ''];
  const get = (ref) => resolveRef(profile, ref).value;
  if ((rs.education ?? []).length) {
    L.push('## Education');
    for (const e of rs.education) { const p = get(e.ref); L.push(`- **${p.institution}**, ${p.degree}${p.field ? ` in ${p.field}` : ''}${dateRange(p) ? ` (${dateRange(p)})` : ''}${p.gpa ? `, GPA ${p.gpa}` : ''}`); if ((e.include_coursework ?? []).length) L.push(`  - Coursework: ${e.include_coursework.join(', ')}`); }
    L.push('');
  }
  if ((rs.experience ?? []).length) {
    L.push('## Experience');
    for (const e of rs.experience) { const p = get(e.ref); L.push(`- **${p.title}**, ${p.organization}${p.location ? `, ${p.location}` : ''}${dateRange(p) ? ` (${dateRange(p)})` : ''}`); for (const b of e.bullets ?? []) L.push(`  - ${str(b.text)}`); }
    L.push('');
  }
  if ((rs.projects ?? []).length) {
    L.push('## Projects');
    for (const e of rs.projects) { const p = get(e.ref); L.push(`- **${p.name}**${(p.technologies ?? []).length ? ` (${p.technologies.join(', ')})` : ''}${p.url ? ` - ${p.url}` : ''}`); for (const b of e.bullets ?? []) L.push(`  - ${str(b.text)}`); }
    L.push('');
  }
  if ((rs.skills ?? []).length) { L.push('## Skills', rs.skills.join(', '), ''); }
  return L.join('\n');
}

const renderLetter = (profile, job, cl, now) => [now.slice(0, 10), '', `Dear ${str(cl.greeting) || 'Hiring Team'},`, '', ...cl.paragraphs.flatMap((p) => [str(p), '']), 'Sincerely,', profile.identity.full_name].join('\n');

function renderAnswers(appId, job, answers) {
  const L = [`# ${job.company} - ${job.title} (${appId})`, ''];
  for (const a of answers) L.push(`## Question: ${str(a.question)}`, `Kind: ${a.kind}`, `Answer: ${str(a.answer) || 'NEEDS USER INPUT'}`, `Source: ${str(a.source) || '(none)'}`, '');
  return L.join('\n');
}

function renderReview({ appId, v, job, pkg, sources, open, gaps, now, pdfs }) {
  const L = [`# Review package: ${job.company} - ${job.title}`, '', '> PREPARED, NOT SUBMITTED. Nothing has been sent, emailed or uploaded.', '',
    `- Application: ${appId} (version ${v}), job ${job.job_id}`, `- Source URL: ${job.source_url}`, `- Apply URL: ${job.apply_url || '(none recorded)'}`, `- Deadline: ${job.deadline || '(none recorded)'}`, `- Prepared at: ${now}`, '',
    '## Requirements and evidence', '', '| Level | Requirement | Status | Evidence |', '|---|---|---|---|',
    ...[...pkg.analysis.requirements].sort((a, b) => (a.level === b.level ? 0 : a.level === 'essential' ? -1 : 1)).map((r) => `| ${r.level} | ${str(r.text)} | ${r.status} | ${(r.evidence ?? []).join(', ') || '-'} |`), '',
    '## Strongest evidence', '', ...((pkg.analysis.strongest_evidence ?? []).length ? pkg.analysis.strongest_evidence.map((s) => `- ${str(s.claim)} (${s.evidence.join(', ')})`) : ['- (none listed)']), '',
    '## Gaps (not claimed anywhere in the documents)', '', ...(gaps.length ? gaps.map((g) => `- ${g}`) : ['- none identified']), '',
    '## Declarations and eligibility questions', '', ...((pkg.answers ?? []).filter((a) => a.kind !== 'general').map((a) => `- [${a.kind}] ${str(a.question)} -> ${str(a.answer) || 'NEEDS USER INPUT'} (${str(a.source) || 'no source'})`)), ...((pkg.answers ?? []).some((a) => a.kind !== 'general') ? [] : ['- none in the package']), '',
    '## Needs the user', '', ...(open.length ? open.map((o) => `- ${o}`) : ['- nothing open']), '',
    '## PDF files (the ones to upload)', '', ...Object.entries(pdfs).map(([k, x]) => `- ${k}.pdf: ${x.pages} page(s), made with ${x.engine}${k === 'resume' && x.pages > 1 ? ' - longer than one page; an internship resume is usually one page' : ''}`), '',
    '## Uncertainties', '', `- Posting last verified: ${job.last_verified_at || 'never'}`, ...(job.unverified_fields ? [`- Unverified job fields: ${job.unverified_fields}`] : []), ...(job.uncertainties ? [`- ${job.uncertainties}`] : []),
    ...sources.map((s) => `- Description source: ${s.origin}${s.url ? ` (${s.url})` : ''}${s.fetched_at ? `, ${s.fetched_at}` : ''}${s.stale ? ' - STALE or unverified, refresh before relying on it' : ''}`), ''];
  return L.join('\n');
}

/** Validate a package and write the documents, then record them in applications.csv as prepared (not submitted). */
export function prepare(dir, appId, pkg, { now = isoNow() } = {}) {
  checkId(appId, ID_APP, 'application');
  return withRun(dir, `apply: prepare ${appId}`, now, ({ profile }) => {
    const { S, jobsT, appsT } = loadAll(dir);
    const app = appOf(appsT, appId);
    const job = jobOf(jobsT, app.job_id);
    if (job.status !== 'shortlisted') throw new RefusedError(`${job.job_id} is ${job.status}, not an approved (shortlisted) job`);
    if (!EDITABLE.includes(app.status)) throw new RefusedError(`${appId} is ${app.status}; run start to open a new version before preparing again`);
    const v = versions(dir, appId).at(-1);
    if (!v) throw new RefusedError(`${appId} has no version folder; run start first`);
    const sources = descriptionSources(dir, appId, v, job);
    if (!sources.length) throw new RefusedError(`the job description for ${job.job_id} is unavailable: jobs.csv holds no qualifications_text or eligibility_text and none was supplied. Re-open ${job.source_url} and run set-description, or ask the user to paste the posting. Requirements are never invented.`);
    const inputs = readInputs(dir, appId);
    const errs = checkPackage(pkg, { profile, job, sources, inputs });
    if (errs.length) throw new Error(`package refused; nothing was written:\n${errs.map((e) => `  - ${e}`).join('\n')}`);

    const answers = pkg.answers ?? [];
    const gaps = [...new Set([...pkg.analysis.requirements.filter((r) => r.status !== 'met').map((r) => `${r.status === 'gap' ? 'No evidence' : 'Partial evidence'} for ${r.level} requirement: ${str(r.text)}${str(r.note) ? ` (${str(r.note)})` : ''}`), ...(pkg.analysis.gaps ?? []).map(str)])];
    const open = answers.filter((a) => !str(a.answer)).map((a) => `Answer needed: ${str(a.question)}`);
    const essentialGaps = pkg.analysis.requirements.filter((r) => r.level === 'essential' && r.status === 'gap').length;

    const vd = verDir(dir, appId, v);
    const resumeMd = renderResume(profile, pkg.resume), letterMd = renderLetter(profile, job, pkg.cover_letter, now);
    // The PDFs are made first: if they cannot be, nothing is written.
    let pdfs;
    try { pdfs = makePdfs({ resume: resumeMd, 'cover-letter': letterMd }, { names: { resume: `${profile.identity.full_name} - Resume`, 'cover-letter': `${profile.identity.full_name} - Cover letter` } }); }
    catch (e) { throw new RefusedError(`${e.message}. Nothing was written; the resume must be a PDF to be uploaded.`); }
    const files = {
      'resume.md': resumeMd, 'cover-letter.md': letterMd,
      'answers.md': renderAnswers(appId, job, answers), 'review.md': renderReview({ appId, v, job, pkg, sources, open, gaps, now, pdfs }),
    };
    if (pkg.recruiter_message) {
      const rm = pkg.recruiter_message;
      mkdirSync(join(dir, 'drafts'), { recursive: true });
      writeText(join(dir, 'drafts', `${appId}-v${v}-recruiter-message.md`), [`DRAFT - NOT SENT. Needs the user's approval of this exact text and recipient.`, `Recipient source: ${rm.user_provided ? 'given by the user' : rm.contact_source_url}`, '', `To: ${str(rm.to)}`, `Subject: ${str(rm.subject)}`, '', String(rm.body).trim(), '', profile.identity.full_name].join('\n'));
    }
    const hashes = {};
    for (const [n, t] of Object.entries(files)) { writeText(join(vd, n), t); hashes[n] = sha(t.endsWith('\n') ? t : `${t}\n`); }
    for (const [k, x] of Object.entries(pdfs)) { writeAtomic(join(vd, `${k}.pdf`), x.pdf); hashes[`${k}.pdf`] = sha(x.pdf); }
    const meta = readMeta(dir, appId, v);
    Object.assign(meta, { prepared_at: now, files: hashes, essential_gaps: essentialGaps, open_items: open.length, recruiter_draft: pkg.recruiter_message ? rel('drafts', `${appId}-v${v}-recruiter-message.md`) : null,
      pdf: Object.fromEntries(Object.entries(pdfs).map(([k, x]) => [k, { engine: x.engine, pages: x.pages }])) });
    writeText(join(vd, 'meta.json'), JSON.stringify(meta, null, 2));
    writeText(join(vd, 'package.json'), JSON.stringify(pkg, null, 2));

    const base = rel('tailored', appId, `v${v}`);
    Object.assign(app, {
      status: open.length ? 'drafting' : 'ready_for_review', resume_path: rel(base, 'resume.pdf'), cover_letter_path: rel(base, 'cover-letter.pdf'), answers_path: rel(base, 'answers.md'),
      next_action: open.length ? `Collect user answers (${open.length}) then re-run prepare` : 'Review package with the user; do not submit without approval', updated_at: now,
      notes: [app.notes, `prepared v${v} ${now}`].filter(Boolean).join(' | '),
    });
    commit(dir, S, { 'applications.csv': appsT }, now);
    return {
      updated: 1, summary: `apply: prepared ${appId} v${v}; ${open.length} open item(s), not submitted`,
      result: { application_id: appId, version: v, status: app.status, submitted: false, prepared_at: now, folder: base, files: [...Object.keys(files), ...Object.keys(pdfs).map((k) => `${k}.pdf`)].map((n) => rel(base, n)), pdf: meta.pdf, recruiter_draft: meta.recruiter_draft, open_items: open, gaps, essential_gaps: essentialGaps, next: 'Run review and show the whole package to the user. Nothing is sent from this skill.' },
    };
  });
}

/** Everything the user must see before any submission, plus an integrity check of the saved files. */
export function review(dir, appId, version = null) {
  checkId(appId, ID_APP, 'application');
  const { jobsT, appsT } = loadAll(dir);
  const app = appOf(appsT, appId);
  const job = jobOf(jobsT, app.job_id);
  const v = version ?? versions(dir, appId).at(-1);
  if (!v) throw new RefusedError(`${appId} has no prepared version`);
  const vd = verDir(dir, appId, v);
  const meta = readMeta(dir, appId, v);
  if (!meta.prepared_at) throw new RefusedError(`${appId} v${v} has not been prepared`);
  const docs = {}, changed = [];
  for (const n of ['resume.md', 'cover-letter.md', 'answers.md', 'review.md']) docs[n] = readIf(join(vd, n));
  for (const n of Object.keys(meta.files)) { // every saved file, the PDFs included, is checked by its bytes
    const f = join(vd, n);
    if (!existsSync(f) || sha(readFileSync(f)) !== meta.files[n]) changed.push(n);
  }
  const draft = meta.recruiter_draft ? readIf(join(dir, meta.recruiter_draft)) : null;
  return {
    application_id: appId, version: v, status: app.status, submitted: false, prepared_at: meta.prepared_at,
    company: job.company, role: job.title, job_id: job.job_id, source_url: job.source_url, apply_url: job.apply_url || null,
    job_status: job.status, open_items: meta.open_items, essential_gaps: meta.essential_gaps,
    modified_since_prepared: changed.length ? changed : null,
    warning: changed.length ? `${changed.join(', ')} changed after preparation: any earlier approval is void; run prepare again or show the user the edited files` : null,
    documents: docs, recruiter_draft: draft,
    pdf_files: { resume: rel('tailored', appId, `v${v}`, 'resume.pdf'), cover_letter: rel('tailored', appId, `v${v}`, 'cover-letter.pdf'), details: meta.pdf ?? null },
  };
}
