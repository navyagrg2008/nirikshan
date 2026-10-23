import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import QRCode from 'qrcode';

export interface CertificateContent {
  certNo: string; holder: string; category: string; makeModel: string; serialNo: string; instrumentNo: string;
  capacity: string; accuracyClass: string; area: string; mpe: string; verifiedOn: string; validTill: string; validityMonths: number;
  marginal: boolean; stickerSerial: string; issuingOffice: string; issuedBy: string; ruleVersion: number; replaces?: string | null;
}
const INK = rgb(0.1, 0.12, 0.16); const MUTED = rgb(0.38, 0.42, 0.48); const BRASS = rgb(0.72, 0.47, 0.12); const LINE = rgb(0.8, 0.82, 0.85);

/** Standard PDF fonts only (Latin text). The certificate lists English wording; a Hindi template needs a text-shaping font and is deferred. */
async function fonts(doc: PDFDocument) { return { serif: await doc.embedFont(StandardFonts.TimesRoman), bold: await doc.embedFont(StandardFonts.TimesRomanBold), mono: await doc.embedFont(StandardFonts.Courier) }; }

function wrap(text: string, font: PDFFont, size: number, max: number): string[] {
  const out: string[] = []; let line = '';
  for (const w of text.split(/\s+/)) { const t = line ? `${line} ${w}` : w; if (font.widthOfTextAtSize(t, size) > max && line) { out.push(line); line = w; } else line = t; }
  if (line) out.push(line); return out;
}
function row(page: PDFPage, f: { serif: PDFFont; bold: PDFFont }, y: number, label: string, value: string, x = 60, w = 475): number {
  page.drawText(label.toUpperCase(), { x, y, size: 8, font: f.bold, color: MUTED });
  let yy = y - 14; for (const l of wrap(value, f.serif, 12, w)) { page.drawText(l, { x, y: yy, size: 12, font: f.serif, color: INK }); yy -= 15; }
  return yy - 6;
}

/** Strip anything outside Latin-1 so a name typed in another script cannot crash the standard fonts. */
const safe = (s: string) => s.replace(/[^\x20-\x7E -ÿ]/g, '?');

export async function renderCertificate(c: CertificateContent, qrUrl: string, fingerprintHex: string, sigPrefix: string): Promise<Buffer> {
  const doc = await PDFDocument.create(); doc.setTitle(`Certificate ${c.certNo}`); doc.setAuthor('Nirikshan'); doc.setProducer('Nirikshan'); doc.setCreationDate(new Date(c.verifiedOn + 'T00:00:00Z'));
  const page = doc.addPage([595, 842]); const f = await fonts(doc);
  page.drawRectangle({ x: 28, y: 28, width: 539, height: 786, borderColor: BRASS, borderWidth: 1.5 });
  page.drawText('CERTIFICATE OF VERIFICATION', { x: 60, y: 770, size: 20, font: f.bold, color: INK });
  page.drawText('Legal Metrology: weighing and measuring instruments', { x: 60, y: 750, size: 11, font: f.serif, color: MUTED });
  page.drawText('SYNTHETIC SAMPLE: not a legal document', { x: 60, y: 735, size: 9, font: f.bold, color: BRASS });
  page.drawLine({ start: { x: 60, y: 725 }, end: { x: 535, y: 725 }, thickness: 0.7, color: LINE });
  let y = 705;
  y = row(page, f, y, 'Certificate number', c.certNo);
  y = row(page, f, y, 'Holder', safe(c.holder));
  y = row(page, f, y, 'Instrument', safe(`${c.category}, ${c.makeModel}, serial ${c.serialNo} (${c.instrumentNo})`));
  y = row(page, f, y, 'Capacity and accuracy class', safe(`${c.capacity}, class ${c.accuracyClass}`));
  y = row(page, f, y, 'Premises area', safe(c.area));
  y = row(page, f, y, 'Maximum permissible error applied', safe(c.mpe));
  y = row(page, f, y, 'Verified on', c.verifiedOn, 60, 200);
  page.drawText('VALID TILL', { x: 300, y: y + 20, size: 8, font: f.bold, color: MUTED }); page.drawText(`${c.validTill}${c.marginal ? '  (shortened: marginal pass)' : ''}`, { x: 300, y: y + 6, size: 12, font: f.serif, color: INK });
  y = row(page, f, y - 2, 'Seal / sticker serial', safe(c.stickerSerial));
  y = row(page, f, y, 'Issuing office', safe(c.issuingOffice));
  if (c.replaces) y = row(page, f, y, 'Replaces certificate', c.replaces);
  const qr = await QRCode.toBuffer(qrUrl, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
  const img = await doc.embedPng(qr); page.drawImage(img, { x: 60, y: 120, width: 110, height: 110 });
  page.drawText('Scan to validate', { x: 60, y: 106, size: 9, font: f.serif, color: MUTED });
  page.drawText(`Digitally issued by ${safe(c.issuedBy)}`, { x: 200, y: 215, size: 11, font: f.bold, color: INK });
  page.drawText(`Signature code ${sigPrefix}`, { x: 200, y: 199, size: 10, font: f.mono, color: INK });
  page.drawText(`Content fingerprint (SHA-256)`, { x: 200, y: 178, size: 8, font: f.bold, color: MUTED });
  page.drawText(fingerprintHex.slice(0, 32), { x: 200, y: 165, size: 9, font: f.mono, color: INK }); page.drawText(fingerprintHex.slice(32), { x: 200, y: 153, size: 9, font: f.mono, color: INK });
  page.drawText(`Rules version ${c.ruleVersion}. Validate at ${qrUrl.split('/v/')[0]}/validate`, { x: 200, y: 130, size: 9, font: f.serif, color: MUTED });
  page.drawLine({ start: { x: 60, y: 90 }, end: { x: 535, y: 90 }, thickness: 0.7, color: LINE });
  for (const [i, l] of wrap('This certificate is valid only while its status on the validation page is Verified. The holder must keep the seal or sticker on the instrument. Report tampering through the public page.', f.serif, 9, 475).entries())
    page.drawText(l, { x: 60, y: 76 - i * 11, size: 9, font: f.serif, color: MUTED });
  return Buffer.from(await doc.save());
}

export interface TestSheetData {
  applicationNo: string; instrumentNo: string; category: string; makeModel: string; serialNo: string; capacity: string; accuracyClass: string;
  inspector: string; visitedAt: string; arrival: string; ruleVersion: number; overall: string; recommendation: string; stickerSerial: string;
  checklist: { text: string; answer: string; remark?: string }[];
  trials: { no: number; reference: string; observed: string; unit: string; error: string; errorUnit: string; pct: string; mpe: string; verdict: string }[];
  evidence: string[]; note?: string;
}
export async function renderTestSheet(d: TestSheetData): Promise<Buffer> {
  const doc = await PDFDocument.create(); doc.setTitle(`Test sheet ${d.applicationNo}`); doc.setProducer('Nirikshan'); const f = await fonts(doc);
  let page = doc.addPage([595, 842]); let y = 800;
  const need = (h: number) => { if (y - h < 60) { page = doc.addPage([595, 842]); y = 800; } };
  const line = (t: string, o: { bold?: boolean; size?: number; color?: ReturnType<typeof rgb>; x?: number } = {}) => {
    for (const l of wrap(safe(t), o.bold ? f.bold : f.serif, o.size ?? 10, 535 - (o.x ?? 50))) { need(14); page.drawText(l, { x: o.x ?? 50, y, size: o.size ?? 10, font: o.bold ? f.bold : f.serif, color: o.color ?? INK }); y -= (o.size ?? 10) + 4; }
  };
  line('TEST SHEET', { bold: true, size: 18 }); line('Signed record of one inspection visit. Read only once submitted.', { color: MUTED }); y -= 6;
  line(`Application ${d.applicationNo}   Instrument ${d.instrumentNo}`, { bold: true });
  line(`${d.category}, ${d.makeModel}, serial ${d.serialNo}, ${d.capacity}, class ${d.accuracyClass}`);
  line(`Inspector ${d.inspector}   Visit ${d.visitedAt}   ${d.arrival}   Rules version ${d.ruleVersion}`); y -= 6;
  line('Checklist', { bold: true, size: 12 });
  for (const c of d.checklist) line(`${c.answer.padEnd(3)}  ${c.text}${c.remark ? `  (${c.remark})` : ''}`, { x: 56 });
  y -= 6; line('Test trials (calculated by the server)', { bold: true, size: 12 });
  line('No  Reference  Observed  Error  Error %  Limit  Result', { color: MUTED, x: 56 });
  for (const t of d.trials) line(`${t.no}   ${t.reference} ${t.unit}   ${t.observed} ${t.unit}   ${t.error} ${t.errorUnit}   ${t.pct}%   ${t.mpe} ${t.errorUnit}   ${t.verdict}`, { x: 56 });
  y -= 6; line(`Overall result: ${d.overall}`, { bold: true }); line(`Inspector recommendation: ${d.recommendation}   Sticker serial: ${d.stickerSerial || 'none'}`);
  line(`Evidence: ${d.evidence.join(', ') || 'none'}`); if (d.note) line(`Note: ${d.note}`);
  return Buffer.from(await doc.save());
}
