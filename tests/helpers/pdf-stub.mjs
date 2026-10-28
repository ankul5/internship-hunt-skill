// Test-only PDF engine: a tiny valid-looking PDF whose bytes depend on the HTML, so edits change its hash.
// Production never uses this; the real engine (headless Chrome or Edge) is exercised in tests/pdf.test.mjs.
import { createHash } from 'node:crypto';
import { setPdfEngine } from '../../scripts/lib/pdf.mjs';

export const stubEngine = ({ html }) => {
  const h = createHash('sha256').update(html).digest('hex');
  const body = `%PDF-1.4\n1 0 obj\n<< /Type /Page /Note ${h} >>\nendobj\n${'% test pdf\n'.repeat(90)}%%EOF\n`;
  return { ok: true, engine: 'stub', pdf: Buffer.from(body, 'latin1') };
};
export const installPdfStub = () => setPdfEngine(stubEngine);
