// Mocked-result tests for the run-search helper. Run: node --test tests/search.test.mjs
// Uses only fictional data and a throwaway data directory; never touches ./private.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot, loadCsvSchemas, checkCsv } from '../scripts/lib/data.mjs';
import { parseCsv, serializeCsv } from '../scripts/lib/csv.mjs';
import { ingest, listJobs, checkReadiness, RefusedError } from '../scripts/lib/ingest.mjs';
import { canonicalUrl, dedupeKey } from '../scripts/lib/scoring.mjs';

const NOW = '2026-10-26T10:00:00Z';
const TODAY = '2026-10-26';
const schemas = loadCsvSchemas();

function makeDir({ profile = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'run-search-test-'));
  cpSync(join(repoRoot, 'templates/data'), dir, { recursive: true });
  if (profile) cpSync(join(repoRoot, 'tests/fixtures/candidate-profile.json'), join(dir, 'candidate-profile.json'));
  return dir;
}
const readCsv = (dir, name) => {
  const rows = parseCsv(readFileSync(join(dir, name), 'utf8'));
  return rows.slice(1).map((r) => Object.fromEntries(rows[0].map((h, i) => [h, r[i]])));
};
const profileOf = (dir) => JSON.parse(readFileSync(join(dir, 'candidate-profile.json'), 'utf8'));
const setProfile = (dir, fn) => { const p = profileOf(dir); fn(p); writeFileSync(join(dir, 'candidate-profile.json'), JSON.stringify(p, null, 2)); };
const run = (dir, input, opts = {}) => ingest(dir, input, { now: NOW, today: TODAY, ...opts });

const S1 = { key: 's1', source_name: 'Example Careers', query: 'software intern', status: 'completed' };
const job = (over = {}) => ({
  search_key: 's1', source_name: 'Example Careers', source_kind: 'company_site', source_url: 'https://careers.example.com/jobs/1',
  company: 'Example Robotics Inc.', title: 'Software Engineering Intern', location: 'Springfield, XX', remote_type: 'hybrid',
  employment_type: 'internship', duration: '12 weeks', start_date: '2027-06-01', deadline: '2026-12-15',
  skills: ['Python', 'ROS'], keywords: ['robotics', 'line following'], industry: 'robotics',
  eligibility: { grad_years: [2027, 2028] }, opened_source: true, verification_notes: 'Opened posting; matches.', ...over,
});

test('readiness: blank profile is refused and nothing is written', () => {
  const dir = makeDir({ profile: false });
  assert.equal(checkReadiness(profileOf(dir)).ready, false);
  assert.throws(() => run(dir, { searches: [S1], jobs: [job()] }), RefusedError);
  assert.equal(readCsv(dir, 'jobs.csv').length, 0);
  assert.equal(readCsv(dir, 'run-history.csv').length, 0);
});

test('readiness: fixture profile is ready', () => {
  assert.equal(checkReadiness(JSON.parse(readFileSync(join(repoRoot, 'tests/fixtures/candidate-profile.json'), 'utf8'))).ready, true);
});

test('persistence: new job, search and run rows validate, backups and sync state update', () => {
  const dir = makeDir();
  const r = run(dir, { run: { harness: 'claude-code' }, searches: [S1], jobs: [job()] });
  assert.equal(r.outcome, 'completed');
  assert.equal(r.stats.new, 1);
  const jobs = readCsv(dir, 'jobs.csv');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].job_id, 'job-0001');
  assert.equal(jobs[0].status, 'verified');
  assert.equal(jobs[0].last_verified_at, NOW);
  assert.equal(jobs[0].search_id, 'srch-0001');
  const sets = { 'search-history.csv': new Set(['srch-0001']), 'run-history.csv': new Set(['run-0001']) };
  for (const name of ['jobs.csv', 'search-history.csv', 'run-history.csv']) {
    assert.deepEqual(checkCsv(name, readFileSync(join(dir, name), 'utf8'), schemas[name], sets), [], name);
  }
  assert.equal(readCsv(dir, 'search-history.csv')[0].new_job_count, '1');
  assert.equal(readCsv(dir, 'run-history.csv')[0].harness, 'claude-code');
  assert.ok(readdirSync(join(dir, 'backups')).some((f) => f.startsWith('jobs.csv.')));
  const sync = JSON.parse(readFileSync(join(dir, 'sync-state.json'), 'utf8'));
  assert.equal(sync.last_run_id, 'run-0001');
  assert.equal(sync.lock.holder, null);
  assert.equal(sync.sources['Example Careers'].last_searched_at, NOW);
  rmSync(dir, { recursive: true });
});

test('duplicates: same listing twice in a batch, and again in a later run, stays one row', () => {
  const dir = makeDir();
  const dupe = job({ source_url: 'https://CAREERS.example.com/jobs/1/?utm_source=x#top' });
  const r1 = run(dir, { searches: [S1], jobs: [job(), dupe] });
  assert.equal(readCsv(dir, 'jobs.csv').length, 1);
  assert.equal(r1.stats.new, 1);
  assert.equal(r1.stats.duplicates_in_batch, 1);
  // different URL on another source, same company/title/location
  const r2 = run(dir, { searches: [{ ...S1, source_name: 'Example Board' }], jobs: [job({ source_name: 'Example Board', source_kind: 'job_board', source_url: 'https://jobs.example.org/listing/55' })] });
  assert.equal(readCsv(dir, 'jobs.csv').length, 1);
  assert.equal(r2.stats.new, 0);
  assert.equal(r2.stats.new + r2.stats.updated + r2.stats.unchanged, 1);
  assert.deepEqual(readCsv(dir, 'run-history.csv').map((x) => x.run_id), ['run-0001', 'run-0002']);
});

test('duplicates: same company and title match when one side has no location', () => {
  const dir = makeDir();
  run(dir, { searches: [S1], jobs: [job({ location: '' , source_url: 'https://careers.example.com/jobs/9', opened_source: false, verification_notes: '' })] });
  run(dir, { searches: [S1], jobs: [job({ source_url: 'https://other.example.org/p/9' })] });
  const rows = readCsv(dir, 'jobs.csv');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].location, 'Springfield, XX'); // filled from the second sighting
});

test('IDs: never reused and keep incrementing', () => {
  const dir = makeDir();
  run(dir, { searches: [S1], jobs: [job()] });
  run(dir, { searches: [S1], jobs: [job({ source_url: 'https://careers.example.com/jobs/2', title: 'Data Science Intern', company: 'Other Example Co' })] });
  assert.deepEqual(readCsv(dir, 'jobs.csv').map((r) => r.job_id), ['job-0001', 'job-0002']);
});

test('incomplete listing: unopened snippet stays discovered with provisional score and uncertainties', () => {
  const dir = makeDir();
  const r = run(dir, { searches: [S1], jobs: [job({ opened_source: false, verification_notes: '', location: '', deadline: '', start_date: '', duration: '', remote_type: 'unknown', skills: [], keywords: [], eligibility: undefined })] });
  const row = readCsv(dir, 'jobs.csv')[0];
  assert.equal(row.status, 'discovered');
  assert.equal(row.last_verified_at, '');
  assert.equal(row.verification_notes, '');
  assert.match(row.uncertainties, /not stated: location, deadline/);
  assert.match(row.fit_rationale, /^PROVISIONAL/);
  assert.deepEqual(r.unverified, ['job-0001']);
});

test('incomplete listing: opened_source without notes is not accepted as verified', () => {
  const dir = makeDir();
  run(dir, { searches: [S1], jobs: [job({ verification_notes: '' })] });
  const row = readCsv(dir, 'jobs.csv')[0];
  assert.equal(row.status, 'discovered');
  assert.match(row.uncertainties, /without verification_notes/);
});

test('incomplete listing: missing URL, company, or bad source_kind is skipped, never recorded', () => {
  const dir = makeDir();
  const r = run(dir, { searches: [S1], jobs: [job({ source_url: '' }), job({ company: '' }), job({ source_kind: 'made_up' }), job({ search_key: 'nope' })] });
  assert.equal(r.skipped.length, 4);
  assert.equal(readCsv(dir, 'jobs.csv').length, 0);
});

test('inaccessible source: failure is logged, its results are rejected, run is partial', () => {
  const dir = makeDir();
  const failed = { key: 's2', source_name: 'Blocked Board', query: 'intern', status: 'failed', error: 'HTTP 403 Forbidden' };
  const r = run(dir, { searches: [S1, failed], jobs: [job(), job({ search_key: 's2', source_url: 'https://blocked.example.com/1', company: 'Ghost Co' })] });
  assert.equal(r.outcome, 'partial');
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /search failed/);
  assert.deepEqual(r.inaccessible_sources, [{ source_name: 'Blocked Board', error: 'HTTP 403 Forbidden' }]);
  const rows = readCsv(dir, 'jobs.csv');
  assert.equal(rows.length, 1);
  const s = readCsv(dir, 'search-history.csv');
  assert.equal(s[1].status, 'failed');
  assert.equal(s[1].error, 'HTTP 403 Forbidden');
  assert.equal(s[1].result_count, '');
  const sync = JSON.parse(readFileSync(join(dir, 'sync-state.json'), 'utf8'));
  assert.equal(sync.sources['Blocked Board'], undefined);
});

test('inaccessible source: every search failed gives a failed run and zero job rows', () => {
  const dir = makeDir();
  const r = run(dir, { searches: [{ key: 'a', source_name: 'A', query: 'q', status: 'failed', error: 'timeout' }], jobs: [] });
  assert.equal(r.outcome, 'failed');
  assert.equal(readCsv(dir, 'jobs.csv').length, 0);
  const run1 = readCsv(dir, 'run-history.csv')[0];
  assert.equal(run1.outcome, 'failed');
  assert.match(run1.error, /A: timeout/);
});

test('inaccessible source: a failed search without an error message is rejected', () => {
  const dir = makeDir();
  assert.throws(() => run(dir, { searches: [{ key: 'a', source_name: 'A', query: 'q', status: 'failed' }], jobs: [] }), /error is required/);
  assert.equal(readCsv(dir, 'search-history.csv').length, 0);
});

test('expired: past deadline and page-closed flag both become expired', () => {
  const dir = makeDir();
  run(dir, { searches: [S1], jobs: [job({ deadline: '2026-10-01' }), job({ source_url: 'https://careers.example.com/jobs/2', company: 'B Example Co', closed: true })] });
  assert.deepEqual(readCsv(dir, 'jobs.csv').map((r) => r.status), ['expired', 'expired']);
});

test('expired: refreshing a verified listing that has closed moves it to expired', () => {
  const dir = makeDir();
  run(dir, { searches: [S1], jobs: [job()] });
  assert.equal(readCsv(dir, 'jobs.csv')[0].status, 'verified');
  const r = run(dir, { searches: [S1], jobs: [job({ closed: true, verification_notes: 'Page says position filled.' })] }, { now: '2026-11-02T10:00:00Z', today: '2026-11-02' });
  const row = readCsv(dir, 'jobs.csv')[0];
  assert.equal(row.status, 'expired');
  assert.equal(row.last_checked_at, '2026-11-02T10:00:00Z');
  assert.deepEqual(r.expired, ['job-0001']);
});

test('refresh: user-owned statuses are preserved; only expiry may move shortlisted', () => {
  const dir = makeDir();
  run(dir, { searches: [S1], jobs: [job()] });
  const rows = readCsv(dir, 'jobs.csv');
  rows[0].status = 'shortlisted';
  writeFileSync(join(dir, 'jobs.csv'), serializeCsv(Object.keys(rows[0]), rows));
  run(dir, { searches: [S1], jobs: [job()] });
  assert.equal(readCsv(dir, 'jobs.csv')[0].status, 'shortlisted');
  run(dir, { searches: [S1], jobs: [job({ closed: true })] });
  assert.equal(readCsv(dir, 'jobs.csv')[0].status, 'expired');
  // applied rows never change status
  const rows2 = readCsv(dir, 'jobs.csv'); rows2[0].status = 'applied';
  writeFileSync(join(dir, 'jobs.csv'), serializeCsv(Object.keys(rows2[0]), rows2));
  run(dir, { searches: [S1], jobs: [job({ closed: true })] });
  assert.equal(readCsv(dir, 'jobs.csv')[0].status, 'applied');
});

test('refresh: an unopened sighting never blanks or downgrades a verified record', () => {
  const dir = makeDir();
  run(dir, { searches: [S1], jobs: [job()] });
  run(dir, { searches: [S1], jobs: [job({ opened_source: false, verification_notes: '', location: '', deadline: '', duration: '', skills: [], keywords: [] })] });
  const row = readCsv(dir, 'jobs.csv')[0];
  assert.equal(row.status, 'verified');
  assert.equal(row.deadline, '2026-12-15');
  assert.equal(row.location, 'Springfield, XX');
  assert.equal(row.fit_score, '80');
});

test('refresh: a changed fact is updated and the change is recorded', () => {
  const dir = makeDir();
  run(dir, { searches: [S1], jobs: [job()] });
  const r = run(dir, { searches: [S1], jobs: [job({ deadline: '2027-01-10' })] });
  const row = readCsv(dir, 'jobs.csv')[0];
  assert.equal(row.deadline, '2027-01-10');
  assert.match(row.notes, /deadline 2026-12-15 -> 2027-01-10/);
  assert.equal(r.stats.updated, 1);
});

test('refresh: an identical re-sighting is unchanged and keeps updated_at', () => {
  const dir = makeDir();
  run(dir, { searches: [S1], jobs: [job()] });
  const r = run(dir, { searches: [S1], jobs: [job()] }, { now: '2026-10-27T10:00:00Z', today: '2026-10-27' });
  assert.equal(r.stats.unchanged, 1);
  const row = readCsv(dir, 'jobs.csv')[0];
  assert.equal(row.updated_at, NOW);
  assert.equal(row.last_checked_at, '2026-10-27T10:00:00Z');
});

test('scoring: transparent rubric gives the expected total and per-component breakdown', () => {
  const dir = makeDir();
  run(dir, { searches: [S1], jobs: [job()] });
  const row = readCsv(dir, 'jobs.csv')[0];
  assert.equal(row.eligibility_check, 'pass');
  assert.equal(row.fit_score, '80');
  for (const part of ['skills 15/30', 'role 25/25', 'location 15/15', 'availability 10/10', 'projects 5/10', 'industry 10/10']) assert.ok(row.fit_rationale.includes(part), part);
  assert.match(row.fit_rationale, /not a prediction of interview outcomes/);
});

test('scoring: a strong match outranks a weak one, and unevaluable components are excluded, not zeroed', () => {
  const dir = makeDir();
  run(dir, { searches: [S1], jobs: [
    job(),
    job({ source_url: 'https://careers.example.com/jobs/3', company: 'Weak Example Co', title: 'Marketing Intern', location: 'Faraway, YY', remote_type: 'onsite', skills: ['Photoshop'], keywords: [], industry: 'retail', start_date: '2027-09-01', duration: '6 weeks' }),
    job({ source_url: 'https://careers.example.com/jobs/4', company: 'Sparse Example Co', title: 'Software Engineering Intern', location: '', remote_type: 'unknown', duration: '', start_date: '', skills: [], keywords: [], industry: '', eligibility: undefined }),
  ] });
  const [strong, weak, sparse] = readCsv(dir, 'jobs.csv').map((r) => Number(r.fit_score));
  assert.ok(strong > weak, `${strong} should beat ${weak}`);
  assert.ok(sparse >= 90, `sparse listing scored only on its known role component (${sparse})`);
  assert.match(readCsv(dir, 'jobs.csv')[2].fit_rationale, /^LOW COVERAGE.*from 25% of the rubric weight/);
  assert.doesNotMatch(readCsv(dir, 'jobs.csv')[0].fit_rationale, /LOW COVERAGE/);
});

test('search history: a caller-supplied result_count is honored in both the CSV and the report', () => {
  const dir = makeDir();
  const r = run(dir, { searches: [{ ...S1, result_count: 9 }], jobs: [job()] });
  assert.equal(readCsv(dir, 'search-history.csv')[0].result_count, '9');
  assert.equal(r.sources_searched[0].result_count, 9);
  assert.equal(r.sources_searched[0].recorded_jobs, 1);
});

test('scoring: unconfirmed (inferred) profile skills never count as matches', () => {
  const dir = makeDir();
  run(dir, { searches: [S1], jobs: [job({ skills: ['Figma'] })] });
  assert.match(readCsv(dir, 'jobs.csv')[0].fit_rationale, /skills 0\/30 \(matched 0\/1\)/);
});

test('eligibility: each hard failure blocks scoring and auto-rejects with a reason', () => {
  const cases = [
    ['non-internship type', {}, { employment_type: 'other' }, /not an internship/],
    ['graduation year', {}, { eligibility: { grad_years: [2030] } }, /requires graduation in 2030/],
    ['work authorization', {}, { eligibility: { countries: ['ZZ'] } }, /work authorization in ZZ/],
    ['deal-breaker', {}, { stipend_text: 'Unpaid, for course credit' }, /deal-breaker "unpaid"/],
    ['excluded company', (p) => { p.preferences.excluded_companies = ['Example Robotics Inc.']; }, {}, /excluded list/],
  ];
  for (const [name, mutate, over, re] of cases) {
    const dir = makeDir();
    if (typeof mutate === 'function') setProfile(dir, mutate);
    run(dir, { searches: [S1], jobs: [job(over)] });
    const row = readCsv(dir, 'jobs.csv')[0];
    assert.equal(row.eligibility_check, 'fail', name);
    assert.equal(row.fit_score, '', name);
    assert.equal(row.status, 'rejected', name);
    assert.match(row.notes, /^\[auto-rejected\]/, name);
    assert.match(row.fit_rationale, re, name);
    assert.deepEqual(checkCsv('jobs.csv', readFileSync(join(dir, 'jobs.csv'), 'utf8'), schemas['jobs.csv'], { 'search-history.csv': new Set(['srch-0001']) }), [], name);
  }
});

test('eligibility: stated requirements the profile cannot confirm give unknown, not pass or fail', () => {
  const dir = makeDir();
  setProfile(dir, (p) => { p.identity.work_authorization.countries = []; });
  run(dir, { searches: [S1], jobs: [job({ eligibility: { countries: ['XX'] } })] });
  const row = readCsv(dir, 'jobs.csv')[0];
  assert.equal(row.eligibility_check, 'unknown');
  assert.notEqual(row.status, 'rejected');
  assert.match(row.fit_rationale, /Eligibility unconfirmed/);
});

test('eligibility: an auto-rejected record is restored when a refresh shows it now qualifies', () => {
  const dir = makeDir();
  run(dir, { searches: [S1], jobs: [job({ eligibility: { grad_years: [2030] } })] });
  assert.equal(readCsv(dir, 'jobs.csv')[0].status, 'rejected');
  run(dir, { searches: [S1], jobs: [job({ eligibility: { grad_years: [2028] } })] });
  const row = readCsv(dir, 'jobs.csv')[0];
  assert.equal(row.status, 'verified');
  assert.equal(row.eligibility_check, 'pass');
  assert.ok(!row.notes.includes('[auto-rejected]'));
});

test('eligibility: a user rejection is never overridden by search', () => {
  const dir = makeDir();
  run(dir, { searches: [S1], jobs: [job()] });
  const rows = readCsv(dir, 'jobs.csv'); rows[0].status = 'rejected'; rows[0].notes = 'Not interested.';
  writeFileSync(join(dir, 'jobs.csv'), serializeCsv(Object.keys(rows[0]), rows));
  run(dir, { searches: [S1], jobs: [job()] });
  assert.equal(readCsv(dir, 'jobs.csv')[0].status, 'rejected');
});

test('lock: a held lock refuses the run and leaves files untouched', () => {
  const dir = makeDir();
  const sync = JSON.parse(readFileSync(join(dir, 'sync-state.json'), 'utf8'));
  sync.lock = { holder: 'run-0099', acquired_at: NOW };
  writeFileSync(join(dir, 'sync-state.json'), JSON.stringify(sync));
  assert.throws(() => run(dir, { searches: [S1], jobs: [job()] }), RefusedError);
  assert.equal(readCsv(dir, 'jobs.csv').length, 0);
});

test('persistence: a corrupted jobs.csv is refused, not silently repaired', () => {
  const dir = makeDir();
  writeFileSync(join(dir, 'jobs.csv'), 'wrong,header\n1,2\n');
  assert.throws(() => run(dir, { searches: [S1], jobs: [job()] }), /header does not match/);
  assert.equal(readFileSync(join(dir, 'jobs.csv'), 'utf8'), 'wrong,header\n1,2\n');
});

test('persistence: listJobs supports refresh by status', () => {
  const dir = makeDir();
  run(dir, { searches: [S1], jobs: [job(), job({ source_url: 'https://careers.example.com/jobs/8', company: 'Late Example Co', closed: true })] });
  assert.deepEqual(listJobs(dir, ['verified']).map((j) => j.job_id), ['job-0001']);
  assert.equal(listJobs(dir).length, 2);
});

test('csv: round-trips commas, quotes, and newlines', () => {
  const header = ['a', 'b', 'c'];
  const recs = [{ a: 'x,y', b: 'say "hi"', c: 'line1\nline2' }, { a: '', b: 'plain', c: '' }];
  const back = parseCsv(serializeCsv(header, recs));
  assert.deepEqual(back[1], ['x,y', 'say "hi"', 'line1\nline2']);
  assert.deepEqual(back[2], ['', 'plain', '']);
});

test('helpers: canonical URLs and dedupe keys', () => {
  assert.equal(canonicalUrl('HTTPS://Example.com/a/b/?utm_medium=x&id=3#frag'), 'https://example.com/a/b?id=3');
  assert.equal(dedupeKey('Example Robotics Inc.', 'Software Engineering Intern', 'Springfield, XX'), 'example robotics inc|software engineering intern|springfield xx');
});
