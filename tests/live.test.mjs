// REAL multi-connection HTTP test. Refuses hosted projects and existing attendees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fake } from './helpers.mjs';
const url = process.env.TEST_SUPABASE_URL;
test('local Supabase: final-place race, shared attendance and public isolation', { skip: !url && 'Set TEST_SUPABASE_URL to a disposable local Supabase instance.' }, async () => {
  const parsed = new URL(url);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname), 'Refusing non-local database: never seed real attendee data.');
  const key = process.env.TEST_PUBLISHABLE_KEY, pin = process.env.TEST_ORGANISER_PIN;
  assert.ok(key && pin, 'Set TEST_PUBLISHABLE_KEY and TEST_ORGANISER_PIN for the local project.');
  const request = async (action, data = {}, token) => {
    const res = await fetch(`${url}/functions/v1/event-api`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: key, ...(token ? { 'x-organiser-session': token } : {}) }, body: JSON.stringify({ action, ...data }) });
    return { status: res.status, data: await res.json() };
  };
  assert.deepEqual((await request('capacity')).data, { capacity: 150, registered: 0, remaining: 150 }, 'Reset the disposable local database before running.');
  assert.equal((await request('snapshot')).status, 401);
  for (let i = 1; i < 150; i++) assert.equal((await request('register', fake(i))).status, 201);
  const race = await Promise.all([request('register', fake(150)), request('register', fake(151))]);
  assert.deepEqual(race.map(r => r.status).sort(), [201, 409]);
  assert.equal(race.find(r => r.status === 409).data.error, 'FULL');
  assert.equal((await request('capacity')).data.registered, 150);
  assert.equal((await request('register', fake(152))).data.error, 'FULL');
  assert.equal((await request('register', fake(1))).data.error, 'DUPLICATE');
  const first = await request('login', { pin }), second = await request('login', { pin });
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  const snapshot = await request('snapshot', {}, first.data.token); assert.equal(snapshot.data.attendees.length, 150);
  const id = snapshot.data.attendees[0].id;
  assert.equal((await request('update', { id, field: 'collected', value: true }, first.data.token)).data.error, 'CHECK_IN_FIRST');
  for (let i = 0; i < 2; i++) assert.equal((await request('update', { id, field: 'checkedIn', value: true }, first.data.token)).status, 200);
  assert.equal((await request('snapshot', {}, second.data.token)).data.checkedIn, 1);
  for (let i = 0; i < 2; i++) assert.equal((await request('update', { id, field: 'collected', value: true }, second.data.token)).status, 200);
  assert.equal((await request('snapshot', {}, first.data.token)).data.collected, 1);
  assert.equal((await request('update', { id, field: 'checkedIn', value: false }, first.data.token)).data.error, 'UNDO_COLLECTION_FIRST');
  for (const path of ['attendees?select=*', 'rpc/event_capacity', 'rpc/organiser_snapshot']) {
    const res = await fetch(`${url}/rest/v1/${path}`, { method: path.includes('rpc/') ? 'POST' : 'GET', headers: { apikey: key, 'Content-Type': 'application/json' }, ...(path.includes('rpc/') ? { body: '{}' } : {}) });
    assert.ok(!res.ok, `Public database access must fail: ${path}`);
  }
  await request('logout', {}, first.data.token);
  assert.equal((await request('snapshot', {}, first.data.token)).status, 401);
});
