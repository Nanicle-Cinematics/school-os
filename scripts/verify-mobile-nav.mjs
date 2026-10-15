/**
 * The phone menu opens, and covers the screen.
 *
 * This exists because it did neither, silently, in production. The drawer is
 * `fixed inset-0`, and it was rendered inside the app header — which is
 * `backdrop-blur-xl`, because --color-chrome is only 80% opaque. An element
 * with a backdrop-filter becomes the containing block for its `position: fixed`
 * DESCENDANTS, exactly as filter and transform do, so `inset-0` resolved to the
 * 64px header strip instead of the viewport.
 *
 * Nothing threw. The button worked, React set the state, all twenty links were
 * in the DOM — laid out 276px wide and 63px tall, behind the page. On a phone
 * the menu button simply did nothing, and every automated check in this repo
 * passed, because they all ask the DOM what exists rather than the layout what
 * is on screen. Hence a check that measures, and hit-tests.
 *
 *   npm run dev   (or a built server on VERIFY_BASE_URL)
 *   npm run verify:mobile-nav
 */
import { createHash, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { sleep, startBrowser } from "./chrome-cdp.mjs";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const WIDTH = 390;
const HEIGHT = 844;

let passed = 0;
const failures = [];
const ok = (label, detail = "") => { passed++; console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`); };
const bad = (label, detail) => { failures.push(label); console.log(`  FAIL ${label} — ${detail}`); };

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL });
const membership = await prisma.membership.findFirst({ where: { role: "OWNER" }, select: { userId: true, schoolId: true } });
if (!membership) { console.error("no OWNER to borrow — run `npm run db:seed`"); process.exit(1); }
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
// Before the browser — connection_limit=1 means a client left open starves the
// server under test and every page renders as its error screen.
await prisma.$disconnect();


/** The login borrowed above, removed on EVERY way out, not just the happy one. */
async function dropSession() {
  const cleanup = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL });
  try {
    await cleanup.session.deleteMany({ where: { id: session.id } });
  } finally {
    await cleanup.$disconnect();
  }
}

// The browser and its protocol client are the shared launcher's (scripts/chrome-cdp.mjs), with a deadline on
// every call. A missing or wedged Chrome is reported there; the borrowed login is dropped here either way.
let browser;
try {
  browser = await startBrowser();
} catch (error) {
  await dropSession();
  throw error;
}
const { send, ev, close } = browser;

/** Read JSON out of the page, or stop and SAY the page did not answer (a call that times out gives nothing back). */
async function json(expression, what) {
  const raw = await ev(expression);
  if (typeof raw !== "string") {
    console.log(`  FAIL ${what} — the page did not answer within the deadline`);
    close();
    await dropSession();
    process.exit(1);
  }
  return JSON.parse(raw);
}

const host = new URL(BASE).hostname;
await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
await send("Network.setCookie", { name: "school_os_session", value: token, domain: host, path: "/" });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `try{localStorage.setItem("theme","light")}catch(e){}` });
/**
 * setDeviceMetricsOverride rather than a window size: headless clamps a real
 * window to a 500px minimum, which would quietly test a tablet. Applied after a
 * first load and then reloaded, so the document lays out at handset width from
 * the start rather than being resized mid-life.
 */
await send("Page.navigate", { url: `${BASE}/dashboard` });
await sleep(6000);
await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: true });
await send("Page.navigate", { url: `${BASE}/dashboard` });
await sleep(8000);

// Report the viewport the page actually got, not the one requested: headless
// does not always honour the override exactly, and a run that quietly widened
// to desktop would pass by testing nothing — the drawer only exists below `lg`.
const seen = await json(
  `JSON.stringify({w:innerWidth,h:innerHeight,client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth})`,
  "reading the viewport",
);
console.log(`\nPhone menu at ${seen.w}x${seen.h}`);
if (seen.w >= 1024) {
  console.log(`  FAIL viewport is below the lg breakpoint — got ${seen.w}px, the rail is not collapsed there`);
  close();
  await dropSession();
  process.exit(1);
}

/**
 * ⚠️ The page must not scroll SIDEWAYS, and this check is here because the
 * viewport reading above is how the overflow was found.
 *
 * The run reported a 453px viewport while asking for 390. That was not the
 * harness: the dashboard was 436px wide inside a 390px phone, and Chrome's
 * mobile emulation zooms out to fit what does not fit. A real iPhone does not
 * zoom — it just lets the page slide under the thumb, which is how a fixed-slot
 * chart in a grid item that cannot shrink presents to a head teacher.
 *
 * So the width is asserted, not printed. A page that overflows is a failure
 * even when every button on it works.
 */
if (seen.scroll > seen.client + 1) {
  bad("the page does not scroll sideways",
    `content is ${seen.scroll}px wide in a ${seen.client}px viewport — something refuses to shrink ` +
    `(a grid or flex item needs min-w-0, or a fixed-width row needs its own overflow-x-auto)`);
} else {
  ok("the page does not scroll sideways", `${seen.scroll}px in ${seen.client}px`);
}

const hasButton = await ev(`String(!!document.querySelector('[aria-label="Open menu"]'))`);
if (hasButton === "true") ok("the menu button is on the page");
else bad("the menu button is on the page", "no [aria-label='Open menu'] at handset width");

if (hasButton === "true") {
  await ev(`document.querySelector('[aria-label="Open menu"]').click()`);
  await sleep(1200);

  const open = await ev(`String(!!document.querySelector('[aria-label="Close menu"]'))`);
  if (open === "true") ok("tapping it opens the drawer");
  else bad("tapping it opens the drawer", "no close button after click");

  if (open === "true") {
    const box = await json(
      `(()=>{const c=document.querySelector('[aria-label="Close menu"]');const p=c.nextElementSibling;const r=p.getBoundingClientRect();` +
      `return JSON.stringify({w:Math.round(r.width),h:Math.round(r.height),y:Math.round(r.y),vh:innerHeight})})()`,
      "measuring the drawer",
    );
    // THE regression. It was 63 tall against an 844 viewport.
    if (box.h >= box.vh * 0.9) ok("the drawer fills the screen", `${box.w}x${box.h} of ${box.vh}`);
    else bad("the drawer fills the screen",
      `panel is ${box.w}x${box.h} in a ${box.vh}-tall viewport — a fixed ancestor with ` +
      `filter/backdrop-filter/transform is capturing it`);

    const reach = await ev(
      `(()=>{const c=document.querySelector('[aria-label="Close menu"]');` +
      `const a=[...c.parentElement.querySelectorAll('a')];if(!a.length)return 'no links';` +
      `const first=a[0];const r=first.getBoundingClientRect();` +
      `const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);` +
      `return (first===hit||first.contains(hit))?('reachable: '+first.textContent.trim()):('covered by '+(hit?hit.tagName:'nothing'))})()`,
    );
    if (String(reach).startsWith("reachable")) ok("a nav link can actually be tapped", String(reach).slice(11));
    else bad("a nav link can actually be tapped", String(reach));

    const count = await ev(`(()=>{const c=document.querySelector('[aria-label="Close menu"]');return c.parentElement.querySelectorAll('a').length})()`);
    if (Number(count) > 5) ok("the drawer carries the whole rail", `${count} links`);
    else bad("the drawer carries the whole rail", `only ${count} links`);

    await ev(`document.querySelector('[aria-label="Close menu"]').click()`);
    await sleep(800);
    const closed = await ev(`String(!document.querySelector('[aria-label="Close menu"]'))`);
    if (closed === "true") ok("tapping the backdrop closes it");
    else bad("tapping the backdrop closes it", "drawer still in the DOM");
  }
}

close();
await dropSession();

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
