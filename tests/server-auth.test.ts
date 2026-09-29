import { describe, expect, it } from 'vitest';
import { checkOrigin, identify } from '../server/auth';
import type { Env } from '../server/env';

const env = {
  GUEST_COOKIE_SECRET: 'test-only-guest-secret-at-least-32-bytes',
  APP_ORIGIN: 'https://firstrole.example.com',
} as Env;

describe('browser session boundaries', () => {
  it('issues an HttpOnly signed cookie and accepts only its original value', async () => {
    const first = await identify(new Request('https://firstrole.example.com/api/searches'), env);
    expect(first.cookie).toContain('HttpOnly; SameSite=Lax');
    expect(first.cookie).toContain('Secure');
    const cookie = first.cookie!.split(';')[0];
    const again = await identify(
      new Request('https://firstrole.example.com/api/searches', { headers: { cookie } }),
      env,
    );
    expect(again.key).toBe(first.key);
    const tampered = `${cookie.slice(0, -1)}${cookie.endsWith('a') ? 'b' : 'a'}`;
    const rejected = await identify(
      new Request('https://firstrole.example.com/api/searches', { headers: { cookie: tampered } }),
      env,
    );
    expect(rejected.key).not.toBe(first.key);
  });
  it('does not accept a browser-supplied guest identity header', async () => {
    const owner = await identify(
      new Request('https://firstrole.example.com/api/searches', {
        headers: { 'X-Guest-Id': 'someone-else' },
      }),
      env,
    );
    expect(owner.key).not.toContain('someone-else');
  });
  it('rejects foreign mutation origins', () =>
    expect(() =>
      checkOrigin(
        new Request('https://firstrole.example.com/api/searches', {
          headers: { origin: 'https://unrelated.example' },
        }),
        env,
      ),
    ).toThrow());
  it('supports both loopback Vite development URLs', () => {
    expect(() =>
      checkOrigin(
        new Request('http://127.0.0.1:8787/api/searches', {
          headers: { origin: 'http://127.0.0.1:5173' },
        }),
        env,
      ),
    ).not.toThrow();
    expect(() =>
      checkOrigin(
        new Request('http://localhost:8787/api/searches', {
          headers: { origin: 'http://localhost:5173' },
        }),
        env,
      ),
    ).not.toThrow();
  });
  it('requires a verified account for account deletion', async () =>
    expect(
      identify(new Request('https://firstrole.example.com/api/account/delete'), env, true),
    ).rejects.toMatchObject({ code: 'SIGN_IN_REQUIRED' }));
});
