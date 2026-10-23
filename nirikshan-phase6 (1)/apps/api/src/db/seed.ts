import { Pool } from 'pg';
import { migrate } from './migrate';
import { seedDemoUsers, seedReference } from './seed-data';
import { CryptoService } from '../infra/crypto';
import { loadEnv } from '../config/env';

async function main() {
  const env = loadEnv(); const url = env.DATABASE_MIGRATE_URL ?? env.DATABASE_URL;
  await migrate(url);
  const pool = new Pool({ connectionString: url });
  try {
    await seedReference(pool);
    if (env.NODE_ENV === 'production') { console.log('Reference data seeded. Demo users are never created in production.'); return; }
    const creds = await seedDemoUsers(pool, new CryptoService(env.rootKeys, env.activeKeyId), env.ARGON_MEMORY_KIB);
    if (!creds.length) console.log('Demo users already exist (passwords are shown only once, at creation).');
    else {
      console.log('\nDemo users (synthetic). Passwords are printed ONCE. Staff authenticator secrets are for development only.\n');
      for (const c of creds) console.log(`${c.role.padEnd(8)} mobile ${c.mobile}  password ${c.password}${c.totpSecret ? `  totp-secret ${c.totpSecret}` : ''}`);
    }
  } finally { await pool.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
