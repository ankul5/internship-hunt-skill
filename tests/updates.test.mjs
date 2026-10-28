// Tests for check-updates (windows, checkpoints, dedupe, recovery), follow-ups, job-status and the tracker repair.
// Run: node --test tests/updates.test.mjs. Fake mail clients only: no mailbox is read and nothing is sent. Fictional data, throwaway folders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { repoRoot, loadCsvSchemas } from '../scripts/lib/data.mjs';
import { parseCsv, serializeCsv } from '../scripts/lib/csv.mjs';
import { RefusedError } from '../scripts/lib/ingest.mjs';
import { AuthError, RateLimitError } from '../scripts/lib/gmail.mjs';
import { setIntegration } from '../scripts/lib/outbound.mjs';
import { resolveWindow, planCheck, recordCheck, checkGmailApi, mergeIntervals, gaps, setTimezone, updatesState, readCheckLog } from '../scripts/lib/updates.mjs';
import { pendingEvents, confirmEvent } from '../scripts/lib/inbox.mjs';
import { _hooks, JOURNAL } from '../scripts/lib/journal.mjs';
import { followUpReport, setPrefs, draft as draftFollowUp, skip as skipFollowUp } from '../scripts/lib/followups.mjs';
import { messageCard, approveMessage, sendWithIntegration } from '../scripts/lib/contact.mjs';
import { jobStatus, renderStatus } from '../scripts/lib/status.mjs';
import { check, plan, apply } from '../scripts/lib/tracker.mjs';

const schemas = loadCsvSchemas();
const NOW = '2026-10-27T12:00:00Z';
const sha = (s) => createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------------- fixtures

const row = (file, over) => { const h = schemas[file].columns.map((c) => c.name); return Object.fromEntries(h.map((k) => [k, over[k] ?? ''])); };
const job = (id, company, title, over = {}) => row('jobs.csv', { job_id: id, status: 'applied', company, title, remote_type: 'remote', employment_type: 'internship', source_name: 'Example Careers', source_kind: 'company_site',
  source_url: `https://careers.example.com/jobs/${id}`, apply_url: `https://careers.example.com/jobs/${id}/apply`, discovered_at: '2026-10-01T09:00:00Z', last_checked_at: '2026-10-02T09:00:00Z', last_verified_at: '2026-10-02T09:00:00Z',
  verification_notes: 'Opened posting.', eligibility_check: 'pass', dedupe_key: `${company}|${title}`.toLowerCase(), updated_at: '2026-10-02T09:00:00Z', ...over });
const app = (id, jobId, status, over = {}) => row('applications.csv', { application_id: id, job_id: jobId, status, created_at: '2026-10-05T09:00:00Z', updated_at: '2026-10-05T09:00:00Z',
  ...(['submitted', 'acknowledged', 'interview'].includes(status) ? { approved_at: '2026-10-06T10:00:00Z', approval_note: 'Yes.', submission_method: 'portal', submitted_at: '2026-10-06T10:05:00Z', submission_result: 'success', confirmation_evidence: '[confirmation_page] Application received' } : {}), ...over });
const sentEvent = (id, appId, jobId, at, over = {}) => row('email-events.csv', { event_id: id, application_id: appId, job_id: jobId, direction: 'outbound', kind: 'recruiter_outreach', status: 'sent', provider: 'gmail',
  contact_name: 'Sam Recruiter', contact_email: 'sam@robotics.example.com', contact_source_url: 'https://careers.example.com/team', subject: 'Software Engineering Intern application', thread_id: `t-${id}`, provider_message_id: `gm-${id}`,
  draft_path: `drafts/${id}.md`, approved_at: at, occurred_at: at, summary: '[gmail] Sent via gmail.', created_at: at, updated_at: at, ...over });

function makeDir({ jobs, apps, events = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'updates-test-'));
  cpSync(join(repoRoot, 'templates/data'), dir, { recursive: true });
  cpSync(join(repoRoot, 'tests/fixtures/candidate-profile.json'), join(dir, 'candidate-profile.json'));
  jobs ??= [job('job-0001', 'Example Robotics Inc.', 'Software Engineering Intern'), job('job-0002', 'Example Robotics Inc.', 'Data Science Intern'), job('job-0003', 'Northwind Labs', 'Backend Intern')];
  apps ??= [app('app-0001', 'job-0001', 'submitted'), app('app-0002', 'job-0002', 'submitted'), app('app-0003', 'job-0003', 'submitted')];
  writeFileSync(join(dir, 'jobs.csv'), serializeCsv(Object.keys(jobs[0]), jobs));
  writeFileSync(join(dir, 'applications.csv'), serializeCsv(Object.keys(apps[0]), apps));
  if (events.length) writeFileSync(join(dir, 'email-events.csv'), serializeCsv(Object.keys(events[0]), events));
  mkdirSync(join(dir, 'backups'), { recursive: true });
  return dir;
}
const csv = (dir, name) => { const rows = parseCsv(readFileSync(join(dir, name), 'utf8')); return rows.slice(1).map((r) => Object.fromEntries(rows[0].map((h, i) => [h, r[i]]))); };
const appRow = (dir, id) => csv(dir, 'applications.csv').find((a) => a.application_id === id);
const events = (dir) => csv(dir, 'email-events.csv');
const sync = (dir) => JSON.parse(readFileSync(join(dir, 'sync-state.json'), 'utf8'));
const verify = (dir, name) => setIntegration(dir, name, 'verified', 'test: fake client answered a read', NOW);

// Messages in Gmail API format, and a fake client that applies after:/before: like Gmail search, two ids per page.
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const apiMsg = ({ id, from, subject, body, at, thread = `t-${id}` }) => ({ id, threadId: thread, internalDate: String(Date.parse(at)), snippet: body.slice(0, 60),
  payload: { mimeType: 'multipart/alternative', headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }, { name: 'Message-ID', value: `<${id}@mail.example.com>` }], parts: [{ mimeType: 'text/plain', body: { data: b64(body) } }] } });
function fakeClient(msgs, { authError = null, rateLimitAtPage = null } = {}) {
  const c = { lists: 0, gets: 0,
    async listMessages({ query, pageToken }) {
      c.lists += 1;
      if (authError) throw new AuthError('the "read" permission was not granted; authorize it separately (nothing was requested or sent)', authError);
      const a = Number(query.match(/after:(\d+)/)[1]), b = Number(query.match(/before:(\d+)/)[1]);
      const ids = msgs.filter((m) => { const t = Date.parse(m.at) / 1000; return t >= a && t < b; }).map((m) => m.id);
      const page = Number(pageToken || 0);
      if (rateLimitAtPage != null && page >= rateLimitAtPage) throw new RateLimitError('rate limited: Rate limit exceeded', '30');
      return { ids: ids.slice(page * 2, page * 2 + 2), next: (page + 1) * 2 < ids.length ? String(page + 1) : null };
    },
    async getMessage(id) { c.gets += 1; return apiMsg(msgs.find((m) => m.id === id)); } };
  return c;
}
const INT = { id: 'g-int', from: 'Example Robotics Recruiting <recruiting@robotics.example.com>', subject: 'Interview invitation: Software Engineering Intern', body: 'We would like to schedule a call. Please share your availability.', at: '2026-10-26T08:00:00Z' };
const REJ = { id: 'g-rej', from: 'Example Robotics <hr@robotics.example.com>', subject: 'Data Science Intern application update', body: 'Unfortunately we will not be moving forward with your application.', at: '2026-10-26T09:00:00Z' };
const CONFLICT = { id: 'g-conf', from: 'Northwind Labs <jobs@northwind.example.org>', subject: 'Backend Intern: interview feedback', body: 'Unfortunately we are not moving forward after the interview.', at: '2026-10-26T10:00:00Z' };
const ACK = { id: 'g-ack', from: 'Northwind Labs <jobs@northwind.example.org>', subject: 'Backend Intern: thank you for applying', body: 'We have received your application and will be in touch.', at: '2026-10-25T10:00:00Z' };
const SALE = { id: 'g-sale', from: 'Deals <news@shop.example.net>', subject: 'Big sale', body: 'Everything half price.', at: '2026-10-26T11:00:00Z' };
const norm = (x) => ({ id: x.id, thread_id: `t-${x.id}`, received_at: x.at, from_name: x.from.split(' <')[0], from_email: x.from.match(/<(.+)>/)[1], subject: x.subject, snippet: x.body, body_text: x.body, links: [] });

// ================================================================ windows

test('windows: today, yesterday and dates use the user\'s offset; 7d is exact; last-sync needs a real checkpoint', () => {
  const dir = makeDir();
  const now = '2026-10-27T04:00:00Z'; // 09:30 in UTC+05:30
  assert.deepEqual([resolveWindow(dir, 'today', { source: 'gmail-api', now, tz: '+05:30' }).from], ['2026-10-26T18:30:00Z']);
  const y = resolveWindow(dir, 'yesterday', { source: 'gmail-api', now, tz: '+05:30' });
  assert.deepEqual([y.from, y.to], ['2026-10-25T18:30:00Z', '2026-10-26T18:30:00Z']);
  assert.equal(resolveWindow(dir, '7d', { source: 'gmail-api', now }).from, '2026-10-20T04:00:00Z');
  assert.equal(resolveWindow(dir, '2026-10-20', { source: 'gmail-api', now, tz: '-04:00' }).from, '2026-10-20T04:00:00Z');
  assert.throws(() => resolveWindow(dir, '2026-11-20', { source: 'gmail-api', now }), RefusedError);
  assert.throws(() => resolveWindow(dir, 'last-sync', { source: 'gmail-api', now }), (e) => e instanceof RefusedError && /never been checked completely/.test(e.message));
  assert.throws(() => resolveWindow(dir, 'last-week', { source: 'gmail-api', now }), /--since must be/);
  setTimezone(dir, '+05:30');
  assert.equal(resolveWindow(dir, 'today', { source: 'gmail-api', now }).tz_offset, '+05:30', 'a saved offset is used when none is given');
  assert.throws(() => setTimezone(dir, 'IST'), /must look like/);
});

test('plan: states the exact window and query, whether the source is usable, and what cannot be checked at all', () => {
  const dir = makeDir();
  const p = planCheck(dir, { since: '7d', source: 'gmail-connector', now: NOW });
  assert.equal(p.ready, false, 'an unverified connector is not assumed to work');
  assert.match(p.query, /^after:\d+ before:\d+ -from:me$/);
  assert.equal(p.window.window_support, 'observed');
  assert.ok(p.not_checked.some((x) => x.id === 'linkedin') && !p.not_checked.some((x) => x.id === 'gmail'));
  assert.ok(p.rules.some((r) => /date-filter-evidence/.test(r)));
  assert.equal(planCheck(dir, { since: '7d', source: 'pasted', now: NOW }).ready, true);
  assert.equal(planCheck(dir, { since: '7d', source: 'pasted', now: NOW }).query, null);
});

test('intervals: merge overlapping ranges and report the gaps honestly', () => {
  const m = mergeIntervals([['2026-10-20T00:00:00Z', '2026-10-22T00:00:00Z'], ['2026-10-21T00:00:00Z', '2026-10-23T00:00:00Z'], ['2026-10-25T00:00:00Z', '2026-10-26T00:00:00Z']]);
  assert.deepEqual(m, [['2026-10-20T00:00:00Z', '2026-10-23T00:00:00Z'], ['2026-10-25T00:00:00Z', '2026-10-26T00:00:00Z']]);
  assert.deepEqual(gaps(m, '2026-10-19T00:00:00Z', '2026-10-27T00:00:00Z'), [['2026-10-19T00:00:00Z', '2026-10-20T00:00:00Z'], ['2026-10-23T00:00:00Z', '2026-10-25T00:00:00Z'], ['2026-10-26T00:00:00Z', '2026-10-27T00:00:00Z']]);
  assert.deepEqual(gaps([], 'a', 'b'), [['a', 'b']]);
});

// ================================================================ gmail api checks

test('repeated syncs: the second check of the same range records nothing new and still moves the checkpoint', async () => {
  const dir = makeDir();
  const c = fakeClient([INT, REJ, ACK, SALE]);
  const r1 = await checkGmailApi(dir, c, { since: '7d', now: NOW });
  assert.equal(r1.complete, true);
  assert.equal(r1.checkpoint_advanced, true);
  assert.equal(r1.recorded.length, 3);
  assert.equal(r1.unrelated, 1, 'the sale email is not stored');
  assert.equal(appRow(dir, 'app-0001').status, 'interview');
  assert.equal(appRow(dir, 'app-0002').status, 'rejected');
  assert.equal(appRow(dir, 'app-0003').status, 'acknowledged');
  const r2 = await checkGmailApi(dir, c, { since: '7d', now: '2026-10-27T13:00:00Z' });
  assert.equal(r2.recorded.length, 0);
  assert.equal(r2.duplicates, 3);
  assert.equal(events(dir).length, 3, 'no event is recorded twice');
  assert.equal(updatesState(dir).sources['gmail-api'].covered.length, 1, 'the two windows merge into one');
  assert.equal(updatesState(dir).sources['gmail-api'].covered[0][1], '2026-10-27T13:00:00Z');
  assert.match(sync(dir).gmail.cursor, /^\d+$/, 'the older gmail cursor is kept in step');
  assert.ok(readCheckLog(dir).filter((e) => e.event === 'checkpoint_advanced').length === 2);
});

test('overlapping ranges: last-sync re-reads an hour of overlap, and a message seen in both ranges is recorded once', async () => {
  const dir = makeDir();
  const late = { ...REJ, at: '2026-10-27T11:30:00Z' }; // indexed late: inside the overlap of the next check
  await checkGmailApi(dir, fakeClient([INT, late]), { since: 'today', now: NOW, tz: '+00:00' });
  const r = await checkGmailApi(dir, fakeClient([INT, late, CONFLICT]), { since: 'last-sync', now: '2026-10-27T15:00:00Z' });
  assert.equal(r.window.from, '2026-10-27T11:00:00Z', 'starts one hour before the last checkpoint');
  assert.equal(r.duplicates, 1);
  assert.equal(events(dir).filter((e) => e.provider_message_id === 'g-rej').length, 1);
  const y = await checkGmailApi(dir, fakeClient([INT, late, CONFLICT]), { since: '7d', now: '2026-10-27T15:00:00Z' });
  assert.equal(y.recorded.length, 2, 'INT and CONFLICT (26 Oct, outside the earlier windows) are new; the late one is not');
  assert.equal(y.duplicates, 1);
  assert.equal(new Set(events(dir).map((e) => e.provider_message_id)).size, events(dir).length);
});

test('missing permissions: nothing is recorded, the checkpoint stays, and the integration is marked as needing authorization', async () => {
  const dir = makeDir();
  verify(dir, 'gmail-read');
  const r = await checkGmailApi(dir, fakeClient([INT], { authError: 'missing_scope' }), { since: '7d', now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'missing_scope');
  assert.equal(r.checkpoint_advanced, false);
  assert.equal(existsSync(join(dir, 'email-events.csv')) ? events(dir).length : 0, 0);
  assert.equal(sync(dir).integrations['gmail-read'].status, 'possible_unconfigured');
  assert.equal(updatesState(dir).sources['gmail-api'], undefined);
  assert.equal(readCheckLog(dir).at(-1).event, 'check_failed');
});

test('partial fetch: a rate limit records what was fetched but keeps the checkpoint; the next check fills in without duplicates', async () => {
  const dir = makeDir();
  const r = await checkGmailApi(dir, fakeClient([INT, REJ, ACK, CONFLICT], { rateLimitAtPage: 1 }), { since: '7d', now: NOW });
  assert.equal(r.complete, false);
  assert.match(r.stopped, /rate limited/);
  assert.equal(r.checkpoint_advanced, false);
  assert.ok(r.checkpoint_kept_because.some((x) => /did not reach the end/.test(x)));
  const first = events(dir).length;
  assert.ok(first > 0 && first < 4);
  const r2 = await checkGmailApi(dir, fakeClient([INT, REJ, ACK, CONFLICT]), { since: '7d', now: NOW });
  assert.equal(r2.checkpoint_advanced, true);
  assert.equal(r2.duplicates, first);
  assert.equal(events(dir).length, 4);
});

test('duplicate messages: repeats in one batch, the same email through a connector, and the same email pasted without an id', async () => {
  const dir = makeDir();
  verify(dir, 'gmail-connector');
  const w = resolveWindow(dir, '7d', { source: 'gmail-connector', now: NOW });
  const r = recordCheck(dir, { source: 'gmail-connector', window: w, messages: [norm(INT), norm(INT), norm(REJ)], complete: true, dateFilterEvidence: 'all results dated inside the window', now: NOW });
  assert.equal(r.recorded.length, 2);
  assert.equal(r.duplicates, 1);
  const pasted = { ...norm(INT), id: undefined, subject: `Re: ${INT.subject}` }; // pasted, no id, with Re:
  const p = recordCheck(dir, { source: 'pasted', window: w, messages: [pasted], now: NOW });
  assert.equal(p.duplicates, 1, 'same sender, subject and time is the same email');
  assert.equal(p.checkpoint_advanced, false, 'pasted mail never moves a checkpoint');
  const fresh = { ...norm(CONFLICT), id: undefined };
  const p2 = recordCheck(dir, { source: 'pasted', window: w, messages: [fresh], now: NOW });
  assert.match(events(dir).find((e) => e.event_id === p2.recorded[0].event_id).provider_message_id, /^stable-[0-9a-f]{16}$/);
  assert.equal(recordCheck(dir, { source: 'pasted', window: w, messages: [fresh], now: NOW }).duplicates, 1, 'pasting the same email twice is a duplicate');
  assert.equal(events(dir).find((e) => e.provider_message_id.startsWith('stable-')).provider, 'manual');
});

test('own mail is skipped: the user\'s sent messages are not updates', () => {
  const dir = makeDir();
  const w = resolveWindow(dir, '7d', { source: 'pasted', now: NOW });
  const mine = { ...norm(INT), id: 'g-mine', from_email: 'alex.example@example.com', from_name: 'Alex Example', subject: 'Re: Interview invitation: Software Engineering Intern' };
  const r = recordCheck(dir, { source: 'pasted', window: w, messages: [mine], now: NOW });
  assert.equal(r.own_messages, 1);
  assert.equal(r.recorded.length, 0);
});

test('connector date range: never assumed; the checkpoint moves only with observed filtering, a complete fetch, and nothing outside the window', () => {
  const dir = makeDir();
  const w = resolveWindow(dir, '2026-10-26', { source: 'gmail-connector', now: NOW, tz: '+00:00' });
  const a = recordCheck(dir, { source: 'gmail-connector', window: w, messages: [norm(INT)], complete: true, now: NOW });
  assert.equal(a.checkpoint_advanced, false);
  assert.ok(a.checkpoint_kept_because.some((x) => /date filter was not observed/.test(x)));
  const b = recordCheck(dir, { source: 'gmail-connector', window: w, messages: [norm(REJ), norm(ACK)], complete: true, dateFilterEvidence: 'checked', now: NOW });
  assert.equal(b.outside_window, 1, 'ACK (25 Oct) is outside the window');
  assert.equal(b.checkpoint_advanced, false);
  assert.ok(b.checkpoint_kept_because.some((x) => /outside the window/.test(x)));
  assert.equal(events(dir).some((e) => e.provider_message_id === 'g-ack'), false, 'out-of-window mail is not recorded as part of this range');
  const c = recordCheck(dir, { source: 'gmail-connector', window: w, messages: [norm(CONFLICT)], complete: false, dateFilterEvidence: 'checked', now: NOW });
  assert.equal(c.checkpoint_advanced, false);
  const d = recordCheck(dir, { source: 'gmail-connector', window: w, messages: [norm(CONFLICT)], complete: true, dateFilterEvidence: 'every result was dated 26 Oct', now: NOW });
  assert.equal(d.checkpoint_advanced, true);
  assert.deepEqual(d.covered, [[w.from, w.to]]);
  assert.throws(() => recordCheck(dir, { source: 'gmail-connector', window: { from: w.to, to: w.from }, messages: [], now: NOW }), /from < to/);
});

test('uncertain status: a conflicting or ambiguous email changes no status and waits for the user', async () => {
  const dir = makeDir({ apps: [app('app-0001', 'job-0001', 'submitted'), app('app-0002', 'job-0002', 'submitted'), app('app-0003', 'job-0003', 'interview')] });
  const vague = { id: 'g-vague', from: 'Example Robotics <hr@robotics.example.com>', subject: 'Update on your application', body: 'Thanks for your patience, more soon.', at: '2026-10-26T07:00:00Z' };
  await checkGmailApi(dir, fakeClient([CONFLICT, vague]), { since: '7d', now: NOW });
  assert.equal(appRow(dir, 'app-0003').status, 'interview', 'interview + "unfortunately" is not a confident rejection');
  assert.equal(appRow(dir, 'app-0001').status, 'submitted');
  assert.equal(appRow(dir, 'app-0002').status, 'submitted');
  const pend = pendingEvents(dir);
  assert.equal(pend.length, 2);
  assert.ok(pend.some((p) => /Confirm which application/.test(p.action_required)), 'ambiguous between two Example Robotics applications');
  assert.ok(pend.some((p) => /Confirm the category/.test(p.action_required)));
  const conf = pend.find((p) => /Confirm the category/.test(p.action_required));
  confirmEvent(dir, conf.event_id, { kind: 'rejection', note: 'Yes, that is a rejection.' }, { now: NOW });
  assert.equal(appRow(dir, 'app-0003').status, 'rejected', 'changed only after the user confirmed');
});

// ================================================================ interrupted writes

test('interrupted write: a crash between files is finished by the next run, with no duplicate events and the checkpoint moving only then', async () => {
  const dir = makeDir();
  const before = { ev: existsSync(join(dir, 'email-events.csv')) ? readFileSync(join(dir, 'email-events.csv'), 'utf8') : null, apps: readFileSync(join(dir, 'applications.csv'), 'utf8') };
  // Simulate a process killed after email-events.csv was written but before applications.csv: run the write, then
  // put applications.csv back and leave the journal behind exactly as writeJournaled leaves it mid-way.
  let journal = null;
  _hooks.afterFile = (name) => { if (name === 'email-events.csv' && !journal) journal = readFileSync(join(dir, JOURNAL), 'utf8'); };
  await checkGmailApi(dir, fakeClient([INT]), { since: '7d', now: NOW });
  _hooks.afterFile = null;
  writeFileSync(join(dir, 'applications.csv'), before.apps);
  writeFileSync(join(dir, JOURNAL), journal);
  const s = sync(dir); delete s.updates; writeFileSync(join(dir, 'sync-state.json'), JSON.stringify(s));
  assert.equal(appRow(dir, 'app-0001').status, 'submitted', 'crash state: the event exists but the application was not updated');
  assert.equal(events(dir).length, 1);

  const t = check(dir, { now: NOW });
  assert.ok(t.issues.some((i) => i.kind === 'interrupted_write' && i.fix.op === 'finish_write'), 'the tracker check sees the interrupted write');

  const r = await checkGmailApi(dir, fakeClient([INT]), { since: '7d', now: '2026-10-27T12:30:00Z' });
  assert.equal(existsSync(join(dir, JOURNAL)), false);
  assert.equal(appRow(dir, 'app-0001').status, 'interview', 'the next run finished the interrupted write first');
  assert.equal(r.duplicates, 1);
  assert.equal(events(dir).length, 1);
  assert.equal(r.checkpoint_advanced, true);
});

test('interrupted write: refuses to finish if a file was changed by someone else in between', () => {
  const dir = makeDir();
  const apps = readFileSync(join(dir, 'applications.csv'), 'utf8');
  writeFileSync(join(dir, JOURNAL), JSON.stringify({ at: NOW, files: { 'applications.csv': { before: sha('something else'), after: sha('another thing'), text: 'x' } } }));
  const w = resolveWindow(dir, '7d', { source: 'pasted', now: NOW });
  assert.throws(() => recordCheck(dir, { source: 'pasted', window: w, messages: [norm(INT)], now: NOW }), (e) => e instanceof RefusedError && /cannot be finished safely/.test(e.message));
  assert.equal(readFileSync(join(dir, 'applications.csv'), 'utf8'), apps, 'nothing was touched');
  assert.ok(existsSync(join(dir, JOURNAL)), 'the journal stays for the user to look at');
});

test('in-process failure: an error after the first file still leaves both files consistent and the checkpoint unmoved', async () => {
  const dir = makeDir();
  _hooks.afterFile = (name) => { if (name === 'email-events.csv') { _hooks.afterFile = null; throw new Error('disk full (simulated)'); } };
  await assert.rejects(checkGmailApi(dir, fakeClient([INT]), { since: '7d', now: NOW }), /disk full/);
  _hooks.afterFile = null;
  assert.equal(existsSync(join(dir, JOURNAL)), false);
  assert.equal(appRow(dir, 'app-0001').status, 'interview', 'the journal finished the write on the way out');
  assert.equal(updatesState(dir).sources['gmail-api'], undefined, 'a failed check never moves the checkpoint');
  assert.equal(csv(dir, 'run-history.csv').at(-1).outcome, 'failed');
  const r = await checkGmailApi(dir, fakeClient([INT]), { since: '7d', now: NOW });
  assert.equal(r.duplicates, 1);
  assert.equal(r.checkpoint_advanced, true);
});

// ================================================================ follow-ups

function followUpDir({ sentAt = '2026-10-18T10:00:00Z', extraEvents = [] } = {}) {
  const dir = makeDir({ apps: [app('app-0001', 'job-0001', 'submitted'), app('app-0002', 'job-0002', 'submitted'), app('app-0003', 'job-0003', 'submission_unconfirmed', { approved_at: '2026-10-06T10:00:00Z', approval_note: 'Yes.' })],
    events: [sentEvent('eml-0001', 'app-0001', 'job-0001', sentAt), ...extraEvents] });
  return dir;
}
const coverInbox = (dir, from, to) => { const s = sync(dir); s.updates = { tz_offset: '+00:00', sources: { 'gmail-api': { covered: [[from, to]], last_success_at: to } } }; writeFileSync(join(dir, 'sync-state.json'), JSON.stringify(s)); };

test('follow-ups: only a sent message with no reply after the approved wait is due; everything else says why not', () => {
  const dir = followUpDir();
  const r = followUpReport(dir, { now: NOW });
  assert.equal(r.timing.approved, false);
  assert.match(r.timing_note, /Ask the user/);
  assert.deepEqual(r.due.map((x) => x.application_id), ['app-0001']);
  assert.equal(r.due[0].days_since, 9);
  assert.match(r.due[0].warning, /not been checked/, 'the inbox was never checked since the message');
  assert.match(r.not_applicable.find((x) => x.application_id === 'app-0002').reason, /no message was sent/);
  assert.match(r.blocked.find((x) => x.application_id === 'app-0003').reason, /unconfirmed/);
  const early = followUpReport(followUpDir({ sentAt: '2026-10-24T10:00:00Z' }), { now: NOW });
  assert.equal(early.waiting[0].due_at, '2026-10-31T10:00:00Z');
});

test('follow-ups: timing must be confirmed, cannot be faster than the policy, and a reply cancels the follow-up', () => {
  const dir = followUpDir();
  assert.throws(() => draftFollowUp(dir, 'app-0001', { body: 'Hello' }, { now: NOW }), /not been confirmed/);
  assert.throws(() => setPrefs(dir, { afterDays: 3, note: 'three days please' }, { now: NOW }), /never follows up sooner than 7/);
  assert.throws(() => setPrefs(dir, { afterDays: 7, maxPerMessage: 3, note: 'three times' }, { now: NOW }), /at most one/);
  assert.throws(() => setPrefs(dir, { afterDays: 7 }, { now: NOW }), RefusedError);
  setPrefs(dir, { afterDays: 10, note: 'wait ten days' }, { now: NOW });
  assert.equal(followUpReport(dir, { now: '2026-10-27T12:00:00Z' }).waiting[0].application_id, 'app-0001', '9 days < 10 days');

  const replied = followUpDir({ extraEvents: [row('email-events.csv', { event_id: 'eml-0002', application_id: 'app-0001', job_id: 'job-0001', direction: 'inbound', kind: 'reply', status: 'processed', provider: 'gmail', contact_email: 'sam@robotics.example.com', subject: 'Re: Software Engineering Intern application', provider_message_id: 'g-r', occurred_at: '2026-10-20T09:00:00Z', summary: '[recorded] Recruiter reply', created_at: NOW, updated_at: NOW })] });
  assert.match(followUpReport(replied, { now: NOW }).not_applicable.find((x) => x.application_id === 'app-0001').reason, /a reply arrived/);
});

test('follow-ups: the draft goes to the person really written to, in the same thread, is approved for its exact text, and the real outcome is recorded', async () => {
  const dir = followUpDir();
  setPrefs(dir, { afterDays: 7, note: 'seven days is fine' }, { now: NOW });
  assert.throws(() => draftFollowUp(dir, 'app-0001', { body: 'Just checking in on my application.' }, { now: NOW }), /inbox has not been checked/);
  coverInbox(dir, '2026-10-18T09:00:00Z', NOW);
  assert.throws(() => draftFollowUp(dir, 'app-0001', { body: 'I improved latency by 73% since then.' }, { now: NOW }), /unsupported/, 'invented numbers are refused');
  const d = draftFollowUp(dir, 'app-0001', { body: 'Hello Sam, I am following up on my application for the Software Engineering Intern role. I remain very interested. Is there any update you can share?' }, { now: NOW });
  assert.equal(d.to, 'sam@robotics.example.com');
  assert.equal(d.subject, 'Re: Software Engineering Intern application');
  const ev = events(dir).find((e) => e.event_id === d.event_id);
  assert.deepEqual([ev.kind, ev.status, ev.thread_id], ['follow_up', 'draft', 't-eml-0001']);
  assert.throws(() => draftFollowUp(dir, 'app-0001', { body: 'again' }, { now: NOW }), /already a draft follow-up|not due/);
  assert.match(followUpReport(dir, { now: NOW }).blocked[0].reason, /already a draft/);

  const card = messageCard(dir, d.event_id, { now: NOW });
  assert.equal(card.reply.thread, 't-eml-0001');
  setIntegration(dir, 'gmail-send', 'verified', 'test: fake sender', NOW);
  approveMessage(dir, d.event_id, { note: 'Yes, send that follow-up.', contentHash: card.content_hash }, { now: NOW });
  let payload;
  const r = await sendWithIntegration(dir, d.event_id, { name: 'gmail-send', send: async (p) => { payload = p; return { ok: true, message_id: 'gm-fu-1', thread_id: 't-eml-0001', evidence: 'Gmail API users.messages.send returned id gm-fu-1' }; } }, { now: NOW });
  assert.equal(r.sent, true);
  assert.equal(payload.thread_id, 't-eml-0001');
  const after = followUpReport(dir, { now: '2026-11-10T12:00:00Z' });
  assert.match(after.not_applicable.find((x) => x.application_id === 'app-0001').reason, /limit/, 'one follow-up per message');
});

test('follow-ups: an ambiguous inbound email blocks the follow-up, and the user can choose to skip one', () => {
  const pendingEv = row('email-events.csv', { event_id: 'eml-0002', direction: 'inbound', kind: 'other', status: 'received', provider: 'gmail', contact_email: 'hr@robotics.example.com', subject: 'Update', provider_message_id: 'g-x', occurred_at: '2026-10-25T09:00:00Z', summary: 'AMBIGUOUS', action_required: 'Confirm which application', created_at: NOW, updated_at: NOW });
  const dir = followUpDir({ extraEvents: [pendingEv] });
  assert.match(followUpReport(dir, { now: NOW }).blocked.find((x) => x.application_id === 'app-0001').reason, /wait for the user to confirm/);
  const dir2 = followUpDir();
  skipFollowUp(dir2, 'app-0001', 'No, do not chase them.', { now: NOW });
  assert.match(followUpReport(dir2, { now: NOW }).not_applicable.find((x) => x.application_id === 'app-0001').reason, /chose no follow-up/);
});

// ================================================================ job status

test('job-status: unknown (never or partly checked) is kept apart from no update (checked, nothing came)', () => {
  const dir = makeDir();
  let s = jobStatus(dir, { now: NOW });
  assert.ok(s.applications.confirmed_submissions.every((a) => a.response === 'unknown' && /never been checked/.test(a.why)));
  assert.ok(s.notes.some((n) => /could not be checked/.test(n)));
  coverInbox(dir, '2026-10-10T00:00:00Z', NOW);
  s = jobStatus(dir, { now: NOW });
  assert.ok(s.applications.confirmed_submissions.every((a) => a.response === 'unknown' && /not checked for 1 period/.test(a.why)), 'submitted 6 Oct, checked from 10 Oct: a gap');
  coverInbox(dir, '2026-10-01T00:00:00Z', NOW);
  s = jobStatus(dir, { now: NOW });
  assert.ok(s.applications.confirmed_submissions.every((a) => a.response === 'no_update'));
  assert.match(renderStatus(s), /no update, the inbox was checked for the whole time/);
});

test('job-status: counts, offers, interviews and pending actions come straight from the records', async () => {
  const dir = makeDir({ jobs: [job('job-0001', 'Example Robotics Inc.', 'Software Engineering Intern'), job('job-0002', 'Example Robotics Inc.', 'Data Science Intern'), job('job-0003', 'Northwind Labs', 'Backend Intern'), job('job-0004', 'Contoso', 'ML Intern', { status: 'shortlisted', deadline: '2026-10-30', discovered_at: '2026-10-26T09:00:00Z' })] });
  await checkGmailApi(dir, fakeClient([INT, REJ, CONFLICT]), { since: '7d', now: NOW });
  const s = jobStatus(dir, { now: NOW });
  assert.deepEqual(s.applications.interviews.map((a) => a.application_id), ['app-0001']);
  assert.deepEqual(s.applications.rejections.map((a) => a.application_id), ['app-0002']);
  assert.deepEqual(s.jobs.new.map((j) => j.job_id), ['job-0004']);
  assert.ok(s.pending_actions.some((a) => a.what === 'confirm an email'));
  assert.ok(s.pending_actions.some((a) => /deadline within 7 days/.test(a.what) && a.job_id === 'job-0004'));
  assert.equal(s.applications.confirmed_submissions.find((a) => a.application_id === 'app-0001').response, 'update_received');
});

// ================================================================ tracker

test('tracker: a clean tracker has no issues; plan changes nothing', () => {
  const dir = makeDir();
  const before = readFileSync(join(dir, 'jobs.csv'), 'utf8');
  assert.equal(check(dir, { now: NOW }).ok, true);
  const p = plan(dir, { now: NOW });
  assert.equal(p.fixes.length, 0);
  assert.equal(readFileSync(join(dir, 'jobs.csv'), 'utf8'), before);
});

test('tracker: finds deleted rows, duplicates, placeholders, conflicts and stuck runs, and repairs only what the user approved, with an audit trail', () => {
  const jobs = [job('job-0001', 'Example Robotics Inc.', 'Software Engineering Intern'), job('job-0002', 'Example Robotics Inc.', 'Data Science Intern', { duration: 'N/A' }),
    job('job-0003', 'Northwind Labs', 'Backend Intern', { status: 'verified' }), job('job-0004', 'Northwind Labs', 'Backend Intern', { status: 'discovered', last_verified_at: '', verification_notes: '', source_url: 'https://careers.example.com/jobs/job-0003' })];
  const dir = makeDir({ jobs, apps: [app('app-0001', 'job-0001', 'submitted'), app('app-0002', 'job-0002', 'submitted'), app('app-0003', 'job-0003', 'submitted')] });
  // a backup holding a row that is gone now
  const withExtra = [...jobs, job('job-0005', 'Fabrikam', 'QA Intern', { status: 'discovered', last_verified_at: '', verification_notes: '' })];
  writeFileSync(join(dir, 'backups', 'jobs.csv.20261020T090000Z'), serializeCsv(Object.keys(jobs[0]), withExtra));
  const runs = [row('run-history.csv', { run_id: 'run-0001', started_at: '2026-10-20T09:00:00Z', harness: 'claude-code', skill: 'apply', outcome: 'in_progress' })];
  writeFileSync(join(dir, 'run-history.csv'), serializeCsv(Object.keys(runs[0]), runs));

  const c = check(dir, { now: NOW });
  const kind = (k) => c.issues.filter((i) => i.kind === k);
  assert.equal(kind('row_deleted')[0].record_id, 'job-0005');
  assert.equal(kind('placeholder')[0].fix.to, '');
  assert.equal(kind('duplicate_job')[0].record_id, 'job-0004', 'the less advanced duplicate is the one to archive');
  assert.ok(kind('conflict').some((i) => i.record_id === 'job-0003' && i.fix?.to === 'applied'));
  assert.equal(kind('stuck_run')[0].fix.to, 'aborted');

  const p = plan(dir, { now: NOW });
  const id = (k) => c.issues.find((i) => i.kind === k).id;
  const rowsBefore = csv(dir, 'jobs.csv').length;
  assert.throws(() => apply(dir, p.plan_path, { planHash: p.plan_hash, only: [id('row_deleted')], now: NOW }), RefusedError, 'needs the user\'s words');
  assert.throws(() => apply(dir, p.plan_path, { planHash: 'f'.repeat(64), note: 'yes', now: NOW }), /plan hash/);
  const r = apply(dir, p.plan_path, { planHash: p.plan_hash, only: [id('row_deleted'), id('placeholder'), id('duplicate_job'), id('stuck_run')], note: 'Yes, fix those four.', now: NOW });
  assert.equal(r.applied, 4);
  const after = csv(dir, 'jobs.csv');
  assert.equal(after.length, rowsBefore + 1, 'a row was restored and none removed');
  assert.equal(after.find((j) => j.job_id === 'job-0004').status, 'archived');
  assert.match(after.find((j) => j.job_id === 'job-0004').notes, /duplicate of job-0003/);
  assert.equal(after.find((j) => j.job_id === 'job-0002').duration, '');
  assert.equal(after.find((j) => j.job_id === 'job-0003').status, 'verified', 'the fix not approved was not applied');
  assert.equal(csv(dir, 'run-history.csv').find((x) => x.run_id === 'run-0001').outcome, 'aborted');
  const audit = readFileSync(join(dir, 'tracker', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(audit.length, 4);
  assert.ok(audit.every((a) => a.approval === 'Yes, fix those four.' && a.plan === p.plan_path));
  assert.ok(readdirSync(join(dir, 'backups')).some((f) => /^jobs\.csv\.\d{8}T\d{6}Z$/.test(f) && f !== 'jobs.csv.20261020T090000Z'), 'backed up before writing');
  assert.throws(() => apply(dir, p.plan_path, { planHash: p.plan_hash, note: 'again', now: NOW }), /changed since the plan/, 'a stale plan is refused');
});

test('tracker: disallowed status moves and changed creation times are found against the latest backup', () => {
  const dir = makeDir({ apps: [app('app-0001', 'job-0001', 'drafting')] });
  writeFileSync(join(dir, 'backups', 'applications.csv.20261020T090000Z'), readFileSync(join(dir, 'applications.csv')));
  const moved = [app('app-0001', 'job-0001', 'submitted', { created_at: '2026-10-04T09:00:00Z' })];
  writeFileSync(join(dir, 'applications.csv'), serializeCsv(Object.keys(moved[0]), moved));
  const c = check(dir, { now: NOW });
  assert.ok(c.issues.some((i) => i.kind === 'disallowed_transition' && /drafting -> submitted/.test(i.message) && !i.fix));
  assert.ok(c.issues.some((i) => i.kind === 'changed_creation_time' && i.fix.to === '2026-10-05T09:00:00Z'));
});

test('tracker: an unreadable file is restored from its backup only on approval, and the broken copy is kept', () => {
  const dir = makeDir();
  const good = readFileSync(join(dir, 'applications.csv'), 'utf8');
  writeFileSync(join(dir, 'backups', 'applications.csv.20261020T090000Z'), good);
  writeFileSync(join(dir, 'applications.csv'), `application_id,job,status\napp-0001,job-0001,submitted\n`);
  const c = check(dir, { now: NOW });
  const bad = c.issues.find((i) => i.kind === 'bad_header');
  assert.equal(bad.fix.op, 'restore_file');
  assert.equal(bad.fix.risky, true);
  const p = plan(dir, { now: NOW });
  apply(dir, p.plan_path, { planHash: p.plan_hash, only: [bad.id], note: 'Yes, restore the backup.', now: NOW });
  assert.equal(readFileSync(join(dir, 'applications.csv'), 'utf8'), good);
  const broken = readdirSync(join(dir, 'backups')).find((f) => f.startsWith('applications.csv.broken-'));
  assert.match(readFileSync(join(dir, 'backups', broken), 'utf8'), /application_id,job,status/, 'nothing is silently discarded');
});

test('tracker: a stale lock is reported and released only on approval; a duplicate email is closed, never removed', () => {
  const ev = (id) => row('email-events.csv', { event_id: id, direction: 'inbound', kind: 'other', status: 'received', provider: 'gmail', contact_email: 'hr@robotics.example.com', subject: 'Update', provider_message_id: 'g-same', occurred_at: '2026-10-25T09:00:00Z', summary: 's', created_at: NOW, updated_at: NOW });
  const dir = makeDir({ events: [ev('eml-0001'), ev('eml-0002')] });
  const s = sync(dir); s.lock = { holder: 'run-0009', acquired_at: '2026-10-27T01:00:00Z' }; writeFileSync(join(dir, 'sync-state.json'), JSON.stringify(s));
  const c = check(dir, { now: NOW });
  const lock = c.issues.find((i) => i.kind === 'stale_lock');
  const dup = c.issues.find((i) => i.kind === 'duplicate_message');
  assert.equal(dup.record_id, 'eml-0002');
  const p = plan(dir, { now: NOW });
  apply(dir, p.plan_path, { planHash: p.plan_hash, only: [lock.id, dup.id], note: 'Yes, nothing else is running.', now: NOW });
  assert.equal(sync(dir).lock.holder, null);
  assert.equal(events(dir).length, 2);
  assert.equal(events(dir).find((e) => e.event_id === 'eml-0002').status, 'processed');
});
