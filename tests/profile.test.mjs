// Tests for the profile-setup helper. Run: node --test tests/profile.test.mjs
// Uses only fictional data and a throwaway data directory; never touches ./private.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoRoot } from '../scripts/lib/data.mjs';

const script = join(repoRoot, 'scripts/profile-store.mjs');
const makeDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-test-'));
  cpSync(join(repoRoot, 'templates/data'), dir, { recursive: true });
  return dir;
};
const run = (dir, ...a) => spawnSync(process.execPath, [script, ...a], { encoding: 'utf8', env: { ...process.env, INTERNSHIP_AGENT_HOME: dir } });
const fixture = () => {
  const p = JSON.parse(readFileSync(join(repoRoot, 'tests/fixtures/candidate-profile.json'), 'utf8'));
  for (const k of ['education', 'experience', 'projects', 'skills', 'certifications']) p[k] = p[k].filter((e) => e.provenance !== 'inferred_unconfirmed');
  return p;
};
const write = (dir, name, o) => { const f = join(dir, name); writeFileSync(f, JSON.stringify(o)); return f; };

test('save: refuses a fact that is not confirmed', () => {
  const dir = makeDir();
  const p = fixture();
  p.skills.push({ name: 'Rust', provenance: 'inferred_unconfirmed' });
  const r = run(dir, 'save', write(dir, 'in.json', p));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unconfirmed facts are not saved/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'candidate-profile.json'), 'utf8')).updated_at, null);
});

test('save: refuses a resume path that does not exist or is absolute', () => {
  const dir = makeDir();
  const p = fixture();
  p.resume.source_path = 'resumes/missing.pdf';
  assert.equal(run(dir, 'save', write(dir, 'a.json', p)).status, 1);
  p.resume.source_path = 'C:/Users/x/resume.pdf';
  assert.match(run(dir, 'save', write(dir, 'b.json', p)).stderr, /relative/);
});

test('attach-resume then save: profile becomes ready, backup made on second save', () => {
  const dir = makeDir();
  const src = join(dir, 'my-resume.txt');
  writeFileSync(src, 'fictional resume');
  const att = JSON.parse(run(dir, 'attach-resume', src).stdout);
  assert.equal(att.source_path, 'resumes/my-resume.txt');
  const p = fixture();
  p.resume.source_path = att.source_path;
  p.resume.parsed_at = null;
  const r1 = run(dir, 'save', write(dir, 'in.json', p));
  assert.equal(r1.status, 0, r1.stderr);
  const saved = JSON.parse(r1.stdout);
  assert.equal(saved.readiness.ready, true);
  assert.ok(JSON.parse(readFileSync(join(dir, 'candidate-profile.json'), 'utf8')).resume.parsed_at);
  assert.equal(run(dir, 'save', write(dir, 'in2.json', p)).status, 0);
  assert.ok(readdirSync(join(dir, 'backups')).some((f) => f.startsWith('candidate-profile-')));
  assert.ok(!existsSync(join(dir, 'candidate-profile.json.tmp')));
});

test('questions: blank profile gets all cards in batches of 4; answered ones are not asked again', () => {
  const dir = makeDir();
  const first = JSON.parse(run(dir, 'questions').stdout);
  assert.equal(first.unanswered.length, 8);
  assert.deepEqual(first.batches.map((b) => b.length), [4, 4]);
  for (const q of first.batches.flat()) {
    assert.ok(q.options.length >= 2 && q.options.length <= 4 && q.header.length <= 12, q.field);
  }
  const p = JSON.parse(readFileSync(join(dir, 'candidate-profile.json'), 'utf8'));
  p.provenance = { 'preferences.target_roles': 'user_stated', 'preferences.min_stipend_text': 'user_stated' };
  writeFileSync(join(dir, 'candidate-profile.json'), JSON.stringify(p));
  const second = JSON.parse(run(dir, 'questions').stdout);
  assert.equal(second.unanswered.length, 6);
  assert.ok(!second.unanswered.includes('target_roles') && !second.unanswered.includes('stipend'));
});

test('show: blank profile reports what is missing', () => {
  const dir = makeDir();
  const r = JSON.parse(run(dir, 'show').stdout);
  assert.equal(r.readiness.ready, false);
  assert.ok(r.readiness.missing.includes('identity.full_name'));
});
