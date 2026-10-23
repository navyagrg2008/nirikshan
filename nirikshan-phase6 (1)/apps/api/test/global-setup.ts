import { execSync, spawn } from 'child_process';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { Pool } from 'pg';

const DIR = '/var/tmp/nrk-test-pg';
const PG_PORT = 5544; const REDIS_PORT = 6380;
const PGBIN = '/usr/lib/postgresql/16/bin';

/** Starts a throwaway PostgreSQL and Redis unless TEST_DATABASE_URL / TEST_REDIS_URL are provided (CI uses service containers). */
export default async function setup() {
  process.env.NODE_ENV = 'test';
  let dbUrl = process.env.TEST_DATABASE_URL; let redisUrl = process.env.TEST_REDIS_URL;
  if (!dbUrl) {
    rmSync(DIR, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true }); execSync(`chown postgres ${DIR}`);
    execSync(`su postgres -c "${PGBIN}/initdb -D ${DIR}/data -A trust >/dev/null && ${PGBIN}/pg_ctl -D ${DIR}/data -o '-p ${PG_PORT} -k ${DIR} -c fsync=off' -l ${DIR}/log -w start >/dev/null"`);
    execSync(`su postgres -c "psql -h ${DIR} -p ${PG_PORT} -c 'create database nrk_test' postgres >/dev/null"`);
    dbUrl = `postgres://postgres@127.0.0.1:${PG_PORT}/nrk_test`;
    (globalThis as any).__pgStarted = true;
  }
  if (!redisUrl) {
    const p = spawn('redis-server', ['--port', String(REDIS_PORT), '--save', '', '--appendonly', 'no'], { stdio: 'ignore', detached: true }); p.unref();
    writeFileSync(`${DIR}-redis.pid`, String(p.pid)); redisUrl = `redis://127.0.0.1:${REDIS_PORT}`;
    await new Promise((r) => setTimeout(r, 600));
  }
  process.env.DATABASE_URL = dbUrl; process.env.REDIS_URL = redisUrl;
  process.env.TRUST_PROXY = '1'; process.env.ARGON_MEMORY_KIB = '1024'; process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
  process.env.STORAGE_LOCAL_DIR = '/var/tmp/nrk-test-uploads';
  const { migrate } = await import('../src/db/migrate'); const { seedReference } = await import('../src/db/seed-data');
  await migrate(dbUrl, () => undefined);
  const pool = new Pool({ connectionString: dbUrl }); await seedReference(pool); await pool.end();
}
