import "server-only";

import type { TenantTx } from "@/lib/prisma";
import { bytesMatchType } from "@/lib/file-sniff";
import {
  ACCEPTED_ATTACHMENT_TYPES as ACCEPTED_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
} from "@/lib/attachment-constants";

/**
 * A photographed bank slip or expense receipt, attached to the voucher it
 * belongs to.
 *
 * PDF is accepted alongside images because a bank emails a statement as one and
 * a bursar should not have to screenshot it. SVG is refused for the same reason
 * the crest refuses it: it is a document format that executes script, and these
 * files are served back to staff browsers.
 */

export type AttachmentRead =
  | { ok: true; bytes: Uint8Array<ArrayBuffer>; mimeType: string; byteSize: number }
  | { ok: false; error: string };

/** Validate and read an uploaded file. Returns the reason when it refuses. */
export async function readAttachment(value: FormDataEntryValue | null): Promise<AttachmentRead> {
  if (!(value instanceof File) || value.size === 0) {
    return { ok: false, error: "No file" };
  }
  if (!ACCEPTED_ATTACHMENTS[value.type]) {
    return {
      ok: false,
      error: `That is a ${value.type || "unknown"} file. Attach a photo (PNG, JPEG, HEIC) or a PDF.`,
    };
  }
  if (value.size > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      error: `That file is ${Math.round(value.size / 1024 / 1024)} MB. Keep it under ${
        MAX_ATTACHMENT_BYTES / 1024 / 1024
      } MB.`,
    };
  }
  // Uint8Array<ArrayBuffer>, not Buffer and not a bare Uint8Array: Prisma's
  // Bytes field is typed to the narrow form, and both the Buffer and the
  // ArrayBufferLike variants fail to assign to it.
  const bytes = new Uint8Array(await value.arrayBuffer()) as Uint8Array<ArrayBuffer>;
  if (!bytesMatchType(bytes, value.type)) {
    return { ok: false, error: "That file is not really a " + ACCEPTED_ATTACHMENTS[value.type] + ". Attach the original photo or PDF." };
  }
  return { ok: true, bytes, mimeType: value.type, byteSize: bytes.byteLength };
}

/** Where the stored file is served from. The column holds this, not the bytes. */
export function attachmentUrl(id: string) {
  return `/api/attachment/${id}`;
}

/**
 * Store one, inside the caller's transaction.
 *
 * Takes the tx rather than opening its own so the file and the voucher it
 * belongs to commit together — a receipt row pointing at an attachment that
 * rolled back would render as a broken link on a printed cash book.
 */
export async function storeAttachment(
  tx: TenantTx,
  schoolId: string,
  uploadedByUserId: string | null,
  read: Extract<AttachmentRead, { ok: true }>,
): Promise<string> {
  const row = await tx.fileAttachment.create({
    data: {
      schoolId,
      mimeType: read.mimeType,
      bytes: read.bytes,
      byteSize: read.byteSize,
      uploadedByUserId,
    },
    select: { id: true },
  });
  return attachmentUrl(row.id);
}
