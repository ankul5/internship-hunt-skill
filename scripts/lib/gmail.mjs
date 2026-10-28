// Gmail API client (documented REST API, OAuth 2.0 loopback flow with PKCE). Uses only what was asked for:
//   read  -> https://www.googleapis.com/auth/gmail.readonly   (restricted scope; read-only sync)
//   send  -> https://www.googleapis.com/auth/gmail.send       (sensitive scope; sending only, no reading)
// No compose, modify, or delete scope is ever requested, so this client cannot alter or delete mail.
// `fetchImpl` is injectable so tests use mocked responses and never touch a real mailbox.
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readClient, readToken, writeToken, deleteToken } from './secrets.mjs';

export const SCOPES = { read: 'https://www.googleapis.com/auth/gmail.readonly', send: 'https://www.googleapis.com/auth/gmail.send' };
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://gmail.googleapis.com/gmail/v1/';

/** code: not_configured | not_authorized | revoked | missing_scope */
export class AuthError extends Error { constructor(message, code) { super(message); this.name = 'AuthError'; this.code = code; } }
export class ApiError extends Error { constructor(message, status, { sentPossible = false } = {}) { super(message); this.name = 'ApiError'; this.status = status; this.sentPossible = sentPossible; } }
export class RateLimitError extends ApiError { constructor(message, retryAfter) { super(message, 429); this.name = 'RateLimitError'; this.retryAfter = retryAfter; } }

const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const pkce = () => { const verifier = b64url(randomBytes(32)); return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }; };

/** Authorization URL requesting only the scopes asked for. */
export function buildAuthUrl({ clientId, redirectUri, levels, state, challenge }) {
  if (!levels?.length || levels.some((l) => !SCOPES[l])) throw new Error(`levels must be a non-empty subset of ${Object.keys(SCOPES).join(', ')}`);
  const u = new URL(AUTH_URL);
  u.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: levels.map((l) => SCOPES[l]).join(' '), state, code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent' }).toString();
  return u.toString();
}

const form = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null)).toString();
async function tokenCall(fetchImpl, body) {
  let res;
  try { res = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(body) }); }
  catch (e) { throw new ApiError(`could not reach Google's token endpoint: ${e.message}`, 0); }
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, j };
}

/**
 * Interactive authorization. Starts a loopback listener on 127.0.0.1, calls `showUrl(url)` so the user can open it,
 * waits for Google's redirect, exchanges the code (PKCE), and stores the refresh token outside the repository.
 */
export async function login({ sdir, levels, fetchImpl = fetch, showUrl, timeoutMs = 300000 }) {
  const client = readClient(sdir);
  if (!client) throw new AuthError(`no OAuth client file at ${sdir}; follow "gmail-store.mjs setup-help" first`, 'not_configured');
  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(16));
  let finish;
  const done = new Promise((resolve, reject) => { finish = { resolve, reject }; });
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname !== '/') { res.writeHead(404).end(); return; }
    const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/plain' }).end(ok ? 'Authorization received. You can close this tab and return to the terminal.' : 'Authorization failed or was cancelled. You can close this tab.');
    if (ok) finish.resolve(u.searchParams.get('code')); else finish.reject(new AuthError(`authorization was not granted (${u.searchParams.get('error') ?? 'state mismatch'})`, 'not_authorized'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const redirectUri = `http://127.0.0.1:${server.address().port}`;
  const timer = setTimeout(() => finish.reject(new AuthError('timed out waiting for authorization', 'not_authorized')), timeoutMs);
  try {
    const url = buildAuthUrl({ clientId: client.client_id, redirectUri, levels, state, challenge });
    showUrl?.(url, redirectUri);
    const code = await done;
    const t = await tokenCall(fetchImpl, { client_id: client.client_id, client_secret: client.client_secret, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri });
    if (!t.ok || !t.j.refresh_token) throw new AuthError(`Google did not return a refresh token (${t.j.error ?? t.status})`, 'not_authorized');
    writeToken(sdir, { refresh_token: t.j.refresh_token, scope: t.j.scope ?? levels.map((l) => SCOPES[l]).join(' '), obtained_at: new Date().toISOString() });
    return { levels, scopes: (t.j.scope ?? '').split(' ').filter(Boolean) };
  } finally { clearTimeout(timer); server.close(); }
}

export const grantedLevels = (token) => Object.entries(SCOPES).filter(([, s]) => (token?.scope ?? '').split(' ').includes(s)).map(([l]) => l);

export class GmailClient {
  constructor({ sdir, fetchImpl = fetch, now = () => Date.now() }) { Object.assign(this, { sdir, fetchImpl, now }); this.cache = null; }

  status() {
    const client = readClient(this.sdir), token = readToken(this.sdir);
    return { client_configured: !!client, authorized: !!token, levels: grantedLevels(token), obtained_at: token?.obtained_at ?? null };
  }

  need(level) {
    const client = readClient(this.sdir);
    if (!client) throw new AuthError('no OAuth client file; Gmail is not configured', 'not_configured');
    const token = readToken(this.sdir);
    if (!token) throw new AuthError('Gmail is not authorized; run the login step', 'not_authorized');
    if (level && !grantedLevels(token).includes(level)) throw new AuthError(`the "${level}" permission was not granted; authorize it separately (nothing was requested or sent)`, 'missing_scope');
    return { client, token };
  }

  async accessToken(level) {
    const { client, token } = this.need(level);
    if (this.cache && this.cache.until > this.now() + 30000) return this.cache.value;
    const t = await tokenCall(this.fetchImpl, { client_id: client.client_id, client_secret: client.client_secret, refresh_token: token.refresh_token, grant_type: 'refresh_token' });
    if (!t.ok) {
      this.cache = null;
      if (t.j.error === 'invalid_grant') throw new AuthError('access was revoked or expired (invalid_grant); authorize again', 'revoked');
      throw new AuthError(`token refresh failed (${t.j.error ?? t.status})`, 'not_authorized');
    }
    this.cache = { value: t.j.access_token, until: this.now() + (t.j.expires_in ?? 3600) * 1000 };
    return this.cache.value;
  }

  async request(level, method, path, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const at = await this.accessToken(level);
      let res;
      try { res = await this.fetchImpl(API + path, { method, headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); }
      catch (e) { throw new ApiError(`network error: ${e.message}`, 0, { sentPossible: method === 'POST' }); }
      if (res.status === 401) { this.cache = null; if (attempt === 0) continue; throw new AuthError('Gmail rejected the credentials (401); authorize again', 'revoked'); }
      const j = await res.json().catch(() => ({}));
      if (res.ok) return j;
      const msg = j.error?.message ?? `HTTP ${res.status}`;
      if (res.status === 403 && /insufficient|PERMISSION_DENIED|scope/i.test(`${msg} ${j.error?.status ?? ''}`)) throw new AuthError(`Gmail refused: ${msg}`, 'missing_scope');
      if (res.status === 429) throw new RateLimitError(`rate limited: ${msg}`, res.headers?.get?.('retry-after') ?? null);
      throw new ApiError(msg, res.status, { sentPossible: method === 'POST' && (res.status >= 500 || res.status === 408) });
    }
    throw new AuthError('unreachable', 'revoked');
  }

  profile() { return this.request('read', 'GET', 'users/me/profile'); }

  async listMessages({ query = '', max = 50, pageToken = null } = {}) {
    const q = new URLSearchParams({ maxResults: String(max), ...(query ? { q: query } : {}), ...(pageToken ? { pageToken } : {}) });
    const j = await this.request('read', 'GET', `users/me/messages?${q}`);
    return { ids: (j.messages ?? []).map((m) => m.id), next: j.nextPageToken ?? null };
  }

  getMessage(id) { return this.request('read', 'GET', `users/me/messages/${encodeURIComponent(id)}?format=full`); }

  /** Only the send permission is needed; this returns the provider's message id, which is the evidence of a send. */
  sendRaw(raw, threadId = null) { return this.request('send', 'POST', 'users/me/messages/send', threadId ? { raw, threadId } : { raw }); }

  async revoke() {
    const token = readToken(this.sdir);
    if (token) { try { await this.fetchImpl(REVOKE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ token: token.refresh_token }) }); } catch { /* the local token is removed regardless */ } }
    deleteToken(this.sdir);
    this.cache = null;
  }
}

// ---------------------------------------------------------------- message parsing and building

const header = (m, name) => (m.payload?.headers ?? []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
const decodePart = (d) => Buffer.from(d ?? '', 'base64url').toString('utf8');
function bodyOf(payload) {
  const plain = [], html = [];
  const walk = (p) => { if (!p) return; if (p.mimeType === 'text/plain' && p.body?.data) plain.push(decodePart(p.body.data)); else if (p.mimeType === 'text/html' && p.body?.data) html.push(decodePart(p.body.data)); (p.parts ?? []).forEach(walk); };
  walk(payload);
  return (plain.join('\n') || html.join('\n').replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').trim();
}
export function parseFrom(v) {
  const m = String(v).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim(), email: m[2].trim().toLowerCase() } : { name: '', email: String(v).trim().toLowerCase() };
}

/** Normalised message used by the inbox pipeline. The body stays in memory for classification and is never stored. */
export function normalizeMessage(m) {
  const body = bodyOf(m.payload);
  const from = parseFrom(header(m, 'From'));
  const ms = Number(m.internalDate) || Date.parse(header(m, 'Date')) || 0;
  return {
    provider: 'gmail', id: m.id, thread_id: m.threadId ?? '', received_at: ms ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
    from_name: from.name, from_email: from.email, to: header(m, 'To').split(',').map((s) => parseFrom(s).email).filter(Boolean),
    subject: header(m, 'Subject'), snippet: m.snippet ?? '', body_text: body, message_id_header: header(m, 'Message-ID') || header(m, 'Message-Id'), references: header(m, 'References'),
    links: [...new Set((body.match(/https?:\/\/[^\s<>"')]+/g) ?? []).map((u) => u.replace(/[.,;:!?]+$/, '')))].slice(0, 20),
  };
}

const noCrlf = (v, what) => { if (/[\r\n]/.test(String(v))) throw new Error(`${what} must not contain line breaks`); return String(v); };
const mimeWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

/** RFC 2822 message, base64url-encoded as users.messages.send requires. Reply threading uses In-Reply-To and References. */
export function buildRaw({ to, subject, body, inReplyTo = null, references = null }) {
  const lines = [`To: ${noCrlf(to, 'to')}`, `Subject: ${mimeWord(noCrlf(subject, 'subject'))}`];
  if (inReplyTo) lines.push(`In-Reply-To: ${noCrlf(inReplyTo, 'in-reply-to')}`);
  if (references || inReplyTo) lines.push(`References: ${noCrlf(references || inReplyTo, 'references')}`);
  lines.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', (Buffer.from(String(body), 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n'));
  return b64url(lines.join('\r\n'));
}

/**
 * The `gmail-send` integration object for contact.mjs sendWithIntegration. Anything that may have been sent but is not
 * confirmed (network error, 5xx, timeout) is returned as ambiguous; a definite refusal (4xx, auth) as failed.
 */
export function gmailSender(client) {
  const self = {
    name: 'gmail-send',
    async send({ to, subject, body, in_reply_to = null, references = null, thread_id = null }) {
      let raw;
      try { raw = buildRaw({ to, subject, body, inReplyTo: in_reply_to, references }); } catch (e) { return { ok: false, error: `message not built: ${e.message}` }; }
      try {
        const r = await client.sendRaw(raw, thread_id || null);
        if (!r?.id) return { ambiguous: true, note: 'Gmail answered without a message id' };
        return { ok: true, message_id: r.id, thread_id: r.threadId ?? '', evidence: `Gmail API users.messages.send returned id ${r.id}${r.threadId ? ` (thread ${r.threadId})` : ''}` };
      } catch (e) {
        if (e instanceof AuthError) self.lastAuthError = e;
        if (e instanceof AuthError || e instanceof RateLimitError) return { ok: false, error: `${e.name}: ${e.message}` };
        if (e instanceof ApiError && !e.sentPossible) return { ok: false, error: `Gmail API ${e.status}: ${e.message}` };
        return { ambiguous: true, note: `${e.message}; the message may or may not have been sent` };
      }
    },
  };
  return self;
}
