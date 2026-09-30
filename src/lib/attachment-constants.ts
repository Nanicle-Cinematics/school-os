/**
 * Shared between `readAttachment` and the client forms that upload a receipt
 * or bank slip, so the two never drift — `attachments.ts` carries `import
 * "server-only"`, which throws if a client component imports it, so these
 * cannot live there even though that is where they are enforced.
 */
export const ACCEPTED_ATTACHMENT_TYPES: Record<string, string> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
  "image/heic": "HEIC",
  "application/pdf": "PDF",
};

/**
 * 4 MB. A photo straight off a phone is 2–4 MB and a bursar will not resize it
 * — the crest's 512 KB ceiling is right for a crest chosen once and wrong for
 * paper photographed in a hurry.
 */
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
