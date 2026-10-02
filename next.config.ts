import type { NextConfig } from "next";

// The Content-Security-Policy is built per request in src/proxy.ts, because its
// script-src carries a nonce. The remaining headers here are static.

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
