import { AppError, type Env } from './env';
import { boundedJson } from './http';

export interface Owner {
  key: string;
  userId: string | null;
  guestId: string | null;
  cookie?: string;
}
const COOKIE = 'firstrole_guest';
const encoder = new TextEncoder();
let signingKeyCache: { secret: string; promise: Promise<CryptoKey> } | null = null;

function signingKey(secret: string): Promise<CryptoKey> {
  if (signingKeyCache?.secret === secret) return signingKeyCache.promise;
  // Keep only the current secret's nonextractable key, shared by concurrent
  // requests in this isolate. A rotated secret always imports a different key.
  const entry = {
    secret,
    promise: crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    ),
  };
  signingKeyCache = entry;
  void entry.promise.catch(() => {
    // A rejected import is retryable, but an old rejection must not evict a
    // newer secret that was installed while the first import was pending.
    if (signingKeyCache === entry) signingKeyCache = null;
  });
  return entry.promise;
}

async function signature(value: string, secret: string): Promise<string> {
  const key = await signingKey(secret);
  const signed = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
  return btoa(String.fromCharCode(...signed))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

export async function pseudonym(value: string, env: Env): Promise<string> {
  if (!env.GUEST_COOKIE_SECRET)
    throw new AppError('SETUP_REQUIRED', 'Search sessions are not configured.', 503);
  return signature(value, env.GUEST_COOKIE_SECRET);
}

function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export async function identify(request: Request, env: Env, requireAccount = false): Promise<Owner> {
  const auth = request.headers.get('authorization');
  if (auth) {
    if (!/^Bearer [A-Za-z0-9._-]+$/.test(auth) || auth.length > 6000)
      throw new AppError('INVALID_SESSION', 'Please sign in again.', 401);
    const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY!, authorization: auth },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new AppError('INVALID_SESSION', 'Your session has expired. Please sign in again.', 401);
    const user = await boundedJson<{ id?: string }>(response, 48 * 1024);
    if (!user.id || !/^[a-f0-9-]{36}$/i.test(user.id))
      throw new AppError('INVALID_SESSION', 'Please sign in again.', 401);
    return { key: `user:${user.id}`, userId: user.id, guestId: null };
  }
  if (requireAccount)
    throw new AppError('SIGN_IN_REQUIRED', 'Sign in to manage your account.', 401);
  if (!env.GUEST_COOKIE_SECRET)
    throw new AppError('SETUP_REQUIRED', 'Guest search is not configured yet.', 503);
  const cookie = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((x) => x.trim())
    .find((x) => x.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (cookie) {
    const [id, expires, sig] = cookie.split('.');
    if (
      /^[a-f0-9-]{36}$/i.test(id ?? '') &&
      /^\d{13}$/.test(expires ?? '') &&
      Number(expires) > Date.now() &&
      sig &&
      equal(sig, await signature(`${id}.${expires}`, env.GUEST_COOKIE_SECRET))
    ) {
      return { key: `guest:${id}`, userId: null, guestId: id };
    }
  }
  const id = crypto.randomUUID();
  const expires = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const payload = `${id}.${expires}`;
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return {
    key: `guest:${id}`,
    userId: null,
    guestId: id,
    cookie: `${COOKIE}=${payload}.${await signature(payload, env.GUEST_COOKIE_SECRET)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`,
  };
}

export function checkOrigin(request: Request, env: Env): void {
  const origin = request.headers.get('origin');
  const expected = env.APP_ORIGIN || new URL(request.url).origin;
  if (
    origin &&
    origin !== expected &&
    !(
      ['localhost', '127.0.0.1'].includes(new URL(request.url).hostname) &&
      /^http:\/\/(localhost|127\.0\.0\.1):5173$/.test(origin)
    )
  ) {
    throw new AppError('ORIGIN_REJECTED', 'This request did not come from FirstRole.', 403);
  }
  if (request.headers.get('sec-fetch-site') === 'cross-site')
    throw new AppError('ORIGIN_REJECTED', 'This request did not come from FirstRole.', 403);
}
