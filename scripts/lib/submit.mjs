// Approved application submission: gate, bind approval to the exact package, record only observed results.
// This module never submits anything itself. A harness integration (browser, API) does that between
// `beginSubmission` and `recordSubmission`; `runSubmission` wires the two around a supplied integration object.
import { join } from 'node:path';
import { loadAll, commit, withRun, checkId, jobOf, appOf, review, readMeta, readIf, str, sha, ID_APP } from './apply.mjs';
import { RefusedError } from './ingest.mjs';
import { isoNow } from './data.mjs';
import { recovery } from './readiness.mjs';
import { SUBMIT_INTEGRATIONS, integrationStatus, requireWords, checkEvidence, appendLog, readLog } from './outbound.mjs';

const DONE = ['submitted', 'acknowledged', 'interview', 'assessment', 'offer', 'accepted', 'rejected', 'declined'];
const METHODS = ['portal', 'manual_by_user', 'other'];

const lastOf = (log, ...events) => [...log].reverse().find((e) => events.includes(e.event));
const openAttempt = (log) => {
  const a = lastOf(log, 'attempt_started');
  if (!a) return null;
  return log.some((e) => ['result', 'aborted'].includes(e.event) && e.attempt_id === a.attempt_id) ? null : a;
};
const currentApproval = (log) => { const e = lastOf(log, 'approval', 'denial', 'approval_void', 'result'); return e?.event === 'approval' ? e : null; };

/** Everything that must hold before a submission may be approved or started. Reads only. */
function gate(dir, appId, now) {
  checkId(appId, ID_APP, 'application');
  const { appsT, jobsT } = loadAll(dir);
  const app = appOf(appsT, appId);
  const job = jobOf(jobsT, app.job_id);
  const log = readLog(dir, appId);
  const blockers = [];
  if (job.status !== 'shortlisted') blockers.push(`${job.job_id} is ${job.status}, not an approved (shortlisted) job`);
  if (DONE.includes(app.status)) blockers.push(`${appId} is already ${app.status}; it is never submitted twice`);
  if (app.status === 'withdrawn') blockers.push(`${appId} was withdrawn`);
  if (app.status === 'submission_unconfirmed') blockers.push(`${appId} has an unconfirmed submission: verify in the portal or inbox and run verify before any retry`);
  if (app.status === 'drafting') blockers.push(`${appId} is still drafting: finish the open items and run prepare`);
  const open = openAttempt(log);
  if (open) blockers.push(`attempt ${open.attempt_id} (${open.at}) has no recorded result: record it or verify what happened before anything is retried`);
  const destination = job.apply_url || job.source_url;
  if (!/^https?:\/\/\S+$/.test(destination || '')) blockers.push('no valid destination URL on the job');
  if (job.deadline && job.deadline < now.slice(0, 10)) blockers.push(`the deadline ${job.deadline} has passed`);

  let rev = null, packageHash = null;
  try {
    rev = review(dir, appId);
    if (rev.open_items) blockers.push(`${rev.open_items} open item(s) in the package (answers marked NEEDS USER INPUT)`);
    if (rev.modified_since_prepared) blockers.push(`${rev.modified_since_prepared.join(', ')} changed after preparation; any earlier approval is void. Show the user the files and run prepare again`);
    else packageHash = sha(JSON.stringify({ files: readMeta(dir, appId, rev.version).files, destination }));
  } catch (e) { blockers.push(e.message); }
  return { app, job, log, blockers, rev, destination, packageHash, appsT };
}

/** The approval card: what the user must see, the hash their approval is bound to, and what could stop it. */
export function submissionCard(dir, appId, { now = isoNow() } = {}) {
  const g = gate(dir, appId, now);
  const { rev, job } = g;
  const integrations = Object.fromEntries(['browser', 'portal-api'].map((n) => { const s = integrationStatus(dir, n, now); return [n, s.usable ? 'verified, usable' : s.reason]; }));
  return {
    application_id: appId, ready_for_approval: g.blockers.length === 0, blockers: g.blockers,
    employer: job.company, role: job.title, job_id: job.job_id, destination_url: g.destination, source_url: job.source_url, deadline: job.deadline || null,
    package_version: rev?.version ?? null, package_hash: g.packageHash,
    documents: rev && !rev.modified_since_prepared ? rev.documents : null, essential_gaps: rev?.essential_gaps ?? null,
    integrations, submission_methods: METHODS,
    instructions: 'Show the user the employer, role, destination, resume, cover letter, every answer and every declaration, then ask whether to submit this exact package to this destination. Approve only on their explicit yes; pass their words and package_hash to approve.',
  };
}

export function approveSubmission(dir, appId, { note, packageHash, destination }, { now = isoNow() } = {}) {
  const words = requireWords(note, 'approving a submission');
  return withRun(dir, `submit: approve ${appId}`, now, () => {
    const g = gate(dir, appId, now);
    if (!['ready_for_review', 'submission_failed'].includes(g.app.status) && !g.blockers.length) g.blockers.push(`${appId} is ${g.app.status}; only a ready_for_review package (or a failed one, re-approved) can be approved`);
    if (g.blockers.length) throw new RefusedError(`cannot approve:\n- ${g.blockers.join('\n- ')}`);
    if (packageHash !== g.packageHash) throw new RefusedError('package_hash does not match the current package and destination: approval must be of exactly what the user saw. Re-show the card.');
    if (destination && destination !== g.destination) throw new RefusedError(`destination ${destination} is not the job's destination ${g.destination}`);
    const { S, appsT } = loadAll(dir);
    const app = appOf(appsT, appId);
    Object.assign(app, { status: 'approved', approved_at: now, approval_note: words, submission_method: '', submitted_at: '', submission_result: '', confirmation_evidence: '', next_action: 'Submit through a verified integration, or hand the user the destination', updated_at: now });
    commit(dir, S, { 'applications.csv': appsT }, now);
    appendLog(dir, appId, { at: now, event: 'approval', hash: g.packageHash, destination: g.destination, version: g.rev.version, note: words });
    return { updated: 1, run: { approvals_requested: '1', approvals_granted: '1' }, result: { application_id: appId, status: 'approved', approved_at: now, destination: g.destination, submitted: false } };
  });
}

export function denySubmission(dir, appId, note, { now = isoNow() } = {}) {
  const words = requireWords(note, 'recording a denial');
  return withRun(dir, `submit: denied ${appId}`, now, () => {
    const { S, appsT } = loadAll(dir);
    const app = appOf(appsT, appId);
    if (DONE.includes(app.status)) throw new RefusedError(`${appId} is already ${app.status}`);
    if (openAttempt(readLog(dir, appId))) throw new RefusedError('an attempt is in flight; record its result first');
    const wasApproved = app.status === 'approved';
    Object.assign(app, { ...(wasApproved ? { status: 'ready_for_review', approved_at: '', approval_note: '' } : {}), next_action: `User declined submission: ${words}`.slice(0, 200), updated_at: now });
    commit(dir, S, { 'applications.csv': appsT }, now);
    appendLog(dir, appId, { at: now, event: 'denial', note: words });
    return { updated: 1, run: { approvals_requested: '1', approvals_granted: '0' }, result: { application_id: appId, status: app.status, submitted: false, denied: true } };
  });
}

/**
 * Start an approved submission. Returns started:false with a hand-off when no verified integration can carry it
 * (nothing is logged as in flight). Otherwise logs the attempt and returns the payload for the integration.
 */
export function beginSubmission(dir, appId, { method = 'portal', integration = null } = {}, { now = isoNow() } = {}) {
  if (!METHODS.includes(method)) throw new Error(`--method must be ${METHODS.join('|')}`);
  return withRun(dir, `submit: begin ${appId}`, now, () => {
    const g = gate(dir, appId, now);
    const stale = g.blockers.filter((b) => /changed after preparation/.test(b));
    if (stale.length || (g.app.status === 'approved' && g.packageHash && currentApproval(g.log)?.hash !== g.packageHash)) {
      const { S, appsT } = loadAll(dir);
      const a = appOf(appsT, appId);
      if (a.status === 'approved') {
        Object.assign(a, { status: 'drafting', approved_at: '', approval_note: '', updated_at: now, notes: [a.notes, `[approval void ${now}: package changed after approval]`].filter(Boolean).join(' | ') });
        commit(dir, S, { 'applications.csv': appsT }, now);
        appendLog(dir, appId, { at: now, event: 'approval_void', reason: 'package changed after approval' });
        return { updated: 1, result: { started: false, voided: true, status: 'drafting', reason: 'The package changed after it was approved. Approval is void; run prepare, show the user the package, and ask again.' } };
      }
    }
    if (g.app.status !== 'approved') throw new RefusedError(`${appId} is ${g.app.status}, not approved: nothing may be submitted without the user's approval of this exact package`);
    const blockers = g.blockers.filter((b) => !/is still drafting/.test(b));
    if (blockers.length) throw new RefusedError(`cannot start:\n- ${blockers.join('\n- ')}`);
    if (!currentApproval(g.log)) throw new RefusedError('no approval is on record for this package (approve it first, with the package_hash from the card)');

    const handoff = { destination: g.destination, files: { resume: g.app.resume_path, cover_letter: g.app.cover_letter_path, answers: g.app.answers_path }, note: 'Open the destination and submit these documents yourself, then paste the confirmation text so it can be recorded.' };
    if (method === 'manual_by_user') {
      appendLog(dir, appId, { at: now, event: 'attempt_started', attempt_id: `${appId}-${now}`, method, integration: null });
      return { updated: 0, result: { started: true, manual: true, attempt_id: `${appId}-${now}`, handoff } };
    }
    const allowed = SUBMIT_INTEGRATIONS[method];
    const picked = integration ?? allowed[0];
    if (!allowed.includes(picked)) throw new RefusedError(`integration "${picked}" cannot carry a ${method} submission (allowed: ${allowed.join(', ')})`);
    const st = integrationStatus(dir, picked, now);
    if (!st.usable) return { updated: 0, result: { started: false, reason: `No authorized integration is available: ${st.reason}`, handoff, recover: recovery(dir, 'submit-application', st.reason, { now }), next: 'Do not just report this. Ask the user the recover.ask_user question (connect a browser tool, or submit it themselves) and help them; the approval stays valid and nothing was submitted or logged as in flight.' } };

    const attemptId = `${appId}-${now}`;
    appendLog(dir, appId, { at: now, event: 'attempt_started', attempt_id: attemptId, method, integration: picked });
    const pkg = JSON.parse(readIf(join(dir, 'tailored', appId, `v${g.rev.version}`, 'package.json')) ?? '{}');
    return {
      updated: 0,
      result: {
        started: true, attempt_id: attemptId, method, integration: picked, destination: g.destination, employer: g.job.company, role: g.job.title,
        payload: { files: handoff.files, answers: (pkg.answers ?? []).map((a) => ({ question: a.question, kind: a.kind, answer: a.answer })), declarations: (pkg.answers ?? []).filter((a) => a.kind !== 'general') },
        rules: ['Use only the approved documents and answers.', 'Do not bypass CAPTCHAs, logins, bot checks or platform rules: stop and use record --result failed --blocked <captcha|login|bot_check>.',
          'A required field that needs the user\'s judgment, or a declaration not in the approved answers: stop before submitting and run needs-input.', 'After pressing submit, read the confirmation and record exactly what you saw.'],
      },
    };
  });
}

/** Stop before submitting because the form asked for something the approved package does not cover. */
export function needsInput(dir, appId, field, { now = isoNow() } = {}) {
  if (!str(field)) throw new RefusedError('say which field or declaration needs the user');
  return withRun(dir, `submit: needs input ${appId}`, now, () => {
    const g = gate(dir, appId, now);
    const open = openAttempt(g.log);
    const { S, appsT } = loadAll(dir);
    const app = appOf(appsT, appId);
    if (app.status !== 'approved') throw new RefusedError(`${appId} is ${app.status}; nothing to stop`);
    if (open) appendLog(dir, appId, { at: now, event: 'aborted', attempt_id: open.attempt_id, reason: `needs user input: ${str(field)}` });
    appendLog(dir, appId, { at: now, event: 'approval_void', reason: `form needs user input: ${str(field)}` });
    Object.assign(app, { status: 'drafting', approved_at: '', approval_note: '', next_action: `Ask the user: ${str(field)}`.slice(0, 200), updated_at: now, notes: [app.notes, `[stopped ${now}: form asks "${str(field).slice(0, 120)}"]`].filter(Boolean).join(' | ') });
    commit(dir, S, { 'applications.csv': appsT }, now);
    return { updated: 1, result: { application_id: appId, status: 'drafting', submitted: false, ask_user: str(field), next: 'Ask the user, record the answer with apply-store add-input, run prepare, then ask for approval again.' } };
  });
}

function writeOutcome(dir, appId, out, now, { allowFrom }) {
  const { S, appsT, jobsT } = (() => { const t = loadAll(dir); return t; })();
  const app = appOf(appsT, appId);
  if (!allowFrom.includes(app.status)) throw new RefusedError(`${appId} is ${app.status}; cannot record this outcome now`);
  const job = jobOf(jobsT, app.job_id);
  const base = { updated_at: now };
  if (out.result === 'success') {
    Object.assign(app, base, { status: 'submitted', submission_method: out.method, submitted_at: now, submission_result: 'success', confirmation_evidence: `[${out.kind}] ${out.evidence}`.slice(0, 500), next_action: 'Watch the inbox for a reply' });
    Object.assign(job, { status: 'applied', updated_at: now, notes: [job.notes, `[applied ${now}] ${appId}`].filter(Boolean).join(' | ') });
  } else if (out.result === 'failed') {
    Object.assign(app, base, { status: 'submission_failed', submission_method: out.method, submission_result: 'failed', submitted_at: '', confirmation_evidence: out.evidence.slice(0, 500),
      next_action: out.blocked ? `Blocked by ${out.blocked}: the user completes this step at the destination, then pastes the confirmation` : 'Fix the cause; a retry needs the user\'s approval again' });
  } else {
    Object.assign(app, base, { status: 'submission_unconfirmed', submission_method: out.method, submission_result: 'unconfirmed', submitted_at: '', confirmation_evidence: out.evidence.slice(0, 500), next_action: 'Verify in the portal or inbox. Do not retry until verified.' });
  }
  commit(dir, S, { 'applications.csv': appsT, 'jobs.csv': jobsT }, now);
  return app;
}

/** Record the observed outcome of the open attempt. */
export function recordSubmission(dir, appId, { result, evidence, evidenceKind = null, blocked = null }, { now = isoNow() } = {}) {
  if (!['success', 'failed', 'unconfirmed'].includes(result)) throw new Error('--result must be success, failed or unconfirmed');
  return withRun(dir, `submit: record ${result} ${appId}`, now, () => {
    const log = readLog(dir, appId);
    const att = openAttempt(log);
    if (!att) throw new RefusedError('no attempt is in flight for this application; begin first');
    const text = checkEvidence(evidenceKind, evidence, { success: result === 'success' });
    if (att.method === 'manual_by_user' && result === 'success' && evidenceKind !== 'user_pasted_confirmation') throw new RefusedError('the user submitted this one, so success needs the confirmation text they pasted (--evidence-kind user_pasted_confirmation); otherwise record unconfirmed');
    const app = writeOutcome(dir, appId, { result, evidence: text, kind: evidenceKind, method: att.method, blocked }, now, { allowFrom: ['approved'] });
    appendLog(dir, appId, { at: now, event: 'result', attempt_id: att.attempt_id, result, evidence_kind: evidenceKind, evidence: text.slice(0, 500), blocked });
    return { updated: 1, result: { application_id: appId, status: app.status, submitted: app.status === 'submitted', result, recorded_at: now, ...(result === 'unconfirmed' ? { warning: 'Outcome unknown. Do NOT retry until verified.' } : {}) } };
  });
}

/** Resolve an unconfirmed submission with fresh evidence (this is the only way out before a retry). */
export function verifySubmission(dir, appId, { result, evidence, evidenceKind = null }, { now = isoNow() } = {}) {
  if (!['success', 'failed'].includes(result)) throw new Error('--result must be success or failed');
  return withRun(dir, `submit: verify ${result} ${appId}`, now, () => {
    const { appsT } = loadAll(dir);
    const app = appOf(appsT, appId);
    if (app.status !== 'submission_unconfirmed') throw new RefusedError(`${appId} is ${app.status}; only an unconfirmed submission is verified`);
    const text = checkEvidence(evidenceKind, evidence, { success: result === 'success' });
    const method = app.submission_method || 'other';
    const out = writeOutcome(dir, appId, { result, evidence: text, kind: evidenceKind, method }, now, { allowFrom: ['submission_unconfirmed'] });
    appendLog(dir, appId, { at: now, event: 'verification', result, evidence_kind: evidenceKind, evidence: text.slice(0, 500) });
    return { updated: 1, result: { application_id: appId, status: out.status, submitted: out.status === 'submitted', verified_at: now } };
  });
}

/**
 * Drive one submission through a supplied integration object:
 *   { name, submit(payload) -> { status: 'confirmed', evidence, evidence_kind } | { status: 'failed', error, blocked? } | { status: 'ambiguous', note } }
 * Anything else, or a thrown error after the request began, is recorded as unconfirmed, never as success.
 */
export async function runSubmission(dir, appId, integration, { method = 'portal', now = isoNow() } = {}) {
  const begun = beginSubmission(dir, appId, { method, integration: integration.name }, { now });
  if (!begun.started) return begun;
  let out;
  try { out = await integration.submit(begun.payload); } catch (e) { out = { status: 'ambiguous', note: `integration error after the request began: ${e.message}` }; }
  if (out?.status === 'confirmed') {
    try { return recordSubmission(dir, appId, { result: 'success', evidence: out.evidence, evidenceKind: out.evidence_kind }, { now }); }
    catch (e) { return recordSubmission(dir, appId, { result: 'unconfirmed', evidence: `claimed success but the evidence was not acceptable: ${e.message}` }, { now }); }
  }
  if (out?.status === 'failed') return recordSubmission(dir, appId, { result: 'failed', evidence: out.error || 'failed with no error text', blocked: out.blocked ?? null }, { now });
  return recordSubmission(dir, appId, { result: 'unconfirmed', evidence: out?.note || 'the integration returned no clear result' }, { now });
}
