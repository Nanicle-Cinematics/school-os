/**
 * The public school-icon and manifest routes, through the running app: what they serve, what they
 * refuse cheaply, and that a flood does not take the site down with it.
 *
 * verify:public-routes proves the budget and the shape of the code. This proves the routes behave:
 * a real crest becomes four correctly sized icons, a malformed or unknown id is refused and the
 * refusal is cacheable, the manifest points at them, and a burst of cache-busting requests (the
 * thing the CDN cannot absorb, because it caches by the full url) is answered with icons or with a
 * 503, never a 500, while an ordinary page is still served afterwards.
 *
 * Fixtures: a crest for the demo school, only if it has none, removed at the end. A crest that is
 * already there is used as it is and never touched.
 *
 * Honest limit: on a machine fast enough to finish every request before the next arrives, the flood
 * sees no 503, and what it still proves is that nothing returns a 500. On the development link,
 * where a database round trip takes seconds, it saturates the budget every time.
 *
 *   npm run dev
 *   npm run verify:school-icon
 */
import sharp from "sharp";
import { homeScreenLabel } from "@/lib/home-screen-label";
import { demoSchool, withOwner } from "./fixture.mjs";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const FLOOD = 120;
const MISS = /public/;

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) passed += 1;
  else failed += 1;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A GET with no cookie, as an OS or a browser's manifest fetch makes it. */
async function get(path: string, tries = 1) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const r = await fetch(BASE + path, { redirect: "manual", signal: AbortSignal.timeout(120_000) });
      const body = Buffer.from(await r.arrayBuffer());
      if (r.status === 500 && attempt + 1 < tries) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      return { status: r.status, headers: r.headers, body };
    } catch {
      if (attempt + 1 >= tries) return { status: 0, headers: new Headers(), body: Buffer.alloc(0) };
      await sleep(500 * (attempt + 1));
    }
  }
  return { status: 0, headers: new Headers(), body: Buffer.alloc(0) };
}
const isPng = (b: Buffer) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

async function main() {
  if (!(await fetch(BASE, { redirect: "manual" }).catch(() => null))) {
    console.log(`Nothing answers at ${BASE} — start the app first (npm run dev).`);
    process.exitCode = 1;
    return;
  }

  const school = await demoSchool();
  let madeAsset = false;
  let setPointer = false;

  try {
    await withOwner(async (db) => {
      const has = await db.schoolAsset.findUnique({ where: { schoolId_kind: { schoolId: school.id, kind: "CREST" } }, select: { id: true } });
      if (!has) {
        // Wider than tall on purpose: a crest is not promised to be square.
        const png = await sharp({ create: { width: 300, height: 200, channels: 4, background: { r: 18, g: 128, b: 92, alpha: 1 } } }).png().toBuffer();
        await db.schoolAsset.create({ data: { schoolId: school.id, kind: "CREST", mimeType: "image/png", bytes: png, byteSize: png.byteLength } });
        madeAsset = true;
      }
      const row = await db.school.findUnique({ where: { id: school.id }, select: { crestUrl: true } });
      if (!row?.crestUrl) {
        await db.school.update({ where: { id: school.id }, data: { crestUrl: "/api/school-asset/crest?v=probe" } });
        setPointer = true;
      }
    });

    console.log("\nA real crest becomes four icons");
    const sizes: Record<string, number> = { "192": 192, "512": 512, "maskable-512": 512, "apple-touch": 180 };
    for (const [variant, size] of Object.entries(sizes)) {
      const r = await get(`/api/school-icon/${school.id}/${variant}?v=1`, 6);
      const meta = isPng(r.body) ? await sharp(r.body).metadata() : null;
      check(`${variant}: a ${size}px PNG`, r.status === 200 && meta?.width === size && meta?.height === size, `HTTP ${r.status} ${meta?.width}x${meta?.height}`);
      check(`${variant}: cached for a year, immutable`, /max-age=31536000/.test(r.headers.get("cache-control") ?? "") && /immutable/.test(r.headers.get("cache-control") ?? ""));
    }

    console.log("\nWhat is refused, and cheaply");
    const refusals: [string, string][] = [
      ["an id that is not a school", "/api/school-icon/cm0000000000000000000000x/192"],
      ["an unknown variant", `/api/school-icon/${school.id}/999`],
      ["a path where the id goes", "/api/school-icon/..%2F..%2Fetc/192"],
      ["spaces in the id", "/api/school-icon/not%20an%20id%20at%20all/192"],
      ["a very long id", `/api/school-icon/${"a".repeat(300)}/192`],
      ["a null byte in the id", "/api/school-icon/cmv6rypbh0001ta02wm0rzxg%00/192"],
    ];
    for (const [label, path] of refusals) {
      const r = await get(path, 3);
      check(`${label}: 404`, r.status === 404, `HTTP ${r.status}`);
      check(`${label}: the refusal is cacheable, so repeats never reach the server`, MISS.test(r.headers.get("cache-control") ?? "") && /max-age=300/.test(r.headers.get("cache-control") ?? ""), r.headers.get("cache-control") ?? "(none)");
    }

    console.log("\nThe manifest");
    const man = await get(`/api/manifest?school=${school.id}&v=1`, 6);
    let json: { icons?: { src: string }[]; short_name?: string; name?: string } = {};
    try { json = JSON.parse(man.body.toString("utf8")); } catch { /* reported below */ }
    check("a school with a crest gets its own manifest", man.status === 200 && Array.isArray(json.icons), `HTTP ${man.status}`);
    check("whose short_name, the label under the icon, is the school's own (name stays the product's)", json.short_name === homeScreenLabel(school) && json.name === "School OS", `${json.short_name} / ${json.name}`);
    check("whose icons point at that school's icon route", (json.icons ?? []).length === 3 && (json.icons ?? []).every((i) => i.src.startsWith(`/api/school-icon/${school.id}/`)));
    for (const [label, path] of [
      ["no school at all", "/api/manifest"],
      ["a malformed school", "/api/manifest?school=..%2F..%2Fetc"],
      ["a school id that does not exist", "/api/manifest?school=cm0000000000000000000000x"],
    ] as const) {
      const r = await get(path, 3);
      check(`${label}: sent to the static manifest`, r.status === 307 && (r.headers.get("location") ?? "").endsWith("/manifest.webmanifest"), `HTTP ${r.status}`);
      check(`${label}: and that answer is cacheable`, /max-age=300/.test(r.headers.get("cache-control") ?? ""), r.headers.get("cache-control") ?? "(none)");
    }

    console.log(`\nA flood of ${FLOOD} cache-busting requests`);
    // A random ?v= is a url the CDN has never seen, so every one of these is a cold request that
    // reads the blob and renders it. Fired together, as an attacker would.
    const stamp = Date.now();
    const started = Date.now();
    const replies = await Promise.all(
      Array.from({ length: FLOOD }, (_, i) => get(`/api/school-icon/${school.id}/512?v=${stamp}-${i}`)),
    );
    const took = Math.round((Date.now() - started) / 1000);
    const by = (s: number) => replies.filter((r) => r.status === s).length;
    const served = replies.filter((r) => r.status === 200);
    const turned = replies.filter((r) => r.status === 503);
    const other = replies.filter((r) => r.status !== 200 && r.status !== 503);
    check("every request was answered, and none with a server error", other.length === 0, `200:${by(200)} 503:${by(503)} other:${other.map((r) => r.status).join(",") || "none"} in ${took}s`);
    check("every icon that was served is a real PNG", served.every((r) => isPng(r.body)));
    check("every refusal says to retry and is never cached", turned.every((r) => r.headers.get("retry-after") === "5" && r.headers.get("cache-control") === "no-store"));
    console.log(`        (${turned.length} of ${FLOOD} were turned away with a 503; ${served.length} were served)`);
    const page = await get("/login", 6);
    check("an ordinary page is still served straight afterwards", page.status === 200, `HTTP ${page.status}`);
  } finally {
    await withOwner(async (db) => {
      if (madeAsset) await db.schoolAsset.deleteMany({ where: { schoolId: school.id, kind: "CREST" } });
      if (setPointer) await db.school.update({ where: { id: school.id }, data: { crestUrl: null } });
      const asset = await db.schoolAsset.count({ where: { schoolId: school.id, kind: "CREST" } });
      const row = await db.school.findUnique({ where: { id: school.id }, select: { crestUrl: true } });
      check("fixtures removed", (!madeAsset || asset === 0) && (!setPointer || row?.crestUrl === null), `asset rows ${asset}, crestUrl ${row?.crestUrl ?? "null"}`);
    });
    // Here, not after the try: an early return or a throw above must not skip the verdict.
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  }
}

await main();
