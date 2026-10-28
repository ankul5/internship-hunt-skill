// Tests for the apply helper. Run: node --test tests/apply.test.mjs
// Uses only fictional data and a throwaway data directory; never touches ./private.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { installPdfStub } from './helpers/pdf-stub.mjs';
import { repoRoot, loadCsvSchemas, checkCsv } from '../scripts/lib/data.mjs';
import { parseCsv, serializeCsv } from '../scripts/lib/csv.mjs';
import { RefusedError } from '../scripts/lib/ingest.mjs';
import { startApplication, approveJob, setDescription, addInput, prepare, review, listApprovable, unsupportedClaims } from '../scripts/lib/apply.mjs';

installPdfStub();
const schemas = loadCsvSchemas();
const T0 = '2026-10-27T10:00:00Z', T1 = '2026-10-27T11:00:00Z', T2 = '2026-10-27T12:00:00Z';

const QUAL = 'Currently pursuing a degree in Computer Science. Experience with Python is required. Familiarity with ROS is preferred.';
const baseJob = (id, status, over = {}) => ({
  job_id: id, status, company: 'Example Robotics Inc.', title: `Software Engineering Intern ${id}`, location: 'Springfield, XX', remote_type: 'hybrid', employment_type: 'internship',
  eligibility_text: 'Graduating 2027 or 2028', qualifications_text: QUAL, source_name: 'Example Careers', source_kind: 'company_site', source_url: `https://careers.example.com/jobs/${id}`,
  apply_url: `https://careers.example.com/jobs/${id}/apply`, discovered_at: '2026-10-20T09:00:00Z', last_checked_at: '2026-10-26T09:00:00Z', last_verified_at: '2026-10-26T09:00:00Z',
  verification_notes: 'Opened posting; matches.', eligibility_check: 'pass', dedupe_key: `example robotics inc|${id}|springfield xx`, updated_at: '2026-10-26T09:00:00Z', ...over,
});

function makeDir(jobs = [baseJob('job-0001', 'shortlisted')]) {
  const dir = mkdtempSync(join(tmpdir(), 'apply-test-'));
  cpSync(join(repoRoot, 'templates/data'), dir, { recursive: true });
  cpSync(join(repoRoot, 'tests/fixtures/candidate-profile.json'), join(dir, 'candidate-profile.json'));
  const header = schemas['jobs.csv'].columns.map((c) => c.name);
  writeFileSync(join(dir, 'jobs.csv'), serializeCsv(header, jobs));
  return dir;
}
const csv = (dir, name) => { const rows = parseCsv(readFileSync(join(dir, name), 'utf8')); return rows.slice(1).map((r) => Object.fromEntries(rows[0].map((h, i) => [h, r[i]]))); };
const profileOf = (dir) => JSON.parse(readFileSync(join(dir, 'candidate-profile.json'), 'utf8'));
const setProfile = (dir, fn) => { const p = profileOf(dir); fn(p); writeFileSync(join(dir, 'candidate-profile.json'), JSON.stringify(p, null, 2)); };
const files = (dir) => { const out = []; const walk = (d, pre = '') => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name), `${pre}${e.name}/`) : out.push(`${pre}${e.name}`); }; walk(dir); return out.sort(); };
const tailoredFiles = (dir) => files(dir).filter((f) => f.startsWith('tailored/') || f.startsWith('drafts/'));
const refused = (fn) => assert.throws(fn, RefusedError);

/** A package that satisfies every rule; tests mutate a clone to break one rule at a time. */
const goodPackage = () => ({
  analysis: {
    requirements: [
      { text: 'Experience with Python', level: 'essential', source_quote: 'Experience with Python is required', status: 'met', evidence: ['skills[0]', 'projects[0].technologies[0]'] },
      { text: 'Familiarity with ROS', level: 'preferred', source_quote: 'Familiarity with ROS is preferred', status: 'gap' },
    ],
    strongest_evidence: [{ claim: 'Python used in a robot course project', evidence: ['projects[0]'] }],
  },
  resume: {
    education: [{ ref: 'education[0]', include_coursework: ['Data Structures'] }],
    experience: [{ ref: 'experience[0]', bullets: [{ text: 'Resolved walk-in and email support requests for students and staff.', source: 'experience[0].highlights[0]' }] }],
    projects: [{ ref: 'projects[0]', bullets: [{ text: 'Built a small robot that follows a track as a course project.', source: 'projects[0].description' }] }],
    skills: ['Python'],
  },
  cover_letter: {
    paragraphs: [
      'I am applying for the Software Engineering Intern role at Example Robotics Inc. because the posting asks for Python experience, which I have used in a course project building a small robot.',
      'As a Student Assistant at the Example Campus IT Help Desk I resolved support requests for students and staff.',
    ],
    uses: ['experience[0]', 'projects[0]'],
  },
  answers: [
    { question: 'Why do you want to work here?', kind: 'general', answer: 'I want to work on robotics software and have used Python in a course project.', source: 'projects[0]' },
    { question: 'Are you legally authorized to work in XX?', kind: 'eligibility', answer: null },
  ],
});
const clone = (o) => JSON.parse(JSON.stringify(o));
const started = (dir, jobId = 'job-0001', now = T0) => startApplication(dir, jobId, { now });
const prep = (dir, appId, pkg, now = T1) => prepare(dir, appId, pkg, { now });
const mustFail = (dir, appId, pkg, pattern) => {
  const before = files(dir).join('|'), apps = readFileSync(join(dir, 'applications.csv'), 'utf8');
  assert.throws(() => prep(dir, appId, pkg), (e) => !(e instanceof RefusedError) && pattern.test(e.message), `expected refusal matching ${pattern}`);
  assert.equal(readFileSync(join(dir, 'applications.csv'), 'utf8'), apps, 'applications.csv must not change');
  assert.equal(files(dir).filter((f) => f.startsWith('tailored/') && /(resume|cover-letter|answers|review)\.md$/.test(f)).join('|'), before.split('|').filter((f) => f.startsWith('tailored/') && /(resume|cover-letter|answers|review)\.md$/.test(f)).join('|'), 'no documents may be written');
};

// ---------------------------------------------------------------- approval gates

test('gate: rejected, expired, discovered, unapproved (verified) and applied jobs are refused; no application is created', () => {
  const dir = makeDir(['rejected', 'expired', 'discovered', 'verified', 'applied', 'archived'].map((s, i) => baseJob(`job-000${i + 1}`, s)));
  for (let i = 1; i <= 6; i++) refused(() => started(dir, `job-000${i}`));
  assert.equal(csv(dir, 'applications.csv').length, 0);
  assert.equal(tailoredFiles(dir).length, 0);
  assert.deepEqual(listApprovable(dir), []);
});

test('gate: only a shortlisted job opens an application, as drafting and not submitted', () => {
  const dir = makeDir();
  const r = started(dir);
  assert.equal(r.application_id, 'app-0001');
  assert.equal(r.status, 'drafting');
  assert.equal(csv(dir, 'applications.csv')[0].status, 'drafting');
  assert.equal(listApprovable(dir).length, 1);
  assert.throws(() => started(dir, 'job-9999'), /no such job/);
  assert.throws(() => started(dir, '../etc'), /not valid/);
});

test('approve-job: needs the user\'s words and a verified posting; discovered is refused', () => {
  const dir = makeDir([baseJob('job-0001', 'verified'), baseJob('job-0002', 'discovered'), baseJob('job-0003', 'rejected')]);
  refused(() => approveJob(dir, 'job-0001', '', { now: T0 }));
  refused(() => approveJob(dir, 'job-0002', 'yes apply', { now: T0 }));
  assert.equal(approveJob(dir, 'job-0001', 'Yes, prepare this one.', { now: T0 }).status, 'shortlisted');
  const j = csv(dir, 'jobs.csv').find((r) => r.job_id === 'job-0001');
  assert.equal(j.status, 'shortlisted');
  assert.match(j.notes, /user-approved .*Yes, prepare this one\./);
  assert.equal(approveJob(dir, 'job-0003', 'I want this one after all', { now: T0 }).status, 'shortlisted'); // explicit user override of a rejection
  assert.deepEqual(checkCsv('jobs.csv', readFileSync(join(dir, 'jobs.csv'), 'utf8'), schemas['jobs.csv']), []);
});

// ---------------------------------------------------------------- missing job description

test('missing description: start reports it, prepare is refused, nothing is written, a user-supplied description unlocks it', () => {
  const dir = makeDir([baseJob('job-0001', 'shortlisted', { qualifications_text: '', eligibility_text: '' })]);
  const s = started(dir);
  assert.equal(s.description.status, 'missing');
  refused(() => prep(dir, s.application_id, goodPackage()));
  assert.equal(files(dir).some((f) => /resume\.md$/.test(f)), false);
  assert.equal(csv(dir, 'applications.csv')[0].resume_path, '');

  const paste = join(dir, 'paste.txt');
  writeFileSync(paste, 'Experience with Python is required. Familiarity with ROS is preferred. You will test line following robots.');
  assert.throws(() => setDescription(dir, s.application_id, paste, { origin: 'guess', now: T0 }), /--origin must be/);
  assert.equal(setDescription(dir, s.application_id, paste, { origin: 'user_provided', now: T0 }).version, 1);
  const r = prep(dir, s.application_id, goodPackage());
  assert.equal(r.submitted, false);
  assert.match(review(dir, s.application_id).documents['review.md'], /Description source: user_provided/);
});

test('missing description: a requirement quoted from nowhere in the posting is refused', () => {
  const dir = makeDir();
  const { application_id: id } = started(dir);
  const pkg = goodPackage();
  pkg.analysis.requirements.push({ text: 'Experience with Kubernetes', level: 'essential', source_quote: 'Kubernetes experience is required', status: 'gap' });
  mustFail(dir, id, pkg, /source_quote not found in the posting/);
  pkg.analysis.requirements.pop();
  assert.equal(prep(dir, id, pkg).status, 'drafting'); // the eligibility answer is still open
});

// ---------------------------------------------------------------- unsupported resume facts

test('unsupported facts: invented numbers, tools, achievements, skills, and unconfirmed or foreign sources are all refused', () => {
  const dir = makeDir();
  const { application_id: id } = started(dir);
  const bullet = (text, source = 'experience[0].highlights[0]') => { const p = goodPackage(); p.resume.experience[0].bullets = [{ text, source }]; return p; };

  mustFail(dir, id, bullet('Resolved 200 walk-in and email support requests for students and staff.'), /unsupported number "200"/);
  mustFail(dir, id, bullet('Resolved walk-in and email support requests using Kubernetes.'), /unsupported term "Kubernetes"/);
  mustFail(dir, id, bullet('Led walk-in and email support for students and staff.'), /claim verb "led"/);
  mustFail(dir, id, bullet('Improved walk-in and email support requests for students and staff.'), /claim verb "improved"/);
  mustFail(dir, id, bullet('Resolved support requests.', 'experience[0].highlights[5]'), /does not exist/);
  mustFail(dir, id, bullet('Built a small robot.', 'projects[0].description'), /source must belong to experience\[0\]/);

  const skill = goodPackage(); skill.resume.skills = ['Python', 'Figma'];
  mustFail(dir, id, skill, /"Figma" is not a confirmed skill/);

  setProfile(dir, (p) => p.experience.push({ organization: 'Made Up Labs', title: 'Intern', highlights: ['Wrote tools.'], provenance: 'inferred_unconfirmed' }));
  const inferred = goodPackage(); inferred.resume.experience.push({ ref: 'experience[1]', bullets: [] });
  mustFail(dir, id, inferred, /not a confirmed fact \(provenance inferred_unconfirmed\)/);

  const extra = goodPackage(); extra.resume.summary = 'Award-winning engineer';
  mustFail(dir, id, extra, /unknown section "summary"/);

  const evid = goodPackage(); evid.analysis.requirements[0].evidence = ['skills[1]'];
  mustFail(dir, id, evid, /not a confirmed fact|does not exist/);
  const met = goodPackage(); met.analysis.requirements[0].evidence = [];
  mustFail(dir, id, met, /"met" needs evidence/);

  const letter = goodPackage(); letter.cover_letter.paragraphs.push('I also won the Regional Robotics Cup in 2025.');
  mustFail(dir, id, letter, /cover_letter\.paragraphs\[2\]: unsupported/);

  assert.equal(prep(dir, id, goodPackage()).version, 1); // the clean package still passes after all those refusals
});

test('unsupportedClaims: supported wording passes, sentence-initial words are not terms', () => {
  assert.deepEqual(unsupportedClaims('Built a Python tool for 12 users.', 'Created a Python tool for 12 users'), []);
  assert.deepEqual(unsupportedClaims('Built a Python tool for 12 users.', 'Created a Python tool'), ['number "12"']);
  assert.deepEqual(unsupportedClaims('Used PostgreSQL daily.', 'Used Postgres daily'), ['term "PostgreSQL"']);
});

test('resume keeps accurate dates, titles and contact details from the profile, not from the package', () => {
  const dir = makeDir();
  const { application_id: id } = started(dir);
  prep(dir, id, goodPackage());
  const resume = review(dir, id).documents['resume.md'];
  assert.match(resume, /^# Alex Example/);
  assert.match(resume, /alex\.example@example\.com \| \+1 555-0100 \| Springfield, XX/);
  assert.match(resume, /\*\*Student Assistant\*\*, Example Campus IT Help Desk, Springfield, XX \(2025-01 - present\)/);
  assert.match(resume, /\*\*Example State University\*\*, BSc in Computer Science \(2024-09 - 2028-05\)/);
  assert.doesNotMatch(resume, /Figma/); // inferred skill never appears
});

// ---------------------------------------------------------------- user corrections and answers

test('answers: sensitive questions are never answered from the profile; they wait for the user, then repeat the user\'s exact words', () => {
  const dir = makeDir();
  const { application_id: id } = started(dir);
  const pkg = goodPackage();

  pkg.answers[1].answer = 'Yes'; pkg.answers[1].source = 'projects[0]';
  mustFail(dir, id, pkg, /eligibility answer needs the user's own recorded answer/);
  pkg.answers[1].source = 'user:auth';
  mustFail(dir, id, pkg, /has not been recorded with add-input/);

  const first = prep(dir, id, goodPackage());
  assert.equal(first.status, 'drafting');
  assert.deepEqual(first.open_items, ['Answer needed: Are you legally authorized to work in XX?']);
  assert.match(first.next, /show the whole package|Nothing is sent/);
  assert.match(review(dir, id).documents['answers.md'], /Answer: NEEDS USER INPUT/);

  refused(() => addInput(dir, id, 'auth', 'Yes', '', { now: T1 }));
  addInput(dir, id, 'auth', 'Yes, I am authorized to work in XX.', 'Yes, I am a citizen so I can work in XX.', { now: T1 });
  const bad = goodPackage(); bad.answers[1] = { question: 'Are you legally authorized to work in XX?', kind: 'eligibility', answer: 'Yes, without restriction.', source: 'user:auth' };
  mustFail(dir, id, bad, /must repeat the user's recorded value exactly/);

  const ok = goodPackage(); ok.answers[1] = { question: 'Are you legally authorized to work in XX?', kind: 'eligibility', answer: 'Yes, I am authorized to work in XX.', source: 'user:auth' };
  const done = prep(dir, id, ok, T2);
  assert.equal(done.status, 'ready_for_review');
  assert.deepEqual(done.open_items, []);
});

test('corrections: a corrected profile fact flows into a new version while the earlier version stays as it was', () => {
  const dir = makeDir();
  const { application_id: id } = started(dir);
  prep(dir, id, goodPackage(), T1);
  const v1Resume = review(dir, id, 1).documents['resume.md'];
  assert.match(v1Resume, /\(2025-01 - present\)/);

  // The user corrects the start date through profile-setup (provenance user_stated).
  setProfile(dir, (p) => { p.experience[0].start_date = '2025-03'; p.experience[0].provenance = 'user_stated'; });
  const v2 = started(dir, 'job-0001', T2);
  assert.equal(v2.version, 2);
  assert.equal(v2.profile.experience[0].start_date, '2025-03');
  prep(dir, id, goodPackage(), T2);
  assert.match(review(dir, id).documents['resume.md'], /\(2025-03 - present\)/);
  assert.equal(review(dir, id, 1).documents['resume.md'], v1Resume);
});

test('corrections: a fact the user stated for this application may be used in the cover letter, an unrecorded one may not', () => {
  const dir = makeDir();
  const { application_id: id } = started(dir);
  const pkg = goodPackage();
  pkg.cover_letter.paragraphs.push('I am available for fourteen weeks starting in June 2029.');
  mustFail(dir, id, pkg, /unsupported number "2029"/);
  addInput(dir, id, 'availability', 'Available for fourteen weeks starting in June 2029', 'I can do fourteen weeks starting June 2029.', { now: T1 });
  assert.equal(prep(dir, id, pkg).version, 1);
});

// ---------------------------------------------------------------- multiple versions

test('versions: each prepare run is kept; one application row points to the latest; approval is cleared by a new version', () => {
  const dir = makeDir();
  const s1 = started(dir);
  prep(dir, s1.application_id, goodPackage(), T1);
  const v1 = files(dir).filter((f) => f.startsWith('tailored/app-0001/v1/'));
  const v1Letter = readFileSync(join(dir, 'tailored/app-0001/v1/cover-letter.md'), 'utf8');

  // Pretend the user approved v1 (done by a later skill), then ask for another version.
  const apps = csv(dir, 'applications.csv');
  apps[0].status = 'approved'; apps[0].approved_at = T1; apps[0].approval_note = 'Yes, this one.';
  writeFileSync(join(dir, 'applications.csv'), serializeCsv(Object.keys(apps[0]), apps));

  const s2 = started(dir, 'job-0001', T2);
  assert.equal(s2.application_id, s1.application_id);
  assert.equal(s2.version, 2);
  let row = csv(dir, 'applications.csv');
  assert.equal(row.length, 1);
  assert.equal(row[0].status, 'drafting');
  assert.equal(row[0].approved_at, '');
  assert.equal(row[0].approval_note, '');
  assert.match(row[0].notes, /approval cleared/);

  const alt = goodPackage();
  alt.cover_letter.paragraphs = ['I am applying for the Software Engineering Intern role at Example Robotics Inc. My Python work in a course project is the closest match to the posting.'];
  alt.cover_letter.uses = ['projects[0]'];
  prep(dir, s2.application_id, alt, T2);
  row = csv(dir, 'applications.csv');
  assert.equal(row[0].resume_path, 'tailored/app-0001/v2/resume.pdf');
  assert.equal(row[0].cover_letter_path, 'tailored/app-0001/v2/cover-letter.pdf');
  assert.match(row[0].notes, /prepared v1 .*prepared v2/);
  assert.deepEqual(files(dir).filter((f) => f.startsWith('tailored/app-0001/v1/')), v1);
  assert.equal(readFileSync(join(dir, 'tailored/app-0001/v1/cover-letter.md'), 'utf8'), v1Letter);
  assert.notEqual(review(dir, s1.application_id, 2).documents['cover-letter.md'], v1Letter);
});

test('versions: preparing a version twice, or one that was already approved, is refused until a new version is started', () => {
  const dir = makeDir();
  const { application_id: id } = started(dir);
  prep(dir, id, goodPackage(), T1);
  const apps = csv(dir, 'applications.csv');
  apps[0].status = 'approved'; apps[0].approved_at = T1; apps[0].approval_note = 'ok';
  writeFileSync(join(dir, 'applications.csv'), serializeCsv(Object.keys(apps[0]), apps));
  refused(() => prep(dir, id, goodPackage(), T2));

  apps[0].status = 'submitted'; apps[0].submitted_at = T2; apps[0].submission_method = 'portal'; apps[0].submission_result = 'success'; apps[0].confirmation_evidence = 'Application received';
  writeFileSync(join(dir, 'applications.csv'), serializeCsv(Object.keys(apps[0]), apps));
  refused(() => started(dir, 'job-0001', T2));
});

// ---------------------------------------------------------------- private output storage and tracker

test('storage: documents live only in the data directory, paths are relative, the tracker is valid and says prepared, not submitted', () => {
  const dir = makeDir();
  const { application_id: id } = started(dir);
  const out = prep(dir, id, goodPackage());
  assert.equal(out.submitted, false);
  assert.ok(out.files.every((f) => f.startsWith('tailored/app-0001/v1/')));
  for (const f of out.files) assert.ok(existsSync(join(dir, f)), f);

  const row = csv(dir, 'applications.csv')[0];
  assert.equal(row.resume_path, 'tailored/app-0001/v1/resume.pdf', 'the resume to upload is the PDF');
  assert.equal(row.cover_letter_path, 'tailored/app-0001/v1/cover-letter.pdf');
  assert.equal(row.answers_path, 'tailored/app-0001/v1/answers.md');
  for (const k of ['resume_path', 'cover_letter_path', 'answers_path']) assert.ok(!row[k].includes('..') && !/^([\\/]|[A-Za-z]:)/.test(row[k]), `${k} is relative: ${row[k]}`);
  assert.ok(['drafting', 'ready_for_review'].includes(row.status));
  assert.equal(row.approved_at, '');
  assert.equal(row.submitted_at, '');
  assert.match(row.notes, /prepared v1 2026-10-27T11:00:00Z/);
  assert.equal(row.updated_at, T1);
  assert.deepEqual(checkCsv('applications.csv', readFileSync(join(dir, 'applications.csv'), 'utf8'), schemas['applications.csv'], { 'jobs.csv': new Set(['job-0001']) }), []);

  const meta = JSON.parse(readFileSync(join(dir, 'tailored/app-0001/v1/meta.json'), 'utf8'));
  assert.equal(meta.prepared_at, T1);

  const runs = csv(dir, 'run-history.csv');
  assert.deepEqual(runs.map((r) => [r.skill, r.outcome]), [['apply', 'completed'], ['apply', 'completed']]);
  assert.equal(JSON.parse(readFileSync(join(dir, 'sync-state.json'), 'utf8')).lock.holder, null);
  assert.ok(readdirSync(join(dir, 'backups')).some((f) => f.startsWith('run-history.csv.')), 'files are backed up before they are rewritten');

  // nothing leaked into the repository
  for (const d of ['tailored', 'drafts']) assert.equal(existsSync(join(repoRoot, d)), false, `${d}/ must not exist in the repository root`);
});

test('storage: the default private folder is git-ignored for every file this skill writes', () => {
  const paths = ['private/tailored/app-0001/v1/resume.md', 'private/tailored/app-0001/v1/cover-letter.md', 'private/tailored/app-0001/user-input.json', 'private/drafts/app-0001-v1-recruiter-message.md', 'private/applications.csv'];
  const r = spawnSync('git', ['check-ignore', ...paths], { cwd: repoRoot, encoding: 'utf8' });
  if (r.error) return; // git missing: validate.mjs warns about this separately
  assert.deepEqual(r.stdout.split(/\r?\n/).filter(Boolean).sort(), [...paths].sort(), 'every private path must be ignored by .gitignore');
});

test('review: shows company, role, URL, documents and open items, and notices edits made after preparation', () => {
  const dir = makeDir();
  const { application_id: id } = started(dir);
  assert.throws(() => review(dir, id), RefusedError);
  prep(dir, id, goodPackage());
  const r = review(dir, id);
  assert.equal(r.company, 'Example Robotics Inc.');
  assert.equal(r.source_url, 'https://careers.example.com/jobs/job-0001');
  assert.equal(r.submitted, false);
  assert.equal(r.modified_since_prepared, null);
  assert.match(r.documents['review.md'], /PREPARED, NOT SUBMITTED/);
  assert.match(r.documents['review.md'], /\[eligibility\] Are you legally authorized to work in XX\? -> NEEDS USER INPUT/);
  assert.match(r.documents['review.md'], /No evidence for preferred requirement: Familiarity with ROS/);
  assert.match(r.documents['review.md'], /Posting last verified: 2026-10-26T09:00:00Z/);

  writeFileSync(join(dir, 'tailored/app-0001/v1/cover-letter.md'), 'edited by hand\n');
  const again = review(dir, id);
  assert.deepEqual(again.modified_since_prepared, ['cover-letter.md']);
  assert.match(again.warning, /approval is void/);
});

test('recruiter message: drafted into drafts/ only with a sourced or user-given recipient; never sent or logged as sent', () => {
  const dir = makeDir();
  const { application_id: id } = started(dir);
  const msg = { to: 'recruiting@example.com', subject: 'Software Engineering Intern application', body: 'I applied for the Software Engineering Intern role at Example Robotics Inc. and would welcome any advice on next steps.' };
  const noSource = goodPackage(); noSource.recruiter_message = { ...msg };
  mustFail(dir, id, noSource, /never guess an address/);
  const badMail = goodPackage(); badMail.recruiter_message = { ...msg, to: 'not-an-email', user_provided: true };
  mustFail(dir, id, badMail, /valid email/);

  const ok = goodPackage(); ok.recruiter_message = { ...msg, contact_source_url: 'https://careers.example.com/contact' };
  const r = prep(dir, id, ok);
  assert.equal(r.recruiter_draft, 'drafts/app-0001-v1-recruiter-message.md');
  const draft = readFileSync(join(dir, r.recruiter_draft), 'utf8');
  assert.match(draft, /^DRAFT - NOT SENT/);
  assert.match(draft, /Recipient source: https:\/\/careers\.example\.com\/contact/);
  assert.equal(csv(dir, 'email-events.csv').length, 0);
});

test('lock and readiness: a held lock or an unready profile refuses without writing', () => {
  const dir = makeDir();
  const sync = JSON.parse(readFileSync(join(dir, 'sync-state.json'), 'utf8'));
  sync.lock = { holder: 'run-0099', acquired_at: T0 };
  writeFileSync(join(dir, 'sync-state.json'), JSON.stringify(sync));
  refused(() => started(dir));
  assert.equal(csv(dir, 'applications.csv').length, 0);

  const dir2 = makeDir();
  cpSync(join(repoRoot, 'templates/data/candidate-profile.json'), join(dir2, 'candidate-profile.json'));
  refused(() => started(dir2));
  mkdirSync(join(dir2, 'x'), { recursive: true });
});
