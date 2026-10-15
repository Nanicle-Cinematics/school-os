/**
 * Start headless Chrome and drive it over the DevTools protocol, with no dependency.
 *
 * Extracted from `verify-mobile-nav.mjs`, whose launcher is the product of a bad day: see the notes on
 * `launchOnce`. Both `verify-grid-browser.mjs` and `verify-mobile-nav.mjs` use this one, so a fix to how Chrome
 * is started, or a deadline on a call, reaches both. It used to be copied into each, and the copy that was not
 * being looked at fell behind: the phone-menu guard had no deadline on its calls.
 *
 * ⚠️ Why a real browser at all: some bugs only exist AFTER an action returns, in the browser, where
 * React resets a form's fields. No HTTP test can see them, because an HTTP client never resets anything.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ubuntu-latest ships google-chrome-stable; macOS has it in /Applications.
// No silent skip when it is missing: a guard nobody runs is not a guard.
const CHROME = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
].find((p) => p && existsSync(p));

const START_BUDGET_MS = 45_000;

function devtoolsPort(profile, stderr) {
  try {
    const port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
    if (port > 0) return port;
  } catch {}
  const match = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(stderr);
  return match ? Number(match[1]) : null;
}

function stopChrome(child, profile) {
  // detached: true put Chrome and its helpers in their own process group, so one signal reaches all of
  // them: killing the parent alone left renderer and crashpad processes for the runner to reap.
  try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

/**
 * History: this failed twice on 2026-10-06, on two different branches, as "chrome never opened the debugging
 * port". The process was alive, had written NOTHING to stderr, and 18 seconds of polling a fixed port found no
 * listener; each time a re-run of the job passed. These are the changes aimed at the ways that happens.
 *
 * `--remote-debugging-port=0` with the port read back from the profile (a fixed port can be held by
 * anything else on a shared runner, and then the failure looks like a slow start); a 45-second budget (a
 * cold runner's first launch can take far longer than a healthy second); and ONE retry with a fresh
 * profile after killing the whole process group (a Chrome wedged before it binds stays wedged).
 * `--disable-dev-shm-usage` because /dev/shm in CI containers is small and Chrome stalls rather than errors.
 */
async function launchOnce(attempt) {
  const profile = mkdtempSync(join(tmpdir(), "school-os-cdp-"));
  const child = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=0", "--hide-scrollbars", "--disable-gpu",
    "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage",
    "--disable-extensions", "--disable-background-networking", "--disable-component-update",
    `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"], detached: true });

  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  let exited = null;
  child.on("exit", (code, signal) => { exited = { code, signal }; });

  const started = Date.now();
  while (Date.now() - started < START_BUDGET_MS) {
    if (exited) break;
    const port = devtoolsPort(profile, stderr);
    if (port) {
      try {
        const listed = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const target = listed.find((t) => t.type === "page");
        if (target) return { child, profile, target };
      } catch {}
    }
    await sleep(250);
  }

  stopChrome(child, profile);
  const why = exited
    ? `exited (code ${exited.code}, signal ${exited.signal})`
    : `no page to drive after ${START_BUDGET_MS / 1000}s`;
  return { error: `attempt ${attempt}: ${why}${stderr.trim() ? `\n${stderr.trim()}` : " (nothing on stderr)"}` };
}

/** A running browser: `send` (a protocol call), `ev` (evaluate in the page), `close`. */
export async function startBrowser() {
  if (!CHROME) {
    throw new Error("no Chrome found: set CHROME_PATH");
  }
  let launched = await launchOnce(1);
  if (launched.error) {
    console.log(`chrome did not start: ${launched.error}\nretrying once with a fresh profile`);
    const first = launched.error;
    launched = await launchOnce(2);
    if (launched.error) {
      throw new Error(`chrome did not start, twice:\n${first}\n${launched.error}`);
    }
  }
  const { child, profile, target } = launched;

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => (ws.onopen = resolve));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
    }
  };
  // ⚠️ Every call has a deadline. Without one, a Chrome that never answers (a page stuck mid-navigation, a
  // wedged renderer) leaves this promise pending for ever, and the guard sits there until the CI job's own
  // limit with nothing printed. A call that times out resolves to nothing, exactly as a protocol error does,
  // so the caller's own wait loop runs out its budget and REPORTS the failure.
  //
  // ⚠️ But NOT the same deadline for every call. `Page.navigate` does not answer until the server's response
  // begins, which on a slow server is as long as the page takes to render (a minute, on the development link). A
  // 30-second limit there gave up on the first page, started the next step against a page that had not loaded,
  // and a guard that passes on a fast server failed on a slow one with "no menu button". A navigation gets a
  // long deadline; everything else answers from a page that is already there.
  const CALL_DEADLINE_MS = 30_000;
  const SLOW_CALLS = { "Page.navigate": 180_000 };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const n = ++id;
      const timer = setTimeout(() => {
        pending.delete(n);
        resolve(undefined);
      }, SLOW_CALLS[method] ?? CALL_DEADLINE_MS);
      pending.set(n, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const ev = async (expression) =>
    (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }))?.result?.value;
  const close = () => {
    try { ws.close(); } catch {}
    stopChrome(child, profile);
  };
  return { send, ev, close };
}
