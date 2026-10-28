// Multi-file write journal. A run that writes several CSVs records the before/after hash of each file and the new
// contents first, then writes the files, then removes the journal. If the process dies part-way, the next run finds the
// journal and finishes the same write (every file is either still "before" or already "after"), or stops if a file was
// changed by someone else in between. This keeps applications.csv and email-events.csv from disagreeing after a crash.
import { readFileSync, existsSync, unlinkSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeAtomic, RefusedError } from './ingest.mjs';

export const JOURNAL = '.pending-write.json';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const shaOf = (p) => (existsSync(p) ? sha(readFileSync(p, 'utf8')) : null);

/** Test hooks only: afterFile(name) runs after each file is written, so a test can simulate a crash. */
export const _hooks = { afterFile: null };

/** Back up, journal, then write each file atomically. texts: { 'name.csv': content }. */
export function writeJournaled(dir, texts, now) {
  recoverJournal(dir);
  const stamp = now.replace(/[-:]/g, '');
  mkdirSync(join(dir, 'backups'), { recursive: true });
  const files = Object.fromEntries(Object.entries(texts).map(([n, t]) => [n, { before: shaOf(join(dir, n)), after: sha(t), text: t }]));
  for (const n of Object.keys(texts)) if (existsSync(join(dir, n))) copyFileSync(join(dir, n), join(dir, 'backups', `${n}.${stamp}`));
  writeAtomic(join(dir, JOURNAL), JSON.stringify({ at: now, files }));
  for (const [n, t] of Object.entries(texts)) { writeAtomic(join(dir, n), t); _hooks.afterFile?.(n); }
  unlinkSync(join(dir, JOURNAL));
}

/**
 * Finish an interrupted write. Returns null when there was nothing to recover.
 * Refuses (without touching anything) if a file matches neither its before nor its after state.
 */
export function recoverJournal(dir) {
  const p = join(dir, JOURNAL);
  if (!existsSync(p)) return null;
  let j;
  try { j = JSON.parse(readFileSync(p, 'utf8')); } catch {
    // The journal itself was cut short, so no data file was written yet (the journal is written before any of them).
    unlinkSync(p);
    return { recovered: false, discarded_incomplete_journal: true, files: [] };
  }
  const state = Object.entries(j.files).map(([n, f]) => ({ n, f, cur: shaOf(join(dir, n)) }));
  const foreign = state.filter((s) => s.cur !== s.f.before && s.cur !== s.f.after);
  if (foreign.length) throw new RefusedError(`an interrupted write from ${j.at} cannot be finished safely: ${foreign.map((s) => s.n).join(', ')} changed since. Nothing was touched. Run the sync-tracker check and show the user.`);
  const finished = state.filter((s) => s.cur !== s.f.after).map((s) => s.n);
  for (const s of state) if (s.cur !== s.f.after) writeAtomic(join(dir, s.n), s.f.text);
  unlinkSync(p);
  return { recovered: true, interrupted_at: j.at, finished, files: state.map((s) => s.n) };
}
