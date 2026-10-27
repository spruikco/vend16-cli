// The Vend16 HTTP API, as the CLI uses it.
//
// SERVER CONTRACT (rolling out on vend16.com): device sign-in follows RFC 8628
// and the agent management API returns JSON. Every path the CLI calls is in
// ENDPOINTS below, and every response is read tolerantly (a list may come back
// as an array or under a key), so a renamed route is a one-line change here.

export const DEFAULT_API = 'https://vend16.com';

export const ENDPOINTS = {
  deviceCode: { method: 'POST', path: '/v1/device/code' },
  deviceToken: { method: 'POST', path: '/v1/device/token' },
  account: { method: 'GET', path: '/v1/me' },
  listApps: { method: 'GET', path: '/v1/apps' },
  createApp: { method: 'POST', path: '/v1/apps' },
  appKeys: { method: 'GET', path: '/v1/apps/:id/keys' },
  createSecretKey: { method: 'POST', path: '/v1/apps/:id/secret-key' },
  setup: { method: 'GET', path: '/v1/apps/:id/setup' },
};

export const EXIT = {
  OK: 0,
  ERROR: 1, // something went wrong, or doctor found problems
  USAGE: 2, // bad flags or command
  AUTH: 3, // not signed in, sign-in denied or expired
  NO_APP: 4, // no supported app found here, or no matching Vend16 app
  SERVER: 5, // Vend16 could not be reached or answered with an error
};

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The error code from either {error:{code,message}} (Vend16) or {error:"code"} (RFC 8628). */
function errorOf(body) {
  const e = body?.error;
  if (!e) return { code: undefined, message: undefined };
  if (typeof e === 'string') return { code: e, message: body.error_description ?? e };
  return { code: e.code, message: e.message };
}

export function createApi({ base = DEFAULT_API, token, fetchImpl = globalThis.fetch, userAgent = 'vend16-cli' } = {}) {
  async function call(name, { params = {}, body, auth = true } = {}) {
    const ep = ENDPOINTS[name];
    const path = ep.path.replace(/:(\w+)/g, (_, k) => encodeURIComponent(params[k]));
    const headers = { Accept: 'application/json', 'User-Agent': userAgent };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth) {
      if (!token) throw new ApiError(401, 'not_signed_in', 'Not signed in. Run: vend16 login');
      headers.Authorization = `Bearer ${token}`;
    }
    let res;
    try {
      res = await fetchImpl(base.replace(/\/+$/, '') + path, {
        method: ep.method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new ApiError(0, 'network', `Could not reach ${base} (${e?.cause?.code ?? e?.message ?? e})`);
    }
    const text = await res.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
    if (!res.ok) {
      const { code, message } = errorOf(json);
      // A 404 on a route with no app in it means this server does not have the
      // route at all (an older Vend16, before the agent API).
      if (res.status === 404 && (!code || (code === 'not_found' && !ep.path.includes(':')))) {
        const what = name.startsWith('device')
          ? `Signing in from the CLI is not switched on at ${base} yet. Sign up at ${base}/signup, create your app there, and put its public key (pk_...) in your app by hand`
          : `${ep.method} ${ep.path} is not available on ${base} yet`;
        throw new ApiError(404, 'not_available', what);
      }
      throw new ApiError(res.status, code ?? `http_${res.status}`, message ?? `Vend16 answered HTTP ${res.status}`);
    }
    return json;
  }

  const list = (v, ...keys) => {
    if (Array.isArray(v)) return v;
    for (const k of keys) if (Array.isArray(v?.[k])) return v[k];
    return [];
  };

  return {
    base,

    async startDeviceLogin(clientName) {
      const r = await call('deviceCode', { auth: false, body: { client_id: 'vend16-cli', client_name: clientName } });
      if (!r.device_code || !r.user_code) throw new ApiError(500, 'bad_response', 'Vend16 did not return a sign-in code');
      return {
        deviceCode: r.device_code,
        userCode: r.user_code,
        verificationUri: r.verification_uri ?? `${base}/activate`,
        verificationUriComplete: r.verification_uri_complete ?? null,
        interval: Math.max(1, Number(r.interval ?? 5)),
        expiresIn: Number(r.expires_in ?? 900),
      };
    },

    /**
     * One poll. Returns {token, email} once approved, or {pending:true}, or
     * {slowDown:true}. Throws ApiError with code access_denied or expired_token.
     */
    async pollDeviceLogin(deviceCode) {
      try {
        const r = await call('deviceToken', {
          auth: false,
          body: { device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: 'vend16-cli' },
        });
        const tok = r.access_token ?? r.token;
        if (!tok) throw new ApiError(500, 'bad_response', 'Vend16 did not return a token');
        return { token: tok, email: r.account?.email ?? r.email ?? null };
      } catch (e) {
        if (e.code === 'authorization_pending') return { pending: true };
        if (e.code === 'slow_down') return { slowDown: true };
        throw e;
      }
    },

    async account() {
      const r = await call('account');
      const a = r.account ?? r;
      return { id: a.id ?? null, email: a.email ?? null, plan: a.plan?.name ?? a.plan ?? null };
    },

    async listApps() {
      return list(await call('listApps'), 'apps', 'data').map(normaliseApp);
    },

    async createApp({ name, bundleId, packageName }) {
      const r = await call('createApp', { body: { name, bundle_id: bundleId || undefined, package_name: packageName || undefined } });
      return normaliseApp(r.app ?? r);
    },

    async publicKey(appId) {
      const r = await call('appKeys', { params: { id: appId } });
      return r.public_key ?? r.publicKey ?? r.keys?.public ?? null;
    },

    /** Makes a new secret key (the old one stops working). Never log the result. */
    async createSecretKey(appId) {
      // Both callers ask the person first ("any older secret key stops working"),
      // so a key that was already handed out is replaced rather than refused.
      const r = await call('createSecretKey', { params: { id: appId }, body: { replace_existing: true } });
      const k = r.secret_key ?? r.secretKey;
      if (!k || !k.startsWith('sk_')) throw new ApiError(500, 'bad_response', 'Vend16 did not return a secret key');
      return k;
    },

    async setup(appId) {
      const r = await call('setup', { params: { id: appId } });
      // vend16.com answers {ready, next, steps: [{id, title, status, next_step, values}]},
      // status 'done', 'todo' or 'not_needed' (an iOS-only app needs no Play steps).
      return list(r, 'steps', 'items', 'checklist')
        .filter((s) => s.status !== 'not_needed')
        .map((s) => ({
          id: s.id ?? s.key ?? null,
          label: s.title ?? s.label ?? s.name ?? String(s.id ?? ''),
          done: s.status !== undefined ? s.status === 'done' : !!(s.done ?? s.complete ?? s.ok),
          how: s.next_step ?? s.how ?? s.detail ?? s.description ?? null,
          url: s.url ?? s.link ?? null,
        }));
    },
  };
}

function normaliseApp(a) {
  return {
    id: a.id,
    name: a.name ?? a.id,
    bundleId: a.bundle_id ?? a.bundleId ?? null,
    packageName: a.package_name ?? a.packageName ?? null,
    publicKey: a.public_key ?? a.publicKey ?? null,
  };
}
