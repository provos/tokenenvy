import { dev } from '$app/environment';
import type { Handle } from '@sveltejs/kit';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_COOKIE = 'claude_speedometer_session';
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function equalSecret(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  const a = createHash('sha256').update(left).digest();
  const b = createHash('sha256').update(right).digest();
  return timingSafeEqual(a, b);
}

/** Parse an HTTP authority without ever consulting DNS. */
export function isLoopbackAuthority(authority: string | null): boolean {
  if (!authority || /[\s/@\\]/.test(authority)) return false;
  try {
    const parsed = new URL(`http://${authority}`);
    return LOOPBACK_NAMES.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function isAllowedOrigin(origin: string | null, authority?: string | null): boolean {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !isLoopbackAuthority(parsed.host)) return false;
    if (authority) {
      const expected = new URL(`http://${authority}`);
      return parsed.host.toLowerCase() === expected.host.toLowerCase();
    }
    return true;
  } catch {
    return false;
  }
}

function unauthorized(message = 'Open Claude Speedometer using the private URL printed by the CLI.'): Response {
  return new Response(message, {
    status: 401,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
  });
}

export interface SecurityHandleOptions {
  production?: boolean;
  bootstrapToken?: string;
  statuslineSecret?: string;
  sessionToken?: string;
}

/** Create an isolated access gate, including its one-time bootstrap state. */
export function createSecurityHandle(options: SecurityHandleOptions = {}): Handle {
  let bootstrapConsumed = false;
  const production = options.production ?? !dev;
  const sessionToken = options.sessionToken ?? randomBytes(32).toString('base64url');
  const bootstrapToken = options.bootstrapToken ?? process.env.CLAUDE_SPEEDOMETER_BOOTSTRAP_TOKEN;
  const statuslineSecret = options.statuslineSecret ?? process.env.CLAUDE_SPEEDOMETER_STATUSLINE_SECRET;

  return async ({ event, resolve }) => {
  const host = event.request.headers.get('host');
  if (!isLoopbackAuthority(host)) {
    return new Response('Claude Speedometer only accepts loopback requests.', { status: 403 });
  }

  const origin = event.request.headers.get('origin');
  if (!isAllowedOrigin(origin, host)) {
    return new Response('Origin is not allowed.', { status: 403 });
  }

  const path = event.url.pathname;
  const isHealth = path === '/api/v1/health' || path === '/health';
  const isStatusline = path === '/api/v1/statusline';

  if (production && !isHealth) {
    if (isStatusline) {
      const supplied = event.request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
      if (!equalSecret(supplied, statuslineSecret)) {
        return unauthorized('Invalid status-line credential.');
      }
    } else {
      const bootstrap = event.url.searchParams.get('token');

      if (!bootstrapConsumed && equalSecret(bootstrap, bootstrapToken)) {
        bootstrapConsumed = true;
        const sessionCookie = event.cookies.serialize(SESSION_COOKIE, sessionToken, {
          path: '/',
          httpOnly: true,
          sameSite: 'strict',
          secure: event.url.protocol === 'https:',
          maxAge: 12 * 60 * 60
        });

        const clean = new URL(event.url);
        clean.searchParams.delete('token');
        return new Response(null, {
          status: 303,
          headers: {
            location: `${clean.pathname}${clean.search}${clean.hash}`,
            'cache-control': 'no-store',
            'set-cookie': sessionCookie
          }
        });
      }

      if (!equalSecret(event.cookies.get(SESSION_COOKIE), sessionToken)) return unauthorized();
    }
  }

  const response = await resolve(event);
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set('x-frame-options', 'DENY');
  response.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  response.headers.set('cross-origin-opener-policy', 'same-origin');
  response.headers.set('cross-origin-resource-policy', 'same-origin');
  response.headers.set('x-robots-tag', 'noindex, nofollow, noarchive');
  return response;
  };
}

export const handle: Handle = createSecurityHandle();
