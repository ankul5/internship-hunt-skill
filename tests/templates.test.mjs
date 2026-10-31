// Tests for resume templates. Run: node --test tests/templates.test.mjs
// Fictional data and throwaway folders; PDFs come from the stub engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot, loadCsvSchemas } from '../scripts/lib/data.mjs';
import { serializeCsv } from '../scripts/lib/csv.mjs';
import { startApplication, prepare, review, previewTemplate, resolveRef } from '../scripts/lib/apply.mjs';
import { listTemplates, loadTemplate, cssProblems, renderResumeHtml, renderLetterHtml, templateName, DEFAULT_TEMPLATE } from '../scripts/lib/resume-templates.mjs';
import { makePdfs, setPdfEngine } from '../scripts/lib/pdf.mjs';
import { stubEngine } from './helpers/pdf-stub.mjs';

setPdfEngine(stubEngine);
const schemas = loadCsvSchemas();
const T0 = '2026-10-31T09:00:00Z';
const QUAL = 'Experience with Python is required. Familiarity with ROS is preferred.';
const job = () => Object.fromEntries(schemas['jobs.csv'].columns.map((c) => [c.name, ({ job_id: 'job-0001', status: 'shortlisted', company: 'Example Robotics Inc.', title: 'Software Engineering Intern', remote_type: 'remote', employment_type: 'internship', qualifications_text: QUAL, source_name: 'Example Careers', source_kind: 'company_site', source_url: 'https://careers.example.com/jobs/1', apply_url: 'https://careers.example.com/jobs/1/apply', discovered_at: '2026-10-20T09:00:00Z', last_checked_at: '2026-10-26T09:00:00Z', last_verified_at: '2026-10-26T09:00:00Z', verification_notes: 'Opened posting.', eligibility_check: 'pass', dedupe_key: 'x', updated_at: '2026-10-26T09:00:00Z' })[c.name] ?? '']));
function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'tpl-test-'));
  cpSync(join(repoRoot, 'templates/data'), dir, { recursive: true });
  cpSync(join(repoRoot, 'tests/fixtures/candidate-profile.json'), join(dir, 'candidate-profile.json'));
  writeFileSync(join(dir, 'jobs.csv'), serializeCsv(Object.keys(job()), [job()]));
  return dir;
}
const pkg = (extra = {}) => ({
  analysis: { requirements: [{ text: 'Experience with Python', level: 'essential', source_quote: 'Experience with Python is required', status: 'met', evidence: ['skills[0]'] }] },
  resume: { education: [{ ref: 'education[0]' }], experience: [{ ref: 'experience[0]', bullets: [{ text: 'Resolved walk-in and email support requests for students and staff.', source: 'experience[0].highlights[0]' }] }], skills: ['Python'] },
  cover_letter: { paragraphs: ['I am applying for the Software Engineering Intern role at Example Robotics Inc. because I have used Python in a course project.'], uses: ['projects[0]'] },
  answers: [],
  ...extra,
});
const userTemplate = (dir, name, json, css) => {
  const d = join(dir, 'resume-templates', name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'template.json'), typeof json === 'string' ? json : JSON.stringify(json));
  writeFileSync(join(d, 'template.css'), css);
};

test('the three built-in templates load, have a license and an attribution, and jake is the default', () => {
  const t = listTemplates(null).filter((x) => x.source === 'builtin');
  assert.deepEqual(t.map((x) => x.name).sort(), ['harvard', 'jake', 'modern']);
  for (const x of t) { assert.equal(x.ok, true, `${x.name}: ${x.problems}`); assert.ok(x.license && x.attribution, x.name); }
  assert.equal(DEFAULT_TEMPLATE, 'jake');
  assert.match(readFileSync(join(repoRoot, 'templates/resume/jake/LICENSE'), 'utf8'), /MIT License[\s\S]*Jake Gutierrez/);
  assert.equal(templateName({}, { preferences: {} }), 'jake');
  assert.equal(templateName({}, { preferences: { resume_template: 'modern' } }), 'modern');
  assert.equal(templateName({ template: 'harvard' }, { preferences: { resume_template: 'modern' } }), 'harvard', 'the package overrides the profile');
});

test('template CSS may not load anything or run anything', () => {
  assert.deepEqual(cssProblems('body{font-family:Georgia}'), []);
  assert.ok(cssProblems('@import "x.css";').length);
  assert.ok(cssProblems('body{background:url(https://example.com/t.png)}').length);
  assert.ok(cssProblems('@font-face{src:url(file:///c:/x.ttf)}').length);
  assert.ok(cssProblems('div{width:expression(alert(1))}').length);
  assert.ok(cssProblems('</style><script>alert(1)</script>').length);
  assert.ok(cssProblems('a'.repeat(70 * 1024)).length);
});

test('a user template in the data directory is listed and used; a bad one is reported with its reasons', () => {
  const dir = makeDir();
  userTemplate(dir, 'mine', { title: 'Mine', section_order: ['skills', 'experience'] }, 'body{font-family:Georgia}');
  userTemplate(dir, 'broken', { section_order: ['hobbies'] }, 'body{background:url(x.png)}');
  userTemplate(dir, 'jake', {}, 'body{}');
  userTemplate(dir, 'badjson', '{not json', 'body{}');
  const all = listTemplates(dir);
  assert.equal(all.find((x) => x.name === 'mine').ok, true);
  const broken = all.find((x) => x.name === 'broken');
  assert.equal(broken.ok, false);
  assert.ok(broken.problems.some((p) => /url/.test(p)) && broken.problems.some((p) => /section_order/.test(p)));
  assert.ok(all.find((x) => x.name === 'jake' && x.source === 'user').problems[0].includes('built-in'));
  assert.equal(all.find((x) => x.name === 'badjson').ok, false);
  assert.throws(() => loadTemplate('broken', dir), /cannot be used/);
  assert.throws(() => loadTemplate('nope', dir), /no resume template "nope"/);
  assert.equal(loadTemplate('jake', dir).source, 'builtin', 'a user folder cannot shadow a built-in');
});

test('rendered HTML holds only profile text, escaped, in the template order and style', () => {
  const profile = JSON.parse(readFileSync(join(repoRoot, 'tests/fixtures/candidate-profile.json'), 'utf8'));
  profile.experience[0].organization = 'Org <script>x</script> & Co';
  const get = (ref) => resolveRef(profile, ref).value;
  const rs = { education: [{ ref: 'education[0]' }], experience: [{ ref: 'experience[0]', bullets: [{ text: 'Did <b>a</b> thing' }] }], skills: ['Python'] };
  const t = loadTemplate('harvard', null);
  const html = renderResumeHtml(profile, rs, t, get);
  assert.ok(html.includes('Org &lt;script&gt;x&lt;/script&gt; &amp; Co'));
  assert.ok(!html.includes('<script>x'));
  assert.ok(html.includes('Did &lt;b&gt;a&lt;/b&gt; thing'));
  assert.ok(html.indexOf('r-education') < html.indexOf('r-experience'), 'harvard puts education first');
  assert.ok(html.includes(t.css.slice(0, 40)), 'the template CSS is inlined');
  const modern = renderResumeHtml(profile, rs, loadTemplate('modern', null), get);
  assert.ok(modern.indexOf('r-experience') < modern.indexOf('r-education'), 'modern puts experience first');
  const letter = renderLetterHtml(profile, t, { date: '2026-10-31', greeting: 'Hiring Team', paragraphs: ['Hello <i>there</i>'] });
  assert.match(letter, /class="r-letter"[\s\S]*Dear Hiring Team,[\s\S]*Hello &lt;i&gt;there&lt;\/i&gt;/);
  const hidden = { ...profile, preferences: { ...profile.preferences, show_gpa: false } };
  if (profile.education[0].gpa) assert.ok(!renderResumeHtml(hidden, rs, t, get).includes(`GPA ${profile.education[0].gpa}`), 'show_gpa false hides the GPA');
});

test('makePdfs passes template HTML through unchanged and still accepts Markdown', () => {
  let seen = '';
  setPdfEngine((a) => { seen = a.html; return stubEngine(a); });
  try {
    makePdfs({ resume: { html: '<html><body>X</body></html>' } });
    assert.equal(seen, '<html><body>X</body></html>');
    makePdfs({ resume: '# Name' });
    assert.match(seen, /<h1>Name<\/h1>/);
  } finally { setPdfEngine(stubEngine); }
});

test('prepare uses the package template, records it in meta and the review, and refuses an unknown one', () => {
  const dir = makeDir();
  const s = startApplication(dir, 'job-0001', { now: T0 });
  assert.throws(() => prepare(dir, s.application_id, pkg({ template: 'nope' }), { now: T0 }), /template: no resume template "nope"[\s\S]*nothing was written|nothing was written[\s\S]*template/);
  prepare(dir, s.application_id, pkg({ template: 'modern' }), { now: T0 });
  const meta = JSON.parse(readFileSync(join(dir, 'tailored', s.application_id, 'v1', 'meta.json'), 'utf8'));
  assert.deepEqual(meta.template, { name: 'modern', source: 'builtin' });
  const r = review(dir, s.application_id);
  assert.equal(r.pdf_files.template.name, 'modern');
  assert.match(r.documents['review.md'], /template: Modern/);
});

test('prepare falls back to the profile preference, then to jake; a user template works end to end', () => {
  const dir = makeDir();
  const p = JSON.parse(readFileSync(join(dir, 'candidate-profile.json'), 'utf8'));
  p.preferences.resume_template = 'mine';
  writeFileSync(join(dir, 'candidate-profile.json'), JSON.stringify(p));
  userTemplate(dir, 'mine', { title: 'Mine' }, 'body{font-family:Georgia}');
  const s = startApplication(dir, 'job-0001', { now: T0 });
  prepare(dir, s.application_id, pkg(), { now: T0 });
  const meta = JSON.parse(readFileSync(join(dir, 'tailored', s.application_id, 'v1', 'meta.json'), 'utf8'));
  assert.deepEqual(meta.template, { name: 'mine', source: 'user' });
});

test('preview-template writes a PDF of the confirmed profile and touches no tracker file', () => {
  const dir = makeDir();
  const before = readFileSync(join(dir, 'run-history.csv'), 'utf8');
  const r = previewTemplate(dir, 'jake', { now: T0 });
  assert.equal(r.file, 'template-previews/jake.pdf');
  assert.ok(readFileSync(join(dir, r.file)).subarray(0, 5).toString() === '%PDF-');
  assert.equal(readFileSync(join(dir, 'run-history.csv'), 'utf8'), before);
  assert.throws(() => previewTemplate(dir, 'nope'), /no resume template/);
});
