import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

/**
 * The no-nonce baseline from Next's own CSP guide, not the nonce/proxy
 * version — this app streams RSC payloads as inline scripts on nearly every
 * page (`self.__next_f.push(...)`), whose content differs per request, so a
 * hash-based script-src can never allow-list them, and a nonce-based CSP
 * would force every page — including the marketing site meant to stay fast
 * and cacheable — into dynamic rendering just to thread the nonce through
 * the root layout. 'unsafe-inline' on script/style is the accepted
 * trade-off Next documents for exactly this shape of app: it doesn't stop
 * an inline script from running if one is ever injected, but everything
 * else here still holds — no loading a script or frame from another
 * origin, no embedding this site in someone else's page, no MIME-sniffing.
 */
const cspHeader = `
  default-src 'self';
  script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""};
  style-src 'self' 'unsafe-inline';
  img-src 'self' blob: data:;
  font-src 'self';
  connect-src 'self';
  object-src 'none';
  base-uri 'self';
  form-action 'self';
  frame-ancestors 'none';
  upgrade-insecure-requests;
`;

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Default is 1MB, and it is ONE global cap shared by every Server
      // Action in the app — not just the crest upload. A phone photo clears
      // 1MB routinely, so this was already silently breaking expense-receipt
      // and payment-slip attachments (readAttachment in attachments.ts,
      // MAX_ATTACHMENT_BYTES = 4MB) for anything between 1MB and 4MB: the
      // framework's own body limit rejects the request before the action's
      // code — and its friendly "keep it under 4 MB" message — ever runs.
      // 4.25mb gives that 4MB ceiling room for multipart overhead while
      // staying under Vercel's own ~4.5MB hard request-body cap, which this
      // setting cannot raise.
      bodySizeLimit: "4.25mb",
    },
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: cspHeader.replace(/\s{2,}/g, " ").trim() },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
