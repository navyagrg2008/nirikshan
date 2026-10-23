import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().default('postgres://postgres@localhost:5432/nirikshan'),
  DATABASE_MIGRATE_URL: z.string().optional(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  /** JSON map of key id -> base64 32-byte root key. The first entry is the active one. */
  ROOT_KEYS: z.string().optional(),
  ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),
  PUBLIC_BASE_URL: z.string().default('http://localhost:3000'),
  COOKIE_SECURE: bool.default(false),
  TRUST_PROXY: z.coerce.number().default(0),
  /** Requests per minute per address for routes with no rate limit of their own. Raise only on a load-test stack. */
  /** Seconds to keep each person's dashboard numbers. 0 = always fresh (default). 30 is a sensible production value. */
  DASHBOARD_CACHE_SECONDS: z.coerce.number().int().min(0).max(300).default(0),
  RATE_LIMIT_DEFAULT_PER_MIN: z.coerce.number().int().min(1).default(600),
  STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('.uploads'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('ap-south-1'),
  S3_ENDPOINT: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default(false),
  SCAN_PROVIDER: z.enum(['builtin', 'clamav']).default('builtin'),
  CLAMAV_HOST: z.string().default('localhost'),
  CLAMAV_PORT: z.coerce.number().default(3310),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('Nirikshan <no-reply@nirikshan.example>'),
  CAPTCHA_PROVIDER: z.enum(['none', 'turnstile', 'hcaptcha']).default('none'),
  CAPTCHA_SECRET: z.string().optional(),
  ENABLE_SWAGGER: bool.default(true),
  LOG_LEVEL: z.string().default('info'),
  ARGON_MEMORY_KIB: z.coerce.number().default(19456),
  OTP_TTL_SECONDS: z.coerce.number().default(300),
  GEOFENCE_NOTE: z.string().optional(),
  /** Background job scheduler (BullMQ). Off by default under test; handlers can always be run directly. */
  JOBS_ENABLED: z.enum(['true', 'false']).optional(),
});

export type Env = z.infer<typeof schema>;

/** Deterministic dev/test key so a fresh checkout runs. Never accepted in production. */
const DEV_ROOT = { 'dev-1': Buffer.from('nirikshan-dev-only-root-key-0001').toString('base64') };

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env & { rootKeys: Record<string, Buffer>; activeKeyId: string } {
  const parsed = schema.safeParse(source);
  if (!parsed.success) throw new Error('Invalid environment: ' + parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const env = parsed.data;
  let raw: Record<string, string>;
  if (env.ROOT_KEYS) raw = JSON.parse(env.ROOT_KEYS);
  else if (env.NODE_ENV === 'production') throw new Error('ROOT_KEYS is required in production (inject from Secrets Manager / KMS)');
  else raw = DEV_ROOT;
  const rootKeys: Record<string, Buffer> = {};
  for (const [id, b64] of Object.entries(raw)) {
    const buf = Buffer.from(b64, 'base64');
    if (buf.length !== 32) throw new Error(`Root key ${id} must be 32 bytes`);
    rootKeys[id] = buf;
  }
  const activeKeyId = Object.keys(rootKeys)[0]!;
  if (env.NODE_ENV === 'production') {
    if (!env.COOKIE_SECURE) throw new Error('COOKIE_SECURE must be true in production');
    if (env.STORAGE_PROVIDER === 'local') throw new Error('Local file storage is not allowed in production');
    if (env.SCAN_PROVIDER === 'builtin') throw new Error('SCAN_PROVIDER must be clamav in production');
    if (env.CAPTCHA_PROVIDER === 'none' || !env.CAPTCHA_SECRET) throw new Error('CAPTCHA_PROVIDER (turnstile or hcaptcha) and CAPTCHA_SECRET are required in production');   // otherwise public lookup, search and tamper reports have no bot protection
    if (env.ROOT_KEYS?.includes(DEV_ROOT['dev-1'])) throw new Error('Dev root key is not allowed in production');
    if (env.ALLOWED_ORIGINS.split(',').some((o) => !o.trim().startsWith('https://')) || !env.PUBLIC_BASE_URL.startsWith('https://')) throw new Error('ALLOWED_ORIGINS and PUBLIC_BASE_URL must be https URLs in production');
  }
  return { ...env, rootKeys, activeKeyId };
}
export type AppEnv = ReturnType<typeof loadEnv>;
export const ENV = Symbol('ENV');
