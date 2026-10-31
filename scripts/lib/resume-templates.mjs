// Resume templates: built-in ones ship in templates/resume/<name>/, the user's own live in
// <data dir>/resume-templates/<name>/. A template is a manifest (template.json) plus a stylesheet (template.css)
// applied to one fixed, semantic HTML structure (documented in templates/resume/README.md). Templates are CSS only:
// no scripts and no remote resources, so the output stays single-column, selectable text that application systems
// can read, and making a PDF never contacts the network.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUILTIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'resume');
export const DEFAULT_TEMPLATE = 'jake';
const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const SECTIONS = ['education', 'experience', 'projects', 'certifications', 'achievements', 'skills'];
const DEFAULT_TITLES = { education: 'Education', experience: 'Experience', projects: 'Projects', certifications: 'Certifications', achievements: 'Achievements', skills: 'Skills' };
const MAX_CSS = 64 * 1024;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const userDir = (dataDir) => join(dataDir, 'resume-templates');

/** Problems with a template's stylesheet. Remote or local resources, imports and script-like constructs are refused. */
export function cssProblems(css) {
  const p = [];
  if (css.length > MAX_CSS) p.push(`template.css is larger than ${MAX_CSS / 1024} KB`);
  if (/@import/i.test(css)) p.push('@import is not allowed; put all rules in template.css');
  if (/url\s*\(/i.test(css)) p.push('url(...) is not allowed (no images, remote fonts or files); use fonts installed on the computer by name');
  if (/expression\s*\(|javascript:|behavior\s*:|-moz-binding/i.test(css)) p.push('script-like CSS is not allowed');
  if (/<\/?\s*(style|script)/i.test(css)) p.push('HTML tags are not allowed in template.css');
  return p;
}

function readTemplateDir(dir, name, source) {
  const mf = join(dir, 'template.json'), cf = join(dir, 'template.css');
  if (!existsSync(mf) || !existsSync(cf)) return { name, source, ok: false, problems: ['needs template.json and template.css'] };
  let manifest;
  try { manifest = JSON.parse(readFileSync(mf, 'utf8').replace(/^﻿/, '')); } catch (e) { return { name, source, ok: false, problems: [`template.json is not valid JSON: ${e.message}`] }; }
  const css = readFileSync(cf, 'utf8');
  const problems = [...cssProblems(css)];
  const order = manifest.section_order ?? SECTIONS;
  if (!Array.isArray(order) || order.some((s) => !SECTIONS.includes(s))) problems.push(`section_order may only list ${SECTIONS.join(', ')}`);
  if (manifest.skills_style && !['inline', 'grouped'].includes(manifest.skills_style)) problems.push('skills_style must be inline or grouped');
  if (manifest.experience_lead && !['title', 'organization'].includes(manifest.experience_lead)) problems.push('experience_lead must be title or organization');
  return {
    name, source, ok: !problems.length, problems,
    title: String(manifest.title ?? name), description: String(manifest.description ?? ''),
    license: manifest.license ?? null, attribution: manifest.attribution ?? null,
    section_order: Array.isArray(order) ? order.filter((s) => SECTIONS.includes(s)) : SECTIONS,
    section_titles: { ...DEFAULT_TITLES, ...(manifest.section_titles ?? {}) },
    skills_style: manifest.skills_style ?? 'inline',
    experience_lead: manifest.experience_lead ?? 'title',
    contact_separator: typeof manifest.contact_separator === 'string' ? manifest.contact_separator.slice(0, 5) : ' | ',
    css,
  };
}

/** Built-in templates first, then the user's (a user template with a built-in's name is reported, not loaded). */
export function listTemplates(dataDir) {
  const out = [];
  const scan = (base, source) => {
    if (!existsSync(base)) return;
    for (const n of readdirSync(base).sort()) {
      const d = join(base, n);
      if (!statSync(d).isDirectory()) continue;
      if (!NAME.test(n)) { out.push({ name: n, source, ok: false, problems: ['folder name must be lowercase letters, digits, - or _'] }); continue; }
      if (source === 'user' && out.some((t) => t.name === n && t.source === 'builtin')) { out.push({ name: n, source, ok: false, problems: [`"${n}" is a built-in template name; rename the folder`] }); continue; }
      out.push(readTemplateDir(d, n, source));
    }
  };
  scan(BUILTIN_DIR, 'builtin');
  if (dataDir) scan(userDir(dataDir), 'user');
  return out;
}

/** Loads a usable template by name. Throws with the reason when it is missing or invalid. */
export function loadTemplate(name, dataDir) {
  const n = String(name ?? DEFAULT_TEMPLATE);
  const all = listTemplates(dataDir);
  const t = all.find((x) => x.name === n && x.ok);
  if (t) return t;
  const bad = all.find((x) => x.name === n);
  if (bad) throw new Error(`resume template "${n}" cannot be used: ${bad.problems.join('; ')}`);
  throw new Error(`no resume template "${n}"; available: ${all.filter((x) => x.ok).map((x) => x.name).join(', ')}`);
}

/** The template a package uses: package.template, else preferences.resume_template, else the default. */
export const templateName = (pkg, profile) => pkg?.template ?? profile?.preferences?.resume_template ?? DEFAULT_TEMPLATE;

// ---------------------------------------------------------------- HTML

const contacts = (id) => {
  const links = Object.entries(id.links ?? {}).flatMap(([k, v]) => (k === 'other' ? v ?? [] : [v])).filter(Boolean);
  return [id.email, id.phone, id.location, ...links].filter(Boolean);
};

const header = (id, t) => `<header class="r-header"><h1 class="r-name">${esc(id.full_name)}</h1><div class="r-contact">${contacts(id).map((c) => `<span class="r-contact-item">${esc(c)}</span>`).join(`<span class="r-sep">${esc(t.contact_separator)}</span>`)}</div></header>`;

const row = (left, right, cls) => `<div class="r-row ${cls}"><span class="r-left">${left}</span>${right ? `<span class="r-right">${right}</span>` : ''}</div>`;
const bullets = (list) => (list.length ? `<ul class="r-bullets">${list.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : '');
const entry = (a, b, c, d, list, extra = '') => `<div class="r-entry">${row(a, b, 'r-row-1')}${c || d ? row(c, d, 'r-row-2') : ''}${extra}${bullets(list)}</div>`;

/**
 * Resume HTML from the same data the Markdown resume uses: the confirmed profile and the package's resume section
 * (refs and bullet texts already checked). `get(ref)` resolves a profile path.
 */
export function renderResumeHtml(profile, rs, t, get) {
  const id = profile.identity;
  const range = (e) => [e.start_date, e.end_date ?? (e.start_date ? 'Present' : null)].filter(Boolean).join(' – ');
  const sec = {};
  if ((rs.education ?? []).length) sec.education = rs.education.map((e) => {
    const p = get(e.ref);
    const gpa = p.gpa && profile.preferences?.show_gpa !== false ? `GPA ${esc(p.gpa)}` : '';
    const course = (e.include_coursework ?? []).length ? `<div class="r-note">Coursework: ${esc(e.include_coursework.join(', '))}</div>` : '';
    return entry(`<strong class="r-org">${esc(p.institution)}</strong>`, esc(p.location ?? ''), `<em class="r-role">${esc([p.degree, p.field].filter(Boolean).join(' in '))}</em>`, [esc(range(p)), gpa].filter(Boolean).join(' · '), [], course);
  }).join('');
  if ((rs.experience ?? []).length) sec.experience = rs.experience.map((e) => {
    const p = get(e.ref);
    const list = (e.bullets ?? []).map((b) => b.text);
    if (t.experience_lead === 'organization') return entry(`<strong class="r-org">${esc(p.organization)}</strong>`, esc(p.location ?? ''), `<em class="r-role">${esc(p.title)}</em>`, esc(range(p)), list);
    return entry(`<strong class="r-org">${esc(p.title)}</strong>`, esc(range(p)), `<em class="r-role">${esc(p.organization)}</em>`, esc(p.location ?? ''), list);
  }).join('');
  if ((rs.projects ?? []).length) sec.projects = rs.projects.map((e) => {
    const p = get(e.ref);
    const tech = (p.technologies ?? []).length ? ` <span class="r-tech">| ${esc(p.technologies.join(', '))}</span>` : '';
    return entry(`<strong class="r-org">${esc(p.name)}</strong>${tech}`, esc(p.url ?? ''), '', '', (e.bullets ?? []).map((b) => b.text));
  }).join('');
  if ((rs.certifications ?? []).length) sec.certifications = rs.certifications.map((e) => {
    const p = get(e.ref);
    return entry(`<strong class="r-org">${esc(p.name)}</strong>${p.issuer ? `, ${esc(p.issuer)}` : ''}`, esc(p.date ?? ''), '', '', []);
  }).join('');
  if ((rs.achievements ?? []).length) sec.achievements = rs.achievements.map((e) => {
    const p = get(e.ref);
    return entry(`<strong class="r-org">${esc(p.name)}</strong>${p.description ? ` – ${esc(p.description)}` : ''}`, esc(p.date ?? ''), '', '', (e.bullets ?? []).map((b) => b.text));
  }).join('');
  if ((rs.skills ?? []).length) {
    if (t.skills_style === 'grouped') {
      const groups = new Map();
      for (const name of rs.skills) {
        const cat = (profile.skills ?? []).find((s) => s.name === name)?.category || 'Other';
        if (!groups.has(cat)) groups.set(cat, []);
        groups.get(cat).push(name);
      }
      sec.skills = `<div class="r-skills">${[...groups].map(([c, l]) => `<div class="r-skill-row"><strong class="r-skill-cat">${esc(c)}:</strong> ${esc(l.join(', '))}</div>`).join('')}</div>`;
    } else sec.skills = `<div class="r-skills"><div class="r-skill-row">${esc(rs.skills.join(', '))}</div></div>`;
  }
  const body = t.section_order.filter((k) => sec[k]).map((k) => `<section class="r-section r-${k}"><h2 class="r-title">${esc(t.section_titles[k])}</h2>${sec[k]}</section>`).join('');
  return page(`${esc(id.full_name)} - Resume`, t, `<main class="r-resume">${header(id, t)}${body}</main>`);
}

/** Cover letter HTML in the same template, so both documents match. `paragraphs` are already checked text. */
export function renderLetterHtml(profile, t, { date, greeting, paragraphs }) {
  const id = profile.identity;
  const body = `<main class="r-letter">${header(id, t)}<p class="r-date">${esc(date)}</p><p class="r-greeting">Dear ${esc(greeting)},</p>${paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}<p class="r-closing">Sincerely,<br>${esc(id.full_name)}</p></main>`;
  return page(`${esc(id.full_name)} - Cover letter`, t, body);
}

// Rules every template gets, before its own CSS: real text, no backgrounds, dates kept on the row.
const BASE = '*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff}body{-webkit-print-color-adjust:exact}.r-row{display:flex;justify-content:space-between;align-items:baseline;gap:12pt}.r-left{min-width:0}.r-right{white-space:nowrap;text-align:right}.r-entry,.r-bullets li{break-inside:avoid}h1,h2{break-after:avoid}.r-sep{white-space:pre}.r-contact-item{white-space:nowrap}';
// Note for template authors: letter-spacing above about .1em makes PDF text extract as "S K I L L S", which
// application systems misread. The built-in templates stay at or below .08em.
const page = (title, t, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>${BASE}\n${t.css}</style></head><body>${body}</body></html>`;
