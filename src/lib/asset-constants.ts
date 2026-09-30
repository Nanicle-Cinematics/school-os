/**
 * Shared between `uploadSchoolAsset` and its client form, so the two never
 * drift — a "use server" file may only export async functions, so these
 * cannot live in asset-actions.ts itself even though that is where they are
 * enforced.
 *
 * The client form uses `MAX_ASSET_BYTES` to reject an oversized file BEFORE
 * submitting: Server Actions cap the request body at 1MB by default
 * (`experimental.serverActions.bodySizeLimit` in next.config.ts, raised here
 * to give this check room to run), and a file that trips THAT limit never
 * reaches `uploadSchoolAsset` at all — the person gets a raw platform
 * failure instead of the friendly message below, which on an installed iOS
 * PWA renders as WebKit's own "This page couldn't load" screen. A photo
 * straight off a phone camera clears 1MB routinely, so this is not a
 * hypothetical edge case.
 */
export const ACCEPTED_ASSET_TYPES: Record<string, string> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
};

/** Enough for a crest at print resolution, small enough to sit in a row. */
export const MAX_ASSET_BYTES = 512 * 1024;
