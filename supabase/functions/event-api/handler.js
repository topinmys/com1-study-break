// edge function request flow: validate the request, choose an action, call the database, return json.
// portable handler: deno serves it; node tests exercise the same request path.
// send a known error code and status without exposing internal database messages.
export class ApiError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
const encoder = new TextEncoder();
// hash session tokens before storing or looking them up; the database never needs the usable token.
export async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
// produce a stable rate-limit bucket without storing the client ip address.
async function ipHash(value, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
// repeat validation on the server because browser checks can be bypassed.
export function validateRegistration(input, domain = 'u.nus.edu') {
  for (const key of ['fullName', 'email', 'studentId', 'telegram']) {
    if (typeof input[key] !== 'string') throw new ApiError('VALIDATION');
  }
  // these p_ keys match the sql function's parameter names.
  const data = {
    p_name: input.fullName.trim(),
    p_email: input.email.trim().toLowerCase(),
    p_student_id: input.studentId.trim().toUpperCase(),
    p_telegram: input.telegram.trim().replace(/^@/, ''),
  };
  if (
    data.p_name.length < 2 ||
    data.p_name.length > 100 ||
    /[\x00-\x1f\x7f]/.test(data.p_name) ||
    data.p_email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.p_email) ||
    data.p_email.split('@')[1] !== domain.toLowerCase() ||
    !/^[A-Z0-9]{6,20}$/.test(data.p_student_id) ||
    !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(data.p_telegram)
  ) {
    throw new ApiError('VALIDATION');
  }
  return data;
}
// translate expected database failures into safe, predictable http responses.
const DB_ERRORS = {
  DUPLICATE: 409,
  FULL: 409,
  UNAUTHORISED: 401,
  NOT_FOUND: 404,
  INVALID_ACTION: 400,
};
// receive database access, pin comparison, and settings here so tests can supply isolated replacements.
export function createHandler({
  rpc,
  comparePin,
  env,
  randomToken = () => {
    return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
  },
}) {
  // cors controls browser origins; a valid organiser session is still required for private operations.
  const origins = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return async function handler(req) {
    const origin = req.headers.get('origin');
    const headers = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      Vary: 'Origin',
      'Access-Control-Allow-Headers': 'content-type, apikey, x-organiser-session',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };
    if (origin && origins.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
    const respond = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
    if (origin && !origins.includes(origin)) return respond({ error: 'ORIGIN_DENIED' }, 403);
    // browsers send a preflight request before cross-origin json requests.
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return respond({ error: 'METHOD_NOT_ALLOWED' }, 405);
    try {
      if (!env.ORGANISER_PIN_HASH || !env.RATE_LIMIT_SECRET || !origins.length)
        throw new ApiError('SERVER_CONFIGURATION', 503);
      // bound streamed bodies too, even if content-length is omitted or untrusted.
      // read at most four kilobytes, even when the sender omits the content-length header.
      const reader = req.body?.getReader();
      let size = 0;
      const parts = [];
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 4096) {
            await reader.cancel();
            throw new ApiError('BODY_TOO_LARGE', 413);
          }
          parts.push(value);
        }
      }
      // join bytes before decoding so a unicode character split across chunks stays intact.
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
      }
      let body;
      try {
        body = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new ApiError('INVALID_JSON');
      }
      if (!body || typeof body !== 'object' || Array.isArray(body))
        throw new ApiError('VALIDATION');
      // run one named database function and convert its error into an application error.
      const call = async (name, params = {}) => {
        const { data, error } = await rpc(name, params);
        if (error) {
          if (DB_ERRORS[error.message]) throw new ApiError(error.message, DB_ERRORS[error.message]);
          if (error.code === '23505') throw new ApiError('DUPLICATE', 409);
          if (['23514', '23502', '22P02'].includes(error.code)) throw new ApiError('VALIDATION');
          throw new ApiError('DATABASE_UNAVAILABLE', 503);
        }
        return data;
      };
      // public operations expose availability or create a reservation; neither returns the attendee list.
      if (body.action === 'capacity') return respond(await call('event_capacity'));
      if (body.action === 'register')
        return respond(
          await call(
            'event_register',
            validateRegistration(body, env.STUDENT_EMAIL_DOMAIN || 'u.nus.edu'),
          ),
          201,
        );
      // login consumes a shared database-backed attempt before checking the private pin hash.
      if (body.action === 'login') {
        if (typeof body.pin !== 'string' || !/^\d{6,12}$/.test(body.pin))
          throw new ApiError('INVALID_PIN', 401);
        // global limit also applies if an attacker spoofs/proxies their client ip.
        const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
        if (!(await call('login_allow', { p_bucket: await ipHash(ip, env.RATE_LIMIT_SECRET) })))
          throw new ApiError('RATE_LIMITED', 429);
        if (!(await comparePin(body.pin, env.ORGANISER_PIN_HASH)))
          throw new ApiError('INVALID_PIN', 401);
        const token = randomToken();
        const expiresAt = await call('organiser_session_create', { p_hash: await sha256(token) });
        return respond({ token, expiresAt });
      }
      if (!['snapshot', 'update', 'logout'].includes(body.action))
        throw new ApiError('INVALID_ACTION');
      // private operations send the session token in a header, then validate its hash and expiry in the database.
      const token = req.headers.get('x-organiser-session');
      if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new ApiError('UNAUTHORISED', 401);
      const p_hash = await sha256(token);
      // each database operation validates expiry before it reads or writes attendees.
      if (body.action === 'snapshot') return respond(await call('organiser_snapshot', { p_hash }));
      if (body.action === 'logout') {
        await call('organiser_logout', { p_hash });
        return respond({ loggedOut: true });
      }
      // check-in takes a target attendee and an explicit true or false value; the old separate collection action is rejected.
      if (
        typeof body.id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.id) ||
        'field' in body ||
        typeof body.value !== 'boolean'
      )
        throw new ApiError('VALIDATION');
      return respond(
        await call('organiser_update', { p_hash, p_id: body.id, p_value: body.value }),
      );
    } catch (error) {
      // never send internal database messages or attendee input to the browser/logs.
      return respond(
        { error: error instanceof ApiError ? error.code : 'SERVER_UNAVAILABLE' },
        error instanceof ApiError ? error.status : 503,
      );
    }
  };
}
