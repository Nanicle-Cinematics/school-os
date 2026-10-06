"use server";

import sharp from "sharp";
import { bytesMatchType } from "@/lib/file-sniff";
import { MAX_CREST_PIXELS } from "@/lib/school-icon";
import { revalidatePath } from "next/cache";
import type { SchoolAssetKind } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { OFFICE } from "@/lib/permissions";
import { tenantTransaction } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { ACCEPTED_ASSET_TYPES as ACCEPTED, MAX_ASSET_BYTES as MAX_BYTES } from "@/lib/asset-constants";

export type AssetState = { error?: string; ok?: string };

const KINDS: SchoolAssetKind[] = ["CREST", "LOGO", "HEAD_SIGNATURE"];

/** Which School column points at each asset, so a render needs no extra query. */
const POINTER: Record<SchoolAssetKind, "crestUrl" | "logoUrl" | "headSignatureUrl"> = {
  CREST: "crestUrl",
  LOGO: "logoUrl",
  HEAD_SIGNATURE: "headSignatureUrl",
};

const LABEL: Record<SchoolAssetKind, string> = {
  CREST: "crest",
  LOGO: "logo",
  HEAD_SIGNATURE: "signature",
};

/**
 * A crest, a logo or the head's signature.
 *
 * SVG is deliberately not accepted. It is a document format that executes
 * script, and this file is served back to every parent who opens a report card;
 * a raster format cannot carry that.
 */
export async function uploadSchoolAsset(
  _prev: AssetState,
  formData: FormData,
): Promise<AssetState> {
  // OFFICE: uploading the crest is the technical half of a decision the
  // head has already made about what the crest IS.
  const auth = await requireRole(OFFICE);
  setTenantContext(auth.tenant);

  const kind = String(formData.get("kind") ?? "") as SchoolAssetKind;
  if (!KINDS.includes(kind)) {
    return { error: "Unknown image." };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Choose a file first." };
  }
  if (!ACCEPTED[file.type]) {
    return { error: `That is a ${file.type || "unknown"} file. Use a PNG, JPEG or WebP.` };
  }
  if (file.size > MAX_BYTES) {
    return {
      error: `That file is ${Math.round(file.size / 1024)} KB. Keep it under ${MAX_BYTES / 1024} KB — a crest does not need more.`,
    };
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (!bytesMatchType(bytes, file.type)) {
    return { error: `That file is not really a ${ACCEPTED[file.type]}. Choose the original image.` };
  }

  // A 500 KB PNG can declare tens of thousands of pixels each way, and the public
  // icon route decodes it on every cold request. Read the declared size (cheap, no
  // decode) and refuse anything a crest could never need.
  try {
    const { width = 0, height = 0 } = await sharp(bytes, { limitInputPixels: MAX_CREST_PIXELS }).metadata();
    if (width * height > MAX_CREST_PIXELS) {
      return { error: "That image is far larger than a crest needs. Resize it to a few hundred pixels across." };
    }
  } catch {
    return { error: "That image could not be read. Choose a different file." };
  }

  // The pointer carries the byte count as its cache key, so replacing the image
  // changes the URL and a parent never sees last term's crest from cache.
  const url = `/api/school-asset/${kind.toLowerCase()}?v=${Date.now().toString(36)}`;

  await tenantTransaction(auth.schoolId, async (tx) => {
    await tx.schoolAsset.upsert({
      where: { schoolId_kind: { schoolId: auth.schoolId, kind } },
      create: {
        schoolId: auth.schoolId,
        kind,
        mimeType: file.type,
        bytes,
        byteSize: bytes.byteLength,
        uploadedByUserId: auth.userId,
      },
      update: {
        mimeType: file.type,
        bytes,
        byteSize: bytes.byteLength,
        uploadedByUserId: auth.userId,
      },
    });
    await tx.school.update({
      where: { id: auth.schoolId },
      data: { [POINTER[kind]]: url },
    });
    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "school.asset.upload",
      entity: "SchoolAsset",
      entityId: kind,
      after: { kind, mimeType: file.type, byteSize: bytes.byteLength },
    });
  });

  revalidatePath("/settings/branding");
  revalidatePath("/results", "layout");
  revalidatePath("/invoices", "layout");
  return { ok: `${ACCEPTED[file.type]} ${LABEL[kind]} saved.` };
}

export async function removeSchoolAsset(formData: FormData): Promise<void> {
  // OFFICE: uploading the crest is the technical half of a decision the
  // head has already made about what the crest IS.
  const auth = await requireRole(OFFICE);
  setTenantContext(auth.tenant);

  const kind = String(formData.get("kind") ?? "") as SchoolAssetKind;
  if (!KINDS.includes(kind)) {
    return;
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    await tx.schoolAsset.deleteMany({ where: { schoolId: auth.schoolId, kind } });
    await tx.school.update({
      where: { id: auth.schoolId },
      data: { [POINTER[kind]]: null },
    });
    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "school.asset.remove",
      entity: "SchoolAsset",
      entityId: kind,
      before: { kind },
    });
  });

  revalidatePath("/settings/branding");
  revalidatePath("/results", "layout");
  revalidatePath("/invoices", "layout");
}
