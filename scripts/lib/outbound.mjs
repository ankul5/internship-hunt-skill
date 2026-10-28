// Shared guards for outward actions (submitting applications, sending messages).
// This code never submits or sends. It gates, binds approval to exact content, and records what was observed.
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeAtomic, RefusedError } from './ingest.mjs';
import { isoNow } from './data.mjs';
import { str } from './apply.mjs';

/** Integration records older than this are treated as not exercised in the current session. */
export const FRESH_HOURS = 12;

/** Which integration may carry which action. Platforms absent here are copy-ready only. */
export const SUBMIT_INTEGRATIONS = { portal: ['browser', 'portal-api'], other: ['browser', 'portal-api'], manual_by_user: [] };
export const SEND_INTEGRATIONS = { gmail: 'gmail-send', outlook: 'outlook-send' }; // linkedin and other platforms: none, by design
export const PLATFORMS = ['gmail', 'outlook', 'linkedin', 'other'];
export const PROVIDER_OF = { gmail: 'gmail', outlook: 'outlook', linkedin: 'manual', other: 'manual' };
export const MAX_SENDS_PER_DAY = 5;

export const EVIDENCE_KINDS = ['confirmation_page', 'receipt', 'api_response', 'confirmation_email', 'user_pasted_confirmation'];
const GENERIC = /^(ok|okay|done|success|successful|submitted|sent|yes|true|worked|completed|all good)[.!]?$/i;
const NEGATIVE = /(captcha|error|failed|failure|try again|invalid|required field|something went wrong|not submitted|unable to|blocked|denied)/i;

export const hoursBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / 3600000;

/** Status of one integration from sync-state.json. Missing means possible_unconfigured. */
export function integrationStatus(dir, name, now = isoNow()) {
  const rec = readJson(join(dir, 'sync-state.json')).integrations?.[name];
  if (!rec) return { name, usable: false, status: 'possible_unconfigured', reason: `${name} is not configured` };
  if (rec.status !== 'verified') return { name, usable: false, status: rec.status, reason: `${name} is ${rec.status}${rec.notes ? `: ${rec.notes}` : ''}` };
  if (!rec.checked_at || hoursBetween(rec.checked_at, now) > FRESH_HOURS) return { name, usable: false, status: 'verified', reason: `${name} was last verified ${rec.checked_at ?? 'never'}, more than ${FRESH_HOURS} hours ago; test it again in this session first` };
  return { name, usable: true, status: 'verified', checked_at: rec.checked_at, notes: rec.notes ?? null };
}

/** Record the result of actually exercising an integration. Only call after a real, observed test. */
export function setIntegration(dir, name, status, notes, now = isoNow()) {
  if (!/^[a-z0-9-]{2,30}$/.test(name ?? '')) throw new Error('integration name must be 2-30 characters of a-z, 0-9, -');
  if (!['verified', 'possible_unconfigured', 'unsupported_or_unverified'].includes(status)) throw new Error('status must be verified, possible_unconfigured or unsupported_or_unverified');
  if (status === 'verified' && !str(notes)) throw new RefusedError('verified needs --notes saying what you actually did (for example "opened the form page and read its fields")');
  const p = join(dir, 'sync-state.json');
  const sync = readJson(p);
  sync.integrations = { ...(sync.integrations ?? {}), [name]: { status, checked_at: now, notes: str(notes) || null } };
  writeAtomic(p, JSON.stringify(sync, null, 2) + '\n');
  return { name, ...sync.integrations[name] };
}

/** Approval wording must exist; it is stored verbatim. The caller must only pass the user's own words. */
export function requireWords(note, what) {
  const n = str(note);
  if (n.length < 3) throw new RefusedError(`${what} needs the user's own approval words as --note; ask them and quote the reply`);
  return n;
}

/** Evidence rules: success is claimed only with specific, positive, observed evidence. */
export function checkEvidence(kind, text, { success }) {
  const t = str(text);
  if (success) {
    if (!EVIDENCE_KINDS.includes(kind)) throw new RefusedError(`success needs --evidence-kind ${EVIDENCE_KINDS.join('|')}`);
    if (t.length < 15 || GENERIC.test(t)) throw new RefusedError('success needs specific evidence you actually saw (confirmation text, reference number, response body), not a generic word');
    if (NEGATIVE.test(t)) throw new RefusedError(`the evidence mentions a problem ("${t.match(NEGATIVE)[0]}"), so it cannot support a success. Record the outcome as failed or unconfirmed.`);
  } else if (!t) throw new RefusedError('record what you observed (the error text, or what was unclear)');
  return t;
}

/** Append-only per-application log of approvals, attempts and results. Private, inside tailored/<app>/. */
export function appendLog(dir, appId, entry) {
  const d = join(dir, 'tailored', appId);
  mkdirSync(d, { recursive: true });
  appendFileSync(join(d, 'submission-log.jsonl'), `${JSON.stringify(entry)}\n`);
}
export function readLog(dir, appId) {
  const p = join(dir, 'tailored', appId, 'submission-log.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}
