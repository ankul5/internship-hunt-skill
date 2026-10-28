// Tests for PDF output of tailored resumes. Run: node --test tests/pdf.test.mjs
// Uses fictional data and throwaway folders. The "real engine" tests use the Chrome or Edge installed on this computer
// (headless, throwaway profile) and are skipped if none is found; everything else uses a stub engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot, loadCsvSchemas } from '../scripts/lib/data.mjs';
import { parseCsv, serializeCsv } from '../scripts/lib/csv.mjs';
import { RefusedError } from '../scripts/lib/ingest.mjs';
import { startApplication, prepare, addInput, review } from '../scripts/lib/apply.mjs';
import { submissionCard } from '../scripts/lib/submit.mjs';
import { mdToHtml, wrapHtml, findBrowser, makePdfs, setPdfEngine, isPdf, pdfPages } from '../scripts/lib/pdf.mjs';
import { stubEngine } from './helpers/pdf-stub.mjs';

const schemas = loadCsvSchemas();
const T0 = '2026-10-27T09:00:00Z';
const QUAL = 'Experience with Python is required. Familiarity with ROS is preferred.';
const job = () => Object.fromEntries(schemas['jobs.csv'].columns.map((c) => [c.name, ({ job_id: 'job-0001', status: 'shortlisted', company: 'Example Robotics Inc.', title: 'Software Engineering Intern', remote_type: 'remote', employment_type: 'internship', qualifications_text: QUAL, source_name: 'Example Careers', source_kind: 'company_site', source_url: 'https://careers.example.com/jobs/1', apply_url: 'https://careers.example.com/jobs/1/apply', discovered_at: '2026-10-20T09:00:00Z', last_checked_at: '2026-10-26T09:00:00Z', last_verified_at: '2026-10-26T09:00:00Z', verification_notes: 'Opened posting.', eligibility_check: 'pass', dedupe_key: 'x', updated_at: '2026-10-26T09:00:00Z' })[c.name] ?? '']));
function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'pdf-test-'));
  cpSync(join(repoRoot, 'templates/data'), dir, { recursive: true });
  cpSync(join(repoRoot, 'tests/fixtures/candidate-profile.json'), join(dir, 'candidate-profile.json'));
  writeFileSync(join(dir, 'jobs.csv'), serializeCsv(Object.keys(job()), [job()]));
  return dir;
}
const csv = (dir, name) => { const rows = parseCsv(readFileSync(join(dir, name), 'utf8')); return rows.slice(1).map((r) => Object.fromEntries(rows[0].map((h, i) => [h, r[i]]))); };
const pkg = () => ({
  analysis: { requirements: [{ text: 'Experience with Python', level: 'essential', source_quote: 'Experience with Python is required', status: 'met', evidence: ['skills[0]'] }] },
  resume: { education: [{ ref: 'education[0]', include_coursework: ['Data Structures'] }], experience: [{ ref: 'experience[0]', bullets: [{ text: 'Resolved walk-in and email support requests for students and staff.', source: 'experience[0].highlights[0]' }] }], skills: ['Python'] },
  cover_letter: { paragraphs: ['I am applying for the Software Engineering Intern role at Example Robotics Inc. because I have used Python in a course project.'], uses: ['projects[0]'] },
  answers: [{ question: 'Why do you want to work here?', kind: 'general', answer: 'I want to work on robotics software and have used Python in a course project.', source: 'projects[0]' }],
});
const prepared = (dir) => { const s = startApplication(dir, 'job-0001', { now: T0 }); prepare(dir, s.application_id, pkg(), { now: T0 }); return s.application_id; };

test('markdown to HTML: headings, nested lists, bold and escaping', () => {
  const html = mdToHtml('# Name\n\na@example.com | +1 555-0100\n\n## Experience\n- **Role**, Org <b>x</b> & co\n  - did a thing\n- Second\n\n## Skills\nPython, Git\n');
  assert.match(html, /<h1>Name<\/h1>/);
  assert.match(html, /<h2>Experience<\/h2>/);
  assert.ok(html.includes('<li><strong>Role</strong>, Org &lt;b&gt;x&lt;/b&gt; &amp; co</li>'));
  assert.match(html, /<ul>[\s\S]*<ul>[\s\S]*did a thing[\s\S]*<\/ul>[\s\S]*Second/);
  assert.doesNotMatch(html, /<b>x<\/b>/, 'user text is escaped, never treated as HTML');
  assert.match(wrapHtml(html, { title: 'T', kind: 'resume' }), /<title>T<\/title>[\s\S]*font-family:Arial/);
});

test('prepare makes the resume and cover letter PDFs, points the tracker at them, and hashes them', () => {
  setPdfEngine(stubEngine);
  const dir = makeDir();
  const id = prepared(dir);
  const vd = join(dir, 'tailored', id, 'v1');
  for (const f of ['resume.pdf', 'cover-letter.pdf']) assert.ok(isPdf(readFileSync(join(vd, f))), f);
  assert.ok(existsSync(join(vd, 'resume.md')), 'the Markdown source is kept beside the PDF');
  const row = csv(dir, 'applications.csv')[0];
  assert.equal(row.resume_path, `tailored/${id}/v1/resume.pdf`);
  assert.equal(row.cover_letter_path, `tailored/${id}/v1/cover-letter.pdf`);
  const meta = JSON.parse(readFileSync(join(vd, 'meta.json'), 'utf8'));
  assert.deepEqual(Object.keys(meta.files).sort(), ['answers.md', 'cover-letter.md', 'cover-letter.pdf', 'resume.md', 'resume.pdf', 'review.md']);
  assert.equal(meta.pdf.resume.engine, 'stub');
  const r = review(dir, id);
  assert.equal(r.pdf_files.resume, `tailored/${id}/v1/resume.pdf`);
  assert.match(r.documents['review.md'], /## PDF files \(the ones to upload\)[\s\S]*resume\.pdf: 1 page\(s\)/);
  assert.equal(r.modified_since_prepared, null);
});

test('the PDF must match the resume: editing the PDF or the resume afterwards is detected and the submission card is blocked', () => {
  setPdfEngine(stubEngine);
  const dir = makeDir();
  const id = prepared(dir);
  assert.equal(submissionCard(dir, id, { now: T0 }).ready_for_approval, true);
  appendFileSync(join(dir, 'tailored', id, 'v1', 'resume.pdf'), '% edited by hand\n');
  assert.deepEqual(review(dir, id).modified_since_prepared, ['resume.pdf']);
  const card = submissionCard(dir, id, { now: T0 });
  assert.equal(card.ready_for_approval, false);
  assert.match(card.blockers.join(' '), /resume\.pdf changed after preparation/);
});

test('if no PDF can be made, prepare refuses and writes nothing: a resume that cannot be uploaded is not "prepared"', () => {
  setPdfEngine(() => ({ ok: false, error: 'no Chrome or Edge was found on this computer to make the PDF' }));
  try {
    const dir = makeDir();
    const s = startApplication(dir, 'job-0001', { now: T0 });
    addInput(dir, s.application_id, 'k1', 'x', 'x', { now: T0 });
    const before = readFileSync(join(dir, 'applications.csv'), 'utf8');
    assert.throws(() => prepare(dir, s.application_id, pkg(), { now: T0 }), (e) => e instanceof RefusedError && /no Chrome or Edge/.test(e.message) && /Nothing was written/.test(e.message));
    assert.equal(readFileSync(join(dir, 'applications.csv'), 'utf8'), before);
    assert.deepEqual(readdirSync(join(dir, 'tailored', s.application_id, 'v1')).filter((f) => /\.(pdf|md)$/.test(f)), []);
    assert.throws(() => makePdfs({ resume: '# x' }), /PDF for resume could not be made/);
    setPdfEngine(() => ({ ok: true, engine: 'x', pdf: Buffer.from('not a pdf') }));
    assert.throws(() => makePdfs({ resume: '# x' }), /returned no valid PDF|could not be made/);
  } finally { setPdfEngine(stubEngine); }
});

test('browser lookup: the override is honoured and a wrong path is not guessed around', () => {
  assert.equal(findBrowser({ INTERNSHIP_AGENT_BROWSER: join(tmpdir(), 'no-such-browser.exe') }), null);
  const fake = join(mkdtempSync(join(tmpdir(), 'fb-')), 'browser.exe');
  writeFileSync(fake, 'x');
  assert.equal(findBrowser({ INTERNSHIP_AGENT_BROWSER: fake }), fake);
});

const browser = findBrowser();
test('real engine: headless Chrome or Edge makes a valid one-page PDF of a resume', { skip: browser ? false : 'no Chrome or Edge on this computer' }, () => {
  setPdfEngine(null); // the real engine
  try {
    const md = '# Alex Example\n\nalex.example@example.com | +1 555-0100 | Springfield, XX\n\n## Education\n- **Example State University**, BSc in Computer Science (2024-09 - 2028-05)\n  - Coursework: Data Structures\n\n## Experience\n- **Student Assistant**, Example Campus IT Help Desk (2025-01 - present)\n  - Resolved walk-in and email support requests for students and staff.\n\n## Skills\nPython\n';
    const out = makePdfs({ resume: md, 'cover-letter': '2026-10-27\n\nDear Hiring Team,\n\nI am applying for the role.\n\nSincerely,\nAlex Example\n' });
    for (const k of ['resume', 'cover-letter']) { assert.ok(isPdf(out[k].pdf), k); assert.ok(out[k].pdf.length > 5000, `${k} has real content`); assert.equal(out[k].pages, 1); }
    assert.match(out.resume.engine, /msedge|chrome/i);
    assert.equal(pdfPages(out.resume.pdf), 1);
  } finally { setPdfEngine(stubEngine); }
});

test('real engine: a full prepare with the real browser produces uploadable PDFs', { skip: browser ? false : 'no Chrome or Edge on this computer' }, () => {
  setPdfEngine(null);
  try {
    const dir = makeDir();
    const id = prepared(dir);
    const buf = readFileSync(join(dir, 'tailored', id, 'v1', 'resume.pdf'));
    assert.ok(isPdf(buf) && buf.length > 5000);
    assert.equal(JSON.parse(readFileSync(join(dir, 'tailored', id, 'v1', 'meta.json'), 'utf8')).pdf.resume.pages, 1);
    assert.equal(review(dir, id).modified_since_prepared, null);
  } finally { setPdfEngine(stubEngine); }
});
