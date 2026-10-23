import type { NextConfig } from "next";

// The Content-Security-Policy is built per request in src/proxy.ts, because its
// script-src carries a nonce. The remaining headers here are static.

const nextConfig: NextConfig = {
  /**
   * What Vercel packages into each function, trimmed.
   *
   * Next traces every file a route might load and ships all of it. For Prisma that meant ~57 MB of
   * `@prisma/client/runtime/*.wasm-base64.*` (the query engine and compiler compiled to WebAssembly, once per
   * database: CockroachDB, MySQL, SQL Server, SQLite, PostgreSQL, each as .js and .mjs), in every one of ~90
   * routes. This app uses PostgreSQL through the native library engine, which loads `runtime/library.js` and
   * the engine binary and nothing else. Checked 2026-10-23 two ways: real queries (a read, a count and an
   * interactive transaction) load only `default.js`, `index.js` and `runtime/library.js`, and a production
   * build with these files physically removed from node_modules served 24 database-backed pages without error.
   * Those files were about two thirds of every bundle, and every deployment stores a copy.
   *
   * `sharp` ships a WebAssembly fallback build (`@img/sharp-wasm32`, 9 MB) for platforms with no native
   * binary; Vercel's Linux has one.
   */
  outputFileTracingExcludes: {
    "/*": [
      "./node_modules/@prisma/client/runtime/*.wasm-base64.*",
      "./node_modules/@img/sharp-wasm32/**",
    ],
  },
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
