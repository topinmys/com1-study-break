// api regression checks cover validation, authentication, safe failures, and the database transport.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import {
  createHandler,
  sha256,
  validateRegistration,
} from '../supabase/functions/event-api/handler.js';
import { createRpc } from '../supabase/functions/event-api/transport.js';
import { database, fake, rpcAdapter } from './helpers.mjs';
let db, handler, env;
// use real validation, sql, and bcrypt with deliberately fake test credentials.
before(async () => {
  db = await database();
  env = {
    ALLOWED_ORIGINS: 'http://localhost:4173',
    ORGANISER_PIN_HASH: await bcrypt.hash('87463921', 4),
    RATE_LIMIT_SECRET: 'test-only-secret',
    STUDENT_EMAIL_DOMAIN: 'u.nus.edu',
  };
  handler = createHandler({ rpc: rpcAdapter(db), comparePin: bcrypt.compare, env });
});
after(async () => {
  await db?.close();
});
// build a request directly for the handler; no real supabase project is contacted.
async function request(body, token, origin = 'http://localhost:4173') {
  const response = await handler(
    new Request('https://example.test/event-api', {
      method: 'POST',
      headers: { origin, ...(token ? { 'x-organiser-session': token } : {}) },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, data: await response.json() };
}
test('server normalises inputs and enforces exact configurable email domain', () => {
  const input = {
    ...fake(),
    email: ' FAKE1@U.NUS.EDU ',
    studentId: ' t0000001 ',
    telegram: '@fake_student',
  };
  assert.equal(validateRegistration(input).p_email, 'fake1@u.nus.edu');
  assert.equal(validateRegistration(input).p_student_id, 'T0000001');
  assert.equal(validateRegistration(input).p_telegram, 'fake_student');
  assert.throws(() => validateRegistration({ ...input, email: 'x@u.nus.edu.evil.com' }));
  assert.throws(() => validateRegistration({ ...input, studentId: '<script>' }));
  assert.equal(
    validateRegistration({ ...input, email: 'x@example.edu' }, 'example.edu').p_email,
    'x@example.edu',
  );
});
test('registration is persisted and public capacity contains aggregate numbers only', async () => {
  assert.equal((await request({ action: 'register', ...fake() })).status, 201);
  const capacity = await request({ action: 'capacity' });
  assert.deepEqual(capacity.data, { capacity: 150, remaining: 149, registered: 1 });
  assert.equal((await request({ action: 'register', ...fake() })).status, 409);
  assert.equal(
    (await request({ action: 'register', ...fake(2), studentId: fake().studentId })).data.error,
    'DUPLICATE',
  );
  assert.equal(
    (await request({ action: 'register', ...fake(2), email: 'x@elsewhere.edu' })).status,
    400,
  );
});
test('unauthorised reads/writes, CORS and oversized/malformed input fail closed', async () => {
  assert.equal((await request({ action: 'snapshot' })).status, 401);
  assert.equal((await request({ action: 'update', id: 'anything' }, 'f'.repeat(64))).status, 400);
  assert.equal((await request({ action: 'snapshot' }, 'f'.repeat(64))).status, 401);
  assert.equal((await request({ action: 'capacity' }, null, 'https://evil.test')).status, 403);
  assert.equal((await request({ action: 'register', fullName: 'x'.repeat(5000) })).status, 413);
  const invalid = await handler(new Request('https://example.test', { method: 'POST', body: '{' }));
  assert.equal(invalid.status, 400);
});
test('real bcrypt PIN, hashed random sessions, logout and expired sessions', async () => {
  assert.equal((await request({ action: 'login', pin: '000000' })).status, 401);
  const login = await request({ action: 'login', pin: '87463921' });
  assert.equal(login.status, 200);
  assert.match(login.data.token, /^[a-f0-9]{64}$/);
  const saved = (await db.query('select * from private.organiser_sessions')).rows[0];
  assert.equal(saved.token_hash, await sha256(login.data.token));
  assert.notEqual(saved.token_hash, login.data.token);
  assert.equal((await request({ action: 'snapshot' }, login.data.token)).status, 200);
  assert.equal((await request({ action: 'logout' }, login.data.token)).status, 200);
  assert.equal((await request({ action: 'snapshot' }, login.data.token)).status, 401);
  const second = await request({ action: 'login', pin: '87463921' });
  await db.exec("update private.organiser_sessions set expires_at=now()-interval '1 second'");
  assert.equal((await request({ action: 'snapshot' }, second.data.token)).status, 401);
  const id = (await db.query('select id from private.attendees limit 1')).rows[0].id;
  assert.equal(
    (await request({ action: 'update', id, value: true }, second.data.token)).status,
    401,
  );
});
test('check-in also records the cup, repeated saves are idempotent, and collection actions are rejected', async () => {
  const login = await request({ action: 'login', pin: '87463921' });
  assert.equal(login.status, 200);
  const token = login.data.token;
  const id = (await db.query('select id from private.attendees limit 1')).rows[0].id;
  for (let n = 0; n < 2; n++)
    assert.equal((await request({ action: 'update', id, value: true }, token)).status, 200);
  assert.equal((await request({ action: 'snapshot' }, token)).data.checkedIn, 1);
  assert.equal(
    (await request({ action: 'update', id, field: 'collected', value: true }, token)).status,
    400,
  );
  assert.equal((await request({ action: 'update', id, value: false }, token)).status, 200);
  assert.equal((await request({ action: 'snapshot' }, token)).data.checkedIn, 0);
});
test('wrong PIN requests hit persistent attempt limit', async () => {
  await db.exec('delete from private.login_limits');
  for (let n = 0; n < 5; n++)
    assert.equal((await request({ action: 'login', pin: '000000' })).status, 401);
  assert.equal((await request({ action: 'login', pin: '87463921' })).status, 429);
});
test('database failure never returns a reservation or a successful save', async () => {
  const broken = createHandler({
    env,
    comparePin: bcrypt.compare,
    rpc: async () => {
      throw Error('network failure');
    },
  });
  const response = await broken(
    new Request('https://example.test', {
      method: 'POST',
      body: JSON.stringify({ action: 'register', ...fake(9) }),
    }),
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json()).reserved, undefined);
});
test('RPC transport uses the modern private key without treating it as a JWT', async () => {
  let request;
  const rpc = createRpc(
    {
      SUPABASE_URL: 'https://example.test',
      SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'sb_secret_fake_test_key' }),
    },
    async (url, options) => {
      request = { url, ...options };
      return Response.json({ capacity: 150 });
    },
  );
  assert.equal((await rpc('event_capacity', {})).data.capacity, 150);
  assert.equal(request.headers.apikey, 'sb_secret_fake_test_key');
  assert.equal(request.headers.Authorization, undefined);
  assert.equal(request.url, 'https://example.test/rest/v1/rpc/event_capacity');
});
test('RPC transport supports legacy local keys and carries database errors safely', async () => {
  const rpc = createRpc(
    { SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'eyJ.fake_test_key' },
    async (_, options) => {
      assert.equal(options.headers.Authorization, 'Bearer eyJ.fake_test_key');
      return Response.json({ message: 'FULL' }, { status: 400 });
    },
  );
  assert.deepEqual(await rpc('event_register', {}), { data: null, error: { message: 'FULL' } });
});
test('RPC transport accepts the empty 204 response returned by logout', async () => {
  const rpc = createRpc(
    { SUPABASE_URL: 'https://example.test', SUPABASE_SECRET_KEY: 'sb_secret_fake_test_key' },
    async () => new Response(null, { status: 204 }),
  );
  assert.deepEqual(await rpc('organiser_logout', { p_hash: 'a'.repeat(64) }), {
    data: null,
    error: null,
  });
});
