import { Inject, Injectable } from '@nestjs/common';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { ENV, AppEnv } from '../config/env';
import { CryptoService } from './crypto';

export interface PutOptions { contentType: string }
/** Private object storage. Objects are never served from the app origin; callers get short-lived signed URLs. */
@Injectable()
export class StorageService {
  private s3?: S3Client;
  constructor(@Inject(ENV) private env: AppEnv, private crypto: CryptoService) {
    if (env.STORAGE_PROVIDER === 's3') {
      this.s3 = new S3Client({ region: env.S3_REGION, endpoint: env.S3_ENDPOINT, forcePathStyle: env.S3_FORCE_PATH_STYLE });
    }
  }
  private localPath(key: string) {
    const base = resolve(this.env.STORAGE_LOCAL_DIR);
    const p = resolve(base, key);
    if (!p.startsWith(base + '/')) throw new Error('BAD_KEY');
    return p;
  }
  async put(key: string, body: Buffer, opts: PutOptions): Promise<void> {
    if (this.s3) {
      await this.s3.send(new PutObjectCommand({ Bucket: this.env.S3_BUCKET!, Key: key, Body: body, ContentType: opts.contentType, ServerSideEncryption: 'aws:kms' }));
      return;
    }
    const p = this.localPath(key); await mkdir(dirname(p), { recursive: true }); await writeFile(p, body, { mode: 0o600 });
  }
  /** Removes an object. Missing objects are not an error, so a retried erasure is safe. */
  async remove(key: string): Promise<void> {
    if (this.s3) { await this.s3.send(new DeleteObjectCommand({ Bucket: this.env.S3_BUCKET!, Key: key })); return; }
    await rm(this.localPath(key), { force: true });
  }
  async getLocal(key: string): Promise<Buffer> { return readFile(this.localPath(key)); }
  /** S3: presigned GET (<= 5 min, single object). Local dev: HMAC-signed API URL with expiry. */
  async signedUrl(key: string, contentType: string, ttlSec = 300): Promise<string> {
    if (this.s3) {
      return getSignedUrl(this.s3, new GetObjectCommand({
        Bucket: this.env.S3_BUCKET!, Key: key, ResponseContentType: contentType, ResponseContentDisposition: 'attachment',
      }), { expiresIn: Math.min(ttlSec, 300) });
    }
    const exp = Math.floor(Date.now() / 1000) + Math.min(ttlSec, 300);
    const payload = `${Buffer.from(key).toString('base64url')}.${exp}.${Buffer.from(contentType).toString('base64url')}`;
    return `/api/v1/files/local/${payload}.${this.crypto.sign('file', payload)}`;
  }
  parseLocalToken(token: string): { key: string; contentType: string } | null {
    const parts = token.split('.');
    if (parts.length !== 4) return null;
    const [k, exp, ct, sig] = parts as [string, string, string, string];
    const payload = `${k}.${exp}.${ct}`;
    if (!this.crypto.verifySign('file', payload, sig)) return null;
    if (Number(exp) < Date.now() / 1000) return null;
    return { key: Buffer.from(k, 'base64url').toString(), contentType: Buffer.from(ct, 'base64url').toString() };
  }
}
