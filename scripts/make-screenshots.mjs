/**
 * Capture the two screenshots the web app manifest advertises.
 *
 * Chrome and Edge show a richer install dialog — a preview beside the name —
 * when the manifest carries screenshots, and fall back to a one-line prompt
 * when it does not. That dialog is the moment someone decides whether this is a
 * product or a bookmark, so the shots are part of the manifest, not decoration.
 *
 * One `wide` (the dashboard, what a proprietor installs on a laptop) and one
 * `narrow` (the portal, what a parent installs on a phone). Chrome picks by
 * form factor, so both are needed to cover desktop and Android.
 *
 * ⚠️ These images are PUBLIC — served to anyone who sees the install prompt,
 * signed in or not. So this refuses to run against a database holding anything
 * but the demo school. Shooting a real school would publish its pupils' names,
 * their fees and their marks to every visitor, and nothing downstream would
 * catch it: the manifest does not know whose faces are in its screenshots.
 *
 *   npm run dev
 *   node scripts/make-screenshots.mjs
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9341;
const OUT = "public/screenshots";
const DEMO_SLUG = "hope-demo";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL });

// The refusal, before anything is captured.
const schools = await prisma.school.findMany({ select: { slug: true, name: true } });
const foreign = schools.filter((s) => s.slug !== DEMO_SLUG && !s.slug.startsWith("qa-"));
if (foreign.length > 0) {
  console.error(
    `Refusing to shoot: this database holds ${foreign.length} school(s) that are not the demo ` +
      `(${foreign.map((s) => s.slug).join(", ")}). These images go in the manifest and are public.`,
  );
  process.exit(1);
}
const demo = schools.find((s) => s.slug === DEMO_SLUG);
if (!demo) {
  console.error(`No ${DEMO_SLUG} school here — run \`npm run db:seed\`.`);
  process.exit(1);
}
console.log(`shooting ${demo.name} (${DEMO_SLUG})`);

const mint = async (where) => {
  const membership = await prisma.membership.findFirst({ where, select: { userId: true, schoolId: true } });
  if (!membership) return null;
  const token = randomBytes(32).toString("hex");
  const session = await prisma.session.create({
    data: {
      userId: membership.userId,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      activeSchoolId: membership.schoolId,
      expiresAt: new Date(Date.now() + 3600e3),
    },
    select: { id: true },
  });
  return { token, sessionId: session.id };
};

// ⚠️ Never a platform admin. Their header carries the "Nanicle console" button,
// which no customer will ever see — marketing.tsx already learnt this the hard
// way. A screenshot that advertises a vendor-only control to prospective
// schools is not a prettier screenshot, it is a wrong one. The demo school's
// only OWNER happens to be an admin, so this falls through to the head, who is
// the more representative dashboard user in any case.
const staff =
  (await mint({ role: "OWNER", school: { slug: DEMO_SLUG }, user: { isPlatformAdmin: false } })) ??
  (await mint({ role: "HEAD", school: { slug: DEMO_SLUG }, user: { isPlatformAdmin: false } }));
const parent = await mint({ role: "PARENT", school: { slug: DEMO_SLUG }, guardianId: { not: null } });
if (!staff || !parent) {
  console.error("need a non-admin leadership login and a PARENT login in the demo school");
  process.exit(1);
}

// Disconnect BEFORE the browser — connection_limit=1 means a client left open
// starves the dev server and every page shoots as Next's error screen.
await prisma.$disconnect();

const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, "--hide-scrollbars",
  "--disable-gpu", "--no-first-run", "--user-data-dir=/tmp/school-os-manifest-shot",
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 40; i++) {
  try {
    const listed = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = listed.find((t) => t.type === "page");
    if (target) break;
  } catch {}
  await sleep(300);
}
if (!target) { chrome.kill(); throw new Error("chrome did not start"); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  const resolve = pending.get(msg.id);
  if (resolve) { pending.delete(msg.id); resolve(msg.result); }
};
const send = (method, params = {}) =>
  new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });

await send("Page.enable");
await send("Network.enable");
// The profile is reused between runs, so the theme is always written rather
// than only when dark — otherwise one dark run silently tints every later one.
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `try { localStorage.setItem("theme", "light"); } catch (e) {}`,
});

mkdirSync(OUT, { recursive: true });

// deviceScaleFactor 1: the manifest's `sizes` must equal the real pixel size,
// and the dialog renders these small. 2x would quadruple the bytes every
// visitor downloads to be shown a thumbnail.
const shots = [
  { name: "wide-dashboard", path: "/dashboard", w: 1280, h: 800, mobile: false, session: staff },
  { name: "narrow-portal", path: "/portal", w: 390, h: 844, mobile: true, session: parent },
];

for (const shot of shots) {
  await send("Network.clearBrowserCookies");
  await send("Network.setCookie", {
    name: "school_os_session", value: shot.session.token, domain: "localhost", path: "/",
  });
  // setDeviceMetricsOverride, not a window size: headless clamps the window to
  // a 500px minimum, which would silently widen every handset shot.
  await send("Emulation.setDeviceMetricsOverride", {
    width: shot.w, height: shot.h, deviceScaleFactor: 1, mobile: shot.mobile,
  });
  await send("Page.navigate", { url: `http://localhost:3000${shot.path}` });
  await sleep(7000);
  const png = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}/${shot.name}.png`, Buffer.from(png.data, "base64"));
  console.log(`  ${shot.name}.png  ${shot.w}x${shot.h}  ${shot.path}`);
}

chrome.kill();
const cleanup = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL });
await cleanup.session.deleteMany({ where: { id: { in: [staff.sessionId, parent.sessionId] } } });
await cleanup.$disconnect();
console.log("sessions removed");
process.exit(0);
