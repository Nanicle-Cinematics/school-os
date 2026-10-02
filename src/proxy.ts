import { NextResponse, type NextRequest } from "next/server";

const isDev = process.env.NODE_ENV === "development";

/**
 * The Content-Security-Policy, with a fresh nonce per request.
 *
 * This replaces a static header that allowed `'unsafe-inline'` scripts, which
 * did nothing to stop an injected inline script from running. Now only a script
 * carrying this request's nonce runs — Next stamps it on its own framework and
 * RSC payload scripts when it finds `'nonce-…'` in the request's CSP header —
 * and `'strict-dynamic'` lets those load their own chunks.
 *
 * Costs, accepted: pages must render per request (every page here already
 * does — they read the session — and the root layout reads the nonce for the
 * theme script), and `style-src` keeps `'unsafe-inline'` because React's style
 * attributes cannot carry a nonce. Scripts are what turn an injection into an
 * account takeover; inline styles cannot run code.
 *
 * ⚠️ `'strict-dynamic'` makes browsers ignore `'self'` in script-src, and a
 * service worker's `worker-src` falls back to script-src — so without the
 * explicit `worker-src 'self'` the install-to-home-screen worker silently stops
 * registering.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");

  const csp = `
    default-src 'self';
    script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""};
    style-src 'self' 'unsafe-inline';
    img-src 'self' blob: data:;
    font-src 'self';
    connect-src 'self';
    worker-src 'self';
    manifest-src 'self';
    object-src 'none';
    base-uri 'self';
    form-action 'self';
    frame-ancestors 'none';
    upgrade-insecure-requests;
  `
    .replace(/\s{2,}/g, " ")
    .trim();

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Documents and API responses; not build assets or files under /public.
      source: "/((?!_next/static|_next/image|.*\\.(?:png|jpg|jpeg|webp|svg|ico|js|webmanifest|txt|xml)$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
