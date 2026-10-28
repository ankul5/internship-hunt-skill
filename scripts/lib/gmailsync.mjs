// Read-only Gmail synchronisation. Fetches first, then records; the cursor moves only after a COMPLETE fetch.
// A failure of authorization records the integration as needing authorization and ingests nothing.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuthError, RateLimitError, normalizeMessage } from './gmail.mjs';
import { ingestMessages, setCursor } from './inbox.mjs';
import { setIntegration } from './outbound.mjs';
import { isoNow } from './data.mjs';

export async function syncGmail(dir, client, { sinceDays = 30, max = 100, query = '', now = isoNow() } = {}) {
  const sync = JSON.parse(readFileSync(join(dir, 'sync-state.json'), 'utf8'));
  const cursor = Number(sync.gmail?.cursor);
  const after = Number.isFinite(cursor) && cursor > 0 ? cursor : Math.floor(Date.parse(now) / 1000) - 86400 * sinceDays;
  const q = `after:${after}${query ? ` ${query}` : ''}`;
  const messages = [];
  let complete = true, stopped = null, page = null;
  try {
    do {
      const l = await client.listMessages({ query: q, max: Math.min(50, max - messages.length), pageToken: page });
      for (const id of l.ids) messages.push(normalizeMessage(await client.getMessage(id)));
      page = l.next;
    } while (page && messages.length < max);
    if (page) { complete = false; stopped = `stopped at the limit of ${max} messages; run sync again for the rest`; }
  } catch (e) {
    if (e instanceof AuthError) {
      setIntegration(dir, 'gmail-read', 'possible_unconfigured', `${e.code}: ${e.message}`, now);
      throw e; // nothing was ingested and the cursor did not move
    }
    if (e instanceof RateLimitError) { complete = false; stopped = `rate limited (retry after ${e.retryAfter ?? 'a while'}); recorded what was fetched`; } else throw e;
  }
  const r = ingestMessages(dir, messages, { now, source: 'gmail' });
  let advanced = false;
  if (complete && r.max_received_at) { setCursor(dir, Math.floor(Date.parse(r.max_received_at) / 1000) - 60, now); advanced = true; }
  return { ok: true, query: q, fetched: messages.length, complete, stopped, cursor_advanced: advanced, ...r };
}
