// Minimal RFC 4180 CSV reader/writer. No dependencies.

export function parseCsv(src) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = ''; rows.push(row); row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const quote = (v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** header: string[]; records: objects keyed by header. Always LF, trailing newline. */
export function serializeCsv(header, records) {
  const lines = [header.map(quote).join(',')];
  for (const r of records) lines.push(header.map((h) => quote(String(r[h] ?? ''))).join(','));
  return `${lines.join('\n')}\n`;
}
