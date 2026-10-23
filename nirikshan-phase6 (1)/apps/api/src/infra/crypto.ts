import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Key hierarchy (ADR-002):
 *  root key (from KMS / Secrets Manager, id-tagged for rotation)
 *    -> HKDF subkeys: field-KEK, blind-index key, otp key, token-signing key
 *  each record gets its own random 256-bit data key (DEK), wrapped by the field-KEK (AES-256-GCM).
 * Blob layout: 0x01 | keyIdLen(1) | keyId | wrappedDekLen(1)=60 | wrappedDek(12 nonce + 32 dek + 16 tag) | nonce(12) | tag(16) | ciphertext
 */
export class CryptoService {
  constructor(private readonly roots: Record<string, Buffer>, private readonly activeId: string) {}

  private sub(rootId: string, label: string): Buffer {
    const root = this.roots[rootId];
    if (!root) throw new Error('UNKNOWN_KEY_ID');
    return Buffer.from(hkdfSync('sha256', root, Buffer.alloc(0), `nirikshan:${label}`, 32));
  }

  encrypt(plain: string | Buffer, aad = ''): Buffer {
    const data = typeof plain === 'string' ? Buffer.from(plain, 'utf8') : plain;
    const keyId = this.activeId;
    const kek = this.sub(keyId, 'field-kek');
    const dek = randomBytes(32);
    const wNonce = randomBytes(12);
    const wc = createCipheriv('aes-256-gcm', kek, wNonce);
    const wrapped = Buffer.concat([wNonce, wc.update(dek), wc.final(), wc.getAuthTag()]);
    const nonce = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', dek, nonce);
    if (aad) c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(data), c.final()]);
    const idBuf = Buffer.from(keyId);
    return Buffer.concat([Buffer.from([1, idBuf.length]), idBuf, Buffer.from([wrapped.length]), wrapped, nonce, c.getAuthTag(), ct]);
  }

  decrypt(blob: Buffer, aad = ''): Buffer {
    if (blob[0] !== 1) throw new Error('BAD_BLOB');
    let o = 1;
    const idLen = blob[o++]!;
    const keyId = blob.subarray(o, o + idLen).toString(); o += idLen;
    const wLen = blob[o++]!;
    const wrapped = blob.subarray(o, o + wLen); o += wLen;
    const nonce = blob.subarray(o, o + 12); o += 12;
    const tag = blob.subarray(o, o + 16); o += 16;
    const ct = blob.subarray(o);
    const kek = this.sub(keyId, 'field-kek');
    const wd = createDecipheriv('aes-256-gcm', kek, wrapped.subarray(0, 12));
    wd.setAuthTag(wrapped.subarray(wrapped.length - 16));
    const dek = Buffer.concat([wd.update(wrapped.subarray(12, wrapped.length - 16)), wd.final()]);
    const d = createDecipheriv('aes-256-gcm', dek, nonce);
    if (aad) d.setAAD(Buffer.from(aad));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
  }
  encStr(s: string | null | undefined, aad = ''): Buffer | null { return s == null || s === '' ? null : this.encrypt(s, aad); }
  decStr(b: Buffer | null | undefined, aad = ''): string | null { return b ? this.decrypt(b, aad).toString('utf8') : null; }
  encJson(v: unknown, aad = ''): Buffer { return this.encrypt(JSON.stringify(v), aad); }
  decJson<T = unknown>(b: Buffer, aad = ''): T { return JSON.parse(this.decrypt(b, aad).toString('utf8')) as T; }

  /** Deterministic HMAC used for lookups on encrypted fields (mobile, email) and for hashing targets / IPs. Uses the first root key. */
  blindIndex(label: string, value: string): Buffer {
    return createHmac('sha256', this.sub(this.activeId, 'blind-index')).update(`${label}:${value}`).digest();
  }
  /** Same as blindIndex but also tries older keys: used when looking up after a root key rotation. */
  blindIndexAll(label: string, value: string): Buffer[] {
    return Object.keys(this.roots).map((id) => createHmac('sha256', this.sub(id, 'blind-index')).update(`${label}:${value}`).digest());
  }
  /** Keyed hash for OTP codes. */
  otpHash(challengeId: string, code: string): Buffer {
    return createHmac('sha256', this.sub(this.activeId, 'otp')).update(`${challengeId}:${code}`).digest();
  }
  get currentKeyId(): string { return this.activeId; }
  knownKeyIds(): string[] { return Object.keys(this.roots); }
  /**
   * QR signature: base64url(HMAC-SHA256(certKey, certNo + ":" + fingerprint)).slice(0, 22). The key is derived per key id, so a certificate keeps
   * verifying after the active key is rotated, as long as the old root key stays in ROOT_KEYS. In production the root key lives in the KMS.
   */
  qrSig(keyId: string, certNo: string, fingerprintHex: string): string {
    return createHmac('sha256', this.sub(keyId, 'cert-qr')).update(`${certNo}:${fingerprintHex}`).digest('base64url').slice(0, 22);
  }
  qrVerify(keyId: string, certNo: string, fingerprintHex: string, sig: string): boolean {
    if (!this.roots[keyId]) return false;
    const a = Buffer.from(this.qrSig(keyId, certNo, fingerprintHex)); const b = Buffer.from(sig);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  /** Sign a short opaque payload (download links, invite tokens). */
  sign(label: string, payload: string): string {
    return createHmac('sha256', this.sub(this.activeId, 'sign')).update(`${label}:${payload}`).digest('base64url');
  }
  verifySign(label: string, payload: string, sig: string): boolean {
    const exp = Buffer.from(this.sign(label, payload)); const got = Buffer.from(sig);
    return exp.length === got.length && timingSafeEqual(exp, got);
  }
}

export const sha256 = (s: string | Buffer): Buffer => createHash('sha256').update(s).digest();
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
