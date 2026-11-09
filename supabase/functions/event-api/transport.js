// Native fetch keeps the runtime small. Supports current and legacy server keys.
export function createRpc(env, fetcher = fetch) {
  return async (name, params) => {
    const keys = env.SUPABASE_SECRET_KEYS ? JSON.parse(env.SUPABASE_SECRET_KEYS) : {};
    const key = keys.default || env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key || !env.SUPABASE_URL) throw new Error('Missing server database configuration');
    const response = await fetcher(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', apikey: key,
        // Secret API keys are not JWTs. Legacy service_role keys are JWTs.
        ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(params), signal: AbortSignal.timeout(12000),
    });
    const result = await response.json();
    return response.ok ? { data: result, error: null } : { data: null, error: result };
  };
}
