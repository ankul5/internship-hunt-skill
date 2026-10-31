// End-to-end simulation of the whole workflow with fictional data and mocked integrations.
// Run: node --test tests/e2e.test.mjs
// One job id is followed from search to follow-up. No request leaves the machine (global fetch is replaced by a
// function that fails the test), no real email is sent, no real form is submitted, and ./private is never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { installPdfStub } from './helpers/pdf-stub.mjs';
import { repoRoot, loadCsvSchemas, checkCsv } from '../scripts/lib/data.mjs';
import { parseCsv } from '../scripts/lib/csv.mjs';
import { ingest, RefusedError } from '../scripts/lib/ingest.mjs';
import { approveJob, startApplication, setDescription, addInput, prepare, review } from '../scripts/lib/apply.mjs';
import { setIntegration } from '../scripts/lib/outbound.mjs';
import { submissionCard, approveSubmission, denySubmission, runSubmission } from '../scripts/lib/submit.mjs';
import { draftMessage, messageCard, approveMessage, denyMessage, sendWithIntegration } from '../scripts/lib/contact.mjs';
import { checkGmailApi } from '../scripts/lib/updates.mjs';
import { followUpReport, setPrefs } from '../scripts/lib/followups.mjs';
import { jobStatus } from '../scripts/lib/status.mjs';
import { check as trackerCheck } from '../scripts/lib/tracker.mjs';
import { findSites, verifyJobs, rowsToVerify } from '../scripts/lib/careerwalk.mjs';

installPdfStub();
const schemas = loadCsvSchemas();
const realFetch = globalThis.fetch;
const T = (d, h) => `2026-${d}T${String(h).padStart(2, '0')}:00:00Z`;
const LONG = 'You will build robotics software in Python with the platform team and ship features to real users. '.repeat(4);
const QUAL = 'Currently pursuing a degree in Computer Science. Experience with Python is required. Familiarity with ROS is preferred.';

const csv = (dir, name) => { const rows = parseCsv(readFileSync(join(dir, name), 'utf8')); return rows.slice(1).map((r) => Object.fromEntries(rows[0].map((h, i) => [h, r[i]]))); };
const node = (dir, script, ...a) => spawnSync(process.execPath, [join(repoRoot, 'scripts', script), ...a], { encoding: 'utf8', env: { ...process.env, INTERNSHIP_AGENT_HOME: dir } });
const json = (r) => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };

function fakeNet(routes) {
  const calls = [];
  return { calls, fetchImpl: async (url) => {
    calls.push(url);
    const hit = routes[url];
    if (hit === undefined || typeof hit === 'number') return new Response('', { status: hit ?? 404 });
    if (typeof hit === 'string') return new Response(hit, { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response(JSON.stringify(hit), { status: 200, headers: { 'content-type': 'application/json' } });
  } };
}

const NET = fakeNet({
  'https://robotics.example.com/': '<title>Example Robotics</title><a href="/careers">Careers</a>',
  'https://robotics.example.com/careers': '<title>Careers</title><script src="https://boards.greenhouse.io/embed/job_board/js?for=examplerobotics"></script>',
  'https://boards-api.greenhouse.io/v1/boards/examplerobotics/jobs?content=true': { jobs: [
    { title: 'Software Engineering Intern', absolute_url: 'https://job-boards.greenhouse.io/examplerobotics/jobs/501', location: { name: 'Springfield, XX' }, first_published: '2026-10-20T00:00:00Z', content: `&lt;p&gt;${LONG} ${QUAL}&lt;/p&gt;` },
    { title: 'Director of Engineering', absolute_url: 'https://job-boards.greenhouse.io/examplerobotics/jobs/502', content: 'x' },
  ] },
  'https://boards-api.greenhouse.io/v1/boards/northwind/jobs/77': { title: 'Backend Intern', location: { name: 'Remote' }, content: `&lt;p&gt;${LONG}&lt;/p&gt;` },
});
const deps = { fetchImpl: NET.fetchImpl, sleep: async () => {} };

function saveDraft(dir, label, r, now) {
  const b = join(dir, `${label}-bundle.json`), d = join(dir, `${label}-draft.json`), f = join(dir, `${label}-checked.json`);
  writeFileSync(b, JSON.stringify({ searches: r.searches, candidates: r.candidates }));
  writeFileSync(d, JSON.stringify({ run: { started_at: now, harness: 'claude-code' }, searches: r.searches, jobs: r.jobs }));
  node(dir, 'agent-reach-search.mjs', 'check', d, b, '--fix', f);
  return ingest(dir, JSON.parse(readFileSync(f, 'utf8')), { now, today: now.slice(0, 10) });
}

test('end to end: profile, search, verify, review, tailor, approve, submit, outreach, inbox, follow-up, recovery', async () => {
  globalThis.fetch = () => { throw new Error('the simulation tried to use the real network'); };
  try {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
    cpSync(join(repoRoot, 'templates/data'), dir, { recursive: true });

    // 1-3. Setup, resume processing, profile: only confirmed facts are saved; the gaps say what is still missing.
    writeFileSync(join(dir, 'sample-resume.txt'), 'Alex Example - fictional resume for testing');
    const att = json(node(dir, 'profile-store.mjs', 'attach-resume', join(dir, 'sample-resume.txt')));
    const p = JSON.parse(readFileSync(join(repoRoot, 'tests/fixtures/candidate-profile.json'), 'utf8'));
    p.skills.push({ name: 'Rust', provenance: 'inferred_unconfirmed' });
    p.resume.source_path = att.source_path;
    writeFileSync(join(dir, 'draft.json'), JSON.stringify(p));
    assert.equal(node(dir, 'profile-store.mjs', 'save', join(dir, 'draft.json')).status, 1, 'an unconfirmed skill is refused');
    p.skills = p.skills.filter((s) => s.provenance !== 'inferred_unconfirmed');
    for (const k of ['education', 'experience', 'projects', 'certifications']) p[k] = p[k].filter((e) => e.provenance !== 'inferred_unconfirmed');
    p.preferences.employment_types = ['Full-time internship']; p.provenance['preferences.employment_types'] = 'user_stated';
    writeFileSync(join(dir, 'draft.json'), JSON.stringify(p));
    assert.equal(json(node(dir, 'profile-store.mjs', 'save', join(dir, 'draft.json'))).readiness.ready, true);
    const gaps = json(node(dir, 'profile-store.mjs', 'gaps'));
    assert.ok(!gaps.stages.search.missing.some((m) => m.field === 'employment_types'), 'an answered card is not asked again');
    assert.ok(gaps.stages.outreach.missing.length > 0);

    // 4-8. Search: career page -> board -> internship only; a freehire-style record arrives unverified; scored and saved.
    const walk = await findSites(dir, [{ name: 'Example Robotics Inc.', site: 'robotics.example.com' }], {}, deps);
    assert.equal(walk.jobs.length, 1, 'the director role is not an internship');
    const s1 = saveDraft(dir, 'walk', walk, T('10-20', 9));
    assert.deepEqual(s1.decisions.map((d) => [d.job_id, d.status]), [['job-0001', 'verified']]);
    const agg = { run: { started_at: T('10-20', 9), harness: 'claude-code' }, searches: [{ key: 's1', source_name: 'freehire.me API', query: 'collections=yc', status: 'completed' }],
      jobs: [1, 2].map(() => ({ search_key: 's1', source_kind: 'job_board', company: 'Northwind Labs', title: 'Backend Intern', employment_type: 'internship', remote_type: 'remote',
        source_url: 'https://northwind.example.org/careers?gh_jid=77', apply_url: 'https://job-boards.greenhouse.io/northwind/jobs/77', opened_source: false })) };
    const s2 = ingest(dir, agg, { now: T('10-20', 9), today: '2026-10-20' });
    assert.equal(s2.stats.duplicates_in_batch, 1);
    const job1 = csv(dir, 'jobs.csv').find((j) => j.job_id === 'job-0001');
    assert.match(job1.fit_rationale, /Rubric v1/);
    assert.ok(job1.fit_score !== '');

    // 10 (repeated runs). The same search again creates no new rows.
    const again = saveDraft(dir, 'walk2', await findSites(dir, [{ name: 'Example Robotics Inc.', site: 'robotics.example.com' }], {}, deps), T('10-21', 9));
    assert.equal(again.stats.new, 0);
    assert.equal(csv(dir, 'jobs.csv').length, 2);

    // 6. Verification of the aggregator record through the board API, then human review.
    const v = await verifyJobs(rowsToVerify(dir, ['job-0002']).rows, { ...deps, now: T('10-21', 10) });
    assert.equal(v.results[0].outcome, 'verified');
    saveDraft(dir, 'verify', v, T('10-21', 10));
    assert.equal(csv(dir, 'jobs.csv').find((j) => j.job_id === 'job-0002').status, 'verified');

    // 9. Human job review: nothing proceeds without the user's words; unapproved jobs cannot be prepared.
    assert.throws(() => approveJob(dir, 'job-0001', '', { now: T('10-21', 11) }), RefusedError);
    assert.throws(() => startApplication(dir, 'job-0002', { now: T('10-21', 11) }), RefusedError, 'a verified but unapproved job cannot be prepared');
    approveJob(dir, 'job-0001', 'User: yes, apply to the Example Robotics internship', { now: T('10-21', 11) });

    // 10-11. Tailoring: resume, cover letter and answers from confirmed facts only; invented claims are refused.
    const { application_id: app } = startApplication(dir, 'job-0001', { now: T('10-21', 12) });
    writeFileSync(join(dir, 'desc.txt'), `${LONG}\n${QUAL}`);
    setDescription(dir, app, join(dir, 'desc.txt'), { origin: 'fetched', url: 'https://job-boards.greenhouse.io/examplerobotics/jobs/501', now: T('10-21', 12) });
    addInput(dir, app, 'auth', 'Yes, I am a citizen.', 'Yes, I am a citizen of XX.', { now: T('10-21', 12) });
    const pkg = {
      analysis: { requirements: [{ text: 'Experience with Python', level: 'essential', source_quote: 'Experience with Python is required', status: 'met', evidence: ['skills[0]'] }] },
      resume: { education: [{ ref: 'education[0]' }], experience: [{ ref: 'experience[0]', bullets: [{ text: 'Resolved walk-in and email support requests for students and staff.', source: 'experience[0].highlights[0]' }] }], skills: ['Python'] },
      cover_letter: { paragraphs: ['I am applying for the Software Engineering Intern role at Example Robotics Inc. because I have used Python in a course project.'], uses: ['projects[0]'] },
      answers: [{ question: 'Why do you want to work here?', kind: 'general', answer: 'I want to work on robotics software and have used Python in a course project.', source: 'projects[0]' },
        { question: 'Are you authorized to work in XX?', kind: 'eligibility', answer: 'Yes, I am a citizen.', source: 'user:auth' }],
    };
    const bad = structuredClone(pkg);
    bad.cover_letter.paragraphs[0] += ' I led a team of 12 engineers at Google.';
    assert.throws(() => prepare(dir, app, bad, { now: T('10-21', 13) }), /unsupported/);
    assert.equal(prepare(dir, app, pkg, { now: T('10-21', 13) }).status, 'ready_for_review');
    const files = readdirSync(join(dir, 'tailored', app, 'v1'));
    for (const f of ['resume.md', 'resume.pdf', 'cover-letter.md', 'cover-letter.pdf', 'answers.md', 'review.md']) assert.ok(files.includes(f), f);
    assert.ok(review(dir, app));

    // 12-13. Approval-gated submission: a denial blocks it; the approved package goes to a mock browser once.
    const card = submissionCard(dir, app, { now: T('10-22', 9) });
    assert.equal(card.ready_for_approval, true, card.blockers?.join('; '));
    const mock = { name: 'browser', calls: 0, submit: async () => { mock.calls += 1; return { status: 'confirmed', evidence: 'Page text: "Thank you, your application has been received" (reference EX-1)', evidence_kind: 'confirmation_page' }; } };
    setIntegration(dir, 'browser', 'verified', 'mock browser for the simulation', T('10-22', 9));
    denySubmission(dir, app, 'User: not yet', { now: T('10-22', 9) });
    await assert.rejects(runSubmission(dir, app, mock, { now: T('10-22', 10) }));
    assert.equal(mock.calls, 0, 'a denied package is never submitted');
    const card2 = submissionCard(dir, app, { now: T('10-22', 11) });
    approveSubmission(dir, app, { note: 'User: yes, submit it now', packageHash: card2.package_hash }, { now: T('10-22', 11) });
    assert.equal((await runSubmission(dir, app, mock, { now: T('10-22', 12) })).status, 'submitted');
    assert.equal(mock.calls, 1);
    assert.equal(csv(dir, 'jobs.csv').find((j) => j.job_id === 'job-0001').status, 'applied');

    // Approval-gated outreach: a denied draft is not sent; the approved one goes to a mock Gmail once.
    const mailer = { name: 'gmail-send', calls: 0, send: async () => { mailer.calls += 1; return { ok: true, message_id: 'gm-sim-1', thread_id: 'th-sim-1', evidence: 'mock Gmail returned id gm-sim-1' }; } };
    setIntegration(dir, 'gmail-send', 'verified', 'mock Gmail for the simulation', T('10-22', 13));
    const msg = { platform: 'gmail', to: 'pat.recruiter@robotics.example.com', name: 'Pat', subject: 'Software Engineering Intern application', contactSourceUrl: 'https://robotics.example.com/careers',
      body: 'Hello Pat, I applied for the Software Engineering Intern role at Example Robotics Inc. and have used Python in a course project. Could you tell me when interviews begin?' };
    const d1 = draftMessage(dir, app, msg, { now: T('10-22', 13) });
    denyMessage(dir, d1.event_id, 'User: do not send this', { now: T('10-22', 13) });
    await assert.rejects(sendWithIntegration(dir, d1.event_id, mailer, { now: T('10-22', 14) }));
    assert.equal(mailer.calls, 0);
    const d2 = draftMessage(dir, app, { ...msg, subject: 'Question about the Software Engineering Intern role' }, { now: T('10-22', 14) });
    const mc = messageCard(dir, d2.event_id, { now: T('10-22', 14) });
    assert.throws(() => approveMessage(dir, d2.event_id, { note: 'yes', contentHash: 'stale' }, { now: T('10-22', 14) }), RefusedError);
    approveMessage(dir, d2.event_id, { note: 'User: yes, send it', contentHash: mc.content_hash }, { now: T('10-22', 14) });
    assert.equal((await sendWithIntegration(dir, d2.event_id, mailer, { now: T('10-22', 15) })).sent, true);
    assert.equal(mailer.calls, 1);

    // 14. Email update checking through a fake Gmail client: an interview invite moves the application; a repeat adds nothing.
    setIntegration(dir, 'gmail-read', 'verified', 'mock Gmail read for the simulation', T('10-25', 9));
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
    const inbox = [{ id: 'in-1', at: '2026-10-24T08:00:00Z', from: 'Example Robotics Recruiting <recruiting@robotics.example.com>', subject: 'Interview invitation: Software Engineering Intern', body: 'We would like to schedule an interview. Please share your availability.' }];
    const client = { async listMessages({ query }) { const a = Number(/after:(\d+)/.exec(query)[1]), b = Number(/before:(\d+)/.exec(query)[1]); return { ids: inbox.filter((m) => Date.parse(m.at) / 1000 >= a && Date.parse(m.at) / 1000 < b).map((m) => m.id), next: null }; },
      async getMessage(id) { const m = inbox.find((x) => x.id === id); return { id, threadId: 'th-in-1', internalDate: String(Date.parse(m.at)), snippet: m.body, payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }], body: { data: b64(m.body) } } }; } };
    const c1 = await checkGmailApi(dir, client, { since: '7d', now: T('10-25', 10) });
    assert.equal(c1.recorded.length, 1);
    assert.equal(csv(dir, 'applications.csv').find((a) => a.application_id === app).status, 'interview');
    const c2 = await checkGmailApi(dir, client, { since: '7d', now: T('10-25', 11) });
    assert.equal(c2.recorded.length, 0);

    // 15. Follow-up preparation: timing needs confirmation; a reply means no follow-up is due.
    setPrefs(dir, { afterDays: 7, note: 'User: 7 days is fine' }, { now: T('10-25', 12) });
    const fu = followUpReport(dir, { now: T('11-02', 9) });
    assert.equal(fu.due.length, 0);
    assert.match(fu.not_applicable.find((x) => x.application_id === app).reason, /reply arrived/, 'the recruiter replied, so no follow-up is due');

    // Status and tracker: the same job id runs through every file; the tracker is consistent.
    const st = jobStatus(dir, { now: T('11-02', 9) });
    assert.ok(JSON.stringify(st).includes('interview'));
    const tc = trackerCheck(dir, { now: T('11-02', 9) });
    assert.deepEqual(tc.issues.filter((i) => i.severity === 'error'), []);
    const appRow = csv(dir, 'applications.csv').find((a) => a.application_id === app);
    assert.equal(appRow.job_id, 'job-0001');
    assert.ok(csv(dir, 'email-events.csv').every((e) => !e.job_id || e.job_id === 'job-0001'));
    const ids = (f, k) => new Set(csv(dir, f).map((r) => r[k]));
    for (const f of ['jobs.csv', 'applications.csv', 'email-events.csv', 'search-history.csv', 'run-history.csv']) {
      assert.deepEqual(checkCsv(f, readFileSync(join(dir, f), 'utf8'), schemas[f], { 'jobs.csv': ids('jobs.csv', 'job_id'), 'applications.csv': ids('applications.csv', 'application_id'), 'search-history.csv': ids('search-history.csv', 'search_id'), 'run-history.csv': ids('run-history.csv', 'run_id') }), [], f);
    }

    // 16. Recovery: a malformed CSV row stops the next run before anything is written; existing data is kept.
    const before = readFileSync(join(dir, 'jobs.csv'), 'utf8');
    appendFileSync(join(dir, 'jobs.csv'), 'job-0099,not,enough,cells\n');
    assert.throws(() => saveDraft(dir, 'walk3', walk, T('11-03', 9)), /validation failed|cells|header/);
    assert.equal(readFileSync(join(dir, 'jobs.csv'), 'utf8').startsWith(before), true, 'nothing was overwritten');
    assert.ok(trackerCheck(dir, { now: T('11-03', 9) }).issues.length > 0, 'the tracker check reports the bad row');
    writeFileSync(join(dir, 'jobs.csv'), before);
    assert.equal(JSON.parse(readFileSync(join(dir, 'sync-state.json'), 'utf8')).lock.holder, null, 'no lock is left behind');
    assert.ok(!NET.calls.some((u) => !/example\.(com|org)|greenhouse/.test(u)), 'only fictional hosts were addressed');
  } finally {
    globalThis.fetch = realFetch;
  }
});
