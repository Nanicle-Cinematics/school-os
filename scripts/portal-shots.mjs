/**
 * Throwaway: what a parent actually sees, on a phone.
 *
 * Mints a session for a real PARENT login and walks the portal at handset width.
 * The staff screens have `npm run shots`; the portal — the surface hundreds of
 * families per school hold, and none of them on a laptop — has never been looked
 * at on the device it is used on.
 *
 *   SHOT_DIR=/tmp/portal node --env-file=.env scripts/portal-shots.mjs
 */
import { randomBytes, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL });
const DIR = process.env.SHOT_DIR ?? "/tmp/portal";
const WIDTH = Number(process.env.SHOT_WIDTH ?? 390);
const HEIGHT = Number(process.env.SHOT_HEIGHT ?? 1400);

const membership = await prisma.membership.findFirst({
  where: { role: "PARENT", user: { phone: { not: null } } },
  select: { userId: true, schoolId: true, guardianId: true },
});
if (!membership) {
  console.error("no parent login to borrow — run the invite screen first");
  process.exit(1);
}

const child = await prisma.studentGuardian.findFirst({
  where: { guardianId: membership.guardianId },
  select: { studentId: true },
});

const token = randomBytes(32).toString("hex");
const session = await prisma.session.create({
  data: {
    userId: membership.userId,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    activeSchoolId: membership.schoolId,
    expiresAt: new Date(Date.now() + 3600_000),
  },
  select: { id: true },
});

// Disconnect BEFORE the browser: connection_limit=1 on the pooled URL means a
// client left open starves the dev server and every page shoots as an error.
await prisma.$disconnect();

const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, "--hide-scrollbars",
  "--disable-gpu", "--no-first-run", "--user-data-dir=/tmp/school-os-portal-shot",
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
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  const resolve = pending.get(msg.id);
  if (resolve) {
    pending.delete(msg.id);
    resolve(msg.result);
  }
};
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params }));
  });

await send("Page.enable");
await send("Network.enable");
await send("Network.setCookie", {
  name: "school_os_session", value: token, domain: "localhost", path: "/",
});

// Always set it — see the note in screenshot.mjs: the profile is reused, so a
// dark run leaves "theme=dark" behind and the next light run shoots dark.
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `try { localStorage.setItem("theme", ${
    process.env.SHOT_THEME === "dark" ? '"dark"' : '"light"'
  }); } catch (e) {}`,
});

const routes = [
  ["portal-home", "/portal"],
  ...(child ? [["portal-child", `/portal/${child.studentId}`]] : []),
  ...(child ? [["portal-fees", `/portal/${child.studentId}/fees`]] : []),
  ...(child ? [["portal-results", `/portal/${child.studentId}/results`]] : []),
];

for (const [name, path] of routes) {
  await send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: true,
  });
  await send("Page.navigate", { url: `http://localhost:3000${path}` });
  await new Promise((r) => setTimeout(r, 6000));
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(`${DIR}/${name}.png`, Buffer.from(shot.data, "base64"));
  console.log(`  ${name}.png  ${path}`);
}

chrome.kill();
const cleanup = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL });
await cleanup.session.delete({ where: { id: session.id } });
await cleanup.$disconnect();
console.log("session removed");
process.exit(0);
