// Inbox pipeline: normalised messages (from the Gmail API client, or from a connector the harness provides) are
// de-duplicated, matched to tracked applications, classified, and recorded in email-events.csv.
// It never alters a mailbox (no delete, archive, label or mark-read) and never stores message bodies.
// Message text is DATA: instructions inside an email are never followed.
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { loadAll, commit, withRun, checkId, appOf, str, sha, writeText, readIf } from './apply.mjs';
import { readTable, nextNum, fmtId, readJson, writeAtomic, RefusedError } from './ingest.mjs';
import { loadCsvSchemas, isoNow } from './data.mjs';

const ID_EVT = /^eml-\d{4,}$/;
export const MATCH_HIGH = 0.6, MATCH_GAP = 0.25, MATCH_MIN = 0.3, CLASS_MIN = 0.7;
const CLOSED = ['withdrawn', 'declined', 'accepted'];
const STOP = new Set('inc llc ltd limited pvt private corp corporation co company technologies technology systems solutions labs group the and of for'.split(' '));
const ROLE_STOP = new Set('intern internship engineer role position the a an and of for'.split(' '));
const GENERIC_HOSTS = /(^|\.)(gmail|googlemail|outlook|hotmail|yahoo|linkedin|indeed|naukri|internshala|wellfound|glassdoor)\.(com|in)$/i;
const words = (s) => String(s ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
const has = (hay, toks) => toks.length > 0 && toks.every((t) => hay.includes(` ${t} `));
const pad = (s) => ` ${words(s).join(' ')} `;
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const canon = (u) => { try { const x = new URL(u); return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}`.toLowerCase(); } catch { return ''; } };

// ---------------------------------------------------------------- classification

const RULES = [
  ['offer', 0.9, /\b(pleased to offer|offer letter|offer of employment|extend(ing)? (you )?an offer|we would like to offer you)\b/i],
  ['rejection', 0.9, /\b(not (be )?moving forward|will not be (moving|proceeding)|regret to inform|unfortunately,? (we|your)|decided to (move|proceed) (forward )?with other|not selected|other candidates)\b/i],
  ['interview', 0.85, /\b(interview|schedule a (call|chat|time)|invite you to (a|an|our)|your availability|book a (slot|time))\b/i],
  ['assessment', 0.85, /\b(assessment|coding challenge|online test|take-?home|hackerrank|codility|codesignal|complete the (test|task))\b/i],
  ['request_for_information', 0.8, /\b(please (provide|send|share|submit|upload)|could you (please )?(provide|send|share)|additional information|transcript|references? (letter|contact)|proof of)\b/i],
  ['auto_acknowledgement', 0.8, /\b(thank you for (applying|your application|your interest)|we (have )?received your application|application (has been )?received)\b/i],
];
const OUTCOMES = ['offer', 'rejection', 'interview', 'assessment'];
const KIND = { offer: 'offer', rejection: 'rejection', interview: 'interview_invite', assessment: 'assessment', request_for_information: 'reply', auto_acknowledgement: 'reply', recruiter_reply: 'reply', other: 'other' };
const ACTION = {
  offer: 'Review the offer and reply within any stated deadline', rejection: '', interview: 'Reply to schedule the interview', assessment: 'Complete the assessment before its deadline',
  request_for_information: 'Provide the requested information', auto_acknowledgement: '', recruiter_reply: 'Read the reply and respond if needed', other: '',
};
const STATUS_FOR = { offer: 'offer', rejection: 'rejected', interview: 'interview', assessment: 'assessment', auto_acknowledgement: 'acknowledged' };

/** Keyword classification with a confidence and the exact phrases that triggered it. Ambiguity lowers confidence. */
export function classify(msg) {
  const text = `${msg.subject ?? ''}\n${msg.snippet ?? ''}\n${msg.body_text ?? ''}`;
  const hits = RULES.map(([cat, conf, re]) => { const m = text.match(re); return m ? { cat, conf, phrase: m[0].toLowerCase() } : null; }).filter(Boolean);
  if (!hits.length) return { category: 'recruiter_reply', kind: KIND.recruiter_reply, confidence: 0.4, phrases: [], action: ACTION.recruiter_reply };
  // Outcome categories conflict with each other (an interview invite that also says "unfortunately" needs a human).
  // A request for information or an acknowledgement is secondary and never conflicts with an outcome.
  const strong = hits.filter((h) => OUTCOMES.includes(h.cat));
  const pick = (strong.length ? strong : hits)[0];
  const conflicting = strong.length > 1 && new Set(strong.map((h) => h.cat)).size > 1;
  const confidence = Math.max(0.3, pick.conf - (conflicting ? 0.3 : 0));
  return { category: pick.cat, kind: KIND[pick.cat], confidence: Math.round(confidence * 100) / 100, phrases: hits.map((h) => h.phrase).slice(0, 3), action: ACTION[pick.cat], conflicting: conflicting ? strong.map((h) => h.cat) : null };
}

// ---------------------------------------------------------------- matching

/** Score every open application against one message. Returns candidates sorted best first, with the reasons. */
export function matchMessage(msg, contexts) {
  const fromHay = pad(`${msg.from_name} ${msg.from_email.split('@')[1] ?? ''}`);
  const subjHay = pad(msg.subject);
  const bodyHay = pad(`${msg.snippet ?? ''} ${msg.body_text ?? ''}`);
  const linkSet = new Set((msg.links ?? []).map(canon).filter(Boolean));
  const out = [];
  for (const c of contexts) {
    let score = 0; const why = [];
    if (msg.thread_id && c.threads.has(msg.thread_id)) { score += 0.9; why.push('thread'); }
    if (c.contacts.has(msg.from_email)) { score += 0.8; why.push('known contact'); }
    const linked = [c.job.source_url, c.job.apply_url].map(canon).filter(Boolean);
    if (linked.some((l) => linkSet.has(l))) { score += 0.6; why.push('link to the posting'); }
    else if ([c.job.source_url, c.job.apply_url].map(hostOf).some((h) => h && !GENERIC_HOSTS.test(h) && (msg.from_email.split('@')[1] ?? '').endsWith(h))) { score += 0.15; why.push('sender domain is the employer site'); }
    const ctoks = words(c.job.company).filter((t) => !STOP.has(t));
    const ct = ctoks.length ? ctoks : words(c.job.company);
    if (has(fromHay, ct)) { score += 0.4; why.push('company in sender'); }
    else if (has(subjHay, ct)) { score += 0.3; why.push('company in subject'); }
    else if (has(bodyHay, ct)) { score += 0.25; why.push('company in text'); }
    const rt = words(c.job.title).filter((t) => !ROLE_STOP.has(t));
    if (rt.length) {
      const frac = (hay) => rt.filter((t) => hay.includes(` ${t} `)).length / rt.length;
      if (frac(subjHay) >= 0.6) { score += 0.25; why.push('role in subject'); } else if (frac(bodyHay) >= 0.6) { score += 0.15; why.push('role in text'); }
    }
    if (score >= MATCH_MIN) out.push({ application_id: c.app.application_id, job_id: c.job.job_id, score: Math.min(1, Math.round(score * 100) / 100), why });
  }
  return out.sort((a, b) => b.score - a.score);
}

export function decideMatch(cands) {
  if (!cands.length) return { outcome: 'unrelated', best: null, cands };
  const [a, b] = cands;
  if (a.score >= MATCH_HIGH && (!b || Math.round((a.score - b.score) * 100) / 100 >= MATCH_GAP)) return { outcome: 'matched', best: a, cands };
  return { outcome: 'ambiguous', best: null, cands };
}

// ---------------------------------------------------------------- ingest

const isoSec = (s) => (s && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(s) ? s : null);
const clip = (s, n) => str(s).slice(0, n);
const normSubject = (s) => words(String(s ?? '').replace(/^\s*((re|fwd?|aw|wg)\s*:\s*)+/i, '')).join(' ');

/**
 * Provider-independent identity of a message: sender, subject without Re:/Fwd:, and received time to the second.
 * The same email fetched through the Gmail API and through a connector (or pasted) gets the same key.
 */
export const stableKey = (fromEmail, subject, receivedAt) => sha(`${String(fromEmail).toLowerCase()}|${normSubject(subject)}|${receivedAt}`).slice(0, 16);
/** gmail only for this repository's Gmail API client; a connector is other; pasted text is manual. */
const providerOf = (source) => (source === 'gmail' ? 'gmail' : source === 'pasted' ? 'manual' : 'other');
/** A message with no provider id (pasted text) is recorded under this id, so pasting it twice is still a duplicate. */
export const stableId = (msg) => `stable-${stableKey(msg.from_email, msg.subject, msg.received_at)}`;

function contextsOf(appsT, jobsT, evT) {
  return appsT.records.filter((a) => !CLOSED.includes(a.status)).map((app) => {
    const job = jobsT.records.find((j) => j.job_id === app.job_id);
    const evs = evT.records.filter((e) => e.application_id === app.application_id);
    return { app, job, threads: new Set(evs.map((e) => e.thread_id).filter(Boolean)), contacts: new Set(evs.filter((e) => e.direction === 'outbound').map((e) => e.contact_email.toLowerCase()).filter(Boolean)) };
  }).filter((c) => c.job);
}

function summaryOf(cls, decision, status) {
  const label = { interview: 'Interview invitation', assessment: 'Assessment', rejection: 'Rejection', offer: 'Offer', request_for_information: 'Request for information', auto_acknowledgement: 'Automatic acknowledgement', recruiter_reply: 'Recruiter reply', other: 'Other' }[cls.category];
  const m = decision.best ? `match ${decision.best.application_id} (${decision.best.why.join(', ')}) conf ${decision.best.score}` : decision.outcome === 'ambiguous' ? `AMBIGUOUS match: ${decision.cands.slice(0, 3).map((c) => `${c.application_id} ${c.score}`).join(', ')}` : 'no match';
  return clip(`[${status}] ${label}${cls.phrases.length ? ` (matched: "${cls.phrases[0]}")` : ''}; class conf ${cls.confidence}; ${m}`, 300);
}

/** Apply a classification to the application row when it is safe and allowed by the lifecycle. Returns the change or null. */
function advance(app, cls, receivedAt, transitions, now) {
  const target = STATUS_FOR[cls.category];
  Object.assign(app, { last_response_at: receivedAt, updated_at: now });
  if (cls.action) app.next_action = cls.action;
  if (!target || cls.confidence < CLASS_MIN || target === app.status) return null;
  if (!(transitions[app.status] ?? []).includes(target)) return null;
  const from = app.status;
  app.status = target;
  return { from, to: target };
}

/**
 * Record a batch of normalised messages. Messages already recorded (same provider message id) are skipped.
 * High-confidence matches update the application; ambiguous matches or classifications wait for the user.
 */
export function ingestMessages(dir, messages, { now = isoNow(), source = 'gmail', skill = 'contact-recruiter' } = {}) {
  if (!Array.isArray(messages)) throw new Error('messages must be an array');
  return withRun(dir, `inbox: ingest ${messages.length} message(s) from ${source}`, now, ({ profile }) => {
    const S = loadCsvSchemas();
    const { appsT, jobsT } = loadAll(dir);
    const evT = readTable(dir, 'email-events.csv', S['email-events.csv']);
    const transitions = S['applications.csv'].transitions;
    // Two keys: the provider's message id, and a provider-independent key (sender|subject|time) for the same email
    // arriving through a different route (API, connector, pasted).
    const seen = new Set(evT.records.map((e) => e.provider_message_id).filter(Boolean));
    const seenStable = new Set(evT.records.filter((e) => e.direction === 'inbound' && e.occurred_at).map((e) => stableKey(e.contact_email, e.subject, e.occurred_at)));
    const own = new Set([profile.identity?.email].filter(Boolean).map((e) => e.toLowerCase()));
    const contexts = contextsOf(appsT, jobsT, evT);
    const result = { recorded: [], duplicates: 0, own_messages: 0, unrelated: 0, ambiguous: [], invalid: [], updated_applications: [], max_received_at: null };
    const metas = [];
    let created = 0, updated = 0;

    for (const msg of messages) {
      const problems = [];
      if (!isoSec(msg.received_at)) problems.push('received_at (UTC YYYY-MM-DDTHH:MM:SSZ)');
      if (!str(msg.from_email)) problems.push('from_email');
      if (!str(msg.id) && !['pasted', 'connector'].includes(source)) problems.push('id');
      if (problems.length) { result.invalid.push({ id: msg.id ?? null, missing: problems }); continue; }
      const id = str(msg.id) || stableId(msg);
      const key = stableKey(msg.from_email, msg.subject, msg.received_at);
      if (seen.has(id) || seenStable.has(key)) { result.duplicates += 1; continue; }
      seen.add(id); seenStable.add(key);
      if (!result.max_received_at || msg.received_at > result.max_received_at) result.max_received_at = msg.received_at;
      if (own.has(msg.from_email.toLowerCase())) { result.own_messages += 1; continue; } // the user's own sent mail is not an update

      const m = { ...msg, id, from_email: msg.from_email.toLowerCase(), from_name: msg.from_name ?? '' };
      const decision = decideMatch(matchMessage(m, contexts));
      if (decision.outcome === 'unrelated') { result.unrelated += 1; continue; }
      const cls = classify(m);
      const confident = decision.outcome === 'matched' && cls.confidence >= CLASS_MIN;

      const eventId = fmtId('eml', nextNum(evT.records, 'event_id'));
      const row = Object.fromEntries(evT.header.map((h) => [h, '']));
      let change = null;
      if (decision.outcome === 'matched') {
        const ctx = contexts.find((c) => c.app.application_id === decision.best.application_id);
        Object.assign(row, { application_id: ctx.app.application_id, job_id: ctx.job.job_id });
        if (confident) {
          const before = ctx.app.status;
          change = advance(ctx.app, cls, m.received_at, transitions, now);
          updated += 1;
          ctx.app.notes = [ctx.app.notes, `[email ${m.received_at}] ${cls.category}${change ? `; status ${before} -> ${change.to}` : before !== 'submitted' && STATUS_FOR[cls.category] && !change ? `; status ${before} not changed` : ''}`].filter(Boolean).join(' | ').slice(0, 1000);
          if (change) result.updated_applications.push({ application_id: ctx.app.application_id, ...change });
        }
      }
      const needsHuman = !confident;
      Object.assign(row, {
        event_id: eventId, direction: 'inbound', kind: needsHuman && decision.outcome === 'matched' && cls.confidence < CLASS_MIN ? 'other' : cls.kind, status: needsHuman ? 'received' : 'processed', provider: providerOf(source),
        contact_name: clip(m.from_name, 100), contact_email: m.from_email, subject: clip(m.subject, 200), thread_id: str(m.thread_id), provider_message_id: str(m.id), occurred_at: m.received_at,
        summary: summaryOf(cls, decision, needsHuman ? 'needs confirmation' : 'recorded'), created_at: now, updated_at: now,
        action_required: decision.outcome === 'ambiguous' ? `Confirm which application this belongs to: ${decision.cands.slice(0, 3).map((c) => `${c.application_id} (${c.score})`).join(', ')}` : cls.confidence < CLASS_MIN ? `Confirm the category (looks like ${cls.category}${cls.conflicting ? `, but also ${cls.conflicting.join('/')}` : ''})` : cls.action,
      });
      evT.records.push(row);
      created += 1;
      result.recorded.push({ event_id: eventId, provider_message_id: id, application_id: row.application_id || null, kind: row.kind, status: row.status, confidence: { match: decision.best?.score ?? null, class: cls.confidence } });
      if (decision.outcome === 'ambiguous') result.ambiguous.push({ event_id: eventId, candidates: decision.cands.slice(0, 3) });
      // Reply threading data only (never the body). Used when drafting a reply.
      metas.push([eventId, { message_id_header: m.message_id_header ?? '', references: m.references ?? '', subject: m.subject ?? '', thread_id: m.thread_id ?? '', provider_message_id: m.id }]);
    }
    if (created || updated) commit(dir, S, { 'email-events.csv': evT, 'applications.csv': appsT }, now);
    // Written only after the rows exist, so a failed commit never leaves threading files for unused event ids.
    if (metas.length) mkdirSync(join(dir, 'email-exports'), { recursive: true });
    for (const [eventId, meta] of metas) writeText(join(dir, 'email-exports', `${eventId}.meta.json`), JSON.stringify(meta, null, 2));
    return { created, updated, summary: `inbox: ${result.recorded.length} recorded, ${result.duplicates} duplicate, ${result.own_messages} own, ${result.unrelated} unrelated, ${result.ambiguous.length} ambiguous`, result };
  }, { skill });
}

/** Events waiting for the user: ambiguous matches or categories. */
export function pendingEvents(dir) {
  const S = loadCsvSchemas();
  return readTable(dir, 'email-events.csv', S['email-events.csv']).records.filter((e) => e.direction === 'inbound' && e.status === 'received').map((e) => ({
    event_id: e.event_id, from: e.contact_email, subject: e.subject, received_at: e.occurred_at, application_id: e.application_id || null, kind: e.kind, summary: e.summary, action_required: e.action_required }));
}

/** The user resolved an ambiguous match or category. */
export function confirmEvent(dir, eventId, { applicationId, kind, note }, { now = isoNow() } = {}) {
  checkId(eventId, ID_EVT, 'event');
  if (!str(note)) throw new RefusedError('record the user\'s confirmation words as --note');
  return withRun(dir, `inbox: confirm ${eventId}`, now, () => {
    const S = loadCsvSchemas();
    const { appsT, jobsT } = loadAll(dir);
    const evT = readTable(dir, 'email-events.csv', S['email-events.csv']);
    const e = evT.records.find((r) => r.event_id === eventId);
    if (!e || e.direction !== 'inbound') throw new Error(`no such inbound event: ${eventId}`);
    if (e.status !== 'received') throw new RefusedError(`${eventId} is ${e.status}; only an unconfirmed event can be confirmed`);
    const KINDS = ['reply', 'interview_invite', 'assessment', 'rejection', 'offer', 'other'];
    const app = appOf(appsT, applicationId || e.application_id);
    const job = jobsT.records.find((j) => j.job_id === app.job_id);
    const k = kind || e.kind;
    if (!KINDS.includes(k)) throw new Error(`--kind must be ${KINDS.join('|')}`);
    const cat = { interview_invite: 'interview', assessment: 'assessment', rejection: 'rejection', offer: 'offer' }[k] ?? 'recruiter_reply';
    const change = advance(app, { category: cat, confidence: 1, action: ACTION[cat] }, e.occurred_at, S['applications.csv'].transitions, now);
    app.notes = [app.notes, `[email ${e.occurred_at} confirmed by the user] ${cat}${change ? `; status ${change.from} -> ${change.to}` : ''}`].filter(Boolean).join(' | ').slice(0, 1000);
    Object.assign(e, { application_id: app.application_id, job_id: job.job_id, kind: k, status: 'processed', updated_at: now, action_required: ACTION[cat], summary: clip(`${e.summary} | confirmed by the user: ${str(note)}`, 300) });
    commit(dir, S, { 'email-events.csv': evT, 'applications.csv': appsT }, now);
    return { updated: 2, result: { event_id: eventId, application_id: app.application_id, kind: k, status: 'processed', application_status: app.status, changed: change } };
  });
}

/** The user says this email is not about any application. The record stays as a processed, unlinked event. */
export function dismissEvent(dir, eventId, note, { now = isoNow() } = {}) {
  checkId(eventId, ID_EVT, 'event');
  if (!str(note)) throw new RefusedError('record the user\'s words as --note');
  return withRun(dir, `inbox: dismiss ${eventId}`, now, () => {
    const S = loadCsvSchemas();
    const evT = readTable(dir, 'email-events.csv', S['email-events.csv']);
    const e = evT.records.find((r) => r.event_id === eventId && r.direction === 'inbound');
    if (!e) throw new Error(`no such inbound event: ${eventId}`);
    if (e.status !== 'received') throw new RefusedError(`${eventId} is ${e.status}`);
    Object.assign(e, { application_id: '', job_id: '', status: 'processed', kind: 'other', action_required: '', updated_at: now, summary: clip(`Dismissed by the user: ${str(note)}`, 300) });
    commit(dir, S, { 'email-events.csv': evT }, now);
    return { updated: 1, result: { event_id: eventId, status: 'processed', dismissed: true } };
  });
}

/** Threading data saved at ingest, for drafting a reply. */
export function replyContext(dir, eventId) {
  const t = readIf(join(dir, 'email-exports', `${eventId}.meta.json`));
  return t ? JSON.parse(t) : null;
}

/** Record the sync cursor after a COMPLETE fetch. A partial or failed sync never advances it. */
export function setCursor(dir, cursor, now = isoNow()) {
  const p = join(dir, 'sync-state.json');
  const s = readJson(p);
  s.gmail = { ...(s.gmail ?? {}), last_sync_at: now, cursor: String(cursor) };
  writeAtomic(p, JSON.stringify(s, null, 2) + '\n');
}
