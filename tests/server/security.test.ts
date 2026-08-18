import { describe, expect, it } from 'vitest';
import { createSecurityHandle, isAllowedOrigin, isLoopbackAuthority } from '../../src/hooks.server';

describe('loopback request boundary', () => {
  it.each(['localhost', 'localhost:4173', '127.0.0.1', '127.0.0.1:65535', '[::1]', '[::1]:4173'])(
    'accepts %s',
    (host) => expect(isLoopbackAuthority(host)).toBe(true),
  );

  it.each([
    null,
    '',
    'example.com',
    'localhost.example.com',
    '127.0.0.2',
    '0.0.0.0',
    'localhost@evil.example',
    'localhost/evil',
    'localhost\\evil',
  ])('rejects %s', (host) => expect(isLoopbackAuthority(host)).toBe(false));

  it('allows absent or loopback origins and rejects non-loopback origins', () => {
    expect(isAllowedOrigin(null)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:4173')).toBe(true);
    expect(isAllowedOrigin('https://localhost:4173')).toBe(true);
    expect(isAllowedOrigin('https://example.com')).toBe(false);
    expect(isAllowedOrigin('null')).toBe(false);
    expect(isAllowedOrigin('http://localhost:4444', 'localhost:4173')).toBe(false);
    expect(isAllowedOrigin('http://localhost:4173', 'localhost:4173')).toBe(true);
  });
});

function eventFor(url: string, cookie?: string, headers: Record<string, string> = {}) {
  const request = new Request(url, { headers: { host: '127.0.0.1:4173', ...headers } });
  return {
    request,
    url: new URL(url),
    cookies: {
      get: (name: string) => (name === 'tokenenvy_session' ? cookie : undefined),
      serialize: (name: string, value: string, options: Record<string, unknown>) => {
        const attributes = [
          `${name}=${value}`,
          options.path ? `Path=${options.path}` : '',
          typeof options.maxAge === 'number' ? `Max-Age=${options.maxAge}` : '',
          options.httpOnly ? 'HttpOnly' : '',
          options.sameSite === 'strict' ? 'SameSite=Strict' : '',
          options.secure ? 'Secure' : '',
        ].filter(Boolean);
        return attributes.join('; ');
      },
    },
  };
}

const TWELVE_HOURS = 12 * 60 * 60;

describe('production browser handshake', () => {
  it('redirects with a strict cookie, strips the bootstrap token, and re-issues on replay', async () => {
    const gate = createSecurityHandle({
      production: true,
      bootstrapToken: 'one-time-bootstrap',
      statuslineSecret: 'statusline-secret',
      sessionToken: 'browser-session',
    });
    const resolve = async () => new Response('dashboard');

    const bootstrap = await gate({
      event: eventFor('http://127.0.0.1:4173/?view=week&token=one-time-bootstrap') as never,
      resolve,
    });
    expect(bootstrap.status).toBe(303);
    expect(bootstrap.headers.get('location')).toBe('/?view=week');
    expect(bootstrap.headers.get('set-cookie')).toContain('tokenenvy_session=browser-session');
    expect(bootstrap.headers.get('set-cookie')).toContain('HttpOnly');
    expect(bootstrap.headers.get('set-cookie')).toContain('SameSite=Strict');
    expect(bootstrap.headers.get('set-cookie')).toContain(`Max-Age=${TWELVE_HOURS}`);
    expect(bootstrap.headers.get('set-cookie')).not.toContain('Secure');
    expect(bootstrap.headers.get('set-cookie')).not.toContain('one-time-bootstrap');

    const replay = await gate({
      event: eventFor('http://127.0.0.1:4173/?token=one-time-bootstrap') as never,
      resolve,
    });
    expect(replay.status).toBe(303);
    expect(replay.headers.get('location')).toBe('/');
    expect(replay.headers.get('set-cookie')).toContain('tokenenvy_session=browser-session');
    expect(replay.headers.get('set-cookie')).toContain(`Max-Age=${TWELVE_HOURS}`);

    const authenticated = await gate({
      event: eventFor('http://127.0.0.1:4173/', 'browser-session') as never,
      resolve,
    });
    expect(authenticated.status).toBe(200);
    expect(authenticated.headers.get('x-content-type-options')).toBe('nosniff');
    expect(authenticated.headers.get('set-cookie')).toContain('tokenenvy_session=browser-session');
    // The sliding re-issue is the fix: without a fresh full-length Max-Age an active
    // dashboard still hard-expires, and Max-Age=0 would sign the browser out at once.
    expect(authenticated.headers.get('set-cookie')).toContain(`Max-Age=${TWELVE_HOURS}`);
    expect(authenticated.headers.get('set-cookie')).toContain('HttpOnly');
    expect(authenticated.headers.get('set-cookie')).toContain('SameSite=Strict');
  });

  it('marks the session cookie Secure only when the dashboard is served over https', async () => {
    const resolve = async () => new Response('dashboard');
    const gate = createSecurityHandle({
      production: true,
      bootstrapToken: 'bootstrap',
      sessionToken: 'browser-session',
    });

    const bootstrap = await gate({
      event: eventFor('https://localhost:4173/?token=bootstrap', undefined, {
        host: 'localhost:4173',
      }) as never,
      resolve,
    });
    expect(bootstrap.status).toBe(303);
    expect(bootstrap.headers.get('set-cookie')).toContain('Secure');

    const authenticated = await gate({
      event: eventFor('https://localhost:4173/', 'browser-session', {
        host: 'localhost:4173',
      }) as never,
      resolve,
    });
    expect(authenticated.headers.get('set-cookie')).toContain('Secure');
  });

  it('keeps health public, protects status-line ingestion, and only slides cookie sessions', async () => {
    const gate = createSecurityHandle({
      production: true,
      bootstrapToken: 'bootstrap',
      statuslineSecret: 'statusline-secret',
      sessionToken: 'session',
    });
    const resolve = async () => new Response('ok');

    expect(
      (
        await gate({
          event: eventFor('http://127.0.0.1:4173/health') as never,
          resolve,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await gate({
          event: eventFor('http://127.0.0.1:4173/api/v1/statusline') as never,
          resolve,
        })
      ).status,
    ).toBe(401);
    const statusline = await gate({
      event: eventFor('http://127.0.0.1:4173/api/v1/statusline', undefined, {
        authorization: 'Bearer statusline-secret',
      }) as never,
      resolve,
    });
    expect(statusline.status).toBe(200);
    expect(statusline.headers.get('set-cookie')).toBeNull();

    const rejected = await gate({
      event: eventFor('http://127.0.0.1:4173/?token=wrong-bootstrap') as never,
      resolve,
    });
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get('set-cookie')).toBeNull();
  });
});
