// Tests for the Gmail connector, inbox pipeline and integration readiness. Run: node --test tests/gmail.test.mjs
// MOCKED Google endpoints only. No real mailbox is read and no real email is sent. The one real network call is a request
// from the test to its own loopback listener on 127.0.0.1 (the OAuth redirect). Fictional data, throwaway folders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPdfStub } from './helpers/pdf-stub.mjs';
import { repoRoot, loadCsvSchemas, checkCsv } from '../scripts/lib/data.mjs';
import { parseCsv, serializeCsv } from '../scripts/lib/csv.mjs';
import { RefusedError } from '../scripts/lib/ingest.mjs';
import { secretsDir, assertSafeSecretsDir, writeToken, readToken, paths } from '../scripts/lib/secrets.mjs';
import { GmailClient, AuthError, ApiError, RateLimitError, SCOPES, buildAuthUrl, buildRaw, login, normalizeMessage, gmailSender, pkce } from '../scripts/lib/gmail.mjs';
import { ingestMessages, pendingEvents, confirmEvent, dismissEvent, classify, matchMessage } from '../scripts/lib/inbox.mjs';
import { syncGmail } from '../scripts/lib/gmailsync.mjs';
import { draftMessage, approveMessage, messageCard, sendWithIntegration } from '../scripts/lib/contact.mjs';
import { setIntegration } from '../scripts/lib/outbound.mjs';
import { readiness, renderChecklist, probe, loadPlatforms, platformsMdIsCurrent, RULES_FOR_MISSING, CATEGORIES } from '../scripts/lib/readiness.mjs';

installPdfStub();
const schemas = loadCsvSchemas();
const T = (h, m = 0) => `2026-10-27T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;
const T0 = T(9), T1 = T(10), T2 = T(11);
const SECRET_TOKEN = 'refresh-token-test-123', CLIENT_SECRET = 'client-secret-test-456';

// ---------------------------------------------------------------- fixtures

const row = (file, over) => { const h = schemas[file].columns.map((c) => c.name); return Object.fromEntries(h.map((k) => [k, over[k] ?? ''])); };
const job = (id, company, title) => row('jobs.csv', { job_id: id, status: 'shortlisted', company, title, remote_type: 'remote', employment_type: 'internship', source_name: 'Example Careers', source_kind: 'company_site',
  source_url: `https://careers.example.com/jobs/${id}`, apply_url: `https://careers.example.com/jobs/${id}/apply`, discovered_at: '2026-10-20T09:00:00Z', last_checked_at: '2026-10-26T09:00:00Z', last_verified_at: '2026-10-26T09:00:00Z',
  verification_notes: 'Opened posting.', eligibility_check: 'pass', dedupe_key: `${company}|${title}`.toLowerCase(), updated_at: '2026-10-26T09:00:00Z' });
const app = (id, jobId, status) => row('applications.csv', { application_id: id, job_id: jobId, status, created_at: '2026-10-21T09:00:00Z', updated_at: '2026-10-21T09:00:00Z',
  ...(status === 'submitted' ? { approved_at: '2026-10-22T10:00:00Z', approval_note: 'Yes.', submission_method: 'portal', submitted_at: '2026-10-22T10:05:00Z', submission_result: 'success', confirmation_evidence: '[confirmation_page] Application received' } : {}) });

function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-test-data-'));
  cpSync(join(repoRoot, 'templates/data'), dir, { recursive: true });
  cpSync(join(repoRoot, 'tests/fixtures/candidate-profile.json'), join(dir, 'candidate-profile.json'));
  const jobs = [job('job-0001', 'Example Robotics Inc.', 'Software Engineering Intern'), job('job-0002', 'Example Robotics Inc.', 'Data Science Intern'), job('job-0003', 'Northwind Labs', 'Backend Intern')];
  writeFileSync(join(dir, 'jobs.csv'), serializeCsv(Object.keys(jobs[0]), jobs));
  const apps = [app('app-0001', 'job-0001', 'submitted'), app('app-0002', 'job-0002', 'submitted'), app('app-0003', 'job-0003', 'ready_for_review')];
  writeFileSync(join(dir, 'applications.csv'), serializeCsv(Object.keys(apps[0]), apps));
  return dir;
}
function makeSecrets({ token = true, levels = ['read'], client = true } = {}) {
  const sdir = mkdtempSync(join(tmpdir(), 'gmail-test-secrets-'));
  if (client) writeFileSync(paths(sdir).client, JSON.stringify({ installed: { client_id: 'client-id-test.apps.example', client_secret: CLIENT_SECRET } }));
  if (token) writeToken(sdir, { refresh_token: SECRET_TOKEN, scope: levels.map((l) => SCOPES[l]).join(' '), obtained_at: T0 });
  return sdir;
}
const csv = (dir, name) => { const rows = parseCsv(readFileSync(join(dir, name), 'utf8')); return rows.slice(1).map((r) => Object.fromEntries(rows[0].map((h, i) => [h, r[i]]))); };
const appRow = (dir, id) => csv(dir, 'applications.csv').find((a) => a.application_id === id);
const evByMsg = (dir, id) => csv(dir, 'email-events.csv').find((e) => e.provider_message_id === id);
const syncState = (dir) => JSON.parse(readFileSync(join(dir, 'sync-state.json'), 'utf8'));

/** Mock of Google's token, Gmail list/get/send and revoke endpoints. Records every call. */
function mockGoogle({ messages = [], tokenError = null, apiStatus = null, sendStatus = 200, sendThrows = false, listPages = null } = {}) {
  const calls = [];
  const res = (status, obj, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => obj });
  const f = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method ?? 'GET', body: init.body });
    if (u.startsWith('https://oauth2.googleapis.com/token')) return tokenError ? res(400, { error: tokenError }) : res(200, { access_token: 'access-token-test', expires_in: 3600, scope: new URLSearchParams(init.body).get('scope') ?? undefined });
    if (u.startsWith('https://oauth2.googleapis.com/revoke')) return res(200, {});
    if (!u.startsWith('https://gmail.googleapis.com/gmail/v1/')) throw new Error(`unexpected URL ${u}`);
    if (apiStatus === 401) return res(401, { error: { message: 'Invalid Credentials' } });
    if (apiStatus === 403) return res(403, { error: { message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED' } });
    if (apiStatus === 429) return res(429, { error: { message: 'Rate limit exceeded' } }, { 'retry-after': '30' });
    if (u.endsWith('/users/me/profile')) return res(200, { emailAddress: 'alex.example@example.com', messagesTotal: 42 });
    if (u.includes('/messages/send')) { if (sendThrows) throw new Error('socket hang up'); return sendStatus === 200 ? res(200, { id: 'gm-msg-77', threadId: 't-g-1' }) : res(sendStatus, { error: { message: `send failed ${sendStatus}` } }); }
    if (/\/messages\?/.test(u)) {
      if (listPages) { const p = new URL(u).searchParams.get('pageToken'); const i = p ? Number(p) : 0; if (i >= listPages.length) return res(429, { error: { message: 'Rate limit exceeded' } }); return res(200, { messages: listPages[i].map((id) => ({ id })), ...(i + 1 <= listPages.length ? { nextPageToken: String(i + 1) } : {}) }); }
      return res(200, { messages: messages.map((m) => ({ id: m.id })) });
    }
    const id = decodeURIComponent(u.split('/messages/')[1].split('?')[0]);
    const m = messages.find((x) => x.id === id);
    return m ? res(200, m) : res(404, { error: { message: 'Not found' } });
  };
  f.calls = calls;
  return f;
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
/** A message in Gmail API "full" format. */
const apiMsg = ({ id, thread = `t-${id}`, from, subject, body, at, msgid = `<${id}@mail.example.com>` }) => ({ id, threadId: thread, internalDate: String(Date.parse(at)), snippet: body.slice(0, 60),
  payload: { mimeType: 'multipart/alternative', headers: [{ name: 'From', value: from }, { name: 'To', value: 'Alex Example <alex.example@example.com>' }, { name: 'Subject', value: subject }, { name: 'Message-ID', value: msgid }],
    parts: [{ mimeType: 'text/plain', body: { data: b64(body) } }] } });

// the normalised messages used by the pipeline tests
const m = (over) => ({ provider: 'gmail', thread_id: `t-${over.id}`, from_name: '', to: ['alex.example@example.com'], snippet: '', body_text: '', links: [], message_id_header: `<${over.id}@mail.example.com>`, references: '', ...over });
const M_INT = m({ id: 'g-1', received_at: '2026-10-27T08:00:00Z', from_name: 'Example Robotics Recruiting', from_email: 'recruiting@robotics.example.com', subject: 'Interview invitation: Software Engineering Intern', body_text: 'Hi, we would like to schedule a call next week. Please share your availability.' });
const M_AMBIG = m({ id: 'g-2', received_at: '2026-10-27T08:10:00Z', from_name: 'Example Robotics', from_email: 'hr@robotics.example.com', subject: 'Update on your application', body_text: 'Thanks for your patience, more soon.' });
const M_REJ = m({ id: 'g-3', received_at: '2026-10-27T08:20:00Z', from_name: 'Example Robotics', from_email: 'hr@robotics.example.com', subject: 'Data Science Intern application update', body_text: 'Unfortunately we will not be moving forward with your application.' });
const M_CONFLICT = m({ id: 'g-4', received_at: '2026-10-27T08:30:00Z', from_name: 'Northwind Labs', from_email: 'jobs@northwind.example.org', subject: 'Backend Intern: interview feedback', body_text: 'Unfortunately we are not moving forward after the interview.' });
const M_ACK = m({ id: 'g-5', received_at: '2026-10-27T08:40:00Z', from_name: 'Northwind Labs', from_email: 'jobs@northwind.example.org', subject: 'Backend Intern: thank you for applying', body_text: 'We have received your application and will be in touch.' });
const M_UNREL = m({ id: 'g-6', received_at: '2026-10-27T08:50:00Z', from_name: 'Deals', from_email: 'news@shop.example.net', subject: 'Big sale this weekend', body_text: 'Everything half price.' });

// ================================================================ SECRETS AND AUTHORIZATION

test('secrets: tokens must live outside the repository and the data directory', () => {
  const dir = makeDir();
  assert.throws(() => assertSafeSecretsDir(join(repoRoot, 'private', 'secrets'), dir), /inside the repository/);
  assert.throws(() => assertSafeSecretsDir(repoRoot, dir), /inside the repository/);
  assert.throws(() => assertSafeSecretsDir(join(dir, 'secrets'), dir), /inside the (repository|private data directory)/);
  const ok = mkdtempSync(join(tmpdir(), 'ok-secrets-'));
  assert.equal(assertSafeSecretsDir(ok, dir), ok);
  assert.equal(secretsDir({ INTERNSHIP_AGENT_SECRETS: ok }), ok);
  assert.match(secretsDir({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming', XDG_CONFIG_HOME: '/home/x/.config' }), /internship-agent$/); // the default folder is per user, outside any repository
  assert.equal(existsSync(join(repoRoot, 'gmail-token.json')), false);
});

test('auth URL requests only the permissions asked for: read-only by default, never compose or modify', () => {
  const { challenge } = pkce();
  const u = new URL(buildAuthUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:5555', levels: ['read'], state: 's', challenge }));
  assert.equal(u.searchParams.get('scope'), SCOPES.read);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://127.0.0.1:5555');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('state'), 's');
  const both = new URL(buildAuthUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:5555', levels: ['read', 'send'], state: 's', challenge })).searchParams.get('scope');
  assert.equal(both, `${SCOPES.read} ${SCOPES.send}`);
  assert.throws(() => buildAuthUrl({ clientId: 'cid', redirectUri: 'x', levels: ['modify'], state: 's', challenge }), /subset/);
  assert.deepEqual(Object.values(SCOPES), ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send']);
});

test('login: loopback authorization stores the token outside the repo; a wrong state or a missing client stores nothing', async () => {
  const sdir = makeSecrets({ token: false });
  const g = mockGoogle();
  let seen;
  // Google's answer has no refresh token: login must say so and store nothing, not pretend to be signed in
  await assert.rejects(login({ sdir, levels: ['read'], fetchImpl: g, showUrl: (url, redirect) => {
    seen = new URL(url);
    setTimeout(() => fetch(`${redirect}/?code=auth-code-1&state=${seen.searchParams.get('state')}`).catch(() => {}), 20);
  } }), (e) => e instanceof AuthError && /did not return a refresh token/.test(e.message));
  const body = new URLSearchParams(g.calls.find((c) => c.url.includes('/token')).body);
  assert.equal(body.get('code'), 'auth-code-1');
  assert.ok(body.get('code_verifier').length >= 43, 'PKCE verifier is sent');
  assert.equal(body.get('grant_type'), 'authorization_code');
  // the mock does not return a refresh token, so nothing is stored: login must say so rather than pretend
  assert.equal(readToken(sdir), null);

  const g2 = mockGoogle();
  const orig = g2;
  const withRefresh = async (url, init) => { const rr = await orig(url, init); if (String(url).includes('/token')) return { ...rr, json: async () => ({ access_token: 'a', refresh_token: SECRET_TOKEN, scope: SCOPES.read, expires_in: 3600 }) }; return rr; };
  await login({ sdir, levels: ['read'], fetchImpl: withRefresh, showUrl: (url, redirect) => { const s = new URL(url).searchParams.get('state'); setTimeout(() => fetch(`${redirect}/?code=c2&state=${s}`).catch(() => {}), 20); } }).catch(() => assert.fail('login should have succeeded'));
  assert.equal(readToken(sdir).refresh_token, SECRET_TOKEN);
  assert.equal(readToken(sdir).scope, SCOPES.read);

  const sdir2 = makeSecrets({ token: false });
  await assert.rejects(login({ sdir: sdir2, levels: ['read'], fetchImpl: withRefresh, showUrl: (url, redirect) => setTimeout(() => fetch(`${redirect}/?code=x&state=WRONG`).catch(() => {}), 20) }), (e) => e instanceof AuthError && e.code === 'not_authorized');
  assert.equal(readToken(sdir2), null);
  await assert.rejects(login({ sdir: makeSecrets({ client: false, token: false }), levels: ['read'], fetchImpl: g, showUrl() {} }), (e) => e.code === 'not_configured');
});

test('authorization failures: not configured, not authorized, missing permission, revoked, rate limited; no request is made when none can succeed', async () => {
  let g = mockGoogle();
  await assert.rejects(new GmailClient({ sdir: makeSecrets({ client: false, token: false }), fetchImpl: g }).profile(), (e) => e.code === 'not_configured');
  await assert.rejects(new GmailClient({ sdir: makeSecrets({ token: false }), fetchImpl: g }).profile(), (e) => e.code === 'not_authorized');
  assert.equal(g.calls.length, 0);

  // read-only authorization cannot send, and nothing is requested from Google
  g = mockGoogle();
  const ro = new GmailClient({ sdir: makeSecrets({ levels: ['read'] }), fetchImpl: g });
  await assert.rejects(ro.sendRaw('AAAA'), (e) => e instanceof AuthError && e.code === 'missing_scope');
  assert.equal(g.calls.length, 0, 'no token refresh and no send request');
  // a send-only authorization cannot read
  await assert.rejects(new GmailClient({ sdir: makeSecrets({ levels: ['send'] }), fetchImpl: mockGoogle() }).listMessages(), (e) => e.code === 'missing_scope');

  // revoked at refresh time
  await assert.rejects(new GmailClient({ sdir: makeSecrets(), fetchImpl: mockGoogle({ tokenError: 'invalid_grant' }) }).profile(), (e) => e.code === 'revoked' && /invalid_grant/.test(e.message));
  // revoked while the access token was still cached (401 twice)
  g = mockGoogle({ apiStatus: 401 });
  await assert.rejects(new GmailClient({ sdir: makeSecrets(), fetchImpl: g }).profile(), (e) => e.code === 'revoked');
  assert.equal(g.calls.filter((c) => c.url.includes('/token')).length, 2, 'one retry after a 401 with a fresh token, then give up');
  // insufficient scope reported by Google
  await assert.rejects(new GmailClient({ sdir: makeSecrets(), fetchImpl: mockGoogle({ apiStatus: 403 }) }).profile(), (e) => e.code === 'missing_scope');
  await assert.rejects(new GmailClient({ sdir: makeSecrets(), fetchImpl: mockGoogle({ apiStatus: 429 }) }).profile(), (e) => e instanceof RateLimitError && e.retryAfter === '30');
});

test('status and logout: nothing secret is reported, and logout revokes and deletes the local token', async () => {
  const sdir = makeSecrets({ levels: ['read', 'send'] });
  const g = mockGoogle();
  const c = new GmailClient({ sdir, fetchImpl: g });
  const st = c.status();
  assert.deepEqual(st.levels, ['read', 'send']);
  assert.doesNotMatch(JSON.stringify(st), new RegExp(`${SECRET_TOKEN}|${CLIENT_SECRET}`));
  await c.revoke();
  assert.ok(g.calls.some((x) => x.url.startsWith('https://oauth2.googleapis.com/revoke')));
  assert.equal(readToken(sdir), null);
  assert.equal(c.status().authorized, false);
});

// ================================================================ MESSAGE PARSING AND BUILDING

test('normalizeMessage keeps the original id and received time; the body stays in memory only', () => {
  const n = normalizeMessage(apiMsg({ id: 'abc', from: 'Pat Recruiter <Pat@Example.com>', subject: 'Hello', body: 'See https://careers.example.com/jobs/job-0001. Thanks.', at: '2026-10-27T07:30:00Z' }));
  assert.equal(n.id, 'abc');
  assert.equal(n.received_at, '2026-10-27T07:30:00Z');
  assert.equal(n.from_email, 'pat@example.com');
  assert.equal(n.from_name, 'Pat Recruiter');
  assert.deepEqual(n.links, ['https://careers.example.com/jobs/job-0001']);
  assert.equal(n.message_id_header, '<abc@mail.example.com>');
});

test('buildRaw: reply threading headers, UTF-8 subjects and header-injection protection', () => {
  const raw = buildRaw({ to: 'pat@example.com', subject: 'Re: Interview', body: 'Hello', inReplyTo: '<orig@mail.example.com>', references: '<a@x> <orig@mail.example.com>' });
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  assert.match(text, /^To: pat@example\.com\r\nSubject: Re: Interview\r\nIn-Reply-To: <orig@mail.example.com>\r\nReferences: <a@x> <orig@mail.example.com>\r\nMIME-Version: 1\.0/);
  assert.match(Buffer.from(buildRaw({ to: 'p@example.com', subject: 'Résumé', body: 'x' }), 'base64url').toString('utf8'), /Subject: =\?UTF-8\?B\?/);
  assert.throws(() => buildRaw({ to: 'p@example.com\r\nBcc: spy@example.com', subject: 's', body: 'x' }), /line breaks/);
  assert.throws(() => buildRaw({ to: 'p@example.com', subject: 's\nBcc: spy@example.com', body: 'x' }), /line breaks/);
});

// ================================================================ INBOX: MATCHING, CLASSIFYING, RECORDING

test('classification: interview, assessment, rejection, offer, request for information, acknowledgement, other; conflicts lower confidence', () => {
  const c = (subject, body_text = '') => classify({ subject, body_text });
  assert.equal(c('Interview invitation').category, 'interview');
  assert.equal(c('Next step', 'Please complete the HackerRank assessment by Friday').category, 'assessment');
  assert.equal(c('Update', 'Unfortunately we will not be moving forward').category, 'rejection');
  assert.equal(c('Great news', 'We are pleased to offer you the position').category, 'offer');
  assert.equal(c('Quick question', 'Could you please provide your transcript?').category, 'request_for_information');
  assert.equal(c('Thanks', 'We have received your application').category, 'auto_acknowledgement');
  assert.equal(c('Hi there', 'Lunch next week?').category, 'recruiter_reply');
  const conflict = c('Interview feedback', 'Unfortunately we are not moving forward');
  assert.ok(conflict.confidence < 0.7 && conflict.conflicting.length === 2);
  assert.ok(c('Interview invitation').confidence >= 0.7);
});

test('inbox: matches to the right application, records id and time, updates status only when confident, keeps no bodies', () => {
  const dir = makeDir();
  const r = ingestMessages(dir, [M_INT, M_INT, M_AMBIG, M_REJ, M_CONFLICT, M_ACK, M_UNREL, { subject: 'no id' }], { now: T1, source: 'gmail' });

  assert.equal(r.recorded.length, 5);
  assert.equal(r.duplicates, 1, 'the same provider message id is recorded once');
  assert.equal(r.unrelated, 1);
  assert.equal(r.invalid.length, 1);
  assert.equal(r.ambiguous.length, 1);

  const e1 = evByMsg(dir, 'g-1');
  assert.deepEqual([e1.application_id, e1.kind, e1.status, e1.direction, e1.provider], ['app-0001', 'interview_invite', 'processed', 'inbound', 'gmail']);
  assert.equal(e1.occurred_at, '2026-10-27T08:00:00Z', 'the received timestamp is preserved');
  assert.equal(e1.thread_id, 't-g-1');
  assert.match(e1.summary, /Interview invitation.*class conf 0\.85.*match app-0001/);
  assert.equal(appRow(dir, 'app-0001').status, 'interview');
  assert.equal(appRow(dir, 'app-0001').last_response_at, '2026-10-27T08:00:00Z');
  assert.equal(appRow(dir, 'app-0001').next_action, 'Reply to schedule the interview');

  const e3 = evByMsg(dir, 'g-3');
  assert.deepEqual([e3.application_id, e3.kind], ['app-0002', 'rejection']);
  assert.equal(appRow(dir, 'app-0002').status, 'rejected');

  // ambiguous match: no application, waits for the user, candidates listed with scores
  const e2 = evByMsg(dir, 'g-2');
  assert.deepEqual([e2.application_id, e2.status], ['', 'received']);
  assert.match(e2.action_required, /Confirm which application.*app-0001 \(0\.4\).*app-0002 \(0\.4\)/);
  assert.match(e2.summary, /AMBIGUOUS match/);

  // matched, but the category is uncertain (interview vs rejection): recorded, application untouched
  const e4 = evByMsg(dir, 'g-4');
  assert.deepEqual([e4.application_id, e4.status, e4.kind], ['app-0003', 'received', 'other']);
  assert.match(e4.action_required, /Confirm the category/);
  // an acknowledgement for an application that was never recorded as submitted: logged, status not forced
  assert.equal(evByMsg(dir, 'g-5').status, 'processed');
  assert.equal(appRow(dir, 'app-0003').status, 'ready_for_review');
  assert.match(appRow(dir, 'app-0003').notes, /status ready_for_review not changed/);
  assert.equal(evByMsg(dir, 'g-6'), undefined, 'unrelated mail is not stored');

  // privacy: no body text in the tracker or the saved metadata
  const all = ['email-events.csv', 'applications.csv'].map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
  assert.doesNotMatch(all, /share your availability|Everything half price|Thanks for your patience/);
  const meta = JSON.parse(readFileSync(join(dir, 'email-exports', `${e1.event_id}.meta.json`), 'utf8'));
  assert.deepEqual(Object.keys(meta).sort(), ['message_id_header', 'provider_message_id', 'references', 'subject', 'thread_id']);

  assert.deepEqual(checkCsv('email-events.csv', readFileSync(join(dir, 'email-events.csv'), 'utf8'), schemas['email-events.csv'], { 'applications.csv': new Set(['app-0001', 'app-0002', 'app-0003']) }), []);
  assert.deepEqual(checkCsv('applications.csv', readFileSync(join(dir, 'applications.csv'), 'utf8'), schemas['applications.csv'], { 'jobs.csv': new Set(['job-0001', 'job-0002', 'job-0003']) }), []);

  // duplicates across runs: ingesting the same batch again adds nothing
  const before = csv(dir, 'email-events.csv').length;
  const again = ingestMessages(dir, [M_INT, M_AMBIG, M_REJ, M_CONFLICT, M_ACK], { now: T2, source: 'gmail' });
  assert.equal(again.recorded.length, 0);
  assert.equal(again.duplicates, 5);
  assert.equal(csv(dir, 'email-events.csv').length, before);
  assert.deepEqual(csv(dir, 'run-history.csv').map((x) => x.outcome), ['completed', 'completed']);
});

test('inbox: a terminal status is never moved, and a later conflicting email cannot revive a rejected application', () => {
  const dir = makeDir();
  ingestMessages(dir, [M_REJ], { now: T1 });
  assert.equal(appRow(dir, 'app-0002').status, 'rejected');
  const later = m({ id: 'g-9', received_at: '2026-10-27T09:30:00Z', from_name: 'Example Robotics', from_email: 'hr@robotics.example.com', subject: 'Data Science Intern: interview invitation', body_text: 'We would like to schedule a call.' });
  ingestMessages(dir, [later], { now: T2 });
  assert.equal(appRow(dir, 'app-0002').status, 'rejected');
  assert.equal(evByMsg(dir, 'g-9').kind, 'interview_invite');
});

test('inbox: ambiguous matches are resolved only by the user: confirm links and applies, dismiss unlinks', () => {
  const dir = makeDir();
  ingestMessages(dir, [M_AMBIG, M_INT], { now: T1 });
  const [pending] = pendingEvents(dir);
  assert.equal(pending.application_id, null);
  assert.throws(() => confirmEvent(dir, pending.event_id, { applicationId: 'app-0001', kind: 'reply', note: '' }, { now: T2 }), RefusedError);
  const c = confirmEvent(dir, pending.event_id, { applicationId: 'app-0001', kind: 'reply', note: 'That one is about the software role.' }, { now: T2 });
  assert.equal(c.status, 'processed');
  assert.equal(evByMsg(dir, 'g-2').application_id, 'app-0001');
  assert.match(evByMsg(dir, 'g-2').summary, /confirmed by the user: That one is about the software role\./);
  assert.throws(() => confirmEvent(dir, pending.event_id, { applicationId: 'app-0001', kind: 'reply', note: 'again' }, { now: T2 }), /only an unconfirmed event/);

  const dir2 = makeDir();
  ingestMessages(dir2, [M_AMBIG], { now: T1 });
  const id = pendingEvents(dir2)[0].event_id;
  assert.equal(dismissEvent(dir2, id, 'Not about my applications', { now: T2 }).dismissed, true);
  assert.deepEqual(pendingEvents(dir2), []);
  assert.equal(csv(dir2, 'email-events.csv')[0].application_id, '');
});

test('matching signals: thread and known contact outrank names; a link to the posting identifies the application', () => {
  const dir = makeDir();
  const ctx = (id, jobId, company, title, extra = {}) => ({ app: { application_id: id }, job: { job_id: jobId, company, title, source_url: `https://careers.example.com/jobs/${jobId}`, apply_url: `https://careers.example.com/jobs/${jobId}/apply` }, threads: new Set(), contacts: new Set(), ...extra });
  const contexts = [ctx('app-0001', 'job-0001', 'Example Robotics Inc.', 'Software Engineering Intern', { threads: new Set(['t-known']) }), ctx('app-0002', 'job-0002', 'Example Robotics Inc.', 'Data Science Intern')];
  const byThread = matchMessage(m({ id: 'x', thread_id: 't-known', from_name: 'Someone', from_email: 'a@other.example.org', subject: 'Re: hello', received_at: T0 }), contexts);
  assert.equal(byThread[0].application_id, 'app-0001');
  assert.ok(byThread[0].score >= 0.9);
  const byLink = matchMessage(m({ id: 'y', from_name: '', from_email: 'no-reply@ats.example.com', subject: 'Next steps', body_text: 'Continue here', links: ['https://careers.example.com/jobs/job-0002/apply?utm=1'], received_at: T0 }), contexts);
  assert.equal(byLink[0].application_id, 'app-0002');
  void dir;
});

// ================================================================ GMAIL SYNC (mock API)

const api = () => [
  apiMsg({ id: 'g-1', from: 'Example Robotics Recruiting <recruiting@robotics.example.com>', subject: 'Interview invitation: Software Engineering Intern', body: 'Hi, we would like to schedule a call next week. Please share your availability.', at: '2026-10-27T08:00:00Z' }),
  apiMsg({ id: 'g-6', from: 'Deals <news@shop.example.net>', subject: 'Big sale', body: 'Everything half price', at: '2026-10-27T08:50:00Z' }),
];


const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const assertNoSecrets = (dir) => { for (const f of walk(dir)) { const t = readFileSync(f, 'utf8'); for (const s of [SECRET_TOKEN, CLIENT_SECRET, 'access-token-test']) assert.ok(!t.includes(s), `${f} must not contain a secret`); } };

test('sync: read-only fetch records recruiter mail, moves the cursor, repeats add nothing, and no secret reaches the data folder', async () => {
  const dir = makeDir();
  const g = mockGoogle({ messages: api() });
  const client = new GmailClient({ sdir: makeSecrets({ levels: ['read'] }), fetchImpl: g });
  const r = await syncGmail(dir, client, { now: T1 });
  assert.equal(r.fetched, 2);
  assert.equal(r.recorded.length, 1);
  assert.equal(r.unrelated, 1);
  assert.equal(r.complete, true);
  assert.equal(r.cursor_advanced, true);
  assert.equal(syncState(dir).gmail.cursor, String(Math.floor(Date.parse('2026-10-27T08:50:00Z') / 1000) - 60));
  assert.equal(syncState(dir).gmail.last_sync_at, T1);
  assert.match(g.calls.find((c) => /\/messages\?/.test(c.url)).url, /q=after%3A\d+/);
  assert.ok(g.calls.every((c) => c.method === 'GET' || c.url.includes('oauth2.googleapis.com')), 'sync only reads: no POST, DELETE, modify or label request');
  assert.ok(!g.calls.some((c) => c.url.includes('/modify') || c.url.includes('/trash') || c.url.includes('/labels')));

  const again = await syncGmail(dir, new GmailClient({ sdir: makeSecrets({ levels: ['read'] }), fetchImpl: mockGoogle({ messages: api() }) }), { now: T2 });
  assert.equal(again.recorded.length, 0);
  assert.equal(again.duplicates, 1);
  assert.equal(csv(dir, 'email-events.csv').length, 1);
  assertNoSecrets(dir);
});

test('sync: revoked access stops cleanly: nothing is recorded, the cursor does not move, and readiness asks for authorization', async () => {
  const dir = makeDir();
  const sdir = makeSecrets({ levels: ['read'] });
  const client = new GmailClient({ sdir, fetchImpl: mockGoogle({ messages: api(), tokenError: 'invalid_grant' }) });
  await assert.rejects(syncGmail(dir, client, { now: T1 }), (e) => e instanceof AuthError && e.code === 'revoked');
  assert.equal(csv(dir, 'email-events.csv').length, 0);
  assert.equal(syncState(dir).gmail.cursor, null);
  assert.equal(syncState(dir).integrations['gmail-read'].status, 'possible_unconfigured');
  assert.match(syncState(dir).integrations['gmail-read'].notes, /revoked/);
  const item = readiness(dir, { sdir, now: T1 }).items.find((i) => i.id === 'gmail-read');
  assert.equal(item.category, 'requires_account_authorization');
  assert.match(item.reason, /revoked/);
});

test('sync: a rate limit part-way keeps what was fetched but leaves the cursor, so the rest is fetched next time', async () => {
  const dir = makeDir();
  const g = mockGoogle({ messages: api(), listPages: [['g-1']] });
  const r = await syncGmail(dir, new GmailClient({ sdir: makeSecrets(), fetchImpl: g }), { now: T1 });
  assert.equal(r.complete, false);
  assert.match(r.stopped, /rate limited \(retry after/);
  assert.equal(r.recorded.length, 1);
  assert.equal(r.cursor_advanced, false);
  assert.equal(syncState(dir).gmail.cursor, null);
});

// ================================================================ REPLIES AND SEND CONFIRMATION

const REPLY = 'Hello, thank you for the invitation. I am available on weekday afternoons and have used Python in a course project.';
function replyReady(dir) {
  ingestMessages(dir, [M_INT], { now: T0, source: 'gmail' });
  const inbound = evByMsg(dir, 'g-1').event_id;
  const d = draftMessage(dir, 'app-0001', { replyTo: inbound, body: REPLY }, { now: T0 });
  const c = messageCard(dir, d.event_id, { now: T0 });
  approveMessage(dir, d.event_id, { note: 'Yes, send this reply.', contentHash: c.content_hash }, { now: T0 });
  return { inbound, eid: d.event_id };
}

test('reply: drafted from a recorded recruiter message with threading data; it needs approval and is not a new contact', () => {
  const dir = makeDir();
  ingestMessages(dir, [M_INT, M_AMBIG], { now: T0, source: 'gmail' });
  const inbound = evByMsg(dir, 'g-1').event_id;
  const d = draftMessage(dir, 'app-0001', { replyTo: inbound, body: REPLY }, { now: T0 });
  assert.equal(d.status, 'draft');
  const e = csv(dir, 'email-events.csv').find((x) => x.event_id === d.event_id);
  assert.deepEqual([e.direction, e.kind, e.status, e.contact_email, e.thread_id], ['outbound', 'reply', 'draft', 'recruiting@robotics.example.com', 't-g-1']);
  assert.equal(e.subject, 'Re: Interview invitation: Software Engineering Intern');
  const file = readFileSync(join(dir, e.draft_path), 'utf8');
  assert.match(file, /In-Reply-To: <g-1@mail.example.com>/);
  assert.match(file, /Contact source: reply to eml-0001/);
  // an unlinked (ambiguous) message cannot be replied to until the match is confirmed
  const amb = evByMsg(dir, 'g-2').event_id;
  assert.throws(() => draftMessage(dir, 'app-0001', { replyTo: amb, body: REPLY }, { now: T0 }), (err) => err instanceof RefusedError && /not linked to app-0001/.test(err.message));
  // and the text is still held to the confirmed facts
  assert.throws(() => draftMessage(dir, 'app-0002', { replyTo: inbound, body: REPLY }, { now: T0 }), /not linked to app-0002/);
  assert.throws(() => draftMessage(dir, 'app-0001', { replyTo: inbound, body: `${REPLY} I also have 7 years of Kubernetes.` }, { now: T0 }), /unsupported/);
});

test('send confirmation: an approved reply sent through the mocked Gmail API is recorded with Gmail\'s message id and correct threading', async () => {
  const dir = makeDir();
  const { eid } = replyReady(dir);
  setIntegration(dir, 'gmail-send', 'verified', 'send permission authorized (mock)', T0);
  const g = mockGoogle();
  const client = new GmailClient({ sdir: makeSecrets({ levels: ['read', 'send'] }), fetchImpl: g });
  const r = await sendWithIntegration(dir, eid, gmailSender(client), { now: T1 });
  assert.equal(r.sent, true);
  const e = csv(dir, 'email-events.csv').find((x) => x.event_id === eid);
  assert.deepEqual([e.status, e.provider_message_id, e.thread_id, e.occurred_at, e.approved_at], ['sent', 'gm-msg-77', 't-g-1', T1, T0]);
  const post = g.calls.filter((c) => c.method === 'POST' && c.url.includes('/messages/send'));
  assert.equal(post.length, 1);
  const raw = Buffer.from(JSON.parse(post[0].body).raw, 'base64url').toString('utf8');
  assert.match(raw, /^To: recruiting@robotics\.example\.com\r\nSubject: Re: Interview invitation: Software Engineering Intern\r\nIn-Reply-To: <g-1@mail.example.com>\r\nReferences: <g-1@mail.example.com>/);
  // never twice
  const g2 = mockGoogle();
  await sendWithIntegration(dir, eid, gmailSender(new GmailClient({ sdir: makeSecrets({ levels: ['read', 'send'] }), fetchImpl: g2 })), { now: T2 }).then(() => assert.fail('must refuse'), (err) => assert.match(err.message, /already sent/));
  assert.equal(g2.calls.length, 0);
  assertNoSecrets(dir);
});

test('send failures: a missing send permission, a Gmail refusal, a server error and a dropped connection are recorded truthfully', async () => {
  // read-only authorization: refused before any request, recorded as failed
  let dir = makeDir();
  let { eid } = replyReady(dir);
  setIntegration(dir, 'gmail-send', 'verified', 'claimed in error (mock)', T0);
  let g = mockGoogle();
  let r = await sendWithIntegration(dir, eid, gmailSender(new GmailClient({ sdir: makeSecrets({ levels: ['read'] }), fetchImpl: g })), { now: T1 });
  assert.equal(r.status, 'failed');
  assert.equal(g.calls.length, 0, 'no token refresh and no send request were made');
  assert.match(csv(dir, 'email-events.csv').find((x) => x.event_id === eid).summary, /missing_scope|permission was not granted/);

  // Gmail refuses (400): a definite failure
  dir = makeDir(); ({ eid } = replyReady(dir)); setIntegration(dir, 'gmail-send', 'verified', 'mock', T0);
  r = await sendWithIntegration(dir, eid, gmailSender(new GmailClient({ sdir: makeSecrets({ levels: ['send'] }), fetchImpl: mockGoogle({ sendStatus: 400 }) })), { now: T1 });
  assert.equal(r.status, 'failed');

  // 503 or a dropped connection after the request began: the message may have gone, so it is UNKNOWN and resending is blocked
  for (const opts of [{ sendStatus: 503 }, { sendThrows: true }]) {
    dir = makeDir(); ({ eid } = replyReady(dir)); setIntegration(dir, 'gmail-send', 'verified', 'mock', T0);
    g = mockGoogle(opts);
    r = await sendWithIntegration(dir, eid, gmailSender(new GmailClient({ sdir: makeSecrets({ levels: ['send'] }), fetchImpl: g })), { now: T1 });
    assert.equal(r.sent, false);
    assert.match(r.warning, /Do NOT resend/);
    const ev = csv(dir, 'email-events.csv').find((x) => x.event_id === eid);
    assert.equal(ev.status, 'approved');
    assert.match(ev.action_required, /^\[send-unverified\]/);
    const g3 = mockGoogle();
    await sendWithIntegration(dir, eid, gmailSender(new GmailClient({ sdir: makeSecrets({ levels: ['send'] }), fetchImpl: g3 })), { now: T2 }).then(() => assert.fail('must refuse'), (err) => assert.match(err.message, /unverified/));
    assert.equal(g3.calls.length, 0);
  }
});

// ================================================================ READINESS

test('readiness: the four categories follow real state: client file, sign-in, verification, staleness and revocation', () => {
  const dir = makeDir();
  const cat = (sdir, id, now = T1) => readiness(dir, { sdir, now }).items.find((i) => i.id === id);

  const none = makeSecrets({ client: false, token: false });
  let item = cat(none, 'gmail-read');
  assert.equal(item.category, 'requires_configuration');
  assert.match(item.reason, /no OAuth client file/);
  assert.ok(item.next_steps.some((s) => s.includes(paths(none).client)));
  assert.ok(item.ask_user.length > 0);

  const clientOnly = makeSecrets({ token: false });
  assert.equal(cat(clientOnly, 'gmail-read').category, 'requires_account_authorization');

  const readTok = makeSecrets({ levels: ['read'] });
  item = cat(readTok, 'gmail-read');
  assert.equal(item.category, 'requires_configuration');
  assert.match(item.reason, /authorized, but not verified/);

  setIntegration(dir, 'gmail-read', 'verified', 'profile call succeeded (mock)', T0);
  assert.equal(cat(readTok, 'gmail-read').category, 'available_and_verified');
  assert.equal(cat(readTok, 'gmail-send').category, 'requires_account_authorization', 'read access does not imply send access');
  assert.equal(cat(readTok, 'gmail-read', '2026-10-28T10:00:00Z').category, 'requires_configuration', 'a verification older than 12 hours is stale');

  setIntegration(dir, 'gmail-read', 'possible_unconfigured', 'revoked: invalid_grant', T1);
  assert.equal(cat(readTok, 'gmail-read').category, 'requires_account_authorization');

  assert.equal(cat(readTok, 'browser').category, 'requires_configuration');
  assert.equal(cat(readTok, 'portal-api').category, 'unsupported_or_unverified');
  assert.equal(cat(readTok, 'google-drive').category, 'requires_account_authorization');
  setIntegration(dir, 'browser', 'verified', 'opened a public page and read it (mock)', T1);
  assert.equal(cat(readTok, 'browser').category, 'available_and_verified');
});

test('readiness: tells Claude what to ask for when something is missing, never asks for secrets, and prints none', () => {
  const dir = makeDir();
  const sdir = makeSecrets({ levels: ['read', 'send'] });
  const r = readiness(dir, { sdir, now: T1 });
  assert.deepEqual(Object.keys(r.summary), CATEGORIES);
  assert.equal(r.items.length, 8);
  for (const i of r.items.filter((x) => x.category !== 'available_and_verified')) assert.ok(i.next_steps.length > 0, `${i.id} needs next steps`);
  assert.ok(RULES_FOR_MISSING.some((x) => /Never ask the user to paste a password, an OAuth client secret, a refresh token or an API key/.test(x)));
  assert.ok(RULES_FOR_MISSING.some((x) => /untrusted.*read it before running it.*explicit agreement/.test(x)));
  assert.match(JSON.stringify(r.items.find((i) => i.id === 'gmail-connector').next_steps), /Gmail connector.*MCP server/);
  const dump = JSON.stringify(r) + renderChecklist(r);
  for (const s of [SECRET_TOKEN, CLIENT_SECRET, 'access-token-test']) assert.ok(!dump.includes(s), 'readiness must not print secrets');
  for (const h of ['Available and verified', 'Requires account authorization', 'Requires configuration', 'Unsupported or unverified']) assert.match(renderChecklist(r), new RegExp(h));
  assert.equal(r.secrets_inside_repository, false);
});

test('probe: public feeds are marked verified only after a real response, and failures are recorded as such', async () => {
  const dir = makeDir();
  const sdir = makeSecrets();
  const ok = async (url) => ({ ok: true, status: 200, json: async () => (String(url).includes('greenhouse') || String(url).includes('ashby') ? { jobs: [] } : String(url).includes('freehire') ? { data: [], meta: { total: 12 } } : []) });
  const bad = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const noSleep = () => Promise.resolve();
  assert.equal((await probe(dir, 'ats-feeds', { fetchImpl: ok, now: T1, sleep: noSleep })).status, 'verified');
  assert.equal((await probe(dir, 'freehire', { fetchImpl: ok, now: T1 })).status, 'verified');
  assert.equal(readiness(dir, { sdir, now: T1 }).items.find((i) => i.id === 'ats-feeds').category, 'available_and_verified');
  const failed = await probe(dir, 'ats-feeds', { fetchImpl: bad, now: T2, sleep: noSleep });
  assert.equal(failed.status, 'unsupported_or_unverified');
  assert.match(failed.notes, /failed: greenhouse \(HTTP 500/);
  assert.equal(readiness(dir, { sdir, now: T2 }).items.find((i) => i.id === 'ats-feeds').category, 'unsupported_or_unverified');
  await assert.rejects(probe(dir, 'linkedin', { fetchImpl: ok }), /probe target/);
});

// ================================================================ PLATFORMS

test('platform matrix: every platform documents search, application, messaging, authentication, limits and verification; the markdown is generated', () => {
  const { platforms, statuses } = loadPlatforms();
  const ids = platforms.map((p) => p.id);
  for (const want of ['linkedin', 'indeed', 'naukri', 'internshala', 'wellfound', 'glassdoor', 'gmail', 'greenhouse-lever-ashby', 'freehire']) assert.ok(ids.includes(want), want);
  for (const p of platforms) {
    for (const cap of ['search', 'apply', 'messaging']) { assert.ok(p[cap].method.length >= 4, `${p.id}.${cap}.method`); assert.ok(statuses.includes(p[cap].status), `${p.id}.${cap}.status`); }
    assert.ok(p.auth && p.limits && p.evidence, `${p.id} needs auth, limits and evidence`);
    const verified = ['search', 'apply', 'messaging'].some((c) => p[c].status === 'verified');
    if (verified) assert.match(p.verified_on ?? '', /^\d{4}-\d{2}-\d{2}$/, `${p.id} claims verified without a date`);
  }
  const by = Object.fromEntries(platforms.map((p) => [p.id, p]));
  assert.notEqual(by.linkedin.messaging.status, 'verified');
  assert.notEqual(by.linkedin.apply.status, 'verified');
  assert.match(by.linkedin.messaging.method, /Gmail cannot send LinkedIn messages/);
  assert.equal(by.gmail.messaging.status, 'possible_unconfigured');
  assert.equal(by.naukri.search.status, 'unsupported_or_unverified');
  assert.match(by.glassdoor.search.method, /not reviewed|None tried/);
  assert.equal(platformsMdIsCurrent(), true, 'run: node scripts/integrations-store.mjs render-platforms --write');
});

// ================================================================ CLI GUARDS AND SAFETY

import { spawnSync } from 'node:child_process';
const cli = (script, args, env) => spawnSync(process.execPath, [join(repoRoot, 'scripts', script), ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

test('cli: refuses a secrets folder inside the repository; setup-help and check work without any network or secret', () => {
  const dir = makeDir();
  const bad = cli('gmail-store.mjs', ['status'], { INTERNSHIP_AGENT_HOME: dir, INTERNSHIP_AGENT_SECRETS: join(repoRoot, 'private', 'secrets') });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /inside the repository/);

  const sdir = mkdtempSync(join(tmpdir(), 'cli-secrets-'));
  const env = { INTERNSHIP_AGENT_HOME: dir, INTERNSHIP_AGENT_SECRETS: sdir };
  const help = cli('gmail-store.mjs', ['setup-help'], env);
  assert.equal(help.status, 0);
  const j = JSON.parse(help.stdout);
  assert.equal(j.client_file, join(sdir, 'google-oauth-client.json'));
  assert.match(j.never, /Do not paste the client secret, a password or a token/);
  assert.deepEqual(Object.keys(j.scopes_requested).slice(0, 2), ['read', 'send']);

  const chk = cli('gmail-store.mjs', ['check'], env);
  assert.equal(chk.status, 2);
  assert.equal(JSON.parse(chk.stdout).code, 'not_configured');
  assert.equal(syncState(dir).integrations['gmail-read'].status, 'possible_unconfigured');
  const sync = cli('gmail-store.mjs', ['sync'], env);
  assert.equal(sync.status, 2, 'an unconfigured mailbox is a refusal, not a crash');
  assert.equal(csv(dir, 'email-events.csv').length, 0);

  const ready = cli('integrations-store.mjs', ['readiness', '--text'], { ...env });
  assert.equal(ready.status, 0);
  assert.match(ready.stdout, /Requires configuration/);
});

test('cli: inbox-store ingests connector-supplied messages the same way as the API path', () => {
  const dir = makeDir();
  const f = join(dir, 'messages.json');
  writeFileSync(f, JSON.stringify({ messages: [M_INT, M_UNREL] }));
  const r = cli('inbox-store.mjs', ['ingest', f, '--source', 'connector'], { INTERNSHIP_AGENT_HOME: dir });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.recorded.length, 1);
  assert.equal(out.unrelated, 1);
  assert.equal(csv(dir, 'email-events.csv')[0].provider, 'other', 'a connector is not recorded as the Gmail API');
  const pend = cli('inbox-store.mjs', ['pending'], { INTERNSHIP_AGENT_HOME: dir });
  assert.deepEqual(JSON.parse(pend.stdout), []);
});

test('safety: no compose, modify, label or delete permission is requested anywhere; secrets are git-ignored; tokens are never in the repository', () => {
  const files = ['scripts', 'skills', 'references'].flatMap((d) => walk(join(repoRoot, d))).filter((f) => /\.(mjs|md|json)$/.test(f));
  for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), /auth\/gmail\.(compose|modify|metadata|labels|settings)|auth\/mail\.google\.com/, `${f} requests a permission this project must not use`);
  const lib = readFileSync(join(repoRoot, 'scripts/lib/gmail.mjs'), 'utf8');
  assert.doesNotMatch(lib, /method: 'DELETE'|\/trash|\/modify|\/labels|batchDelete/);
  const r = spawnSync('git', ['check-ignore', 'google-oauth-client.json', 'gmail-token.json', 'client_secret_123.json'], { cwd: repoRoot, encoding: 'utf8' });
  if (!r.error) assert.deepEqual(r.stdout.split(/\r?\n/).filter(Boolean).sort(), ['client_secret_123.json', 'gmail-token.json', 'google-oauth-client.json']);
  for (const n of ['google-oauth-client.json', 'gmail-token.json']) assert.equal(existsSync(join(repoRoot, n)), false);
  assert.ok(ApiError.prototype instanceof Error);
});

// ================================================================ PREFLIGHT

import { preflight, TASKS } from '../scripts/lib/readiness.mjs';

test('preflight: each task checks what it needs first and, when missing, returns the question and options to ask the user', () => {
  const dir = makeDir();
  const sdir = makeSecrets({ client: false, token: false });
  const p = (task, now = T1) => preflight(dir, task, { sdir, now });

  assert.equal(p('apply').ready, true, 'preparing an application needs no email');
  assert.throws(() => p('unknown-task'), /task must be one of/);

  const send = p('contact-recruiter');
  assert.equal(send.ready, false);
  assert.equal(send.can_continue_without, 'copy_ready');
  assert.match(send.ask_user.question, /Which email/);
  assert.deepEqual(send.ask_user.options.map((o) => o.id), ['connect-gmail-api', 'use-connector', 'copy-ready']);
  assert.ok(send.steps_by_choice['connect-gmail-api'].some((s) => s.includes(paths(sdir).client)), 'the steps name the exact file the user saves');
  assert.ok(send.steps_by_choice['use-connector'].length > 0);
  assert.match(send.instructions.join(' '), /Never ask them to paste a password, secret or token/);
  assert.match(JSON.stringify(send), /Claude never sees your password or tokens/);

  const inbox = p('inbox-sync');
  assert.equal(inbox.ready, false);
  assert.deepEqual(inbox.ask_user.options.map((o) => o.id), ['connect-gmail-api', 'use-connector', 'paste-instead']);
  assert.equal(inbox.can_continue_without, null, 'reading the inbox cannot proceed without a connection or pasted mail');

  const submit = p('submit-application');
  assert.equal(submit.ready, false);
  assert.equal(submit.can_continue_without, 'manual');
  assert.deepEqual(submit.ask_user.options.map((o) => o.id), ['connect-browser', 'submit-myself']);

  // after a real, recorded check the same task starts without asking
  const ready = makeSecrets({ levels: ['read', 'send'] });
  setIntegration(dir, 'gmail-send', 'verified', 'send permission authorized (mock)', T0);
  setIntegration(dir, 'gmail-read', 'verified', 'profile call succeeded (mock)', T0);
  setIntegration(dir, 'browser', 'verified', 'opened a public page (mock)', T0);
  assert.deepEqual(preflight(dir, 'contact-recruiter', { sdir: ready, now: T1 }), { task: 'contact-recruiter', title: 'Message a recruiter', ready: true, satisfied_by: ['gmail-send'], note: null });
  assert.equal(preflight(dir, 'inbox-sync', { sdir: ready, now: T1 }).ready, true);
  assert.equal(preflight(dir, 'submit-application', { sdir: ready, now: T1 }).ready, true);
  // a stale verification asks again
  assert.equal(preflight(dir, 'contact-recruiter', { sdir: ready, now: '2026-10-29T10:00:00Z' }).ready, false);
  assert.deepEqual(Object.keys(TASKS).sort(), ['apply', 'contact-recruiter', 'inbox-sync', 'submit-application']);
});

test('preflight: the skills that read the mailbox or send start with it, and ask before connecting', () => {
  // contact-recruiter covers both sending (Part A) and reading replies (Part B), so it runs both preflights
  assert.match(readFileSync(join(repoRoot, 'skills', 'contact-recruiter', 'SKILL.md'), 'utf8'), /preflight inbox-sync/);
  for (const [skill, task] of [['contact-recruiter', 'contact-recruiter'], ['submit-application', 'submit-application']]) {
    const body = readFileSync(join(repoRoot, 'skills', skill, 'SKILL.md'), 'utf8');
    assert.match(body, new RegExp(String.raw`## 0\. Preflight[\s\S]*preflight ${task}`), `${skill} must start with the preflight`);
    assert.ok(body.indexOf('## 0. Preflight') < body.indexOf('## 1.'), `${skill}: preflight comes before everything else`);
    assert.match(body, /stop and ask the user/);
    assert.match(body, /Never ask for a password, client secret, token or API key/);
  }
  const cliOut = spawnSync(process.execPath, [join(repoRoot, 'scripts/integrations-store.mjs'), 'preflight', 'contact-recruiter'], { encoding: 'utf8', env: { ...process.env, INTERNSHIP_AGENT_HOME: makeDir(), INTERNSHIP_AGENT_SECRETS: mkdtempSync(join(tmpdir(), 'pf-')) } });
  assert.equal(cliOut.status, 0, cliOut.stderr);
  assert.equal(JSON.parse(cliOut.stdout).ready, false);
});

// ================================================================ ASK, DON'T JUST REPORT, WHEN A CONNECTION FAILS

import { beginSend } from '../scripts/lib/contact.mjs';
import { beginSubmission } from '../scripts/lib/submit.mjs';
import { recovery } from '../scripts/lib/readiness.mjs';

test('failure recovery: an unavailable email connection asks which email or connector to use, with steps, instead of only failing', () => {
  const dir = makeDir();
  const { eid } = replyReady(dir);
  const r = beginSend(dir, eid, { now: T1 });
  assert.equal(r.started, false);
  assert.ok(r.recover, 'a recover payload is returned');
  assert.match(r.recover.failed_because, /gmail-send is not configured/);
  assert.match(r.recover.ask_user.question, /Which email/);
  assert.deepEqual(r.recover.ask_user.options.map((o) => o.id), ['connect-gmail-api', 'use-connector', 'copy-ready']);
  assert.ok(r.recover.steps_by_choice['connect-gmail-api'].length > 0);
  assert.match(r.next, /Do not just report this\. Ask the user/);
  assert.match(r.recover.instructions.join(' '), /Do not just report that it failed/);
  assert.equal(r.handoff.copy_ready_text, REPLY, 'the copy-ready fallback is still provided');
  assert.equal(csv(dir, 'email-events.csv').find((e) => e.event_id === eid).status, 'approved', 'the approved message is kept for a retry');
});

test('failure recovery: LinkedIn has nothing to connect, so it hands over the draft without a connect question', () => {
  const dir = makeDir();
  ingestMessages(dir, [M_INT], { now: T0 });
  const d = draftMessage(dir, 'app-0001', { platform: 'linkedin', to: 'https://www.linkedin.com/in/pat-recruiter', userProvided: true, name: 'Pat', body: 'Hello Pat, I applied for the Software Engineering Intern role at Example Robotics Inc. and have used Python in a course project.' }, { now: T0 });
  const c = messageCard(dir, d.event_id, { now: T0 });
  approveMessage(dir, d.event_id, { note: 'Yes, that one.', contentHash: c.content_hash }, { now: T0 });
  const r = beginSend(dir, d.event_id, { now: T1 });
  assert.equal(r.started, false);
  assert.equal(r.recover, undefined);
  assert.match(r.next, /copy-ready text and destination/);
});

test('failure recovery: an unavailable browser asks to connect one or to let the user submit, and an auth failure while sending asks to reconnect', async () => {
  // submission
  // build a prepared package so the gate passes: reuse the apply flow on a job
  const dir2 = makeDir();
  const { startApplication, prepare, addInput } = await import('../scripts/lib/apply.mjs');
  const { submissionCard, approveSubmission } = await import('../scripts/lib/submit.mjs');
  const sj = startApplication(dir2, 'job-0003', { now: T0 });
  addInput(dir2, sj.application_id, 'auth', 'Yes, I am a citizen.', 'Yes.', { now: T0 });
  const pkg = { analysis: { requirements: [{ text: 'Python', level: 'essential', source_quote: 'Backend Intern', status: 'met', evidence: ['skills[0]'] }] },
    resume: { education: [{ ref: 'education[0]' }], skills: ['Python'] }, cover_letter: { paragraphs: ['I am applying for the Backend Intern role at Northwind Labs because I have used Python.'], uses: ['skills[0]'] },
    answers: [{ question: 'Authorized to work?', kind: 'eligibility', answer: 'Yes, I am a citizen.', source: 'user:auth' }] };
  const jobs = csv(dir2, 'jobs.csv'); jobs[2].qualifications_text = 'Backend Intern with Python.';
  writeFileSync(join(dir2, 'jobs.csv'), serializeCsv(Object.keys(jobs[0]), jobs));
  prepare(dir2, sj.application_id, pkg, { now: T0 });
  const card = submissionCard(dir2, sj.application_id, { now: T1 });
  assert.equal(card.ready_for_approval, true, card.blockers.join('; '));
  approveSubmission(dir2, sj.application_id, { note: 'Yes, submit it.', packageHash: card.package_hash }, { now: T1 });
  const b = beginSubmission(dir2, sj.application_id, {}, { now: T1 });
  assert.equal(b.started, false);
  assert.deepEqual(b.recover.ask_user.options.map((o) => o.id), ['connect-browser', 'submit-myself']);
  assert.match(b.next, /Do not just report this/);
  assert.equal(b.recover.can_continue_without, 'manual');

  // authorization failing during a send: the sender remembers it so the CLI can ask how to reconnect
  const dir3 = makeDir();
  const { eid } = replyReady(dir3);
  setIntegration(dir3, 'gmail-send', 'verified', 'mock', T0);
  const sender = gmailSender(new GmailClient({ sdir: makeSecrets({ levels: ['send'] }), fetchImpl: mockGoogle({ tokenError: 'invalid_grant' }) }));
  const res = await sendWithIntegration(dir3, eid, sender, { now: T1 });
  assert.equal(res.status, 'failed');
  assert.equal(sender.lastAuthError.code, 'revoked');
  const rec = recovery(dir3, 'contact-recruiter', sender.lastAuthError.message, { now: T1 });
  assert.match(rec.failed_because, /revoked or expired/);
  assert.equal(rec.ask_user.options.length, 3);
  assert.equal(recovery(dir3, 'apply', 'x'), null, 'tasks with nothing to connect return nothing');
});

test('failure recovery: the CLI returns the question and options when Gmail is not configured, and the skills say to ask', () => {
  const dir = makeDir();
  const env = { INTERNSHIP_AGENT_HOME: dir, INTERNSHIP_AGENT_SECRETS: mkdtempSync(join(tmpdir(), 'rec-')) };
  for (const [args, task] of [[['check'], 'inbox-sync'], [['sync'], 'inbox-sync']]) {
    const r = cli('gmail-store.mjs', args, env);
    assert.equal(r.status, 2, `${args[0]}: ${r.stderr}`);
    const j = JSON.parse(r.stdout);
    assert.equal(j.code, 'not_configured');
    assert.ok(j.recover.ask_user.options.some((o) => o.id === 'connect-gmail-api') && j.recover.ask_user.options.some((o) => o.id === 'use-connector'), `${args[0]} offers the connect options (${task})`);
    assert.match(j.next, /Do not just report this/);
  }
  for (const skill of ['contact-recruiter', 'submit-application']) {
    const body = readFileSync(join(repoRoot, 'skills', skill, 'SKILL.md'), 'utf8');
    assert.match(body, /## When a connection fails/, `${skill} needs the failure section`);
    assert.match(body, /do not just report the error|not just report/i);
    assert.match(body, /recover/);
  }
});
