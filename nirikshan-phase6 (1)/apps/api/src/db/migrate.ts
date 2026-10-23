import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { PERMISSIONS, ROLE_PERMISSIONS } from '@nirikshan/shared';

/** PostGIS-less fallback used only for local development and CI where the extension is not installable. */
function withoutPostgis(sql: string): string {
  return sql
    .replace(/CREATE EXTENSION IF NOT EXISTS postgis;/g, '-- postgis not available: geometry columns degrade to plain point/polygon')
    .replace(/geometry\(MultiPolygon, 4326\)/g, 'polygon')
    .replace(/geometry\(Point, 4326\)/g, 'point');
}

export async function migrate(url: string, log: (m: string) => void = console.log): Promise<{ postgis: boolean; applied: string[] }> {
  const pool = new Pool({ connectionString: url, max: 1 });
  const applied: string[] = [];
  try {
    await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const avail = await pool.query(`SELECT 1 FROM pg_available_extensions WHERE name='postgis'`);
    const postgis = (avail.rowCount ?? 0) > 0;
    if (!postgis) {
      if (process.env.NODE_ENV === 'production') throw new Error('PostGIS is required in production');
      log('PostGIS not available: using point/polygon fallback (development only)');
    }
    const dir = join(__dirname, 'migrations');
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      const done = await pool.query('SELECT 1 FROM schema_migrations WHERE name=$1', [f]);
      if (done.rowCount) continue;
      let sql = readFileSync(join(dir, f), 'utf8');
      if (!postgis) sql = withoutPostgis(sql);
      const c = await pool.connect();
      try {
        await c.query('BEGIN'); await c.query(sql); await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]); await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK'); throw new Error(`Migration ${f} failed: ${(e as Error).message}`); } finally { c.release(); }
      applied.push(f); log(`applied ${f}`);
    }
    await syncPermissions(pool);
    return { postgis, applied };
  } finally { await pool.end(); }
}

/** Roles to permissions come from packages/shared so UI, API and database can never drift apart. */
export async function syncPermissions(pool: Pool) {
  for (const [code, description] of Object.entries(PERMISSIONS)) {
    await pool.query('INSERT INTO permissions(code, description) VALUES ($1,$2) ON CONFLICT (code) DO UPDATE SET description=EXCLUDED.description', [code, description]);
  }
  await pool.query('DELETE FROM role_permissions');
  for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
    for (const p of perms) {
      await pool.query(
        'INSERT INTO role_permissions(role_id, permission_id) SELECT r.id, p.id FROM roles r, permissions p WHERE r.code=$1 AND p.code=$2 ON CONFLICT DO NOTHING', [role, p]);
    }
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_MIGRATE_URL ?? process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/nirikshan';
  migrate(url).then((r) => { console.log('migrations done', r); }).catch((e) => { console.error(e.message); process.exit(1); });
}
