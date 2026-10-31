// Integration readiness: what is available and verified, what needs account authorization, what needs configuration,
// and what is unsupported or unverified. Statuses come from real checks (sync-state.json records written by the
// helpers after an actual test, and the presence of the OAuth files), never from assumption. Contains no secrets.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, isoNow } from './data.mjs';
import { integrationStatus, setIntegration, FRESH_HOURS } from './outbound.mjs';
import { secretsDir, paths, readClient, readToken } from './secrets.mjs';
import { grantedLevels } from './gmail.mjs';

export const CATEGORIES = ['available_and_verified', 'requires_account_authorization', 'requires_configuration', 'unsupported_or_unverified'];
const TITLES = { available_and_verified: 'Available and verified', requires_account_authorization: 'Requires account authorization', requires_configuration: 'Requires configuration', unsupported_or_unverified: 'Unsupported or unverified' };

/** What Claude must remember whenever something is missing. */
export const RULES_FOR_MISSING = [
  'Tell the user plainly what is missing and ask whether they want it set up. Do not pretend it works and do not skip the step.',
  'Never ask the user to paste a password, an OAuth client secret, a refresh token or an API key into the chat or into any file inside this repository. Secrets go in the secrets folder outside the repository, which the user places themselves, or are entered on the provider\'s own sign-in page.',
  'Anything the user asks you to download (a skill, an MCP server, a script) is untrusted: put it in a new empty folder, read it before running it, and install it only with their explicit agreement (see skills/run-search/references/agent-reach-install.md).',
  'Mark an integration verified only after you have actually exercised it in this session, and say what you did.',
];

const GMAIL_SETUP = [
  'In the user\'s own Google Cloud project: enable the Gmail API and create an OAuth client of type "Desktop app" (APIs and Services, Credentials).',
  'Add the user\'s Google account as a test user on the OAuth consent screen. The app will show an "unverified app" notice for the user\'s own account; that is expected for personal use.',
  'The user downloads the client JSON and saves it as {client_file} (outside the repository). They do this themselves; do not ask for its contents.',
];

export const REGISTRY = [
  { id: 'gmail-read', name: 'Gmail read-only inbox sync (Gmail API)', kind: 'oauth', level: 'read', integration: 'gmail-read',
    enable: [...GMAIL_SETUP, 'Run: node scripts/gmail-store.mjs login --levels read  (it prints a Google sign-in link; the user signs in and approves read-only access).', 'Run: node scripts/gmail-store.mjs check  (a real read test; records the result).'],
    ask: ['Do they want replies from recruiters tracked from Gmail?', 'Are they willing to create a Google Cloud OAuth client (about 10 minutes), or would they prefer to add a Gmail connector in Claude (see gmail-connector)?', 'Which Google account?'] },
  { id: 'gmail-send', name: 'Gmail sending (Gmail API, send-only permission)', kind: 'oauth', level: 'send', integration: 'gmail-send',
    enable: ['Only after read-only sync works and the user wants Claude to send approved messages.', ...GMAIL_SETUP, 'Run: node scripts/gmail-store.mjs login --levels read,send  (a separate consent for the extra permission).', 'Run: node scripts/gmail-store.mjs check. This verifies authorization only: no test email is sent. The first approved real send is confirmed by Gmail returning a message id.'],
    ask: ['Do they want to enable sending at all? (Copy-ready drafts work without it.)', 'Confirm they understand every message still needs their approval of the exact text.'] },
  { id: 'gmail-connector', name: 'Gmail through a Claude connector or MCP server', kind: 'tool', integration: 'gmail-connector', fallback: 'requires_configuration',
    enable: ['If their Claude plan offers a Gmail connector, the user adds it in Claude settings (Connectors) and signs in on Google\'s page. Or they add an MCP server they have chosen with: claude mcp add ...', 'Then run one harmless read (for example list a few message subjects), and record it: node scripts/submit-store.mjs set-integration gmail-connector --status verified --notes "<what you did>".', 'Feed messages to the inbox with: node scripts/inbox-store.mjs ingest <messages.json>. Messages are normalised JSON, so this works the same as the direct API.'],
    ask: ['Do they already have a Gmail connector or MCP server, or would they like help choosing one?', 'If they name a skill or server to download, ask for the link and review it first.'] },
  { id: 'browser', name: 'Browser automation (Claude in Chrome or the built-in browser)', kind: 'tool', integration: 'browser', fallback: 'requires_configuration',
    enable: ['The user installs the official "Claude in Chrome" extension from the Chrome Web Store in Chrome or Edge (the user clicks Install; an agent cannot install a browser extension). It needs a Claude Pro, Max, Team or Enterprise plan and signing in with /login, with the extension signed in to the same claude.ai account.', 'Then start Claude Code with: claude --chrome (or run /chrome and choose "Enabled by default"). /chrome shows "Status: Enabled" and "Extension: Installed" when it works. If the extension is not detected, restart Chrome once.', 'Open one public page and read it, then record: node scripts/submit-store.mjs set-integration browser --status verified --notes "<what you did>".', 'It uses the user\'s own browser, so it shares their logins; it pauses and asks the user at a login page or CAPTCHA. Alternatively the desktop app\'s built-in browser can be used.'],
    ask: ['Do they want Claude to fill application forms while they watch?', 'Is the Chrome extension or the desktop browser pane available to them?'] },
  { id: 'portal-api', name: 'Employer application APIs', kind: 'tool', integration: 'portal-api', fallback: 'unsupported_or_unverified',
    enable: ['No candidate-facing application API is known for the supported career-page vendors. Applications are made on the employer\'s page.'], ask: [] },
  { id: 'google-drive', name: 'Google Drive (resume import)', kind: 'tool', integration: 'google-drive', fallback: 'requires_account_authorization',
    enable: ['The Drive connector shows as connected in Claude, but it has not been exercised here. Ask the user to name one resume file, read it once, and record: node scripts/submit-store.mjs set-integration google-drive --status verified --notes "<what you did>".'],
    ask: ['Is the resume in Google Drive, or should they give a local file path instead?'] },
  { id: 'ats-feeds', name: 'Employer job-board feeds (Greenhouse, Lever, Ashby, SmartRecruiters, Workable)', kind: 'network', integration: 'ats-feeds', probe: 'ats', fallback: 'requires_configuration',
    enable: ['No account needed. Run: node scripts/integrations-store.mjs probe ats-feeds  (five read-only requests).'], ask: [] },
  { id: 'freehire', name: 'freehire.me public job search (also used for startup discovery)', kind: 'network', integration: 'freehire', probe: 'freehire', fallback: 'requires_configuration',
    enable: ['No account needed. Run: node scripts/integrations-store.mjs probe freehire  (one read-only request). Personal, non-commercial use only.'], ask: [] },
  { id: 'career-walk', name: 'Career-page walker (this repository\'s own fetcher)', kind: 'network', integration: 'career-walk', probe: 'career-walk', fallback: 'requires_configuration',
    enable: ['No account needed. Run: node scripts/integrations-store.mjs probe career-walk  (reads one public careers page, honouring robots.txt). Pages that need JavaScript return too little text; read those with Agent Reach or the browser.'], ask: [] },
  { id: 'pdf', name: 'PDF output (headless Chrome or Edge on this computer)', kind: 'local', integration: 'pdf', probe: 'pdf', fallback: 'requires_configuration',
    enable: ['Needs Chrome or Edge installed (or INTERNSHIP_AGENT_BROWSER set to one). Run: node scripts/integrations-store.mjs probe pdf  (renders a one-line test PDF locally; nothing leaves the computer).'], ask: [] },
];

const fill = (steps, sdir) => steps.map((s) => s.replace('{client_file}', paths(sdir).client));

function evaluateOne(dir, entry, sdir, now) {
  const rec = (() => { try { return JSON.parse(readFileSync(join(dir, 'sync-state.json'), 'utf8')).integrations?.[entry.integration]; } catch { return null; } })();
  const st = integrationStatus(dir, entry.integration, now);
  const base = { id: entry.id, name: entry.name, integration: entry.integration, next_steps: fill(entry.enable, sdir), ask_user: entry.ask };
  let category, reason;

  if (entry.kind === 'oauth') {
    let client = null, token = null, problem = null;
    try { client = readClient(sdir); token = readToken(sdir); } catch (e) { problem = e.message; }
    const levels = grantedLevels(token);
    if (problem) { category = 'requires_configuration'; reason = problem; }
    else if (!client) { category = 'requires_configuration'; reason = `no OAuth client file at ${paths(sdir).client}`; }
    else if (!token) { category = 'requires_account_authorization'; reason = 'the OAuth client exists but the user has not signed in and approved access'; }
    else if (!levels.includes(entry.level)) { category = 'requires_account_authorization'; reason = `signed in, but the "${entry.level}" permission has not been granted`; }
    else if (rec?.status !== 'verified' && /revoked|expired/i.test(rec?.notes ?? '')) { category = 'requires_account_authorization'; reason = `access was revoked or expired: ${rec.notes}`; }
    else if (st.usable) { category = 'available_and_verified'; reason = `verified ${st.checked_at}${st.notes ? `: ${st.notes}` : ''}`; }
    else { category = 'requires_configuration'; reason = `authorized, but not verified in this session (${st.reason}); run the check`; }
  } else if (st.usable) { category = 'available_and_verified'; reason = `verified ${st.checked_at}${st.notes ? `: ${st.notes}` : ''}`; }
  else if (rec?.status === 'verified') { category = 'requires_configuration'; reason = `last verified ${rec.checked_at}, more than ${FRESH_HOURS} hours ago; test it again`; }
  else if (rec?.status === 'unsupported_or_unverified') { category = 'unsupported_or_unverified'; reason = rec.notes ?? 'marked unsupported or unverified'; }
  else { category = entry.fallback ?? 'requires_configuration'; reason = rec ? st.reason : 'never exercised in this repository'; }
  return { ...base, category, reason };
}

// ---------------------------------------------------------------- preflight: what a task needs before it starts

/**
 * Each task lists the integrations it needs (any one of them is enough), whether it can still be useful without them,
 * and the choices to offer the user when they are missing. "gmail-send" is recorded by both the Gmail API client and a
 * connector, so a connector counts only once its sending has been verified.
 */
export const TASKS = {
  apply: { needs: [], title: 'Prepare an application', note: 'Tailoring uses only your profile and the posting; no email connection is needed.' },
  'submit-application': { needs: ['browser', 'portal-api'], fallback: 'manual', title: 'Submit an application',
    question: 'No verified browser or API is available to submit the form. How do you want to continue?',
    options: [{ id: 'connect-browser', label: 'Connect a browser tool', description: 'Enable Claude in Chrome or the built-in browser; Claude tests it on a public page, then submits only after you approve the exact package.' },
      { id: 'submit-myself', label: 'I will submit it myself', description: 'Claude hands you the destination and the files, and records the result only from the confirmation you paste.' }] },
  'contact-recruiter': { needs: ['gmail-send'], fallback: 'copy_ready', title: 'Message a recruiter',
    question: 'Which email do you want to send from?',
    options: [{ id: 'connect-gmail-api', label: 'Connect my Gmail (send permission)', description: 'You create a Google OAuth client once and approve a send-only permission on Google\'s page. Claude never sees your password or tokens.' },
      { id: 'use-connector', label: 'Use a Gmail connector I already have', description: 'If your Claude has a Gmail connector, Claude tests it and uses it. Nothing is downloaded without your agreement.' },
      { id: 'copy-ready', label: 'Just give me copy-ready drafts', description: 'Claude writes the message and the destination; you send it yourself. Works with any email and with LinkedIn.' }] },
  'inbox-sync': { needs: ['gmail-read', 'gmail-connector'], title: 'Read replies from your inbox',
    question: 'Which email holds the recruiter replies?',
    options: [{ id: 'connect-gmail-api', label: 'Connect my Gmail (read-only)', description: 'You create a Google OAuth client once and approve read-only access. Claude can then read but never delete, archive or change mail.' },
      { id: 'use-connector', label: 'Use a Gmail connector I already have', description: 'Claude uses the connector\'s read tools only, after testing it.' },
      { id: 'paste-instead', label: 'I will paste the emails', description: 'No connection: paste or forward the replies and Claude records them.' }] },
};

/**
 * Decide whether a task can start. Pure reads. When something is missing it returns the question to ask the user, the
 * options, and the steps for each; the caller asks, guides the connection, and runs preflight again.
 */
export function preflight(dir, task, { sdir = secretsDir(), now = isoNow() } = {}) {
  const t = TASKS[task];
  if (!t) throw new Error(`task must be one of ${Object.keys(TASKS).join(', ')}`);
  const items = readiness(dir, { sdir, now }).items;
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  const satisfied = t.needs.filter((id) => byId[id]?.category === 'available_and_verified');
  if (!t.needs.length || satisfied.length) return { task, title: t.title, ready: true, satisfied_by: satisfied, note: t.note ?? null };
  return {
    task, title: t.title, ready: false, can_continue_without: t.fallback ?? null,
    missing: t.needs.map((id) => ({ id, name: byId[id]?.name ?? id, category: byId[id]?.category ?? 'requires_configuration', reason: byId[id]?.reason ?? 'not configured' })),
    ...askPayload(t, task, byId),
  };
}

function askPayload(t, task, byId) {
  const steps = (id) => (byId[id]?.next_steps ?? []);
  return {
    ask_user: { question: t.question, options: t.options },
    steps_by_choice: Object.fromEntries(t.options.map((o) => [o.id, o.id === 'connect-gmail-api' ? steps(t.needs[0]) : o.id === 'use-connector' ? steps('gmail-connector') : o.id === 'connect-browser' ? steps('browser') : []])),
    instructions: ['Ask the user the question above (with the options) before doing anything else for this task. Do not just report that it failed.', 'Do the steps for the option they choose, one at a time, with them. Never ask them to paste a password, secret or token in chat.', 'Run preflight again after connecting, then repeat the step that failed from its start. Proceed only when ready is true, or when they choose the fallback (' + (t.fallback ?? 'none') + ').'],
  };
}

/**
 * Used when a step FAILED because a connection is missing, expired, revoked, or lacks a permission, even if an earlier
 * record said it was fine. Returns the same question, options and steps as preflight, with the reason it failed, so the
 * skill asks the user how to reconnect instead of only reporting the error. Returns null for tasks with nothing to connect.
 */
export function recovery(dir, task, reason, { sdir = secretsDir(), now = isoNow() } = {}) {
  const t = TASKS[task];
  if (!t?.options) return null;
  const byId = Object.fromEntries(readiness(dir, { sdir, now }).items.map((i) => [i.id, i]));
  return { failed_because: reason, can_continue_without: t.fallback ?? null, ...askPayload(t, task, byId) };
}

/** The readiness checklist. Pure reads: no network, no mailbox access. */
export function readiness(dir, { sdir = secretsDir(), now = isoNow() } = {}) {
  const items = REGISTRY.map((e) => evaluateOne(dir, e, sdir, now));
  const by = Object.fromEntries(CATEGORIES.map((c) => [c, items.filter((i) => i.category === c)]));
  return { checked_at: now, secrets_folder: sdir, secrets_inside_repository: false, rules_when_something_is_missing: RULES_FOR_MISSING, summary: Object.fromEntries(CATEGORIES.map((c) => [c, by[c].map((i) => i.id)])), items };
}

/** Plain-text checklist for the user. */
export function renderChecklist(r) {
  const L = [`Integration readiness (${r.checked_at})`, ''];
  for (const c of CATEGORIES) {
    const list = r.items.filter((i) => i.category === c);
    L.push(`${TITLES[c]} (${list.length})`);
    if (!list.length) L.push('  none');
    for (const i of list) {
      L.push(`  [${c === 'available_and_verified' ? 'x' : ' '}] ${i.name}: ${i.reason}`);
      if (c !== 'available_and_verified') for (const s of i.next_steps.slice(0, 4)) L.push(`        - ${s}`);
    }
    L.push('');
  }
  L.push('When something is missing: ask the user; never request passwords, secrets or tokens in chat; review anything downloaded before installing.');
  return L.join('\n');
}

// ---------------------------------------------------------------- probes (real, read-only, public endpoints)

const UA = 'internship-agent-personal/0.1 (personal job search; read-only)';
const getJson = async (fetchImpl, url) => { const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } }); if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`); return res.json(); };

export async function probe(dir, which, { fetchImpl = fetch, now = isoNow(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pdfImpl = null } = {}) {
  if (which === 'ats-feeds') {
    const checks = [['greenhouse', 'https://boards-api.greenhouse.io/v1/boards/stripe/jobs', (j) => Array.isArray(j.jobs)], ['lever', 'https://api.lever.co/v0/postings/palantir?mode=json&limit=1', (j) => Array.isArray(j)], ['ashby', 'https://api.ashbyhq.com/posting-api/job-board/notion', (j) => Array.isArray(j.jobs)],
      ['smartrecruiters', 'https://api.smartrecruiters.com/v1/companies/PHONEPELIMITED/postings?limit=1', (j) => Array.isArray(j.content)], ['workable', 'https://apply.workable.com/api/v1/widget/accounts/apna', (j) => Array.isArray(j.jobs)]];
    const ok = [], bad = [];
    for (const [name, url, valid] of checks) {
      try { (valid(await getJson(fetchImpl, url)) ? ok : bad).push(name); } catch (e) { bad.push(`${name} (${e.message})`); }
      await sleep(1000);
    }
    return setIntegration(dir, 'ats-feeds', bad.length ? 'unsupported_or_unverified' : 'verified', bad.length ? `failed: ${bad.join('; ')}` : `read-only feed requests succeeded for ${ok.join(', ')}`, now);
  }
  if (which === 'freehire') {
    try { const j = await getJson(fetchImpl, 'https://freehire.me/api/v1/jobs/search?employment_type=internship&limit=1'); if (!Array.isArray(j.data)) throw new Error('unexpected response shape'); return setIntegration(dir, 'freehire', 'verified', `search returned ${j.meta?.total ?? '?'} internships`, now); }
    catch (e) { return setIntegration(dir, 'freehire', 'unsupported_or_unverified', `failed: ${e.message}`, now); }
  }
  if (which === 'career-walk') {
    const { createWalker } = await import('./walker.mjs');
    const r = await createWalker({ fetchImpl, sleep }).get('https://job-boards.greenhouse.io/stripe');
    return setIntegration(dir, 'career-walk', r.ok && r.text.length > 200 ? 'verified' : 'unsupported_or_unverified',
      r.ok ? `read ${r.url} (${r.text.length} characters of text, robots.txt allowed it)` : `failed: ${r.code} ${r.error}`, now);
  }
  if (which === 'pdf') {
    const { makePdfs } = await import('./pdf.mjs');
    try { const r = (pdfImpl ?? makePdfs)({ resume: '# Test\n\nOne line.' }).resume; return setIntegration(dir, 'pdf', 'verified', `made a ${r.pages}-page test PDF with ${r.engine}`, now); }
    catch (e) { return setIntegration(dir, 'pdf', 'unsupported_or_unverified', `failed: ${e.message}`, now); }
  }
  throw new Error('probe target must be ats-feeds, freehire, career-walk or pdf');
}

// ---------------------------------------------------------------- platform matrix

export const loadPlatforms = () => JSON.parse(readFileSync(join(repoRoot, 'references/platforms.json'), 'utf8').replace(/^﻿/, ''));
const cell = (s) => String(s).replace(/\|/g, '/');

export function renderPlatformsMd(data = loadPlatforms()) {
  const L = ['<!-- GENERATED from references/platforms.json by: node scripts/integrations-store.mjs render-platforms --write. Edit the JSON, not this file. -->', '',
    '# Platform capabilities', '',
    'What each platform supports for search, application and messaging, how it is authorized, its limits, and what was actually verified. A status of **verified** means it was exercised, with the date and evidence shown. Everything else is **possible_unconfigured** or **unsupported_or_unverified**. Nothing here permits scraping a site its rules forbid or getting past a login, CAPTCHA or rate limit; those steps go to the user.', '',
    '| Platform | Search | Application | Messaging |', '|---|---|---|---|'];
  for (const p of data.platforms) L.push(`| ${p.name} | ${p.search.status} | ${p.apply.status} | ${p.messaging.status} |`);
  for (const p of data.platforms) {
    L.push('', `## ${p.name}`, '', '| | Method | Status |', '|---|---|---|', `| Search | ${cell(p.search.method)} | ${p.search.status} |`, `| Application | ${cell(p.apply.method)} | ${p.apply.status} |`, `| Messaging | ${cell(p.messaging.method)} | ${p.messaging.status} |`, '',
      `- **Authentication:** ${p.auth}`, `- **Permissions and limitations:** ${p.limits}`, `- **Verification:** ${p.verified_on ? `${p.verified_on}. ${p.evidence}` : `not verified. ${p.evidence}`}`);
  }
  return `${L.join('\n')}\n`;
}

export const platformsMdPath = () => join(repoRoot, 'references/platforms.md');
export const platformsMdIsCurrent = () => existsSync(platformsMdPath()) && readFileSync(platformsMdPath(), 'utf8') === renderPlatformsMd();
