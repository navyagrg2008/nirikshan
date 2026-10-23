import { randomBytes } from 'crypto';
import { loadEnv } from '../src/config/env';

/** A server that starts in production with an unsafe setting is worse than one that refuses to start. */
const good = () => ({
  NODE_ENV: 'production', COOKIE_SECURE: 'true', STORAGE_PROVIDER: 's3', S3_BUCKET: 'b', SCAN_PROVIDER: 'clamav', CAPTCHA_PROVIDER: 'turnstile', CAPTCHA_SECRET: 's',
  ROOT_KEYS: JSON.stringify({ 'prod-1': randomBytes(32).toString('base64') }), ALLOWED_ORIGINS: 'https://nirikshan.example', PUBLIC_BASE_URL: 'https://nirikshan.example',
}) as NodeJS.ProcessEnv;

describe('production start-up checks', () => {
  it('accepts a safe configuration', () => { expect(() => loadEnv(good())).not.toThrow(); });
  const bad: [string, Record<string, string | undefined>, RegExp][] = [
    ['insecure cookies', { COOKIE_SECURE: 'false' }, /COOKIE_SECURE/],
    ['local file storage', { STORAGE_PROVIDER: 'local' }, /Local file storage/],
    ['the built-in virus scanner', { SCAN_PROVIDER: 'builtin' }, /clamav/],
    ['no human check', { CAPTCHA_PROVIDER: 'none' }, /CAPTCHA/],
    ['a human check without a secret', { CAPTCHA_SECRET: undefined }, /CAPTCHA/],
    ['no root keys', { ROOT_KEYS: undefined }, /ROOT_KEYS/],
    ['the development root key', { ROOT_KEYS: JSON.stringify({ 'dev-1': Buffer.from('nirikshan-dev-only-root-key-0001').toString('base64') }) }, /Dev root key/],
    ['a root key of the wrong length', { ROOT_KEYS: JSON.stringify({ k: Buffer.from('short').toString('base64') }) }, /32 bytes/],
    ['http origins', { ALLOWED_ORIGINS: 'http://nirikshan.example' }, /https/],
    ['an http public address', { PUBLIC_BASE_URL: 'http://nirikshan.example' }, /https/],
  ];
  for (const [name, over, re] of bad) it(`refuses to start with ${name}`, () => { const e = { ...good(), ...over }; for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k]; expect(() => loadEnv(e)).toThrow(re); });
});
