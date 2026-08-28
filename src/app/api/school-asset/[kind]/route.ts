import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import type { SchoolAssetKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { setTenantContext, withBypass } from "@/lib/tenant-context";

/**
 * Serve a school's crest, logo or the head's signature.
 *
 * The bytes live in `SchoolAsset` rather than on `School`, so this is the only
 * place they are read — a report card carries the pointer and nothing more.
 *
 * Deliberately NOT `requireAuth`: that resolves the whole user, their
 * memberships, the school row and the staff record, which is a heavy join to
 * repeat for a 2 KB image on a page that has already done it once. This needs
 * one thing — which school is this session in — so it asks for that and nothing
 * else. On a fast link the difference is milliseconds; on a slow one it is the
 * difference between an image and a wait.
 *
 * The tenant context is still set explicitly before the read: under RLS an
 * unscoped query returns nothing rather than failing, so a missing context here
 * would look exactly like "this school has no crest".
 */

const COOKIE_NAME = "school_os_session";

const KINDS: Record<string, SchoolAssetKind> = {
  crest: "CREST",
  logo: "LOGO",
  head_signature: "HEAD_SIGNATURE",
};

const NOT_FOUND = () => new Response("Not found", { status: 404 });

/** Which school this session is in — mirrors `requireAuth`, reading only ids. */
async function activeSchoolId(): Promise<string | null> {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!token) {
    return null;
  }

  // Sign-in happens before a tenant is known, so this read bypasses RLS.
  const session = await withBypass(() =>
    prisma.session.findUnique({
      where: { tokenHash: createHash("sha256").update(token).digest("hex") },
      select: {
        expiresAt: true,
        activeSchoolId: true,
        user: {
          select: {
            deletedAt: true,
            memberships: {
              where: { status: "ACTIVE" },
              select: { schoolId: true },
            },
          },
        },
      },
    }),
  );

  if (!session || session.expiresAt < new Date() || session.user.deletedAt) {
    return null;
  }

  const memberships = session.user.memberships;
  if (memberships.length === 0) {
    return null;
  }
  return (
    memberships.find((m) => m.schoolId === session.activeSchoolId)?.schoolId ?? memberships[0].schoolId
  );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ kind: string }> },
) {
  const { kind: slug } = await params;
  const kind = KINDS[slug];
  if (!kind) {
    return NOT_FOUND();
  }

  const schoolId = await activeSchoolId();
  if (!schoolId) {
    // 404 rather than a redirect: this is an <img> source, and a signed-out
    // browser should get a broken image, not a login page decoded as one.
    return NOT_FOUND();
  }

  setTenantContext({ schoolId });

  const asset = await prisma.schoolAsset.findFirst({
    where: { schoolId, kind },
    select: { bytes: true, mimeType: true, byteSize: true },
  });
  if (!asset) {
    return NOT_FOUND();
  }

  return new Response(new Uint8Array(asset.bytes), {
    headers: {
      "Content-Type": asset.mimeType,
      "Content-Length": String(asset.byteSize),
      // The URL carries a version, so a stored copy is never the wrong image;
      // private because it belongs to one school and is served through a session.
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
