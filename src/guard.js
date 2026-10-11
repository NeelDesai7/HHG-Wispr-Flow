// Privacy rules for the HTTP server. The promise is "only this computer can talk to it",
// so every request passes these checks before any route runs.

export const HOST = '127.0.0.1';
export const PORT = Number(process.env.PORT) || 5181;

const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function isLoopbackAddress(addr) {
  return LOOPBACK_ADDRS.has(addr);
}

// DNS-rebinding defence: a hostile site that points its own domain at 127.0.0.1
// still sends its own domain in the Host header.
export function isAllowedHost(host, port = PORT) {
  const m = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+):(\d+)$/i.exec(host || '');
  return !!m && LOCAL_NAMES.has(m[1].toLowerCase()) && Number(m[2]) === port;
}

// Stops other websites open in your browser from reading or writing the hub.
// Requests with no Origin/Sec-Fetch-Site come from local tools like curl, which is fine.
export function isSameOrigin(headers) {
  const site = headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = headers.origin;
  return !origin || origin === `http://${headers.host}`;
}

// Returns a refusal reason, or null if the request may proceed.
export function checkRequest(req, isApi) {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return 'not from this computer';
  if (!isAllowedHost(req.headers.host)) return 'unknown host';
  const writes = req.method !== 'GET' && req.method !== 'HEAD';
  if ((isApi || writes) && !isSameOrigin(req.headers)) return 'cross-origin request refused';
  return null;
}

export const SECURITY_HEADERS = {
  // The page may only talk to this server; the browser blocks every other destination.
  'Content-Security-Policy': [
    "default-src 'self'",
    "connect-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
