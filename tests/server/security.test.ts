import { describe, expect, it } from 'vitest';
import { createSecurityHandle, isAllowedOrigin, isLoopbackAuthority } from '../../src/hooks.server';

describe('loopback request boundary', () => {
  it.each(['localhost', 'localhost:4173', '127.0.0.1', '127.0.0.1:65535', '[::1]', '[::1]:4173'])(
    'accepts %s',
    (host) => expect(isLoopbackAuthority(host)).toBe(true)
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
    'localhost\\evil'
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
      get: (name: string) => (name === 'claude_speedometer_session' ? cookie : undefined),
      serialize: (name: string, value: string, options: Record<string, unknown>) => {
        const attributes = [
          `${name}=${value}`,
          options.path ? `Path=${options.path}` : '',
          options.httpOnly ? 'HttpOnly' : '',
          options.sameSite === 'strict' ? 'SameSite=Strict' : ''
        ].filter(Boolean);
        return attributes.join('; ');
      }
    }
  };
}

describe('production browser handshake', () => {
  it('redirects once, returns a strict cookie, and strips the bootstrap token', async () => {
    const gate = createSecurityHandle({
      production: true,
      bootstrapToken: 'one-time-bootstrap',
      statuslineSecret: 'statusline-secret',
      sessionToken: 'browser-session'
    });
    const resolve = async () => new Response('dashboard');

    const bootstrap = await gate({
      event: eventFor('http://127.0.0.1:4173/?view=week&token=one-time-bootstrap') as never,
      resolve
    });
    expect(bootstrap.status).toBe(303);
    expect(bootstrap.headers.get('location')).toBe('/?view=week');
    expect(bootstrap.headers.get('set-cookie')).toContain('claude_speedometer_session=browser-session');
    expect(bootstrap.headers.get('set-cookie')).toContain('HttpOnly');
    expect(bootstrap.headers.get('set-cookie')).toContain('SameSite=Strict');
    expect(bootstrap.headers.get('set-cookie')).not.toContain('one-time-bootstrap');

    const replay = await gate({
      event: eventFor('http://127.0.0.1:4173/?token=one-time-bootstrap') as never,
      resolve
    });
    expect(replay.status).toBe(401);

    const authenticated = await gate({
      event: eventFor('http://127.0.0.1:4173/', 'browser-session') as never,
      resolve
    });
    expect(authenticated.status).toBe(200);
    expect(authenticated.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('keeps health public but protects status-line ingestion with its separate secret', async () => {
    const gate = createSecurityHandle({
      production: true,
      bootstrapToken: 'bootstrap',
      statuslineSecret: 'statusline-secret',
      sessionToken: 'session'
    });
    const resolve = async () => new Response('ok');

    expect(
      (
        await gate({
          event: eventFor('http://127.0.0.1:4173/health') as never,
          resolve
        })
      ).status
    ).toBe(200);
    expect(
      (
        await gate({
          event: eventFor('http://127.0.0.1:4173/api/v1/statusline') as never,
          resolve
        })
      ).status
    ).toBe(401);
    expect(
      (
        await gate({
          event: eventFor('http://127.0.0.1:4173/api/v1/statusline', undefined, {
            authorization: 'Bearer statusline-secret'
          }) as never,
          resolve
        })
      ).status
    ).toBe(200);
  });
});
