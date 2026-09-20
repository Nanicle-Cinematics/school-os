/**
 * Screenshot signed-in screens with headless Chrome, over the DevTools protocol.
 *
 * There is no way to see a tenant screen without a session, and the pages that
 * matter most — the dashboard, a mark sheet, a report card — are all behind one.
 * So this mints a session for the demo school's proprietor, hands the cookie to
 * Chrome over CDP, and captures each page at 2x.
 *
 * Node 22+ has a global WebSocket, so driving CDP needs no dependencies and no
 * Puppeteer install on a machine with 12 GB free.
 *
 * ⚠️ Disconnect Prisma BEFORE driving the browser. `DATABASE_URL` pins
 * `connection_limit=1`, so a client left open here starves the dev server and
 * every page screenshots as Next's "server error occurred" — which looks
 * exactly like a styling bug and is not one.
 *
 *   npm run dev
 *   SHOT_DIR=/tmp/shots npm run shots
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const OUT = process.env.SHOT_DIR ?? ".";
const prisma = new PrismaClient();

const owner = await prisma.membership.findFirst({ where: { role: "OWNER" } });
const token = randomBytes(32).toString("hex");
await prisma.session.create({ data: {
  userId: owner.userId, tokenHash: createHash("sha256").update(token).digest("hex"),
  activeSchoolId: owner.schoolId, expiresAt: new Date(Date.now() + 3600e3) } });

// Every read happens here, before the pool is released — reopening it while
// Chrome is browsing starves the dev server and every page 500s.
const published = await prisma.termResult.findFirst();
const assignment = await prisma.teachingAssignment.findFirst();
const aPupil = await prisma.student.findFirst({ where: { deletedAt: null }, select: { lastName: true } });
const currentTerm = await prisma.term.findFirst({ where: { isCurrent: true } });
await prisma.$disconnect();

const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, "--hide-scrollbars",
  "--disable-gpu", "--no-first-run", "--user-data-dir=/tmp/school-os-shot",
  "--force-device-scale-factor=2", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 40; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === "page");
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
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) =>
  new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
await send("Network.setCookie", {
  name: "school_os_session", value: token, domain: "localhost", path: "/",
});

// The theme is a class on <html> set from localStorage before paint, so seed
// the storage the same way a person's first press would.
//
// The skin (SHOT_SKIN=classic|oneui|oxygen|pixel) is seeded the same way.
//
// ⚠️ ALWAYS set it, never just when dark. The profile directory is reused
// between runs, so a dark capture left "theme=dark" behind and the next light
// run silently shot dark screens — which is a very convincing way to verify the
// wrong thing.
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `try { localStorage.setItem("theme", ${
    process.env.SHOT_THEME === "dark" ? '"dark"' : '"light"'
  }); localStorage.setItem("skin", ${JSON.stringify(process.env.SHOT_SKIN ?? "classic")}); } catch (e) {}`,
});

const shots = [
  ["dashboard", "/dashboard", 1440, 950],
  ["students", "/students", 1440, 950],
  ["invoices", "/invoices", 1440, 950],
  ["login", "/login", 1440, 950],
];

if (aPupil) {
  shots.push(["search", `/search?q=${encodeURIComponent(aPupil.lastName)}`, 1440, 950]);
}

// An OPEN mark sheet, not the empty picker — the picker shows none of the work.
if (assignment && currentTerm) {
  shots.push([
    "marksheet",
    `/assessments/sheet?term=${currentTerm.id}&class=${assignment.classGroupId}&subject=${assignment.subjectId}`,
    1560,
    950,
  ]);
}

if (published) {
  shots.push(["reportcard", `/results/${published.studentId}?term=${published.termId}`, 1000, 1500]);
  shots.push(["reportprint", `/results/print?term=${published.termId}&class=${published.classGroupId}&drafts=1`, 1000, 1500]);
}

for (const [name, path, w, h] of shots) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: false });
  await send("Page.navigate", { url: `http://localhost:3000${path}` });
  await sleep(2500);
  // Images are served by a route that does its own database work, so on this
  // link they land seconds after the HTML. Wait for them rather than guess, or
  // the capture shows a report card with no crest and it looks like a bug.
  for (let waited = 0; waited < 20_000; waited += 500) {
    const { result } = await send("Runtime.evaluate", {
      expression: "[...document.images].every((i) => i.complete)",
      returnByValue: true,
    });
    if (result?.result?.value === true) break;
    await sleep(500);
  }
  const { result } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  if (result?.data) {
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(result.data, "base64"));
    console.log(`  ${name}.png`);
  } else {
    console.log(`  ${name}: FAILED`);
  }
}

ws.close();
chrome.kill();
const cleanup = new PrismaClient();
await cleanup.session.deleteMany({ where: { tokenHash: createHash("sha256").update(token).digest("hex") } });
await cleanup.$disconnect();
