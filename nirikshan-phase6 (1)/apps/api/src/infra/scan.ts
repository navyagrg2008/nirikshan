import { Inject, Injectable } from '@nestjs/common';
import { Socket } from 'net';
import { ENV, AppEnv } from '../config/env';

export const ALLOWED_UPLOADS: Record<string, { ext: string; max: number }> = {
  'application/pdf': { ext: 'pdf', max: 5 * 1024 * 1024 },
  'image/jpeg': { ext: 'jpg', max: 5 * 1024 * 1024 },
  'image/png': { ext: 'png', max: 5 * 1024 * 1024 },
};

/** Detect the real type from magic bytes; the client-supplied MIME type is never trusted. */
export function sniffMime(buf: Buffer): string | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

export type ScanResult = 'CLEAN' | 'INFECTED' | 'FAILED';

@Injectable()
export class ScanService {
  constructor(@Inject(ENV) private env: AppEnv) {}
  async scan(buf: Buffer): Promise<ScanResult> {
    if (this.env.SCAN_PROVIDER === 'clamav') return this.clam(buf);
    // builtin: EICAR + embedded script markers in PDFs. Development only; production requires ClamAV.
    const s = buf.toString('latin1');
    if (s.includes(EICAR)) return 'INFECTED';
    if (/%PDF-/.test(s.slice(0, 8)) && /\/(JavaScript|JS|Launch|EmbeddedFile)\b/.test(s)) return 'INFECTED';
    return 'CLEAN';
  }
  /** clamd INSTREAM protocol over TCP. Fails closed: any error means the file is not accepted. */
  private clam(buf: Buffer): Promise<ScanResult> {
    return new Promise((resolve) => {
      const sock = new Socket(); let out = ''; let settled = false;
      const done = (r: ScanResult) => { if (!settled) { settled = true; sock.destroy(); resolve(r); } };
      sock.setTimeout(15000, () => done('FAILED'));
      sock.on('error', () => done('FAILED'));
      sock.on('data', (d) => { out += d.toString(); });
      sock.on('close', () => { if (/FOUND/.test(out)) done('INFECTED'); else if (/OK/.test(out)) done('CLEAN'); else done('FAILED'); });
      sock.connect(this.env.CLAMAV_PORT, this.env.CLAMAV_HOST, () => {
        sock.write('zINSTREAM\0');
        for (let i = 0; i < buf.length; i += 65536) {
          const chunk = buf.subarray(i, i + 65536); const len = Buffer.alloc(4); len.writeUInt32BE(chunk.length); sock.write(len); sock.write(chunk);
        }
        sock.write(Buffer.alloc(4));
      });
    });
  }
}
