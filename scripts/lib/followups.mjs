// follow-ups: which sent messages may deserve one polite follow-up, using only recorded timestamps and the timing the
// user approved. Policy (references/contact-discovery.md): at most one follow-up, no sooner than 7 days after the
// message, only if there was no reply. A follow-up is never sent from here: drafts go through contact-store
// card -> approve -> begin-send -> record-send like any other message.
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { loadAll, commit, withRun, checkId, appOf, str, ID_APP } from './apply.mjs';
import { readTable, readJson, writeAtomic, RefusedError } from './ingest.mjs';
import { loadCsvSchemas, isoNow } from './data.mjs';
import { draftFollowUp } from './contact.mjs';
import { updatesState, gaps } from './updates.mjs';
import { requireWords } from './outbound.mjs';

export const POLICY = { min_after_days: 7, max_per_message: 1 };
export const DEFAULTS = { after_days: 7, max_per_message: 1 };
const AWAITING = ['submitted', 'acknowledged', 'interview', 'assessment'];
const FIRST_KINDS = ['recruiter_outreach', 'application_email', 'reply'];
const prefsPath = (dir) => join(dir, 'preferences.json');
const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 86400000;
const addDays = (t, n) => new Date(Date.parse(t) + n * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Timing the user approved, or the policy default marked as not yet approved. */
export function getPrefs(dir) {
  const p = existsSync(prefsPath(dir)) ? readJson(prefsPath(dir)).follow_up : null;
  return p?.approved_at ? { ...p, approved: true } : { ...DEFAULTS, approved: false, approved_at: null, approval_note: null };
}

/** Save the user's follow-up timing. It may be slower than the policy, never faster or more frequent. */
export function setPrefs(dir, { afterDays, maxPerMessage = 1, note }, { now = isoNow() } = {}) {
  const words = requireWords(note, 'follow-up timing');
  const after = Number(afterDays), max = Number(maxPerMessage);
  if (!Number.isInteger(after) || after < POLICY.min_after_days || after > 60) throw new RefusedError(`--after-days must be a whole number from ${POLICY.min_after_days} to 60 (the policy never follows up sooner than ${POLICY.min_after_days} days)`);
  if (!Number.isInteger(max) || max < 0 || max > POLICY.max_per_message) throw new RefusedError(`--max must be 0 or ${POLICY.max_per_message} (the policy allows at most one follow-up per message)`);
  const cur = existsSync(prefsPath(dir)) ? readJson(prefsPath(dir)) : {};
  const follow_up = { after_days: after, max_per_message: max, approved_at: now, approval_note: words };
  writeAtomic(prefsPath(dir), JSON.stringify({ ...cur, follow_up }, null, 2) + '\n');
  return { follow_up, approved: true };
}

const isAutoAck = (e) => /Automatic acknowledgement/.test(e.summary);

/** Inbox coverage for the time since a message: the gaps nobody checked. */
function inboxGaps(dir, from, now) {
  const src = updatesState(dir).sources;
  const covered = Object.values(src).flatMap((s) => s.covered ?? []);
  return gaps(covered, from, now);
}

/**
 * Every awaiting application, sorted into: due (a follow-up may be appropriate now), waiting (not yet), blocked
 * (something must be checked first) and not_applicable (with the reason). Nothing is written.
 */
export function followUpReport(dir, { now = isoNow() } = {}) {
  const S = loadCsvSchemas();
  const { appsT, jobsT } = loadAll(dir);
  const evs = readTable(dir, 'email-events.csv', S['email-events.csv']).records;
  const prefs = getPrefs(dir);
  const unlinkedPending = evs.filter((e) => e.direction === 'inbound' && e.status === 'received' && !e.application_id).length;
  const out = { now, timing: prefs, due: [], waiting: [], blocked: [], not_applicable: [] };

  for (const app of appsT.records) {
    const job = jobsT.records.find((j) => j.job_id === app.job_id);
    const base = { application_id: app.application_id, company: job?.company ?? null, role: job?.title ?? null, status: app.status };
    if (!AWAITING.includes(app.status)) {
      if (app.status === 'submission_unconfirmed') out.blocked.push({ ...base, reason: 'the submission itself is unconfirmed; verify it before any follow-up' });
      continue;
    }
    if (/\[no-follow-up[ \]]/.test(app.notes)) { out.not_applicable.push({ ...base, reason: 'the user chose no follow-up for this application' }); continue; }
    const mine = evs.filter((e) => e.application_id === app.application_id);
    const sent = mine.filter((e) => e.direction === 'outbound' && e.status === 'sent' && FIRST_KINDS.includes(e.kind) && e.occurred_at).sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1));
    if (!sent.length) { out.not_applicable.push({ ...base, reason: 'no message was sent for this application, so there is nothing to follow up on (a first message is a /contact-recruiter step)' }); continue; }
    const last = sent[0];
    const followUps = mine.filter((e) => e.kind === 'follow_up');
    const sentFollowUps = followUps.filter((e) => e.status === 'sent' && e.occurred_at > last.occurred_at);
    const openFollowUp = followUps.find((e) => ['draft', 'approved'].includes(e.status));
    const replies = mine.filter((e) => e.direction === 'inbound' && e.occurred_at > last.occurred_at && !isAutoAck(e));
    const pendingMine = mine.filter((e) => e.direction === 'inbound' && e.status === 'received');
    const item = { ...base, message: { event_id: last.event_id, kind: last.kind, sent_at: last.occurred_at, to: last.contact_email, subject: last.subject }, follow_ups_sent: sentFollowUps.length };

    if (replies.length) { out.not_applicable.push({ ...item, reason: `a reply arrived ${replies[0].occurred_at} (${replies[0].event_id}); answer it instead of following up` }); continue; }
    if (sentFollowUps.length >= prefs.max_per_message) { out.not_applicable.push({ ...item, reason: `the follow-up limit (${prefs.max_per_message}) for this message is reached` }); continue; }
    if (openFollowUp) { out.blocked.push({ ...item, reason: `${openFollowUp.event_id} is already a ${openFollowUp.status} follow-up; show its card, approve or discard it` }); continue; }
    if (pendingMine.length || unlinkedPending) { out.blocked.push({ ...item, reason: `${pendingMine.length + unlinkedPending} inbound message(s) wait for the user to confirm which application they belong to; one may be the reply` }); continue; }
    const dueAt = addDays(last.occurred_at, prefs.after_days);
    // A date recorded on the application (next_action_due) is respected; none is ever assumed.
    const promised = app.next_action_due && `${app.next_action_due}T23:59:59Z` > now ? app.next_action_due : null;
    if (promised) { out.waiting.push({ ...item, due_at: `${app.next_action_due}T23:59:59Z`, reason: `the application records a later date (${app.next_action_due}): ${app.next_action || 'no detail'}` }); continue; }
    if (dueAt > now) { out.waiting.push({ ...item, due_at: dueAt, reason: `${Math.floor(days(last.occurred_at, now))} of ${prefs.after_days} days since the message` }); continue; }
    const g = inboxGaps(dir, last.occurred_at, now);
    out.due.push({ ...item, due_at: dueAt, days_since: Math.floor(days(last.occurred_at, now)),
      inbox_unchecked: g.length ? g : null,
      warning: g.length ? `the inbox has not been checked for part of the time since the message (${g.map(([a, b]) => `${a} to ${b}`).join('; ')}); run check-updates first, a reply may have arrived` : null });
  }
  if (!prefs.approved) out.timing_note = `Timing is the policy default (${DEFAULTS.after_days} days, one follow-up). Ask the user to confirm or choose a longer wait, then save it with set-prefs. Drafting needs a confirmed timing.`;
  return out;
}

/** Draft one follow-up. Refused unless the report lists the application as due with the inbox checked since the message. */
export function draft(dir, appId, { body, subject = null, allowUncheckedInbox = false }, { now = isoNow() } = {}) {
  checkId(appId, ID_APP, 'application');
  const prefs = getPrefs(dir);
  if (!prefs.approved) throw new RefusedError('the follow-up timing has not been confirmed by the user; ask them and run set-prefs first');
  const r = followUpReport(dir, { now });
  const item = r.due.find((x) => x.application_id === appId);
  if (!item) {
    const other = [...r.waiting, ...r.blocked, ...r.not_applicable].find((x) => x.application_id === appId);
    throw new RefusedError(`${appId} is not due for a follow-up: ${other ? other.reason + (other.due_at ? ` (due ${other.due_at})` : '') : 'it is not an application awaiting a response'}`);
  }
  if (item.inbox_unchecked && !allowUncheckedInbox) throw new RefusedError(`${item.warning}. If the user says to go ahead anyway, pass --allow-unchecked-inbox.`);
  return draftFollowUp(dir, appId, { of: item.message.event_id, body, subject, basis: `${item.days_since} days without a reply; timing confirmed ${prefs.approved_at}` }, { now });
}

/** The user decided not to follow up on this application. Recorded with their words; reversible by editing notes. */
export function skip(dir, appId, note, { now = isoNow() } = {}) {
  checkId(appId, ID_APP, 'application');
  const words = requireWords(note, 'skipping a follow-up');
  return withRun(dir, `follow-ups: skip ${appId}`, now, () => {
    const { S, appsT } = loadAll(dir);
    const app = appOf(appsT, appId);
    app.notes = [app.notes, `[no-follow-up ${now}] ${words}`].filter(Boolean).join(' | ').slice(0, 1000);
    app.updated_at = now;
    commit(dir, S, { 'applications.csv': appsT }, now);
    return { updated: 1, result: { application_id: appId, follow_up: 'skipped' } };
  }, { skill: 'follow-ups' });
}
