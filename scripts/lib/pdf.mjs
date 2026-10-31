// PDF output for tailored documents. Uses the Chrome or Edge already installed, in headless mode with a throwaway
// profile, so no new software is needed and the user's own browser profile and logins are never touched.
// The PDF is plain single-column text (real, selectable text; no images or tables) so application systems can read it.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

/** Converts the small Markdown subset our documents use: #, ##, "- " and nested "  - " lists, **bold**, paragraphs. */
export function mdToHtml(md) {
  const out = [];
  let depth = 0; // open <ul> count
  const closeLists = (to = 0) => { while (depth > to) { out.push('</ul>'); depth -= 1; } };
  let para = [];
  const flush = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  for (const raw of String(md).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if (!line.trim()) { flush(); closeLists(); continue; }
    if ((m = line.match(/^# (.*)$/))) { flush(); closeLists(); out.push(`<h1>${inline(m[1])}</h1>`); continue; }
    if ((m = line.match(/^## (.*)$/))) { flush(); closeLists(); out.push(`<h2>${inline(m[1])}</h2>`); continue; }
    if ((m = line.match(/^(\s*)- (.*)$/))) {
      flush();
      const want = m[1].length >= 2 ? 2 : 1;
      if (depth < want) { while (depth < want) { out.push('<ul>'); depth += 1; } } else closeLists(want);
      out.push(`<li>${inline(m[2])}</li>`);
      continue;
    }
    closeLists();
    para.push(line.trim());
  }
  flush(); closeLists();
  return out.join('\n');
}

const BASE_CSS = '@page{size:A4;margin:14mm 15mm}*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:0}';
const CSS = {
  resume: `${BASE_CSS}body{font-size:10pt;line-height:1.3}h1{font-size:19pt;margin:0 0 2pt}h2{font-size:10.5pt;letter-spacing:.06em;text-transform:uppercase;border-bottom:1px solid #444;margin:10pt 0 4pt;padding-bottom:1pt}p{margin:0 0 4pt}ul{margin:0 0 2pt;padding-left:14pt}ul ul{margin-bottom:3pt}li{margin:0 0 1.5pt;break-inside:avoid}`,
  letter: `${BASE_CSS}body{font-size:11pt;line-height:1.5}p{margin:0 0 10pt}`,
};

export const wrapHtml = (body, { title, kind }) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS[kind]}</style></head><body>${body}</body></html>`;

/** Chrome or Edge on this machine. INTERNSHIP_AGENT_BROWSER overrides. Returns a path or null. */
export function findBrowser(env = process.env) {
  if (env.INTERNSHIP_AGENT_BROWSER) return existsSync(env.INTERNSHIP_AGENT_BROWSER) ? env.INTERNSHIP_AGENT_BROWSER : null;
  const pf = [env.ProgramFiles, env['ProgramFiles(x86)'], 'C:\\Program Files', 'C:\\Program Files (x86)'].filter(Boolean);
  const candidates = platform() === 'win32'
    ? [...pf.flatMap((p) => [`${p}\\Microsoft\\Edge\\Application\\msedge.exe`, `${p}\\Google\\Chrome\\Application\\chrome.exe`]), env.LOCALAPPDATA && `${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`]
    : platform() === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  return candidates.filter(Boolean).find((p) => existsSync(p)) ?? null;
}

/** Page count read from the PDF's page objects (a check, not a layout engine). */
export function pdfPages(buf) { return (buf.toString('latin1').match(/\/Type\s*\/Page(?![a-z])/g) ?? []).length; }
export const isPdf = (buf) => Buffer.isBuffer(buf) && buf.length > 800 && buf.subarray(0, 5).toString('latin1') === '%PDF-';

/** Default engine: headless browser. Returns { ok, engine, pdf } or { ok: false, error }. */
function browserEngine({ html }) {
  const browser = findBrowser();
  if (!browser) return { ok: false, error: 'no Chrome or Edge was found on this computer to make the PDF; install one, or set INTERNSHIP_AGENT_BROWSER to its path' };
  const tmp = mkdtempSync(join(tmpdir(), 'resume-pdf-'));
  try {
    const src = join(tmp, 'doc.html'), out = join(tmp, 'doc.pdf');
    writeFileSync(src, html, 'utf8');
    let last = '';
    for (const headless of ['--headless=new', '--headless']) {
      const r = spawnSync(browser, [headless, '--disable-gpu', '--no-first-run', '--disable-extensions', '--no-pdf-header-footer', `--user-data-dir=${join(tmp, 'profile')}`, `--print-to-pdf=${out}`, pathToFileURL(src).href], { timeout: 60000, encoding: 'utf8' });
      last = r.error?.message ?? r.stderr?.slice(0, 200) ?? '';
      if (existsSync(out)) { const pdf = readFileSync(out); if (isPdf(pdf)) return { ok: true, engine: browser.split(/[\\/]/).pop().replace(/\.exe$/i, ''), pdf }; }
    }
    return { ok: false, error: `the browser did not produce a PDF${last ? ` (${last.trim()})` : ''}` };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

let engine = browserEngine;
/** Tests replace the engine with a stub. Production always uses the browser engine. */
export function setPdfEngine(fn) { engine = fn ?? browserEngine; }

/**
 * Renders { resume, 'cover-letter' } to PDFs. Each value is Markdown (plain built-in styling) or { html } already
 * rendered by a resume template. Throws an Error if any cannot be made; never returns a partial set.
 */
export function makePdfs(docs, { names = {} } = {}) {
  const out = {};
  for (const [kind, doc] of Object.entries(docs)) {
    const html = typeof doc === 'object' && doc && typeof doc.html === 'string'
      ? doc.html
      : wrapHtml(mdToHtml(doc), { title: names[kind] ?? kind, kind: kind === 'resume' ? 'resume' : 'letter' });
    const r = engine({ html, kind });
    if (!r?.ok || !isPdf(r.pdf)) throw new Error(`PDF for ${kind} could not be made: ${r?.error ?? 'the engine returned no valid PDF'}`);
    out[kind] = { pdf: r.pdf, engine: r.engine, pages: pdfPages(r.pdf) };
  }
  return out;
}
