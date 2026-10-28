// Recruiter outreach: sourced contacts, drafts from confirmed facts, approval bound to the exact text,
// sends only through a verified integration, results recorded as observed.
// Each platform is treated separately: Gmail/Outlook can be sent through a verified connector; LinkedIn and
// everything else is copy-ready only. This module never sends anything itself.
import { join } from 'node:path';
import { existsSync, appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { loadAll, commit, withRun, checkId, jobOf, appOf, readInputs, confirmedText, unsupportedClaims, jobText, str, sha, readIf, writeText, ID_APP } from './apply.mjs';
import { readTable, nextNum, fmtId, RefusedError } from './ingest.mjs';
import { loadCsvSchemas, isoNow } from './data.mjs';
import { replyContext } from './inbox.mjs';
import { recovery } from './readiness.mjs';
import { PLATFORMS, PROVIDER_OF, SEND_INTEGRATIONS, MAX_SENDS_PER_DAY, integrationStatus, requireWords, checkEvidence } from './outbound.mjs';

export const MAX_CONTACTS_PER_APPLICATION = 1;
export const MAX_CONTACTS_PER_COMPANY = 2;
const KINDS = ['recruiter_outreach', 'application_email', 'reply'];
const ACTIVE = ['draft', 'approved', 'sent'];
const ID_EVT = /^eml-\d{4,}$/;
const LINKEDIN_PROFILE = /^https?:\/\/([a-z]+\.)?linkedin\.com\/in\/[^\s/]+\/?/i;
const LINKEDIN_MESSAGING = 'https://www.linkedin.com/messaging/';
const MAX_BODY = 1500;

const draftRel = (id) => `drafts/${id}.md`;
const logPath = (dir, id) => join(dir, 'drafts', `${id}.log.jsonl`);
const evLog = (dir, id, e) => { mkdirSync(join(dir, 'drafts'), { recursive: true }); appendFileSync(logPath(dir, id), `${JSON.stringify(e)}\n`); };
const readEvLog = (dir, id) => (existsSync(logPath(dir, id)) ? readFileSync(logPath(dir, id), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const lastEv = (log, ...names) => [...log].reverse().find((e) => names.includes(e.event));

function renderDraft(f) {
  return [`Platform: ${f.platform}`, `To: ${f.to}`, `Name: ${f.name || ''}`, `Subject: ${f.subject || ''}`, `Contact source: ${f.source}`, `Application: ${f.appId} (${f.jobId})`, `Kind: ${f.kind}`, ...(f.thread ? [`Thread: ${f.thread}`] : []), ...(f.inReplyTo ? [`In-Reply-To: ${f.inReplyTo}`] : []), ...(f.references ? [`References: ${f.references}`] : []), '---', f.body.trim(), ''].join('\n');
}
function parseDraft(text) {
  const [head, ...rest] = text.split('\n---\n');
  const get = (k) => (head.match(new RegExp(`^${k}: ?(.*)$`, 'm')) ?? [])[1]?.trim() ?? '';
  return { platform: get('Platform'), to: get('To'), name: get('Name'), subject: get('Subject'), source: get('Contact source'), application: get('Application'), kind: get('Kind'), thread: get('Thread'), in_reply_to: get('In-Reply-To'), references: get('References'), body: rest.join('\n---\n').trim() };
}

function tables(dir) {
  const S = loadCsvSchemas();
  const t = loadAll(dir);
  return { ...t, evT: readTable(dir, 'email-events.csv', S['email-events.csv']) };
}
const eventOf = (evT, id) => { checkId(id, ID_EVT, 'event'); const e = evT.records.find((r) => r.event_id === id); if (!e) throw new Error(`no such event: ${id}`); return e; };
const today = (now) => now.slice(0, 10);

/** The destination a human would use for this draft, and what (if anything) can send it. */
function route(dir, platform, to, now) {
  if (platform === 'linkedin') return { mode: 'copy_ready', destination: LINKEDIN_PROFILE.test(to) ? to : LINKEDIN_MESSAGING, why: 'LinkedIn messages are never sent by this tool; the user sends them in LinkedIn.' };
  if (platform === 'other') return { mode: 'copy_ready', destination: /^https?:\/\//.test(to) ? to : null, why: 'No supported sending integration exists for this platform.' };
  const name = SEND_INTEGRATIONS[platform];
  const st = integrationStatus(dir, name, now);
  return st.usable ? { mode: 'send', integration: name, destination: to } : { mode: 'copy_ready', integration: name, destination: platform === 'gmail' ? `mailto:${to}` : `mailto:${to}`, why: `Cannot send: ${st.reason}` };
}

function checkClaims(dir, profile, job, appId, name, subject, body) {
  const inputs = Object.values(readInputs(dir, appId)).map((i) => i.value).join('\n');
  const evidence = `${confirmedText(profile)}\n${jobText(job, [])}\n${inputs}\n${name || ''}`;
  return unsupportedClaims(`${subject}\n${body}`, evidence);
}

/** Create a draft. The contact must be sourced or given by the user; the text may use only real facts. */
export function draftMessage(dir, appId, f, { now = isoNow() } = {}) {
  checkId(appId, ID_APP, 'application');
  return withRun(dir, `contact: draft for ${appId}`, now, ({ profile }) => {
    const { S, appsT, jobsT, evT } = tables(dir);
    const app = appOf(appsT, appId);
    const job = jobOf(jobsT, app.job_id);
    const problems = [];
    let reply = null;
    if (f.replyTo) {
      const ev = evT.records.find((e) => e.event_id === f.replyTo);
      if (!ev || ev.direction !== 'inbound') problems.push(`replyTo ${f.replyTo} is not an inbound message`);
      else if (ev.application_id !== appId) problems.push(`${f.replyTo} is not linked to ${appId}; confirm the match first (inbox-store confirm)`);
      else if (!ev.contact_email) problems.push(`${f.replyTo} has no sender address to reply to`);
      else {
        const ctx = replyContext(dir, ev.event_id) ?? {};
        const orig = ctx.subject || ev.subject;
        reply = { ev, ctx };
        f = { ...f, platform: 'gmail', to: ev.contact_email, name: f.name || ev.contact_name, kind: 'reply', userProvided: false, contactSourceUrl: '', subject: f.subject || (/^re:/i.test(orig) ? orig : `Re: ${orig}`) };
      }
    }
    if (!PLATFORMS.includes(f.platform)) problems.push(`platform must be ${PLATFORMS.join('|')}`);
    const kind = f.kind ?? 'recruiter_outreach';
    if (!KINDS.includes(kind)) problems.push(`kind must be ${KINDS.join('|')}`);
    if (['rejected', 'expired', 'archived'].includes(job.status)) problems.push(`${job.job_id} is ${job.status}`);
    if (['withdrawn', 'rejected', 'declined'].includes(app.status)) problems.push(`${appId} is ${app.status}`);
    const to = str(f.to), body = String(f.body ?? '').trim(), subject = str(f.subject);
    const sourceUrl = str(f.contactSourceUrl);
    if (!reply && !f.userProvided && !/^https?:\/\/\S+$/.test(sourceUrl)) problems.push('the contact needs contact_source_url (a page that publishes it) or user_provided; a contact with neither is not used. Addresses are never guessed.');
    if (f.platform === 'linkedin') {
      if (!f.userProvided) problems.push('LinkedIn contacts must come from the user (the agent does not read LinkedIn profiles)');
      if (!LINKEDIN_PROFILE.test(to)) problems.push('for LinkedIn, to must be the profile URL the user gave (linkedin.com/in/...)');
    } else if (['gmail', 'outlook'].includes(f.platform)) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) problems.push('to must be a valid email address');
      if (!subject) problems.push('subject is required for email');
    } else if (!to) problems.push('to is required');
    if (!body) problems.push('body is required');
    if (body.length > MAX_BODY) problems.push(`body is ${body.length} characters; keep recruiter messages under ${MAX_BODY}`);
    if (!problems.length) for (const c of checkClaims(dir, profile, job, appId, f.name, subject, body)) problems.push(`unsupported ${c}: not in the confirmed profile, the posting, or the user's recorded input`);

    const out = reply ? [] : evT.records.filter((e) => e.direction === 'outbound' && ['recruiter_outreach', 'application_email'].includes(e.kind) && ACTIVE.includes(e.status));
    const contactKey = (e) => (e.contact_email || parseDraft(readIf(join(dir, e.draft_path)) ?? '').to || '').toLowerCase();
    const mine = out.filter((e) => e.application_id === appId);
    if (mine.some((e) => contactKey(e) === to.toLowerCase())) problems.push(`this contact already has a ${mine.find((e) => contactKey(e) === to.toLowerCase()).status} message for ${appId}; a follow-up belongs to the follow-up step, not a second first message`);
    else if (new Set(mine.map(contactKey)).size >= MAX_CONTACTS_PER_APPLICATION) problems.push(`${appId} already has a message to a contact (limit ${MAX_CONTACTS_PER_APPLICATION} per application); discard it first if the user wants a different contact`);
    const sameCompany = out.filter((e) => jobsT.records.find((j) => j.job_id === e.job_id)?.company.toLowerCase() === job.company.toLowerCase());
    if (!mine.some((e) => contactKey(e) === to.toLowerCase()) && new Set(sameCompany.map(contactKey)).size >= MAX_CONTACTS_PER_COMPANY) problems.push(`${job.company} already has ${MAX_CONTACTS_PER_COMPANY} contacts (the per-company limit)`);
    if (problems.length) throw new RefusedError(`draft refused; nothing was written:\n- ${problems.join('\n- ')}`);

    const id = fmtId('eml', nextNum(evT.records, 'event_id'));
    const source = reply ? `reply to ${reply.ev.event_id}` : f.userProvided ? 'given by the user' : sourceUrl;
    const row = Object.fromEntries(evT.header.map((h) => [h, '']));
    Object.assign(row, { event_id: id, application_id: appId, job_id: job.job_id, direction: 'outbound', kind, status: 'draft', provider: PROVIDER_OF[f.platform],
      contact_name: str(f.name), contact_email: ['gmail', 'outlook'].includes(f.platform) ? to : '', contact_source_url: f.userProvided || reply ? '' : sourceUrl, subject, thread_id: reply?.ev.thread_id ?? '', draft_path: draftRel(id),
      summary: `[${f.platform}] ${reply ? `Reply to ${reply.ev.event_id}. ` : f.userProvided ? 'Contact given by the user. ' : ''}Draft: ${body.slice(0, 80).replace(/\s+/g, ' ')}`, action_required: 'Await the user\'s approval of this exact text', created_at: now, updated_at: now });
    evT.records.push(row);
    writeText(join(dir, row.draft_path), renderDraft({ platform: f.platform, to, name: f.name, subject, source, appId, jobId: job.job_id, kind, body, thread: reply?.ev.thread_id, inReplyTo: reply?.ctx.message_id_header, references: reply ? [reply.ctx.references, reply.ctx.message_id_header].filter(Boolean).join(' ') : undefined }));
    commit(dir, S, { 'email-events.csv': evT }, now);
    evLog(dir, id, { at: now, event: 'draft' });
    return { created: 1, summary: `contact: drafted ${id} for ${appId}`, result: { event_id: id, status: 'draft', platform: f.platform, draft_path: row.draft_path, sent: false, route: route(dir, f.platform, to, now) } };
  });
}

/**
 * Draft a follow-up to a message already sent for this application. The recipient, thread and subject come from that
 * sent message (never typed in), so a follow-up can only go to someone who was really written to. Eligibility (timing,
 * no reply, limits) is decided by followups.mjs, which calls this.
 */
export function draftFollowUp(dir, appId, { of: sentId, body, subject = null, basis }, { now = isoNow() } = {}) {
  checkId(appId, ID_APP, 'application');
  return withRun(dir, `follow-ups: draft for ${appId}`, now, ({ profile }) => {
    const { S, appsT, jobsT, evT } = tables(dir);
    const app = appOf(appsT, appId);
    const job = jobOf(jobsT, app.job_id);
    const sent = eventOf(evT, sentId);
    const problems = [];
    if (sent.application_id !== appId || sent.direction !== 'outbound' || sent.status !== 'sent') problems.push(`${sentId} is not a sent message for ${appId}`);
    const d = sent.draft_path ? parseDraft(readIf(join(dir, sent.draft_path)) ?? '') : {};
    const platform = d.platform || sent.provider;
    if (!['gmail', 'outlook'].includes(platform)) problems.push(`${sentId} went out by ${platform || 'an unknown route'}; follow-ups are drafted for email only (for LinkedIn, write it yourself in LinkedIn)`);
    if (!sent.contact_email) problems.push(`${sentId} has no recipient address`);
    const open = evT.records.find((e) => e.application_id === appId && e.kind === 'follow_up' && ['draft', 'approved'].includes(e.status));
    if (open) problems.push(`${open.event_id} is already a ${open.status} follow-up for ${appId}; approve, revise or discard it instead`);
    const text = String(body ?? '').trim();
    const subj = str(subject) || (/^re:/i.test(sent.subject) ? sent.subject : `Re: ${sent.subject}`);
    if (!text) problems.push('body is required');
    if (text.length > MAX_BODY) problems.push(`body is ${text.length} characters; keep it under ${MAX_BODY}`);
    if (!problems.length) for (const c of checkClaims(dir, profile, job, appId, sent.contact_name, subj, text)) problems.push(`unsupported ${c}: not in the confirmed profile, the posting, or the user's recorded input`);
    if (problems.length) throw new RefusedError(`follow-up refused; nothing was written:\n- ${problems.join('\n- ')}`);

    const id = fmtId('eml', nextNum(evT.records, 'event_id'));
    const row = Object.fromEntries(evT.header.map((h) => [h, '']));
    Object.assign(row, { event_id: id, application_id: appId, job_id: job.job_id, direction: 'outbound', kind: 'follow_up', status: 'draft', provider: sent.provider,
      contact_name: sent.contact_name, contact_email: sent.contact_email, subject: subj, thread_id: sent.thread_id, draft_path: draftRel(id),
      summary: `[${platform}] Follow-up to ${sentId} (${str(basis)}). Draft: ${text.slice(0, 60).replace(/\s+/g, ' ')}`.slice(0, 300), action_required: 'Await the user\'s approval of this exact text', created_at: now, updated_at: now });
    evT.records.push(row);
    writeText(join(dir, row.draft_path), renderDraft({ platform, to: sent.contact_email, name: sent.contact_name, subject: subj, source: `follow-up to ${sentId}`, appId, jobId: job.job_id, kind: 'follow_up', body: text, thread: sent.thread_id || undefined }));
    commit(dir, S, { 'email-events.csv': evT }, now);
    evLog(dir, id, { at: now, event: 'draft', follow_up_of: sentId });
    return { created: 1, summary: `follow-ups: drafted ${id} for ${appId}`, result: { event_id: id, status: 'draft', follow_up_of: sentId, to: sent.contact_email, subject: subj, draft_path: row.draft_path, sent: false, route: route(dir, platform, sent.contact_email, now) } };
  }, { skill: 'follow-ups' });
}

/** What the user must see before approving: recipient, platform, subject, full text, hash, and how it would go out. */
export function messageCard(dir, eventId, { now = isoNow() } = {}) {
  const { evT, jobsT } = tables(dir);
  const e = eventOf(evT, eventId);
  const text = readIf(join(dir, e.draft_path));
  if (text == null) throw new RefusedError(`the draft file ${e.draft_path} is missing`);
  const d = parseDraft(text);
  const job = jobsT.records.find((j) => j.job_id === e.job_id);
  const sentToday = evT.records.filter((x) => x.direction === 'outbound' && x.status === 'sent' && (x.occurred_at || '').startsWith(today(now))).length;
  return {
    event_id: eventId, status: e.status, platform: d.platform, to: d.to, contact_name: d.name || null, contact_source: d.source, subject: d.subject || null,
    employer: job?.company, role: job?.title, application_id: e.application_id, full_text: d.body, content_hash: sha(text),
    route: route(dir, d.platform, d.to, now), sends_today: sentToday, daily_limit: MAX_SENDS_PER_DAY,
    reply: d.in_reply_to || d.thread ? { thread: d.thread, in_reply_to: d.in_reply_to, references: d.references } : null,
    instructions: 'Show the user the recipient, platform, subject and the complete text, then ask whether to send this exact message to this exact recipient. Approve only on their explicit yes.',
  };
}

/** Rewrite a draft after the user's edits. Any earlier approval is void. */
export function reviseMessage(dir, eventId, { subject, body }, { now = isoNow() } = {}) {
  return withRun(dir, `contact: revise ${eventId}`, now, ({ profile }) => {
    const { S, evT, jobsT } = tables(dir);
    const e = eventOf(evT, eventId);
    if (!['draft', 'approved', 'failed'].includes(e.status)) throw new RefusedError(`${eventId} is ${e.status}; it cannot be revised`);
    const d = parseDraft(readIf(join(dir, e.draft_path)));
    const job = jobOf(jobsT, e.job_id);
    const nb = body == null ? d.body : String(body).trim(), ns = subject == null ? d.subject : str(subject);
    const claims = checkClaims(dir, profile, job, e.application_id, d.name, ns, nb);
    if (claims.length) throw new RefusedError(`revision refused:\n- ${claims.map((c) => `unsupported ${c}`).join('\n- ')}`);
    if (nb.length > MAX_BODY) throw new RefusedError(`body is over ${MAX_BODY} characters`);
    writeText(join(dir, e.draft_path), renderDraft({ ...d, subject: ns, body: nb, appId: e.application_id, jobId: e.job_id }));
    Object.assign(e, { status: 'draft', approved_at: '', subject: ns, updated_at: now, action_required: 'Await the user\'s approval of this exact text' });
    commit(dir, S, { 'email-events.csv': evT }, now);
    evLog(dir, eventId, { at: now, event: 'revised' });
    return { updated: 1, result: { event_id: eventId, status: 'draft', approval_void: true, sent: false } };
  });
}

export function approveMessage(dir, eventId, { note, contentHash }, { now = isoNow() } = {}) {
  const words = requireWords(note, 'approving a message');
  return withRun(dir, `contact: approve ${eventId}`, now, () => {
    const { S, evT } = tables(dir);
    const e = eventOf(evT, eventId);
    if (!['draft', 'failed'].includes(e.status)) throw new RefusedError(`${eventId} is ${e.status}; only a draft (or a failed send, re-approved) can be approved`);
    const card = messageCard(dir, eventId, { now });
    if (contentHash !== card.content_hash) throw new RefusedError('content_hash does not match the current draft: approval must be of exactly the text the user saw. Re-show the card.');
    if (card.sends_today >= MAX_SENDS_PER_DAY) throw new RefusedError(`${card.sends_today} messages were already sent today (limit ${MAX_SENDS_PER_DAY}); this tool does not mass-message`);
    Object.assign(e, { status: 'approved', approved_at: now, updated_at: now, action_required: card.route.mode === 'send' ? 'Send through the verified integration' : 'Copy-ready only: the user sends it themselves' });
    commit(dir, S, { 'email-events.csv': evT }, now);
    evLog(dir, eventId, { at: now, event: 'approval', hash: card.content_hash, note: words });
    return { updated: 1, run: { approvals_requested: '1', approvals_granted: '1' }, result: { event_id: eventId, status: 'approved', approved_at: now, sent: false, route: card.route } };
  });
}

export function denyMessage(dir, eventId, note, { now = isoNow() } = {}) {
  const words = requireWords(note, 'recording a denial');
  return withRun(dir, `contact: denied ${eventId}`, now, () => {
    const { S, evT } = tables(dir);
    const e = eventOf(evT, eventId);
    if (!['draft', 'approved', 'failed'].includes(e.status)) throw new RefusedError(`${eventId} is ${e.status}`);
    if (lastEv(readEvLog(dir, eventId), 'send_started') && !lastEv(readEvLog(dir, eventId), 'send_result')) throw new RefusedError('a send is in flight; record its result first');
    Object.assign(e, { status: 'discarded', approved_at: '', updated_at: now, action_required: '', summary: `Discarded by the user: ${words}`.slice(0, 200) });
    commit(dir, S, { 'email-events.csv': evT }, now);
    evLog(dir, eventId, { at: now, event: 'denial', note: words });
    return { updated: 1, run: { approvals_requested: '1', approvals_granted: '0' }, result: { event_id: eventId, status: 'discarded', sent: false } };
  });
}

/** Copy-ready text and the official destination. Needs no approval because nothing is sent. */
export function handoff(dir, eventId, { now = isoNow() } = {}) {
  const c = messageCard(dir, eventId, { now });
  return { event_id: eventId, platform: c.platform, destination: c.route.destination, to: c.to, subject: c.subject, copy_ready_text: c.full_text, sent: false,
    note: c.platform === 'linkedin' ? 'Open the destination in LinkedIn and paste this yourself; this tool never sends LinkedIn messages.' : 'Copy this into the destination yourself; nothing has been sent.' };
}

/** Start an approved send. Returns started:false with a hand-off when no verified integration can carry it. */
export function beginSend(dir, eventId, { now = isoNow() } = {}) {
  return withRun(dir, `contact: begin send ${eventId}`, now, () => {
    const { S, evT } = tables(dir);
    const e = eventOf(evT, eventId);
    const log = readEvLog(dir, eventId);
    if (e.status === 'sent') throw new RefusedError(`${eventId} was already sent (${e.provider_message_id}); it is never sent twice`);
    if (lastEv(log, 'send_started') && !lastEv(log, 'send_result')) throw new RefusedError(`a send of ${eventId} has no recorded result: check the Sent folder, record it, or run verify-send before anything is retried`);
    if (/\[send-unverified\]/.test(e.action_required)) throw new RefusedError(`the last send of ${eventId} is unverified: run verify-send before any retry`);
    if (e.status !== 'approved') throw new RefusedError(`${eventId} is ${e.status}, not approved: nothing is sent without the user's approval of this exact message`);
    const card = messageCard(dir, eventId, { now });
    const ap = lastEv(log, 'approval', 'denial');
    if (ap?.event !== 'approval' || ap.hash !== card.content_hash) {
      Object.assign(e, { status: 'draft', approved_at: '', updated_at: now, action_required: 'Approval void: the text changed after approval. Show the user and ask again.' });
      commit(dir, S, { 'email-events.csv': evT }, now);
      evLog(dir, eventId, { at: now, event: 'approval_void' });
      return { updated: 1, result: { started: false, voided: true, status: 'draft', reason: 'The draft changed after it was approved. Approval is void.' } };
    }
    if (card.sends_today >= MAX_SENDS_PER_DAY) throw new RefusedError(`${card.sends_today} messages were already sent today (limit ${MAX_SENDS_PER_DAY})`);
    if (card.route.mode !== 'send') return { updated: 0, result: { started: false, reason: card.route.why, handoff: handoff(dir, eventId, { now }), ...(['gmail', 'outlook'].includes(card.platform) ? { recover: recovery(dir, 'contact-recruiter', card.route.why, { now }) } : {}), next: ['gmail', 'outlook'].includes(card.platform) ? 'Do not just report this. Ask the user the recover.ask_user question (which email or connector, or copy-ready) and help them connect; the approved message stays approved and nothing was sent or logged as in flight.' : 'Give the user the copy-ready text and destination. Nothing was sent or logged as in flight.' } };
    evLog(dir, eventId, { at: now, event: 'send_started', integration: card.route.integration });
    return { updated: 0, result: { started: true, event_id: eventId, integration: card.route.integration, payload: { to: card.to, subject: card.subject, body: card.full_text, ...(card.reply ? { thread_id: card.reply.thread, in_reply_to: card.reply.in_reply_to, references: card.reply.references } : {}) }, rules: ['Send exactly this payload to exactly this recipient.', 'Then record what the provider returned (message id, thread id).'] } };
  });
}

/** Record the observed send result. */
export function recordSend(dir, eventId, { result, evidence, messageId = null, threadId = null, occurredAt = null }, { now = isoNow() } = {}) {
  if (!['sent', 'failed', 'unknown'].includes(result)) throw new Error('--result must be sent, failed or unknown');
  return withRun(dir, `contact: record ${result} ${eventId}`, now, () => {
    const { S, evT } = tables(dir);
    const e = eventOf(evT, eventId);
    const log = readEvLog(dir, eventId);
    if (!lastEv(log, 'send_started') || lastEv(log, 'send_result')) throw new RefusedError('no send is in flight for this message; begin-send first');
    if (e.status !== 'approved') throw new RefusedError(`${eventId} is ${e.status}`);
    if (result === 'sent') {
      if (!str(messageId)) throw new RefusedError('a sent message needs the provider message id that was returned');
      checkEvidence('api_response', evidence, { success: true });
      Object.assign(e, { status: 'sent', occurred_at: occurredAt || now, provider_message_id: str(messageId), thread_id: str(threadId), action_required: 'Watch for a reply; one follow-up after 7 days with no reply', summary: `${e.summary.split(' Draft:')[0]} Sent via ${e.provider}.`.trim().slice(0, 300), updated_at: now });
    } else if (result === 'failed') {
      const t = checkEvidence(null, evidence, { success: false });
      Object.assign(e, { status: 'failed', action_required: 'Fix the cause; sending again needs the user\'s approval again', summary: `Send failed: ${t}`.slice(0, 300), updated_at: now });
    } else {
      const t = checkEvidence(null, evidence, { success: false });
      Object.assign(e, { action_required: `[send-unverified] Outcome unknown: ${t}. Check the Sent folder; do not resend until verified.`.slice(0, 300), updated_at: now });
    }
    commit(dir, S, { 'email-events.csv': evT }, now);
    evLog(dir, eventId, { at: now, event: 'send_result', result, message_id: messageId, evidence: str(evidence).slice(0, 300) });
    return { updated: 1, result: { event_id: eventId, status: e.status, sent: e.status === 'sent', result, recorded_at: now, ...(result === 'unknown' ? { warning: 'Outcome unknown. Do NOT resend until verified.' } : {}) } };
  });
}

/** Resolve an unknown send with fresh evidence. */
export function verifySend(dir, eventId, { result, evidence, messageId = null, threadId = null }, { now = isoNow() } = {}) {
  if (!['sent', 'not_sent'].includes(result)) throw new Error('--result must be sent or not_sent');
  return withRun(dir, `contact: verify ${eventId}`, now, () => {
    const { S, evT } = tables(dir);
    const e = eventOf(evT, eventId);
    if (!/\[send-unverified\]/.test(e.action_required)) throw new RefusedError(`${eventId} has no unverified send`);
    if (result === 'sent') {
      if (!str(messageId)) throw new RefusedError('verifying a send needs the message id seen in the Sent folder or the provider');
      checkEvidence('api_response', evidence, { success: true });
      Object.assign(e, { status: 'sent', occurred_at: now, provider_message_id: str(messageId), thread_id: str(threadId), action_required: 'Watch for a reply', updated_at: now });
    } else {
      Object.assign(e, { status: 'failed', action_required: 'Verified not sent. Sending again needs the user\'s approval again', summary: `Verified not sent: ${checkEvidence(null, evidence, { success: false })}`.slice(0, 300), updated_at: now });
    }
    commit(dir, S, { 'email-events.csv': evT }, now);
    evLog(dir, eventId, { at: now, event: 'verification', result });
    return { updated: 1, result: { event_id: eventId, status: e.status, sent: e.status === 'sent' } };
  });
}

/**
 * Drive one approved send through a supplied integration object:
 *   { name, send({to, subject, body}) -> { ok: true, message_id, thread_id, evidence } | { ok: false, error } | { ambiguous: true, note } }
 * A thrown error or anything unclear is recorded as unknown, never as sent.
 */
export async function sendWithIntegration(dir, eventId, integration, { now = isoNow() } = {}) {
  const begun = beginSend(dir, eventId, { now });
  if (!begun.started) return begun;
  let out;
  try { out = await integration.send(begun.payload); } catch (e) { out = { ambiguous: true, note: `integration error after the request began: ${e.message}` }; }
  if (out?.ok === true) {
    try { return recordSend(dir, eventId, { result: 'sent', evidence: out.evidence, messageId: out.message_id, threadId: out.thread_id }, { now }); }
    catch (e) { return recordSend(dir, eventId, { result: 'unknown', evidence: `claimed sent but the proof was not acceptable: ${e.message}` }, { now }); }
  }
  if (out?.ok === false) return recordSend(dir, eventId, { result: 'failed', evidence: out.error || 'failed with no error text' }, { now });
  return recordSend(dir, eventId, { result: 'unknown', evidence: out?.note || 'the integration returned no clear result' }, { now });
}
