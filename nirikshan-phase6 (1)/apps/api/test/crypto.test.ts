import { CryptoService } from '../src/infra/crypto';
import { randomBytes } from 'crypto';

const k1 = randomBytes(32); const k2 = randomBytes(32);
describe('field encryption', () => {
  const c = new CryptoService({ a: k1 }, 'a');
  it('round-trips and never repeats ciphertext', () => {
    const x = c.encrypt('9876543210'); const y = c.encrypt('9876543210');
    expect(x.equals(y)).toBe(false); expect(c.decrypt(x).toString()).toBe('9876543210'); expect(x.includes(Buffer.from('9876543210'))).toBe(false);
  });
  it('detects tampering', () => { const x = c.encrypt('secret'); x[x.length - 1] ^= 1; expect(() => c.decrypt(x)).toThrow(); });
  it('binds ciphertext to its AAD', () => { const x = c.encrypt('secret', 'user:1'); expect(() => c.decrypt(x, 'user:2')).toThrow(); expect(c.decrypt(x, 'user:1').toString()).toBe('secret'); });
  it('decrypts data written under an older root key after rotation', () => {
    const old = new CryptoService({ a: k1 }, 'a'); const blob = old.encrypt('legacy');
    const rotated = new CryptoService({ b: k2, a: k1 }, 'b');
    expect(rotated.decrypt(blob).toString()).toBe('legacy'); expect(rotated.decrypt(rotated.encrypt('new')).toString()).toBe('new');
    expect(rotated.blindIndexAll('mobile', '1').some((h) => h.equals(old.blindIndex('mobile', '1')))).toBe(true);
  });
  it('blind index is deterministic, keyed and label-separated', () => {
    expect(c.blindIndex('mobile', '1').equals(c.blindIndex('mobile', '1'))).toBe(true);
    expect(c.blindIndex('mobile', '1').equals(c.blindIndex('email', '1'))).toBe(false);
    expect(new CryptoService({ a: k2 }, 'a').blindIndex('mobile', '1').equals(c.blindIndex('mobile', '1'))).toBe(false);
  });
  it('signs and verifies tokens', () => { const s = c.sign('x', 'p'); expect(c.verifySign('x', 'p', s)).toBe(true); expect(c.verifySign('x', 'q', s)).toBe(false); expect(c.verifySign('y', 'p', s)).toBe(false); });
});

describe('certificate QR signature', () => {
  const fp = 'ab'.repeat(32);
  it('is 22 URL-safe characters, bound to number and fingerprint', () => {
    const c = new CryptoService({ a: k1 }, 'a'); const s = c.qrSig('a', 'NRK/CERT/CEN/2026/000001', fp);
    expect(s).toMatch(/^[A-Za-z0-9_-]{22}$/); expect(c.qrVerify('a', 'NRK/CERT/CEN/2026/000001', fp, s)).toBe(true);
    expect(c.qrVerify('a', 'NRK/CERT/CEN/2026/000002', fp, s)).toBe(false); expect(c.qrVerify('a', 'NRK/CERT/CEN/2026/000001', 'cd'.repeat(32), s)).toBe(false);
    expect(c.qrVerify('a', 'NRK/CERT/CEN/2026/000001', fp, s.slice(0, 21) + (s.endsWith('A') ? 'B' : 'A'))).toBe(false);
    expect(c.qrVerify('nope', 'x', fp, s)).toBe(false);
  });
  it('old certificates keep verifying after the active key is rotated; a different root does not verify', () => {
    const old = new CryptoService({ a: k1 }, 'a'); const s = old.qrSig('a', 'N', fp);
    const rotated = new CryptoService({ b: k2, a: k1 }, 'b');
    expect(rotated.currentKeyId).toBe('b'); expect(rotated.qrVerify('a', 'N', fp, s)).toBe(true); expect(rotated.qrVerify('b', 'N', fp, s)).toBe(false);
    expect(new CryptoService({ a: k2 }, 'a').qrVerify('a', 'N', fp, s)).toBe(false);
  });
});
