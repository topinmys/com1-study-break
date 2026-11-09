import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
export async function database() {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role;');
  const migrations = new URL('../supabase/migrations/', import.meta.url);
  for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(name, migrations), 'utf8'));
  }
  return db;
}
export const fake = (n = 1) => ({ fullName: `Fake Student ${n}`, email: `fake${n}@u.nus.edu`, studentId: `T${String(n).padStart(7, '0')}`, telegram: 'fake_student' });
export async function register(db, n) {
  const a = fake(n);
  return (await db.query('select public.event_register($1,$2,$3,$4) as result', [a.fullName, a.email, a.studentId, a.telegram])).rows[0].result;
}
export function rpcAdapter(db) {
  return async (name, params = {}) => {
    if (!/^(event_capacity|event_register|login_allow|organiser_session_create|organiser_snapshot|organiser_update|organiser_logout)$/.test(name)) throw Error('Unknown RPC');
    const keys = Object.keys(params);
    try {
      const result = await db.query(`select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(',')}) as result`, Object.values(params));
      return { data: result.rows[0].result, error: null };
    } catch (error) { return { data: null, error: { message: error.message, code: error.code } }; }
  };
}
