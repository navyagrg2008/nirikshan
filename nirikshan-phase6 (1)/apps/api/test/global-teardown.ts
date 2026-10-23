import { execSync } from 'child_process';
import { existsSync, readFileSync, rmSync } from 'fs';

export default async function teardown() {
  const DIR = '/var/tmp/nrk-test-pg';
  if (existsSync(`${DIR}-redis.pid`)) { try { process.kill(Number(readFileSync(`${DIR}-redis.pid`, 'utf8'))); } catch { /* already gone */ } rmSync(`${DIR}-redis.pid`); }
  if (existsSync(DIR)) { try { execSync(`su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D ${DIR}/data -m immediate stop >/dev/null"`); } catch { /* already stopped */ } rmSync(DIR, { recursive: true, force: true }); }
  rmSync('/var/tmp/nrk-test-uploads', { recursive: true, force: true });
}
