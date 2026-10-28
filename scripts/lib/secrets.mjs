// OAuth client and token storage. Secrets live OUTSIDE the repository and outside the private data directory.
// Nothing here is ever printed, logged, or written into sync-state.json, a CSV, a skill, or a test fixture.
import { homedir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { repoRoot } from './data.mjs';

const inside = (child, parent) => { const r = relative(resolve(parent), resolve(child)); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };

/** $INTERNSHIP_AGENT_SECRETS, else %APPDATA%\internship-agent (Windows) or ~/.config/internship-agent. */
export function secretsDir(env = process.env) {
  if (env.INTERNSHIP_AGENT_SECRETS) return resolve(env.INTERNSHIP_AGENT_SECRETS);
  return resolve(process.platform === 'win32' ? join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'internship-agent') : join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'internship-agent'));
}

/** Throws unless the secrets folder is outside the repository and outside the private data directory. */
export function assertSafeSecretsDir(sdir, dataDirPath) {
  if (inside(sdir, repoRoot)) throw new Error(`secrets folder ${sdir} is inside the repository; set INTERNSHIP_AGENT_SECRETS to a folder outside it`);
  if (dataDirPath && inside(sdir, dataDirPath)) throw new Error(`secrets folder ${sdir} is inside the private data directory; keep tokens separate from exported data`);
  return sdir;
}

const clientPath = (sdir) => join(sdir, 'google-oauth-client.json');
const tokenPath = (sdir) => join(sdir, 'gmail-token.json');
export const paths = (sdir) => ({ client: clientPath(sdir), token: tokenPath(sdir) });

/** The OAuth client the user downloaded from Google Cloud Console (Desktop app type). Returns null if absent. */
export function readClient(sdir) {
  if (!existsSync(clientPath(sdir))) return null;
  const j = JSON.parse(readFileSync(clientPath(sdir), 'utf8').replace(/^﻿/, ''));
  const c = j.installed;
  if (!c?.client_id) throw new Error('google-oauth-client.json must be a "Desktop app" client (it should contain an "installed" section with client_id)');
  return { client_id: c.client_id, client_secret: c.client_secret ?? null };
}

export function readToken(sdir) {
  if (!existsSync(tokenPath(sdir))) return null;
  return JSON.parse(readFileSync(tokenPath(sdir), 'utf8').replace(/^﻿/, ''));
}

export function writeToken(sdir, token) {
  mkdirSync(sdir, { recursive: true });
  writeFileSync(tokenPath(sdir), JSON.stringify(token, null, 2), { mode: 0o600 });
  try { chmodSync(tokenPath(sdir), 0o600); } catch { /* Windows: rely on the per-user profile folder */ }
}

export function deleteToken(sdir) { if (existsSync(tokenPath(sdir))) rmSync(tokenPath(sdir)); }
