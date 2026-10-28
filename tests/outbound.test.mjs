// Tests for submit-application and contact-recruiter. Run: node --test tests/outbound.test.mjs
// MOCKED integrations only: nothing here submits an application or sends a message. Fictional data, throwaway data dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPdfStub } from './helpers/pdf-stub.mjs';
import { repoRoot, loadCsvSchemas, checkCsv } from '../scripts/lib/data.mjs';
import { parseCsv, serializeCsv } from '../scripts/lib/csv.mjs';
import { RefusedError } from '../scripts/lib/ingest.mjs';
import { startApplication, prepare, addInput } from '../scripts/lib/apply.mjs';
import { setIntegration } from '../scripts/lib/outbound.mjs';
import { submissionCard, approveSubmission, denySubmission, beginSubmission, needsInput, recordSubmission, verifySubmission, runSubmission } from '../scripts/lib/submit.mjs';
import { draftMessage, messageCard, reviseMessage, approveMessage, denyMessage, handoff, beginSend, recordSend, verifySend, sendWithIntegration } from '../scripts/lib/contact.mjs';

installPdfStub();
const schemas = loadCsvSchemas();
const T = (h, m = 0) => `2026-10-27T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;
const T0 = T(9), T1 = T(10), T2 = T(11), T3 = T(12), T4 = T(13);

const job = (id, status = 'shortlisted', over = {}) => ({
  job_id: id, status, company: 'Example Robotics Inc.', title: 'Software Engineering Intern', location: 'Springfield, XX', remote_type: 'hybrid', employment_type: 'internship',
  eligibility_text: 'Graduating 2027 or 2028', qualifications_text: 'Experience with Python is required. Familiarity with ROS is preferred.', source_name: 'Example Careers', source_kind: 'company_site',
  source_url: `https://careers.example.com/jobs/${id}`, apply_url: `https://careers.example.com/jobs/${id}/apply`, discovered_at: '2026-10-20T09:00:00Z', last_checked_at: '2026-10-26T09:00:00Z',
  last_verified_at: '2026-10-26T09:00:00Z', verification_notes: 'Opened posting; matches.', eligibility_check: 'pass', dedupe_key: `example robotics inc|${id}`, updated_at: '2026-10-26T09:00:00Z', ...over,
});

function makeDir(jobs = [job('job-0001')]) {
  const dir = mkdtempSync(join(tmpdir(), 'outbound-test-'));
  cpSync(join(repoRoot, 'templates/data'), dir, { recursive: true });
  cpSync(join(repoRoot, 'tests/fixtures/candidate-profile.json'), join(dir, 'candidate-profile.json'));
  writeFileSync(join(dir, 'jobs.csv'), serializeCsv(schemas['jobs.csv'].columns.map((c) => c.name), jobs));
  return dir;
}
const csv = (dir, name) => { const rows = parseCsv(readFileSync(join(dir, name), 'utf8')); return rows.slice(1).map((r) => Object.fromEntries(rows[0].map((h, i) => [h, r[i]]))); };
const app = (dir, id = 'app-0001') => csv(dir, 'applications.csv').find((a) => a.application_id === id);
const evt = (dir, id) => csv(dir, 'email-events.csv').find((e) => e.event_id === id);
const jobRow = (dir, id = 'job-0001') => csv(dir, 'jobs.csv').find((j) => j.job_id === id);
const refused = (fn, re) => assert.throws(fn, (e) => e instanceof RefusedError && (!re || re.test(e.message)), `expected a refusal${re ? ` matching ${re}` : ''}`);

const pkg = () => ({
  analysis: { requirements: [{ text: 'Experience with Python', level: 'essential', source_quote: 'Experience with Python is required', status: 'met', evidence: ['skills[0]'] }] },
  resume: { education: [{ ref: 'education[0]' }], experience: [{ ref: 'experience[0]', bullets: [{ text: 'Resolved walk-in and email support requests for students and staff.', source: 'experience[0].highlights[0]' }] }], skills: ['Python'] },
  cover_letter: { paragraphs: ['I am applying for the Software Engineering Intern role at Example Robotics Inc. because I have used Python in a course project.'], uses: ['projects[0]'] },
  answers: [
    { question: 'Why do you want to work here?', kind: 'general', answer: 'I want to work on robotics software and have used Python in a course project.', source: 'projects[0]' },
    { question: 'Are you authorized to work in XX?', kind: 'eligibility', answer: 'Yes, I am a citizen.', source: 'user:auth' },
  ],
});

/** A prepared, ready_for_review application for job-0001. */
function ready(dir, jobId = 'job-0001') {
  const s = startApplication(dir, jobId, { now: T0 });
  addInput(dir, s.application_id, 'auth', 'Yes, I am a citizen.', 'Yes, I am a citizen of XX.', { now: T0 });
  const r = prepare(dir, s.application_id, pkg(), { now: T0 });
  assert.equal(r.status, 'ready_for_review');
  return s.application_id;
}
const approved = (dir, id, now = T1) => {
  const card = submissionCard(dir, id, { now });
  assert.equal(card.ready_for_approval, true, card.blockers.join('; '));
  approveSubmission(dir, id, { note: 'Yes, submit this one.', packageHash: card.package_hash }, { now });
  return card;
};
const withBrowser = (dir, now = T1) => setIntegration(dir, 'browser', 'verified', 'opened the form page and read its fields (mock)', now);

/** A mock form-submission integration. calls counts how often it would have submitted. */
const mockSubmitter = (outcome) => { const m = { name: 'browser', calls: 0, submit: async (payload) => { m.calls += 1; m.payload = payload; if (outcome instanceof Error) throw outcome; return outcome; } }; return m; };
const CONFIRMED = { status: 'confirmed', evidence: 'Page text: "Thank you, your application has been received" (reference FAB-12345)', evidence_kind: 'confirmation_page' };

// ================================================================ APPLICATION SUBMISSION

test('submit: the card shows employer, role, destination, documents, declarations and a hash; an unprepared package is not ready', () => {
  const dir = makeDir();
  const s = startApplication(dir, 'job-0001', { now: T0 });
  const early = submissionCard(dir, s.application_id, { now: T1 });
  assert.equal(early.ready_for_approval, false);
  assert.match(early.blockers.join(' '), /still drafting|not been prepared/);
  refused(() => approveSubmission(dir, s.application_id, { note: 'yes', packageHash: early.package_hash }, { now: T1 }), /cannot approve/);

  const dir2 = makeDir();
  const id = ready(dir2);
  const card = submissionCard(dir2, id, { now: T1 });
  assert.equal(card.ready_for_approval, true);
  assert.equal(card.employer, 'Example Robotics Inc.');
  assert.equal(card.role, 'Software Engineering Intern');
  assert.equal(card.destination_url, 'https://careers.example.com/jobs/job-0001/apply');
  for (const f of ['resume.md', 'cover-letter.md', 'answers.md']) assert.ok(card.documents[f].length > 50, f);
  assert.match(card.documents['review.md'], /\[eligibility\] Are you authorized to work in XX\? -> Yes, I am a citizen\./);
  assert.match(card.package_hash, /^[0-9a-f]{64}$/);
});

test('submit: approval denial: no words, a wrong hash, or a denial blocks everything; nothing is attempted', () => {
  const dir = makeDir();
  const id = ready(dir);
  const card = submissionCard(dir, id, { now: T1 });
  refused(() => approveSubmission(dir, id, { note: '', packageHash: card.package_hash }, { now: T1 }), /approval words/);
  refused(() => approveSubmission(dir, id, { note: 'yes', packageHash: 'f'.repeat(64) }, { now: T1 }), /package_hash does not match/);
  assert.equal(app(dir, id).status, 'ready_for_review');

  refused(() => beginSubmission(dir, id, {}, { now: T1 }), /not approved/);
  const d = denySubmission(dir, id, 'No, not this one yet.', { now: T1 });
  assert.equal(d.denied, true);
  assert.equal(app(dir, id).status, 'ready_for_review');
  assert.match(app(dir, id).next_action, /declined submission: No, not this one yet\./);
  refused(() => beginSubmission(dir, id, {}, { now: T2 }), /not approved/);
  assert.equal(app(dir, id).submitted_at, '');
  approved(dir, id, T2); // the user can change their mind: a fresh approval works
  assert.equal(app(dir, id).status, 'approved');
});

test('submit: unapproved, rejected and already-applied jobs cannot be approved', () => {
  for (const status of ['rejected', 'expired', 'verified', 'applied']) {
    const dir = makeDir([job('job-0001', 'shortlisted')]);
    const id = ready(dir);
    const rows = csv(dir, 'jobs.csv'); rows[0].status = status;
    writeFileSync(join(dir, 'jobs.csv'), serializeCsv(Object.keys(rows[0]), rows));
    const card = submissionCard(dir, id, { now: T1 });
    assert.equal(card.ready_for_approval, false, status);
    assert.match(card.blockers.join(' '), /not an approved \(shortlisted\) job/);
    refused(() => approveSubmission(dir, id, { note: 'yes', packageHash: card.package_hash ?? 'x' }, { now: T1 }), /cannot approve/);
  }
});

test('submit: unavailable integrations: not configured, stale, or the wrong kind. A hand-off is returned and nothing is logged as in flight', () => {
  const dir = makeDir();
  const id = ready(dir);
  approved(dir, id);
  const none = beginSubmission(dir, id, {}, { now: T1 });
  assert.equal(none.started, false);
  assert.match(none.reason, /browser is not configured/);
  assert.equal(none.handoff.destination, 'https://careers.example.com/jobs/job-0001/apply');
  assert.ok(none.handoff.files.resume.endsWith('resume.pdf'));
  assert.equal(app(dir, id).status, 'approved');

  setIntegration(dir, 'browser', 'verified', 'tested yesterday (mock)', '2026-10-26T01:00:00Z');
  const stale = beginSubmission(dir, id, {}, { now: T1 });
  assert.equal(stale.started, false);
  assert.match(stale.reason, /more than 12 hours ago/);

  setIntegration(dir, 'browser', 'unsupported_or_unverified', 'form is behind a login', T1);
  assert.equal(beginSubmission(dir, id, {}, { now: T1 }).started, false);
  refused(() => beginSubmission(dir, id, { integration: 'gmail-send' }, { now: T1 }), /cannot carry a portal submission/);

  const m = mockSubmitter(CONFIRMED);
  return runSubmission(dir, id, m, { now: T1 }).then((r) => { assert.equal(r.started, false); assert.equal(m.calls, 0, 'the integration must not be called'); assert.equal(app(dir, id).submitted_at, ''); });
});

test('submit: a confirmed submission is recorded with its time, method, evidence and the job becomes applied', async () => {
  const dir = makeDir();
  const id = ready(dir);
  approved(dir, id);
  withBrowser(dir);
  const m = mockSubmitter(CONFIRMED);
  const r = await runSubmission(dir, id, m, { now: T2 });
  assert.equal(m.calls, 1);
  assert.equal(m.payload.answers.length, 2);
  assert.equal(m.payload.declarations[0].kind, 'eligibility');
  assert.equal(r.status, 'submitted');
  const a = app(dir, id);
  assert.equal(a.status, 'submitted');
  assert.equal(a.submitted_at, T2);
  assert.equal(a.submission_method, 'portal');
  assert.equal(a.submission_result, 'success');
  assert.match(a.confirmation_evidence, /^\[confirmation_page\] Page text: "Thank you, your application has been received" \(reference FAB-12345\)/);
  assert.equal(a.approval_note, 'Yes, submit this one.');
  assert.equal(jobRow(dir).status, 'applied');
  assert.deepEqual(checkCsv('applications.csv', readFileSync(join(dir, 'applications.csv'), 'utf8'), schemas['applications.csv'], { 'jobs.csv': new Set(['job-0001']) }), []);
  assert.deepEqual(checkCsv('jobs.csv', readFileSync(join(dir, 'jobs.csv'), 'utf8'), schemas['jobs.csv']), []);
  assert.deepEqual(csv(dir, 'run-history.csv').map((x) => x.outcome).filter((o) => o !== 'completed'), []);
  assert.equal(JSON.parse(readFileSync(join(dir, 'sync-state.json'), 'utf8')).lock.holder, null);
});

test('submit: success is never claimed without specific, positive evidence', async () => {
  const dir = makeDir();
  const id = ready(dir);
  approved(dir, id);
  beginSubmission(dir, id, { method: 'manual_by_user' }, { now: T2 }); // opens an attempt without any integration
  refused(() => recordSubmission(dir, id, { result: 'success', evidence: 'done', evidenceKind: 'confirmation_page' }, { now: T2 }), /specific evidence/);
  refused(() => recordSubmission(dir, id, { result: 'success', evidence: 'The page showed: please complete the CAPTCHA to continue', evidenceKind: 'confirmation_page' }, { now: T2 }), /mentions a problem/);
  refused(() => recordSubmission(dir, id, { result: 'success', evidence: 'The page said everything went well, reference 123', evidenceKind: 'guess' }, { now: T2 }), /evidence-kind/);
  refused(() => recordSubmission(dir, id, { result: 'success', evidence: 'The user says it worked and the page was fine', evidenceKind: 'confirmation_page' }, { now: T2 }), /confirmation text they pasted/);
  assert.equal(app(dir, id).status, 'approved');
  assert.equal(app(dir, id).submitted_at, '');
  assert.equal(recordSubmission(dir, id, { result: 'success', evidence: 'User pasted: "Application received. Reference ABC-777"', evidenceKind: 'user_pasted_confirmation' }, { now: T3 }).status, 'submitted');

  // an integration that claims success with weak evidence is downgraded to unconfirmed
  const dir2 = makeDir();
  const id2 = ready(dir2);
  approved(dir2, id2);
  withBrowser(dir2);
  const r = await runSubmission(dir2, id2, mockSubmitter({ status: 'confirmed', evidence: 'success', evidence_kind: 'confirmation_page' }), { now: T2 });
  assert.equal(r.status, 'submission_unconfirmed');
  assert.equal(jobRow(dir2).status, 'shortlisted');
});

test('submit: a failed submission (CAPTCHA) is recorded as failed, hands the step to the user, and a retry needs a fresh approval', async () => {
  const dir = makeDir();
  const id = ready(dir);
  approved(dir, id);
  withBrowser(dir);
  const r = await runSubmission(dir, id, mockSubmitter({ status: 'failed', error: 'CAPTCHA challenge appeared; stopped without attempting it', blocked: 'captcha' }), { now: T2 });
  assert.equal(r.status, 'submission_failed');
  const a = app(dir, id);
  assert.equal(a.submission_result, 'failed');
  assert.equal(a.submitted_at, '');
  assert.match(a.next_action, /Blocked by captcha: the user completes this step/);
  assert.match(a.confirmation_evidence, /CAPTCHA challenge appeared/);
  assert.equal(jobRow(dir).status, 'shortlisted');

  refused(() => beginSubmission(dir, id, {}, { now: T3 }), /not approved/);
  const card = submissionCard(dir, id, { now: T3 });
  assert.equal(card.ready_for_approval, true);
  approveSubmission(dir, id, { note: 'Yes, retry it.', packageHash: card.package_hash }, { now: T3 });
  assert.equal(app(dir, id).status, 'approved');
  assert.equal(app(dir, id).submission_result, '');
});

test('submit: an ambiguous outcome (unclear or thrown) is unconfirmed and blocks any retry until verified', async () => {
  for (const outcome of [{ status: 'ambiguous', note: 'the page reloaded with no message' }, new Error('network dropped after the click')]) {
    const dir = makeDir();
    const id = ready(dir);
    approved(dir, id);
    withBrowser(dir);
    const m = mockSubmitter(outcome);
    const r = await runSubmission(dir, id, m, { now: T2 });
    assert.equal(r.status, 'submission_unconfirmed');
    assert.match(r.warning, /Do NOT retry/);
    assert.equal(m.calls, 1);
    assert.equal(app(dir, id).submitted_at, '');
    assert.equal(jobRow(dir).status, 'shortlisted');

    assert.equal(submissionCard(dir, id, { now: T3 }).ready_for_approval, false);
    refused(() => approveSubmission(dir, id, { note: 'yes', packageHash: 'x' }, { now: T3 }), /unconfirmed submission/);
    refused(() => beginSubmission(dir, id, {}, { now: T3 }), /not approved|unconfirmed/);
    const m2 = mockSubmitter(CONFIRMED);
    await runSubmission(dir, id, m2, { now: T3 }).then(() => assert.fail('must not run'), (e) => assert.ok(e instanceof RefusedError));
    assert.equal(m2.calls, 0, 'no second submission may be made while the first is unverified');

    refused(() => verifySubmission(dir, id, { result: 'success', evidence: 'looks fine' }, { now: T3 }), /specific evidence|evidence-kind/);
    const v = verifySubmission(dir, id, { result: 'success', evidence: 'Confirmation email in the inbox: "We received your application" (subject: Application received)', evidenceKind: 'confirmation_email' }, { now: T4 });
    assert.equal(v.status, 'submitted');
    assert.equal(jobRow(dir).status, 'applied');
  }
  const dir = makeDir();
  const id = ready(dir);
  approved(dir, id);
  withBrowser(dir);
  await runSubmission(dir, id, mockSubmitter({ status: 'ambiguous', note: 'unclear' }), { now: T2 });
  assert.equal(verifySubmission(dir, id, { result: 'failed', evidence: 'Checked the portal and the inbox: no application is listed' }, { now: T3 }).status, 'submission_failed');
});

test('submit: duplicate submissions are prevented: already submitted, repeated begin, and an attempt left without a result', async () => {
  const dir = makeDir();
  const id = ready(dir);
  approved(dir, id);
  withBrowser(dir);
  const first = beginSubmission(dir, id, {}, { now: T2 });
  assert.equal(first.started, true);
  refused(() => beginSubmission(dir, id, {}, { now: T2 }), /no recorded result/); // crash or double click: the first attempt is still open
  assert.match(submissionCard(dir, id, { now: T2 }).blockers.join(' '), /no recorded result/);
  recordSubmission(dir, id, { result: 'success', evidence: 'Confirmation page: "Application received", reference Q-1', evidenceKind: 'confirmation_page' }, { now: T2 });

  const m = mockSubmitter(CONFIRMED);
  for (const attempt of [() => beginSubmission(dir, id, {}, { now: T3 }), () => approveSubmission(dir, id, { note: 'again', packageHash: 'x' }, { now: T3 }), () => runSubmission(dir, id, m, { now: T3 })]) {
    await Promise.resolve().then(attempt).then(() => assert.fail('a second submission must be refused'), (e) => assert.ok(e instanceof RefusedError, e.message));
  }
  assert.equal(m.calls, 0);
  assert.equal(app(dir, id).submitted_at, T2);
  refused(() => recordSubmission(dir, id, { result: 'success', evidence: 'Confirmation page: "Application received", reference Q-2', evidenceKind: 'confirmation_page' }, { now: T3 }), /no attempt is in flight/);
});

test('submit: editing the package after approval voids the approval and nothing is submitted', async () => {
  const dir = makeDir();
  const id = ready(dir);
  approved(dir, id);
  withBrowser(dir);
  appendFileSync(join(dir, 'tailored', id, 'v1', 'cover-letter.md'), '\nP.S. one more thing.\n');
  const m = mockSubmitter(CONFIRMED);
  const r = await runSubmission(dir, id, m, { now: T2 });
  assert.equal(r.started, false);
  assert.equal(r.voided, true);
  assert.equal(m.calls, 0);
  const a = app(dir, id);
  assert.equal(a.status, 'drafting');
  assert.equal(a.approved_at, '');
  assert.equal(a.approval_note, '');
  assert.match(a.notes, /approval void/);
});

test('submit: a required field that needs the user stops the submission before it is made', () => {
  const dir = makeDir();
  const id = ready(dir);
  approved(dir, id);
  withBrowser(dir);
  assert.equal(beginSubmission(dir, id, {}, { now: T2 }).started, true);
  refused(() => needsInput(dir, id, '', { now: T2 }), /which field/);
  const r = needsInput(dir, id, 'Do you have a criminal record? (required declaration)', { now: T2 });
  assert.equal(r.submitted, false);
  const a = app(dir, id);
  assert.equal(a.status, 'drafting');
  assert.equal(a.approved_at, '');
  assert.match(a.next_action, /Ask the user: Do you have a criminal record/);
  refused(() => beginSubmission(dir, id, {}, { now: T3 }), /still drafting|not approved/);
});

test('submit: the user submitting by hand is handed the package; only their pasted confirmation counts', () => {
  const dir = makeDir();
  const id = ready(dir);
  approved(dir, id);
  const b = beginSubmission(dir, id, { method: 'manual_by_user' }, { now: T2 });
  assert.equal(b.manual, true);
  assert.equal(b.handoff.destination, 'https://careers.example.com/jobs/job-0001/apply');
  assert.equal(recordSubmission(dir, id, { result: 'unconfirmed', evidence: 'The user says they submitted it but pasted nothing' }, { now: T3 }).status, 'submission_unconfirmed');
  assert.equal(app(dir, id).submission_method, 'manual_by_user');
});

// ================================================================ RECRUITER OUTREACH

const BODY = 'Hello Pat, I applied for the Software Engineering Intern role at Example Robotics Inc. and have used Python in a course project. Could you tell me when interviews begin?';
const draft = (dir, id, over = {}, now = T1) => draftMessage(dir, id, { platform: 'gmail', to: 'pat.recruiter@example.com', name: 'Pat', subject: 'Question about the Software Engineering Intern role', body: BODY, contactSourceUrl: 'https://careers.example.com/contact', ...over }, { now });
const approveMsg = (dir, eid, now = T2) => { const c = messageCard(dir, eid, { now }); approveMessage(dir, eid, { note: 'Yes, send it.', contentHash: c.content_hash }, { now }); return c; };
const withGmail = (dir, now = T1) => setIntegration(dir, 'gmail-send', 'verified', 'listed the mailbox labels through the connector (mock)', now);
const mockMailer = (outcome) => { const m = { name: 'gmail-send', calls: 0, send: async (payload) => { m.calls += 1; m.payload = payload; if (outcome instanceof Error) throw outcome; return outcome; } }; return m; };
const SENT = { ok: true, message_id: 'msg-mock-001', thread_id: 'thr-mock-001', evidence: 'Gmail API returned id msg-mock-001 and the message is in Sent (mock response)' };

test('outreach: contacts must be sourced or given by the user; addresses are never guessed', () => {
  const dir = makeDir();
  const id = ready(dir);
  refused(() => draft(dir, id, { contactSourceUrl: undefined }), /neither is not used|contact_source_url/);
  refused(() => draft(dir, id, { to: 'not-an-email' }), /valid email/);
  refused(() => draft(dir, id, { subject: '' }), /subject is required/);
  refused(() => draft(dir, id, { platform: 'linkedin', to: 'https://www.linkedin.com/in/pat-recruiter', contactSourceUrl: 'https://www.linkedin.com/in/pat-recruiter' }), /must come from the user/);
  refused(() => draft(dir, id, { platform: 'linkedin', to: 'pat', userProvided: true, contactSourceUrl: undefined }), /profile URL/);
  assert.equal(csv(dir, 'email-events.csv').length, 0);
  assert.equal(draft(dir, id, { contactSourceUrl: undefined, userProvided: true }).status, 'draft');
  const row = evt(dir, 'eml-0001');
  assert.equal(row.contact_source_url, '');
  assert.match(row.summary, /Contact given by the user/);
});

test('outreach: the text may use only confirmed facts, the posting and the user\'s input', () => {
  const dir = makeDir();
  const id = ready(dir);
  refused(() => draft(dir, id, { body: `${BODY} I also won the Regional Robotics Cup.` }), /unsupported term "Regional"|unsupported/);
  refused(() => draft(dir, id, { body: `${BODY} I have 3 years of experience.` }), /unsupported number "3"/);
  refused(() => draft(dir, id, { body: 'x'.repeat(1600) }), /under 1500/);
  assert.equal(csv(dir, 'email-events.csv').length, 0);
  assert.equal(draft(dir, id).sent, false);
});

test('outreach: limits: one contact per application, two per company, no second first-message to the same contact', () => {
  const dir = makeDir([job('job-0001'), job('job-0002', 'shortlisted', { title: 'Data Science Intern' }), job('job-0003', 'shortlisted', { title: 'Research Intern' })]);
  const a1 = ready(dir);
  draft(dir, a1);
  refused(() => draft(dir, a1), /already has a draft message/);
  refused(() => draft(dir, a1, { to: 'other.person@example.com' }), /limit 1 per application/);
  const a2 = startApplication(dir, 'job-0002', { now: T0 }).application_id;
  draft(dir, a2, { to: 'second.contact@example.com', subject: 'Question about the Data Science Intern role', body: BODY.replace('Software Engineering Intern', 'Data Science Intern') });
  const a3 = startApplication(dir, 'job-0003', { now: T0 }).application_id;
  refused(() => draft(dir, a3, { to: 'third.contact@example.com', subject: 'Question about the Research Intern role', body: BODY.replace('Software Engineering Intern', 'Research Intern') }), /per-company limit/);
});

test('outreach: the card shows recipient, platform, subject, the full text and a hash; routing depends on a verified integration', () => {
  const dir = makeDir();
  const id = ready(dir);
  const { event_id: eid, route } = draft(dir, id);
  assert.equal(route.mode, 'copy_ready');
  assert.match(route.why, /gmail-send is not configured/);
  const card = messageCard(dir, eid, { now: T1 });
  assert.equal(card.to, 'pat.recruiter@example.com');
  assert.equal(card.platform, 'gmail');
  assert.equal(card.subject, 'Question about the Software Engineering Intern role');
  assert.equal(card.full_text, BODY);
  assert.equal(card.employer, 'Example Robotics Inc.');
  assert.match(card.content_hash, /^[0-9a-f]{64}$/);
  withGmail(dir);
  assert.equal(messageCard(dir, eid, { now: T2 }).route.mode, 'send');
  assert.deepEqual(checkCsv('email-events.csv', readFileSync(join(dir, 'email-events.csv'), 'utf8'), schemas['email-events.csv'], { 'applications.csv': new Set([id]) }), []);
});

test('outreach: approval denial: no words, a stale hash or a denial keeps the message unsent', async () => {
  const dir = makeDir();
  const id = ready(dir);
  const { event_id: eid } = draft(dir, id);
  withGmail(dir);
  const c = messageCard(dir, eid, { now: T2 });
  refused(() => approveMessage(dir, eid, { note: '', contentHash: c.content_hash }, { now: T2 }), /approval words/);
  refused(() => approveMessage(dir, eid, { note: 'yes, send it', contentHash: '0'.repeat(64) }, { now: T2 }), /content_hash does not match/);
  refused(() => beginSend(dir, eid, { now: T2 }), /not approved/);
  const m = mockMailer(SENT);
  await sendWithIntegration(dir, eid, m, { now: T2 }).then(() => assert.fail('must refuse'), (e) => assert.ok(e instanceof RefusedError));
  assert.equal(m.calls, 0);

  assert.equal(denyMessage(dir, eid, 'No, do not contact them.', { now: T2 }).status, 'discarded');
  assert.equal(evt(dir, eid).status, 'discarded');
  refused(() => approveMessage(dir, eid, { note: 'yes, send it', contentHash: c.content_hash }, { now: T3 }), /only a draft/);
});

test('outreach: a successful send through a mocked Gmail connector is recorded with its message id; it is never sent twice', async () => {
  const dir = makeDir();
  const id = ready(dir);
  const { event_id: eid } = draft(dir, id);
  withGmail(dir);
  approveMsg(dir, eid);
  const m = mockMailer(SENT);
  const r = await sendWithIntegration(dir, eid, m, { now: T3 });
  assert.equal(m.calls, 1);
  assert.deepEqual(m.payload, { to: 'pat.recruiter@example.com', subject: 'Question about the Software Engineering Intern role', body: BODY });
  assert.equal(r.sent, true);
  const e = evt(dir, eid);
  assert.equal(e.status, 'sent');
  assert.equal(e.provider_message_id, 'msg-mock-001');
  assert.equal(e.thread_id, 'thr-mock-001');
  assert.equal(e.occurred_at, T3);
  assert.equal(e.provider, 'gmail');
  assert.equal(e.approved_at, T2);
  assert.equal(app(dir, id).status, 'ready_for_review', 'a message never changes the application status');
  assert.deepEqual(checkCsv('email-events.csv', readFileSync(join(dir, 'email-events.csv'), 'utf8'), schemas['email-events.csv'], { 'applications.csv': new Set([id]) }), []);

  const m2 = mockMailer(SENT);
  await sendWithIntegration(dir, eid, m2, { now: T4 }).then(() => assert.fail('must refuse'), (e2) => assert.match(e2.message, /already sent/));
  assert.equal(m2.calls, 0);
  refused(() => recordSend(dir, eid, { result: 'sent', evidence: 'Gmail API returned id msg-mock-002 in Sent', messageId: 'msg-mock-002' }, { now: T4 }), /no send is in flight/);
});

test('outreach: a failed send is recorded as failed and sending again needs a fresh approval', async () => {
  const dir = makeDir();
  const id = ready(dir);
  const { event_id: eid } = draft(dir, id);
  withGmail(dir);
  approveMsg(dir, eid);
  const r = await sendWithIntegration(dir, eid, mockMailer({ ok: false, error: 'Gmail API 403: insufficient permissions for send' }), { now: T3 });
  assert.equal(r.status, 'failed');
  assert.equal(r.sent, false);
  const e = evt(dir, eid);
  assert.equal(e.status, 'failed');
  assert.match(e.summary, /Send failed: Gmail API 403/);
  assert.equal(e.provider_message_id, '');
  refused(() => beginSend(dir, eid, { now: T3 }), /not approved/);
  approveMsg(dir, eid, T4);
  assert.equal(evt(dir, eid).status, 'approved');
});

test('outreach: an unclear or thrown send is unknown and blocks resending until verified', async () => {
  for (const outcome of [{ ambiguous: true, note: 'the connector timed out after accepting the request' }, new Error('socket closed'), { ok: true, message_id: '', evidence: 'ok' }]) {
    const dir = makeDir();
    const id = ready(dir);
    const { event_id: eid } = draft(dir, id);
    withGmail(dir);
    approveMsg(dir, eid);
    const r = await sendWithIntegration(dir, eid, mockMailer(outcome), { now: T3 });
    assert.equal(r.sent, false);
    assert.match(r.warning, /Do NOT resend/);
    const e = evt(dir, eid);
    assert.equal(e.status, 'approved');
    assert.match(e.action_required, /^\[send-unverified\]/);
    assert.equal(e.provider_message_id, '');
    const m2 = mockMailer(SENT);
    await sendWithIntegration(dir, eid, m2, { now: T4 }).then(() => assert.fail('must refuse'), (e2) => assert.match(e2.message, /unverified/));
    assert.equal(m2.calls, 0);

    refused(() => verifySend(dir, eid, { result: 'sent', evidence: 'I can see it in Sent in the mailbox view' }, { now: T4 }), /message id/);
    assert.equal(verifySend(dir, eid, { result: 'sent', evidence: 'Found in Sent: id msg-found-9, to pat.recruiter@example.com', messageId: 'msg-found-9' }, { now: T4 }).sent, true);
    assert.equal(evt(dir, eid).provider_message_id, 'msg-found-9');
  }
  const dir = makeDir();
  const id = ready(dir);
  const { event_id: eid } = draft(dir, id);
  withGmail(dir);
  approveMsg(dir, eid);
  await sendWithIntegration(dir, eid, mockMailer({ ambiguous: true, note: 'timeout' }), { now: T3 });
  assert.equal(verifySend(dir, eid, { result: 'not_sent', evidence: 'Checked Sent and Drafts: the message is not there' }, { now: T4 }).status, 'failed');
});

test('outreach: unavailable integrations: Gmail unconfigured gives a copy-ready draft and the destination; nothing is logged as sent', async () => {
  const dir = makeDir();
  const id = ready(dir);
  const { event_id: eid } = draft(dir, id);
  approveMsg(dir, eid);
  const m = mockMailer(SENT);
  const r = await sendWithIntegration(dir, eid, m, { now: T3 });
  assert.equal(r.started, false);
  assert.equal(m.calls, 0);
  assert.match(r.reason, /Cannot send: gmail-send is not configured/);
  assert.equal(r.handoff.copy_ready_text, BODY);
  assert.equal(r.handoff.destination, 'mailto:pat.recruiter@example.com');
  assert.equal(r.handoff.sent, false);
  assert.equal(evt(dir, eid).status, 'approved');
  assert.equal(evt(dir, eid).provider_message_id, '');
  assert.equal(handoff(dir, eid, { now: T3 }).copy_ready_text, BODY);
});

test('outreach: Gmail is never used for LinkedIn: the draft is copy-ready with the official destination, even with Gmail verified', async () => {
  const dir = makeDir();
  const id = ready(dir);
  withGmail(dir);
  setIntegration(dir, 'linkedin-send', 'verified', 'claimed in error (mock)', T1);
  const d = draft(dir, id, { platform: 'linkedin', to: 'https://www.linkedin.com/in/pat-recruiter', userProvided: true, contactSourceUrl: undefined, subject: '' });
  assert.equal(d.route.mode, 'copy_ready');
  assert.equal(d.route.destination, 'https://www.linkedin.com/in/pat-recruiter');
  assert.equal(evt(dir, d.event_id).provider, 'manual');
  approveMsg(dir, d.event_id);
  const m = mockMailer(SENT);
  const r = await sendWithIntegration(dir, d.event_id, m, { now: T3 });
  assert.equal(r.started, false);
  assert.equal(m.calls, 0, 'Gmail must not be asked to send a LinkedIn message');
  assert.match(r.reason, /never sent by this tool/);
  assert.match(r.handoff.note, /paste this yourself/);
  assert.equal(evt(dir, d.event_id).status, 'approved');
});

test('outreach: editing after approval voids it; revise returns a draft that needs approval again', async () => {
  const dir = makeDir();
  const id = ready(dir);
  const { event_id: eid } = draft(dir, id);
  withGmail(dir);
  approveMsg(dir, eid);
  appendFileSync(join(dir, 'drafts', `${eid}.md`), 'P.S. also call me\n');
  const m = mockMailer(SENT);
  const r = await sendWithIntegration(dir, eid, m, { now: T3 });
  assert.equal(r.voided, true);
  assert.equal(m.calls, 0);
  assert.equal(evt(dir, eid).status, 'draft');
  assert.equal(evt(dir, eid).approved_at, '');

  approveMsg(dir, eid, T3);
  const rev = reviseMessage(dir, eid, { body: `${BODY} Thank you.` }, { now: T3 });
  assert.equal(rev.approval_void, true);
  assert.equal(evt(dir, eid).status, 'draft');
  refused(() => reviseMessage(dir, eid, { body: `${BODY} I led a team of 50.` }, { now: T3 }), /unsupported/);
});

test('outreach: no mass messaging: the daily limit stops further approvals and sends', () => {
  const dir = makeDir();
  const id = ready(dir);
  const { event_id: eid } = draft(dir, id);
  const header = schemas['email-events.csv'].columns.map((c) => c.name);
  const rows = csv(dir, 'email-events.csv');
  for (let i = 0; i < 5; i++) rows.push({ ...Object.fromEntries(header.map((h) => [h, ''])), event_id: `eml-00${i + 2}`, application_id: id, job_id: 'job-0001', direction: 'outbound', kind: 'recruiter_outreach', status: 'sent', provider: 'gmail',
    contact_email: `p${i}@example.com`, approved_at: T0, occurred_at: T0, provider_message_id: `m${i}`, draft_path: `drafts/eml-00${i + 2}.md`, created_at: T0, updated_at: T0 });
  writeFileSync(join(dir, 'email-events.csv'), serializeCsv(header, rows));
  const c = messageCard(dir, eid, { now: T2 });
  assert.equal(c.sends_today, 5);
  refused(() => approveMessage(dir, eid, { note: 'yes', contentHash: c.content_hash }, { now: T2 }), /does not mass-message/);
});

test('safety: neither skill writes personal data outside the data directory, and no real send or submit helper exists', () => {
  for (const d of ['tailored', 'drafts']) assert.equal(existsSync(join(repoRoot, d)), false, `${d}/ must not exist in the repository root`);
  const src = ['scripts/lib/submit.mjs', 'scripts/lib/contact.mjs', 'scripts/lib/outbound.mjs'].map((f) => readFileSync(join(repoRoot, f), 'utf8')).join('\n');
  assert.doesNotMatch(src, /\bfetch\(|child_process|nodemailer|smtp|googleapis|puppeteer|playwright/i, 'the helpers must not perform network or browser actions themselves');
});
