// database transport: send requests and return results, while the handler decides the event rules.
// native fetch keeps the runtime small. supports current and legacy server keys.
// rpc means asking the database to run a named function; fetcher can be replaced in tests.
export function createRpc(env, fetcher = fetch) {
  return async (name, params) => {
    // choose a private server key from runtime settings; these values never go into the frontend.
    const keys = env.SUPABASE_SECRET_KEYS ? JSON.parse(env.SUPABASE_SECRET_KEYS) : {};
    const key = keys.default || env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key || !env.SUPABASE_URL) throw new Error('Missing server database configuration');
    // the handler supplies the function name and parameters; this layer sends them over https.
    const response = await fetcher(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        // secret api keys are not jwts. legacy service_role keys are jwts.
        ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(12000),
    });
    // postgresql void functions (logout) can return http 204 with no json body.
    const result = response.status === 204 ? null : await response.json();
    return response.ok ? { data: result, error: null } : { data: null, error: result };
  };
}
