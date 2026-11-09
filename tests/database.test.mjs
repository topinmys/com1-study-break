import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { database, register } from './helpers.mjs';
let db;
before(async () => { db = await database(); });
after(async () => { await db?.close(); });
test('migration enables RLS and explicitly blocks public data and RPC access', async () => {
  const tables = (await db.query("select relname, relrowsecurity from pg_class join pg_namespace n on n.oid=relnamespace where n.nspname='private' and relkind='r'")).rows;
  assert.equal(tables.length, 4); assert.ok(tables.every(t => t.relrowsecurity));
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal((await db.query(`select has_table_privilege('${role}', 'private.attendees', 'SELECT') as allowed`)).rows[0].allowed, false);
  }
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await db.query(`select has_function_privilege('${role}', 'public.organiser_update(text,uuid,boolean)', 'EXECUTE') as allowed`)).rows[0].allowed, false);
    assert.equal((await db.query(`select has_function_privilege('${role}', 'public.organiser_snapshot(text)', 'EXECUTE') as allowed`)).rows[0].allowed, false);
    await db.exec(`set role ${role}`);
    await assert.rejects(db.query('select * from private.attendees'), /permission denied/);
    await assert.rejects(db.query("select public.event_capacity()"), /permission denied/);
    await db.exec('reset role');
  }
});
test('normalised duplicates, constraints and persistence across independent queries', async () => {
  const saved = await register(db, 1); assert.equal(saved.reserved, true);
  assert.equal((await db.query('select count(*)::int as n from private.attendees')).rows[0].n, 1);
  await assert.rejects(db.query("select public.event_register('Fake Person', ' FAKE1@U.NUS.EDU ', 'OTHER123', 'fake_user')"), /DUPLICATE/);
  await assert.rejects(db.query("select public.event_register('Fake Person', 'other@u.nus.edu', ' t0000001 ', 'fake_user')"), /DUPLICATE/);
  await assert.rejects(db.query("insert into private.attendees(full_name,email,student_id,telegram) values('Fake Person','NOTNORMALIZED@u.nus.edu','INVALID1','fake_user')"), /check constraint/);
});
test('session expiry, idempotent combined check-in and undo', async () => {
  const hash = 'a'.repeat(64);
  await db.query('select public.organiser_session_create($1)', [hash]);
  const id = (await db.query('select id from private.attendees limit 1')).rows[0].id;
  const update = (value, token = hash) => db.query('select public.organiser_update($1,$2,$3)', [token, id, value]);
  await assert.rejects(update(true, 'b'.repeat(64)), /UNAUTHORISED/);
  await assert.rejects(update(null), /INVALID_ACTION/);
  await update(true);
  const first = (await db.query('select checked_in_at from private.attendees where id=$1', [id])).rows[0].checked_in_at;
  await update(true);
  assert.deepEqual((await db.query('select checked_in_at from private.attendees where id=$1', [id])).rows[0].checked_in_at, first);
  assert.equal((await db.query('select public.organiser_snapshot($1) as s', [hash])).rows[0].s.checkedIn, 1);
  await update(false); await update(false);
  const totals = (await db.query('select public.organiser_snapshot($1) as s', [hash])).rows[0].s;
  assert.equal(totals.checkedIn, 0); assert.equal('collected' in totals, false);
  assert.equal('collected_at' in totals.attendees[0], false);
  await db.query("update private.organiser_sessions set expires_at=now()-interval '1 second'");
  await assert.rejects(update(true), /UNAUTHORISED/);
  await assert.rejects(db.query('select public.organiser_snapshot($1)', [hash]), /UNAUTHORISED/);
});
test('login limits are shared, bounded, and reset after the fixed window', async () => {
  const hash = 'c'.repeat(64);
  for (let i = 0; i < 5; i++) assert.equal((await db.query('select public.login_allow($1) as ok', [hash])).rows[0].ok, true);
  assert.equal((await db.query('select public.login_allow($1) as ok', [hash])).rows[0].ok, false);
  await db.exec("update private.login_limits set started_at=now()-interval '11 minutes'");
  assert.equal((await db.query('select public.login_allow($1) as ok', [hash])).rows[0].ok, true);
  await db.exec("update private.login_limits set attempts=100 where bucket='global'");
  assert.equal((await db.query('select public.login_allow($1) as ok', ['d'.repeat(64)])).rows[0].ok, false);
});
test('capacity is 150; simultaneous queued requests for the last place yield one success', async () => {
  for (let n = 2; n <= 149; n++) await register(db, n);
  // PGlite runs one connection: this tests the SQL boundary, not multi-connection locking.
  // test:live exercises simultaneous HTTP requests against local Supabase/Postgres.
  const results = await Promise.allSettled([register(db, 150), register(db, 151)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /FULL/);
  await assert.rejects(register(db, 152), /FULL/);
  const result = (await db.query('select public.event_capacity() as result')).rows[0].result;
  assert.deepEqual(result, { capacity: 150, registered: 150, remaining: 0 });
});
