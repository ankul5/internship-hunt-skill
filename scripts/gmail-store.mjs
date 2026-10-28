#!/usr/bin/env node
// Gmail API connector for the internship agent (not a product CLI). Tokens live OUTSIDE the repository
// ($INTERNSHIP_AGENT_SECRETS, else %APPDATA%\internship-agent or ~/.config/internship-agent). Nothing secret is printed.
//   node scripts/gmail-store.mjs setup-help                     the steps the USER does in their own Google Cloud project
//   node scripts/gmail-store.mjs status                         what is configured and authorized (no network)
//   node scripts/gmail-store.mjs login --levels read[,send]     opens Google's sign-in (loopback + PKCE); the user approves
//   node scripts/gmail-store.mjs check                          real test of what was authorized; records the result
//   node scripts/gmail-store.mjs sync [--since-days N] [--max N] [--query "<extra search>"]   read-only; records recruiter replies
//   node scripts/gmail-store.mjs send <event_id>                sends one APPROVED message through gmail-send (needs the send permission)
//   node scripts/gmail-store.mjs logout                         revokes the token with Google and deletes it locally
// Only run login, check, sync and send because the user asked for that step. Exit 0 ok, 2 refused/auth problem, 1 error.
import { parseArgs } from 'node:util';
import { dataDir } from './lib/data.mjs';
import { RefusedError } from './lib/ingest.mjs';
import { secretsDir, assertSafeSecretsDir, paths } from './lib/secrets.mjs';
import { GmailClient, AuthError, login, gmailSender, SCOPES } from './lib/gmail.mjs';
import { setIntegration } from './lib/outbound.mjs';
import { syncGmail } from './lib/gmailsync.mjs';
import { sendWithIntegration } from './lib/contact.mjs';
import { REGISTRY, recovery } from './lib/readiness.mjs';

const { positionals: [cmd, arg], values: v } = parseArgs({ allowPositionals: true, strict: false, options: { levels: { type: 'string' }, 'since-days': { type: 'string' }, max: { type: 'string' }, query: { type: 'string' } } });
const dir = dataDir();
const out = (o) => console.log(JSON.stringify(o, null, 2));
const record = (name, status, notes) => setIntegration(dir, name, status, notes);
let sdir, client;

try {
  sdir = assertSafeSecretsDir(secretsDir(), dir);
  client = new GmailClient({ sdir });
  if (cmd === 'setup-help') {
    out({ secrets_folder: sdir, client_file: paths(sdir).client, steps: REGISTRY.find((r) => r.id === 'gmail-read').enable.map((s) => s.replace('{client_file}', paths(sdir).client)),
      never: 'Do not paste the client secret, a password or a token into the chat or into any file in this repository.', scopes_requested: { read: SCOPES.read, send: SCOPES.send, never_requested: 'gmail.compose, gmail.modify (they can alter or send mail)' } });
  } else if (cmd === 'status') out({ secrets_folder: sdir, ...client.status() });
  else if (cmd === 'login') {
    const levels = (v.levels ?? 'read').split(',').map((s) => s.trim()).filter(Boolean);
    const r = await login({ sdir, levels, showUrl: (url) => console.error(`Open this link in your browser, sign in, and approve ONLY the permissions listed (${levels.join(', ')}):\n${url}\n`) });
    out({ authorized: true, levels: r.levels, next: 'Run: node scripts/gmail-store.mjs check' });
  } else if (cmd === 'check') {
    const st = client.status();
    const results = {};
    try {
      if (st.levels.includes('read')) { const p = await client.profile(); results.account = p.emailAddress ?? null; results.read = record('gmail-read', 'verified', 'Gmail API profile call succeeded with the read-only permission'); }
      if (st.levels.includes('send')) { await client.accessToken('send'); results.send = record('gmail-send', 'verified', 'send permission authorized and the token refreshed; no test email was sent, so the first approved send is confirmed by Gmail returning a message id'); }
      if (!st.levels.length) throw new AuthError(st.client_configured ? 'not authorized yet; run login' : 'no OAuth client file; run setup-help', st.client_configured ? 'not_authorized' : 'not_configured');
      out({ ok: true, ...st, results });
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      for (const n of ['gmail-read', 'gmail-send']) record(n, 'possible_unconfigured', `${e.code}: ${e.message}`);
      out({ ok: false, code: e.code, message: e.message, recover: recovery(dir, st.levels.length && !st.levels.includes('read') ? 'contact-recruiter' : 'inbox-sync', e.message), next: 'Do not just report this. Ask the user the recover.ask_user question and help them connect or reconnect.' });
      process.exitCode = 2;
    }
  } else if (cmd === 'sync') {
    try { out(await syncGmail(dir, client, { sinceDays: Number(v['since-days'] ?? 30), max: Number(v.max ?? 100), query: v.query ?? '' })); }
    catch (e) { if (!(e instanceof AuthError)) throw e; out({ ok: false, code: e.code, message: e.message, ingested: 0, cursor_advanced: false, recover: recovery(dir, 'inbox-sync', e.message), next: 'Do not just report this. Ask the user the recover.ask_user question and help them connect or reconnect, then run sync again.' }); process.exitCode = 2; }
  } else if (cmd === 'send') {
    const sender = gmailSender(client);
    const r = await sendWithIntegration(dir, arg, sender);
    if (sender.lastAuthError) {
      record('gmail-send', 'possible_unconfigured', `${sender.lastAuthError.code}: ${sender.lastAuthError.message}`);
      r.recover = recovery(dir, 'contact-recruiter', sender.lastAuthError.message);
      r.next = 'Do not just report this. Ask the user the recover.ask_user question and help them reconnect. The message stays approved; nothing was sent.';
    }
    out(r);
    if (r.started === false || sender.lastAuthError) process.exitCode = 2;
  } else if (cmd === 'logout') {
    await client.revoke();
    for (const n of ['gmail-read', 'gmail-send']) record(n, 'possible_unconfigured', 'access revoked and the local token deleted by the user');
    out({ revoked: true });
  } else { console.error('usage: gmail-store.mjs setup-help | status | login --levels read[,send] | check | sync | send <event_id> | logout'); process.exit(1); }
} catch (e) {
  console.error(e.message);
  process.exit(e instanceof RefusedError || e instanceof AuthError ? 2 : 1);
}
