import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkOrigin, identify, pseudonym } from '../server/auth';
import type { Env } from '../server/env';

const env = {
  GUEST_COOKIE_SECRET: 'test-only-guest-secret-at-least-32-bytes',
  APP_ORIGIN: 'https://firstrole.example.com',
} as Env;

afterEach(() => vi.restoreAllMocks());

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

describe('private signing-key reuse', () => {
  it('shares one nonextractable import across concurrent signing while preserving HMAC output', async () => {
    const signingEnv = { ...env, GUEST_COOKIE_SECRET: 'test-only-concurrent-key-import-secret' };
    const importKey = vi.spyOn(crypto.subtle, 'importKey');
    const values = ['guest:first', 'guest:second', 'network:test'];
    const signatures = await Promise.all(values.map((value) => pseudonym(value, signingEnv)));
    expect(importKey).toHaveBeenCalledTimes(1);
    for (let index = 0; index < values.length; index++) {
      expect(signatures[index]).toBe(
        createHmac('sha256', signingEnv.GUEST_COOKIE_SECRET)
          .update(values[index])
          .digest('base64url'),
      );
    }
    expect(await pseudonym(values[0], signingEnv)).toBe(signatures[0]);
    expect(importKey).toHaveBeenCalledTimes(1);
    const key = await importKey.mock.results[0].value;
    expect(key.extractable).toBe(false);
    expect(key.usages).toEqual(['sign']);
  });

  it('imports a rotated secret and rejects cookies signed under the previous one', async () => {
    const firstEnv = { ...env, GUEST_COOKIE_SECRET: 'test-only-cookie-rotation-secret-one' };
    const nextEnv = { ...env, GUEST_COOKIE_SECRET: 'test-only-cookie-rotation-secret-two' };
    const importKey = vi.spyOn(crypto.subtle, 'importKey');
    const first = await identify(new Request('https://firstrole.example.com/api/config'), firstEnv);
    const cookie = first.cookie!.split(';')[0];
    const rotated = await identify(
      new Request('https://firstrole.example.com/api/config', {
        headers: { cookie },
      }),
      nextEnv,
    );
    expect(rotated.key).not.toBe(first.key);
    expect(rotated.cookie).toBeDefined();
    expect(await pseudonym('guest:rotation-check', nextEnv)).toBe(
      createHmac('sha256', nextEnv.GUEST_COOKIE_SECRET)
        .update('guest:rotation-check')
        .digest('base64url'),
    );
    expect(importKey).toHaveBeenCalledTimes(2);
    const acknowledged = await identify(
      new Request('https://firstrole.example.com/api/config', {
        headers: { cookie: rotated.cookie!.split(';')[0] },
      }),
      nextEnv,
    );
    expect(acknowledged.key).toBe(rotated.key);
    expect(acknowledged.cookie).toBeUndefined();
    expect(importKey).toHaveBeenCalledTimes(2);
  });

  it('does not permanently cache a rejected import', async () => {
    const signingEnv = { ...env, GUEST_COOKIE_SECRET: 'test-only-retry-key-import-secret' };
    const importKey = vi
      .spyOn(crypto.subtle, 'importKey')
      .mockRejectedValueOnce(new Error('Temporary test import failure'));
    await expect(pseudonym('guest:retry', signingEnv)).rejects.toThrow(
      'Temporary test import failure',
    );
    expect(await pseudonym('guest:retry', signingEnv)).toBe(
      createHmac('sha256', signingEnv.GUEST_COOKIE_SECRET)
        .update('guest:retry')
        .digest('base64url'),
    );
    expect(importKey).toHaveBeenCalledTimes(2);
  });

  it('does not evict the rotated key when an older pending import rejects', async () => {
    const previousEnv = { ...env, GUEST_COOKIE_SECRET: 'test-only-old-pending-import-secret' };
    const currentEnv = { ...env, GUEST_COOKIE_SECRET: 'test-only-new-pending-import-secret' };
    let rejectPrevious!: (reason: Error) => void;
    const pending = new Promise<CryptoKey>((_resolve, reject) => {
      rejectPrevious = reject;
    });
    const importKey = vi.spyOn(crypto.subtle, 'importKey').mockImplementationOnce(() => pending);
    const previous = pseudonym('guest:old', previousEnv).catch(() => 'rejected');
    const current = await pseudonym('guest:new', currentEnv);
    rejectPrevious(new Error('Old test import failed'));
    expect(await previous).toBe('rejected');
    expect(await pseudonym('guest:new', currentEnv)).toBe(current);
    expect(current).toBe(
      createHmac('sha256', currentEnv.GUEST_COOKIE_SECRET).update('guest:new').digest('base64url'),
    );
    expect(importKey).toHaveBeenCalledTimes(2);
  });

  it('still requires the configured secret even after a key is warm', async () => {
    const signingEnv = { ...env, GUEST_COOKIE_SECRET: 'test-only-required-secret-after-cache' };
    await pseudonym('guest:configured', signingEnv);
    await expect(
      pseudonym('guest:missing-secret', { ...signingEnv, GUEST_COOKIE_SECRET: undefined }),
    ).rejects.toMatchObject({ code: 'SETUP_REQUIRED' });
  });
});
