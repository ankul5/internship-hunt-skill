// Tests for startup discovery, the career-page walker, posting verification, and the scoring/profile additions.
// Run: node --test tests/discovery.test.mjs
// Fictional companies and a fake network only (no request leaves the machine); never touches ./private.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoRoot } from '../scripts/lib/data.mjs';
import { ingest } from '../scripts/lib/ingest.mjs';
import { approveJob } from '../scripts/lib/apply.mjs';
import { robotsAllows, createWalker, findCareerPages, internLinks } from '../scripts/lib/walker.mjs';
import { detectBoards, boardFromFreehire, postingLookup, readBoard, makeGetJson, parseCompany } from '../scripts/lib/ats.mjs';
import { groupFreehire, writeSuggestions, addBoards, knownBoards } from '../scripts/lib/discovery.mjs';
import { findSites, verifyJobs, rowsToVerify, sitesFromBundle } from '../scripts/lib/careerwalk.mjs';
import { evaluate, homePlaces } from '../scripts/lib/scoring.mjs';
import { probe } from '../scripts/lib/readiness.mjs';

const NOW = '2026-10-30T10:00:00Z';
const noSleep = async () => {};
const LONG = 'You will build and test robotics software with the platform team. '.repeat(8);

function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'discovery-test-'));
  cpSync(join(repoRoot, 'templates/data'), dir, { recursive: true });
  cpSync(join(repoRoot, 'tests/fixtures/candidate-profile.json'), join(dir, 'candidate-profile.json'));
  return dir;
}

/** A fake fetch over a URL -> response map. Values: string (HTML 200), object (JSON 200), number (status), Error (network failure). */
function fakeNet(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const hit = Object.prototype.hasOwnProperty.call(routes, url) ? routes[url] : (url.endsWith('/robots.txt') ? 404 : 404);
    if (hit instanceof Error) throw hit;
    if (typeof hit === 'number') return new Response('', { status: hit });
    if (typeof hit === 'string') return new Response(hit, { status: 200, headers: { 'content-type': url.endsWith('robots.txt') ? 'text/plain' : 'text/html' } });
    return new Response(JSON.stringify(hit), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

// ---------------------------------------------------------------- robots.txt and polite fetching

test('robots: disallow, longer allow wins, own group beats *, wildcards and $', () => {
  const txt = 'User-agent: *\nDisallow: /private\nAllow: /private/careers\nDisallow: /*.pdf$\n\nUser-agent: badbot\nDisallow: /';
  assert.equal(robotsAllows(txt, '/careers'), true);
  assert.equal(robotsAllows(txt, '/private/x'), false);
  assert.equal(robotsAllows(txt, '/private/careers/1'), true);
  assert.equal(robotsAllows(txt, '/doc.pdf'), false);
  assert.equal(robotsAllows('User-agent: internship-agent-personal\nDisallow: /\n\nUser-agent: *\nAllow: /', '/jobs'), false);
  assert.equal(robotsAllows('', '/anything'), true);
});

test('walker: robots.txt disallow means the page is never requested', async () => {
  const net = fakeNet({ 'https://shy.example.com/robots.txt': 'User-agent: *\nDisallow: /careers' });
  const w = createWalker({ fetchImpl: net.fetchImpl, sleep: noSleep });
  const r = await w.get('https://shy.example.com/careers');
  assert.equal(r.code, 'ROBOTS_DISALLOWED');
  assert.ok(!net.calls.includes('https://shy.example.com/careers'));
});

test('walker: robots.txt server error or network failure means stay away', async () => {
  const net = fakeNet({ 'https://down.example.com/robots.txt': 503, 'https://gone.example.org/robots.txt': new Error('ECONNREFUSED') });
  const w = createWalker({ fetchImpl: net.fetchImpl, sleep: noSleep });
  assert.equal((await w.get('https://down.example.com/careers')).code, 'ROBOTS_DISALLOWED');
  assert.equal((await w.get('https://gone.example.org/careers')).code, 'ROBOTS_DISALLOWED');
});

test('walker: after a 429 the host is not contacted again in the run', async () => {
  const net = fakeNet({ 'https://busy.example.com/jobs': 429 });
  const w = createWalker({ fetchImpl: net.fetchImpl, sleep: noSleep });
  assert.equal((await w.get('https://busy.example.com/jobs')).code, 'RATE_LIMITED');
  const before = net.calls.length;
  assert.equal((await w.get('https://busy.example.com/careers')).code, 'RATE_LIMITED');
  assert.equal(net.calls.length, before);
});

test('walker: one request per second per host is enforced through sleep', async () => {
  const waits = [];
  const net = fakeNet({ 'https://a.example.com/x': '<p>x</p>', 'https://a.example.com/y': '<p>y</p>' });
  const w = createWalker({ fetchImpl: net.fetchImpl, sleep: async (ms) => { waits.push(ms); }, perHostMs: 1000 });
  await w.get('https://a.example.com/x');
  await w.get('https://a.example.com/y');
  assert.ok(waits.length >= 1 && waits.every((ms) => ms > 0 && ms <= 1000));
});

// ---------------------------------------------------------------- job boards

test('boards: detected in links, embeds and API calls; asset paths are ignored', () => {
  const html = `<a href="https://jobs.lever.co/examplebots">Jobs</a>
    <script src="https://boards.greenhouse.io/embed/job_board/js?for=exampleco"></script>
    <a href="https://jobs.ashbyhq.com/Example%20Labs/123">x</a> <a href="https://careers.smartrecruiters.com/ExampleCo1">y</a>
    <a href="https://apply.workable.com/example-ai/">z</a> <link href="https://boards.greenhouse.io/embed/css">`;
  assert.deepEqual(detectBoards(html).sort(), ['ashby:Example Labs', 'greenhouse:exampleco', 'lever:examplebots', 'smartrecruiters:ExampleCo1', 'workable:example-ai'].sort());
  assert.equal(boardFromFreehire({ source: 'greenhouse', external_id: 'exampleco:123' }), 'greenhouse:exampleco');
  assert.equal(boardFromFreehire({ source: 'telegram', external_id: 'x/1' }), null);
  assert.throws(() => parseCompany('monster:x'), /provider/);
});

test('postings: URL patterns map to board APIs; a 404 means closed', async () => {
  assert.equal(postingLookup('https://job-boards.greenhouse.io/exampleco/jobs/42').id, '42');
  assert.equal(postingLookup('https://jobs.lever.co/examplebots/0f0e0d0c-0b0a-4908-8706-050403020100').provider, 'lever');
  assert.equal(postingLookup('https://www.example.com/careers/?gh_jid=42'), null);
  assert.equal(postingLookup('https://www.example.com/careers/?gh_jid=42', '<script src="https://boards.greenhouse.io/embed/job_board/js?for=exampleco">').slug, 'exampleco');
  assert.equal(postingLookup('https://example.com/jobs/1'), null);
  const net = fakeNet({ 'https://boards-api.greenhouse.io/v1/boards/exampleco/jobs/42': 404 });
  const r = await postingLookup('https://job-boards.greenhouse.io/exampleco/jobs/42').read(makeGetJson(net.fetchImpl));
  assert.equal(r.closed, true);
});

test('boards: SmartRecruiters descriptions are fetched per posting; Workable maps to its board URL', async () => {
  const net = fakeNet({
    'https://api.smartrecruiters.com/v1/companies/ExampleCo1/postings?limit=100': { content: [{ id: '77', name: 'Data Intern', location: { fullLocation: 'Pune, India', remote: false }, releasedDate: '2026-10-01T00:00:00Z', typeOfEmployment: { label: 'Intern' } }, { id: '78', name: 'Senior Engineer', location: {} }] },
    'https://api.smartrecruiters.com/v1/companies/ExampleCo1/postings/77': { jobAd: { sections: { jobDescription: { text: `<p>${LONG}</p>` } } } },
    'https://apply.workable.com/api/v1/widget/accounts/example-ai?details=true': { jobs: [{ title: 'ML Intern', shortcode: 'AB12', telecommuting: true, country: 'India', published_on: '2026-10-02', employment_type: 'Internship', description: `<p>${LONG}</p>` }] },
  });
  const g = makeGetJson(net.fetchImpl);
  const sr = await readBoard(g, parseCompany('smartrecruiters:ExampleCo1=Example Co'), { match: /intern/i, sleep: noSleep });
  assert.equal(sr.jobs.length, 1);
  assert.equal(sr.jobs[0].source_url, 'https://jobs.smartrecruiters.com/ExampleCo1/77');
  assert.ok(sr.jobs[0].description.length > 200);
  const wk = await readBoard(g, parseCompany('workable:example-ai=Example AI'), { match: /intern/i });
  assert.equal(wk.jobs[0].source_url, 'https://apply.workable.com/example-ai/j/AB12/');
  assert.equal(wk.jobs[0].remote_type, 'remote');
});

// ---------------------------------------------------------------- startup discovery

const FH = [
  { source: 'greenhouse', external_id: 'exampleco:1', company: 'Example Co', title: 'SWE Intern', url: 'https://example.com/careers?gh_jid=1', collections: ['yc'], countries: ['in'], work_mode: 'remote' },
  { source: 'greenhouse', external_id: 'exampleco:2', company: 'Example Co', title: 'Data Intern', url: 'https://example.com/careers?gh_jid=2', collections: ['yc'] },
  { source: 'lever', external_id: 'stripe:abc', company: 'Known', title: 'Intern', url: 'https://jobs.lever.co/stripe/abc' },
  { source: 'keka', external_id: 'x:1', company: 'Example Labs', title: 'Intern', url: 'https://careers.example.org/jobs/1', collections: ['indian-roots'] },
  { source: 'telegram', external_id: 'c/1', company: 'Example Chat', title: 'Intern', url: 'https://t.me/c/1' },
];

test('discovery: freehire records become board suggestions; known boards and aggregator sites are left out', () => {
  const g = groupFreehire(FH, new Set(['lever:stripe']));
  assert.deepEqual(g.boards.map((b) => [b.spec, b.listings]), [['greenhouse:exampleco', 2]]);
  assert.deepEqual(g.boards[0].collections, ['yc']);
  const labs = g.leads.find((l) => l.company === 'Example Labs');
  assert.equal(labs.site, 'https://careers.example.org');
  assert.equal(g.leads.find((l) => l.company === 'Example Chat').site, null);
});

test('discovery: add-boards needs the user\'s words, skips unconfirmed boards, backs up, never duplicates', () => {
  const dir = makeDir();
  const before = readFileSync(join(dir, 'companies.txt'), 'utf8');
  const { file } = writeSuggestions(dir, 'test', [
    { spec: 'greenhouse:exampleco', company: 'Example Co', probe: { ok: true } },
    { spec: 'lever:examplebots', company: 'Example Bots', probe: { ok: false, error: 'HTTP 404' } },
  ], [], NOW);
  assert.throws(() => addBoards(dir, file, ['B1'], ''), /user's words/);
  const r = addBoards(dir, file, ['all'], 'add the first one', { now: NOW });
  assert.deepEqual(r.added.map((a) => a.spec), ['greenhouse:exampleco']);
  assert.match(r.skipped[0].reason, /not confirmed/);
  const after = readFileSync(join(dir, 'companies.txt'), 'utf8');
  assert.ok(after.startsWith(before) && /greenhouse:exampleco=Example Co/.test(after));
  assert.ok(readdirSync(join(dir, 'backups')).some((f) => f.startsWith('companies.txt.')));
  assert.equal(addBoards(dir, file, ['B1'], 'again', { now: NOW }).added.length, 0);
  assert.ok(knownBoards(join(dir, 'companies.txt')).has('greenhouse:exampleco'));
});

// ---------------------------------------------------------------- career-page walk

const GH_API = 'https://boards-api.greenhouse.io/v1/boards/exampleco/jobs?content=true';
const SITE = {
  'https://example.com/': '<html><head><title>Example Co</title></head><body><a href="/about">About</a> <a href="/careers">Careers</a></body></html>',
  'https://example.com/careers': '<html><head><title>Careers at Example Co</title></head><body><h1>Join us</h1><script src="https://boards.greenhouse.io/embed/job_board/js?for=exampleco"></script></body></html>',
  [GH_API]: { jobs: [
    { title: 'Software Engineering Intern', absolute_url: 'https://job-boards.greenhouse.io/exampleco/jobs/101', location: { name: 'Pune, India' }, first_published: '2026-10-20T00:00:00Z', content: `&lt;p&gt;${LONG}&lt;/p&gt;` },
    { title: 'Staff Engineer', absolute_url: 'https://job-boards.greenhouse.io/exampleco/jobs/102', location: { name: 'Remote' }, content: 'x' },
  ] },
};

test('walk: finds the careers page from the homepage, detects the embedded board, reads only internships', async () => {
  const dir = makeDir();
  const net = fakeNet(SITE);
  const r = await findSites(dir, [{ name: 'Example Co', site: 'example.com' }], {}, { fetchImpl: net.fetchImpl, sleep: noSleep });
  assert.deepEqual(r.report[0].careers_pages, ['https://example.com/careers']);
  assert.deepEqual(r.report[0].boards, ['greenhouse:exampleco']);
  assert.equal(r.jobs.length, 1);
  assert.equal(r.jobs[0].title, 'Software Engineering Intern');
  assert.equal(r.jobs[0].opened_source, true);
  assert.equal(r.boards[0].probe.intern_matches, 1);
  assert.equal(r.searches[0].status, 'completed');
});

test('walk: careers page without a board: internship links are opened; closed notices are kept; JS shells go to the reader', async () => {
  const dir = makeDir();
  const net = fakeNet({
    'https://example.org/careers': '<title>Careers</title><a href="/jobs/1">Product Design Intern</a> <a href="/jobs/2">Data Analyst Intern</a> <a href="/jobs/3">Head of Sales</a>',
    'https://example.org/jobs/1': `<title>Product Design Intern | Example Org</title><h1>Product Design Intern</h1><p>${LONG}</p>`,
    'https://example.org/jobs/2': `<title>Data Analyst Intern</title><h1>Data Analyst Intern</h1><p>This position has been filled. ${LONG}</p>`,
    'https://example.net/careers': '<title>Careers</title><div id="root"></div>',
  });
  const reader = async (url) => ({ ok: true, url, html: '<a href="https://jobs.lever.co/examplenet">Open roles</a>', text: 'Open roles', title: 'Careers', via: 'fake reader' });
  const r = await findSites(dir, [{ name: 'Example Org', site: 'https://example.org/careers' }, { name: 'Example Net', site: 'https://example.net/careers' }], {},
    { fetchImpl: async (u, i) => (u === 'https://api.lever.co/v0/postings/examplenet?mode=json' ? new Response('[]', { status: 200 }) : net.fetchImpl(u, i)), reader, sleep: noSleep });
  const org = r.jobs.filter((j) => j.company === 'Example Org');
  assert.deepEqual(org.map((j) => j.title), ['Product Design Intern', 'Data Analyst Intern']);
  assert.ok(org.every((j) => j.opened_source));
  assert.equal(org[1].closed, true);
  assert.match(r.report[1].rendered, /fake reader/);
  assert.deepEqual(r.report[1].boards, ['lever:examplenet']);
});

test('walk: an unreachable site is a failed search with the reason, never a guessed job', async () => {
  const dir = makeDir();
  const net = fakeNet({ 'https://nothing.example.com/robots.txt': 'User-agent: *\nDisallow: /' });
  const r = await findSites(dir, [{ name: 'Nothing', site: 'nothing.example.com' }], {}, { fetchImpl: net.fetchImpl, sleep: noSleep });
  assert.equal(r.searches[0].status, 'failed');
  assert.match(r.searches[0].error, /ROBOTS_DISALLOWED/);
  assert.equal(r.jobs.length, 0);
  assert.deepEqual(sitesFromBundle({ candidates: [{ url: 'https://www.linkedin.com/jobs/1' }, { url: 'https://example.com/careers/2' }] }).map((s) => s.site), ['https://example.com']);
});

// ---------------------------------------------------------------- verify, ingest, approve

const check = (draft, bundle, fixed) => spawnSync(process.execPath, [join(repoRoot, 'scripts/agent-reach-search.mjs'), 'check', draft, bundle, '--fix', fixed], { encoding: 'utf8' });
function saveVia(dir, label, r) {
  const b = join(dir, `${label}-bundle.json`), d = join(dir, `${label}-draft.json`), f = join(dir, `${label}-checked.json`);
  writeFileSync(b, JSON.stringify({ searches: r.searches, candidates: r.candidates }));
  writeFileSync(d, JSON.stringify({ run: { started_at: NOW, harness: 'claude-code' }, searches: r.searches, jobs: r.jobs }));
  check(d, b, f);
  return ingest(dir, JSON.parse(readFileSync(f, 'utf8')), { now: NOW, today: NOW.slice(0, 10) });
}

test('verify: discovered jobs become verified, closed or stay unverified; unreachable ones are untouched; approval follows', async () => {
  const dir = makeDir();
  const base = { source_kind: 'job_board', remote_type: 'unknown', employment_type: 'internship', opened_source: false };
  const seed = {
    run: { started_at: NOW, harness: 'claude-code' },
    searches: [{ key: 's1', source_name: 'freehire.me API', query: 'collections=yc', status: 'completed' }],
    jobs: [
      { ...base, search_key: 's1', company: 'Example Co', title: 'Software Engineering Intern', source_url: 'https://example.com/careers?gh_jid=101', apply_url: 'https://job-boards.greenhouse.io/exampleco/jobs/101' },
      { ...base, search_key: 's1', company: 'Example Co', title: 'Hardware Intern', source_url: 'https://example.com/careers?gh_jid=103', apply_url: 'https://job-boards.greenhouse.io/exampleco/jobs/103' },
      { ...base, search_key: 's1', company: 'Example Org', title: 'Design Intern', source_url: 'https://example.org/jobs/9' },
      { ...base, search_key: 's1', company: 'Example Net', title: 'QA Intern', source_url: 'https://example.net/jobs/5' },
      { ...base, search_key: 's1', company: 'Example Shell', title: 'Ops Intern', source_url: 'https://shell.example.com/jobs/5' },
    ],
  };
  const first = ingest(dir, seed, { now: NOW, today: NOW.slice(0, 10) });
  assert.ok(first.decisions.every((d) => d.status === 'discovered'));
  const net = fakeNet({
    'https://boards-api.greenhouse.io/v1/boards/exampleco/jobs/101': { title: 'Software Engineering Intern', location: { name: 'Pune' }, content: `&lt;p&gt;${LONG}&lt;/p&gt;` },
    'https://boards-api.greenhouse.io/v1/boards/exampleco/jobs/103': 404,
    'https://example.org/jobs/9': 404,
    'https://example.net/jobs/5': new Error('ENOTFOUND'),
    'https://shell.example.com/jobs/5': '<div id="app"></div>',
  });
  const { rows } = rowsToVerify(dir, [], ['discovered']);
  const v = await verifyJobs(rows, { fetchImpl: net.fetchImpl, sleep: noSleep, now: NOW });
  assert.deepEqual(v.results.map((x) => x.outcome), ['verified', 'closed', 'closed', 'not_reached', 'unverified']);
  assert.equal(v.searches[0].status, 'partial');
  const saved = saveVia(dir, 'verify', v);
  const status = Object.fromEntries(saved.decisions.map((d) => [d.job_id, d.status]));
  assert.deepEqual(status, { 'job-0001': 'verified', 'job-0002': 'expired', 'job-0003': 'expired', 'job-0005': 'discovered' });
  assert.throws(() => approveJob(dir, 'job-0005', 'user said yes', { now: NOW }), /verify/);
  assert.throws(() => approveJob(dir, 'job-0002', 'user said yes', { now: NOW }), /expired/);
  assert.equal(approveJob(dir, 'job-0001', 'user said: approve the Example Co internship', { now: NOW }).status, 'shortlisted');
  assert.throws(() => rowsToVerify(dir, ['job-0099']), /no such job/);
});

test('walk then save twice: the second run adds no duplicate rows', async () => {
  const dir = makeDir();
  const net = fakeNet(SITE);
  const deps = { fetchImpl: net.fetchImpl, sleep: noSleep };
  const a = saveVia(dir, 'walk1', await findSites(dir, [{ name: 'Example Co', site: 'example.com' }], {}, deps));
  const b = saveVia(dir, 'walk2', await findSites(dir, [{ name: 'Example Co', site: 'example.com' }], {}, deps));
  assert.equal(a.stats.new, 1);
  assert.equal(b.stats.new, 0);
  const rows = readFileSync(join(dir, 'jobs.csv'), 'utf8').trim().split('\n');
  assert.equal(rows.length, 2);
});

test('extraction: skills are whole-word vocabulary hits; location comes only from a labelled line', async () => {
  const { skillsIn, locationIn } = await import('../scripts/lib/careerwalk.mjs');
  assert.deepEqual(skillsIn('We use Python, React.js and C++ daily; Gophers welcome. Knowledge of R is a plus.'), ['Python', 'C++', 'R', 'React.js']);
  assert.deepEqual(skillsIn('Our CRM and BRAND team'), []);
  assert.deepEqual(locationIn('Title: Intern\nLocation: Pune, India\nApply now'), { location: 'Pune, India', remote_type: undefined });
  assert.deepEqual(locationIn('Location: Remote'), { location: undefined, remote_type: 'remote' });
  assert.deepEqual(locationIn('We are based in Pune.'), { location: undefined, remote_type: undefined });
});

// ---------------------------------------------------------------- scoring additions

const prof = (prefs) => ({ ...JSON.parse(readFileSync(join(repoRoot, 'tests/fixtures/candidate-profile.json'), 'utf8')), preferences: { target_roles: ['Software Engineering Intern'], locations: ['Near Pune, India'], remote_types: ['hybrid', 'remote'], industries: [], excluded_companies: [], deal_breakers: [], ...prefs } });

test('scoring: places come from the first part of each location; relocation and unpaid deal-breakers are real checks', () => {
  assert.deepEqual(homePlaces(prof({ locations: ['Near Pune, India', 'Anywhere in India', 'Remote only', 'Anywhere in my country'] })), ['pune', 'india']);
  const p = prof({ deal_breakers: ['Roles needing relocation', 'Unpaid roles'] });
  const job = { title: 'Software Engineering Intern', company: 'Example Co', employment_type: 'internship' };
  assert.equal(evaluate(p, { ...job, remote_type: 'onsite', location: 'Bengaluru, India' }).eligibility, 'fail');
  assert.notEqual(evaluate(p, { ...job, remote_type: 'hybrid', location: 'Pune, Maharashtra' }).eligibility, 'fail');
  assert.notEqual(evaluate(p, { ...job, remote_type: 'remote', location: 'Bengaluru' }).eligibility, 'fail');
  assert.notEqual(evaluate(p, { ...job, remote_type: 'unknown', location: 'Bengaluru' }).eligibility, 'fail');
  assert.equal(evaluate(p, { ...job, remote_type: 'remote', stipend_text: 'This is an unpaid internship' }).eligibility, 'fail');
  const near = evaluate(prof({}), { ...job, remote_type: 'hybrid', location: 'Pune, Maharashtra' });
  assert.match(near.rationale, /location 15\/15/);
});

test('scoring: part-time roles pass only when the profile accepts part-time', () => {
  const job = { title: 'Part-time Software Engineer', company: 'Example Co', employment_type: 'other', employment_label: 'Part-time' };
  assert.equal(evaluate(prof({}), job).eligibility, 'fail');
  assert.notEqual(evaluate(prof({ employment_types: ['Full-time internship', 'Part-time internship'] }), job).eligibility, 'fail');
});

// ---------------------------------------------------------------- profile gaps and probes

test('profile gaps: per-stage list from the fixture profile; questions include the new cards', () => {
  const dir = makeDir();
  const run = (...a) => spawnSync(process.execPath, [join(repoRoot, 'scripts/profile-store.mjs'), ...a], { encoding: 'utf8', env: { ...process.env, INTERNSHIP_AGENT_HOME: dir } });
  const g = JSON.parse(run('gaps').stdout);
  assert.deepEqual(Object.keys(g.stages), ['search', 'scoring', 'apply', 'outreach', 'submit']);
  assert.ok(g.stages.outreach.missing.some((m) => m.field === 'tone'));
  assert.ok(g.stages.search.missing.some((m) => m.field === 'employment_types'));
  assert.match(run('gaps', '--text').stdout, /Profile gaps/);
  const q = JSON.parse(run('questions').stdout);
  for (const f of ['company_types', 'show_gpa', 'pitch', 'achievements']) assert.ok(q.unanswered.includes(f), f);
});

test('profile save: new optional fields are validated; old profiles without them still save', () => {
  const dir = makeDir();
  const run = (...a) => spawnSync(process.execPath, [join(repoRoot, 'scripts/profile-store.mjs'), ...a], { encoding: 'utf8', env: { ...process.env, INTERNSHIP_AGENT_HOME: dir } });
  const p = JSON.parse(readFileSync(join(dir, 'candidate-profile.json'), 'utf8'));
  for (const k of ['education', 'experience', 'projects', 'skills', 'certifications']) p[k] = p[k].filter((e) => e.provenance !== 'inferred_unconfirmed');
  p.resume.source_path = null;
  const f = join(dir, 'p.json');
  writeFileSync(f, JSON.stringify(p));
  assert.equal(run('save', f).status, 0);
  p.preferences.show_gpa = 'yes'; p.outreach = { sender_email: 'not-an-email' }; p.achievements = [{ name: 'Hackathon winner', provenance: 'inferred_unconfirmed' }];
  writeFileSync(f, JSON.stringify(p));
  const bad = run('save', f);
  assert.equal(bad.status, 1);
  for (const re of [/show_gpa/, /sender_email/, /achievements\[0\]\.provenance/]) assert.match(bad.stderr, re);
});

test('probes: pdf and career-walk record what actually happened', async () => {
  const dir = makeDir();
  const ok = await probe(dir, 'pdf', { now: NOW, pdfImpl: () => ({ resume: { pages: 1, engine: 'stub' } }) });
  assert.equal(ok.status, 'verified');
  const bad = await probe(dir, 'pdf', { now: NOW, pdfImpl: () => { throw new Error('no browser'); } });
  assert.equal(bad.status, 'unsupported_or_unverified');
  const net = fakeNet({ 'https://job-boards.greenhouse.io/stripe': `<p>${LONG}</p>` });
  assert.equal((await probe(dir, 'career-walk', { now: NOW, fetchImpl: net.fetchImpl, sleep: noSleep })).status, 'verified');
  const off = fakeNet({ 'https://job-boards.greenhouse.io/robots.txt': new Error('offline') });
  assert.equal((await probe(dir, 'career-walk', { now: NOW, fetchImpl: off.fetchImpl, sleep: noSleep })).status, 'unsupported_or_unverified');
  assert.ok(existsSync(join(dir, 'sync-state.json')));
});
