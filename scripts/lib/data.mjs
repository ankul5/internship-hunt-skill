// Shared schema loading and CSV validation, used by the search helper and tests/validate.mjs.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from './csv.mjs';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const loadCsvSchemas = () =>
  JSON.parse(readFileSync(join(repoRoot, 'references/schemas/csv-schemas.json'), 'utf8').replace(/^﻿/, '')).files;

/** Private data directory: $INTERNSHIP_AGENT_HOME, else <repo>/private. */
export const dataDir = () => process.env.INTERNSHIP_AGENT_HOME || join(repoRoot, 'private');

export const isoNow = (d = new Date()) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

export const TYPE_CHECKS = {
  datetime: (v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v),
  date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v),
  url: (v) => /^https?:\/\/\S+$/.test(v),
  integer: (v) => /^-?\d+$/.test(v),
  number: (v) => !Number.isNaN(Number(v)),
  path: (v) => !/^([\\/]|[A-Za-z]:)/.test(v) && !/(^|[\\/])\.\.([\\/]|$)/.test(v),
};

/** Validate CSV text against one file spec. Returns an array of error strings. */
export function checkCsv(label, src, spec, idSets = {}) {
  const errs = [];
  const rows = parseCsv(src);
  const header = rows[0] ?? [];
  const names = spec.columns.map((c) => c.name);
  if (header.join(',') !== names.join(',')) {
    errs.push(`header mismatch.\n        expected: ${names.join(',')}\n        actual:   ${header.join(',')}`);
    return errs;
  }
  const seen = new Set();
  const idRe = new RegExp(spec.idPattern);
  rows.slice(1).forEach((cells, i) => {
    const line = i + 2;
    if (cells.length !== names.length) { errs.push(`line ${line}: ${cells.length} cells, expected ${names.length}`); return; }
    const rec = Object.fromEntries(names.map((n, k) => [n, cells[k]]));
    for (const col of spec.columns) {
      const v = rec[col.name];
      if (v === '') { if (col.required) errs.push(`line ${line}: ${col.name} is required`); continue; }
      if (v !== v.trim()) errs.push(`line ${line}: ${col.name} has leading/trailing whitespace`);
      if (/^(n\/a|na|tbd|null|none|unknown\?)$/i.test(v)) errs.push(`line ${line}: ${col.name} uses placeholder "${v}"; leave empty instead`);
      if (col.type === 'id' && col.name === spec.idField && !idRe.test(v)) errs.push(`line ${line}: ${col.name} "${v}" does not match ${spec.idPattern}`);
      if (col.type === 'enum' && !col.enum.includes(v)) errs.push(`line ${line}: ${col.name} "${v}" not in [${col.enum.join(', ')}]`);
      const check = TYPE_CHECKS[col.type];
      if (check && !check(v)) errs.push(`line ${line}: ${col.name} "${v}" is not a valid ${col.type}`);
      if (col.type === 'integer' && check(v)) {
        const n = Number(v);
        if (col.min !== undefined && n < col.min) errs.push(`line ${line}: ${col.name} ${n} < ${col.min}`);
        if (col.max !== undefined && n > col.max) errs.push(`line ${line}: ${col.name} ${n} > ${col.max}`);
      }
      if (col.ref) {
        const [file, field] = col.ref.split('.csv.');
        const ids = idSets[`${file}.csv`];
        if (ids && !ids.has(v)) errs.push(`line ${line}: ${col.name} "${v}" not found in ${file}.csv.${field}`);
      }
    }
    for (const rule of spec.requiredWhen ?? []) {
      const [[field, values]] = Object.entries(rule.when);
      if (values.includes(rec[field])) {
        for (const req of rule.require) if (rec[req] === '') errs.push(`line ${line}: ${field}=${rec[field]} requires ${req}`);
      }
    }
    const id = rec[spec.idField];
    if (seen.has(id)) errs.push(`line ${line}: duplicate ${spec.idField} ${id}`);
    seen.add(id);
  });
  return errs;
}
