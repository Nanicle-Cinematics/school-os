/**
 * The long transactions (class roll-ups, invoice runs) run at most one per lane, two in all, per instance, and nothing starts
 * one without asking.
 *
 *   npm run verify:heavy-work
 *
 * Pure: no database, no server. The cap exists because the app role has four connections per instance and each
 * of these holds one for seconds; see src/lib/heavy-work.ts. The behaviour is checked by running it, and the
 * wiring by reading the source, because a cap that one caller walks around caps nothing: the first check that
 * matters is that EVERY place calling an engine is behind it, so a new caller added next year fails here.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { LimiterFull } from "@/lib/concurrency";
import { HEAVY_WORK_QUEUE, HEAVY_WORK_SLOTS, heavyWork } from "@/lib/heavy-work";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}
const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

console.log("Behaviour");
check("two heavy transactions in all, leaving two of the app role's four connections for reading", HEAVY_WORK_SLOTS === 2);
check("a lane for roll-ups and a lane for invoice runs, one slot each", HEAVY_WORK_QUEUE.results.slots === 1 && HEAVY_WORK_QUEUE.invoices.slots === 1);
{
  let running = 0;
  let peak = 0;
  const job = async () => {
    running += 1;
    peak = Math.max(peak, running);
    await sleep(15);
    running -= 1;
  };
  await Promise.all(Array.from({ length: 12 }, (_, i) => heavyWork(i % 2 === 0 ? "results" : "invoices", job)));
  check("twelve at once, across both lanes, never run more than two together", peak === 2, `peak ${peak}`);
  running = 0;
  peak = 0;
  await Promise.all(Array.from({ length: 10 }, () => heavyWork("results", job)));
  check("ten roll-ups run one at a time", peak === 1, `peak ${peak}`);
}
{
  // THE regression the lanes exist for: a long invoice run holds its slot, and a roll-up still starts at once.
  let release: () => void = () => {};
  const longRun = heavyWork("invoices", () => new Promise<void>((resolveHold) => (release = resolveHold)));
  await sleep(5);
  // Raced against a timer: if the lanes were shared this would wait for the invoice run, and a check that hangs
  // reports nothing. It must say "blocked".
  const started = performance.now();
  const outcome = await Promise.race([heavyWork("results", async () => sleep(5)).then(() => "ran"), sleep(300).then(() => "blocked")]);
  check("a roll-up is not kept waiting by an invoice run in progress", outcome === "ran", `${outcome} after ${Math.round(performance.now() - started)} ms`);
  release();
  await longRun;
}
for (const lane of ["results", "invoices"] as const) {
  // Fill the slot and the lane's whole queue, then one more: it is turned away AT ONCE rather than queued.
  const release: (() => void)[] = [];
  const hold = () => new Promise<void>((resolveHold) => release.push(resolveHold));
  const { slots, queue } = HEAVY_WORK_QUEUE[lane];
  const accepted = Array.from({ length: slots + queue }, () => heavyWork(lane, hold));
  await sleep(5);
  const turnedAway = await heavyWork(lane, async () => "ran").then(
    () => false,
    (error) => error instanceof LimiterFull,
  );
  check(`${lane}: past its queue (${queue}) a caller is refused with LimiterFull, not left waiting`, turnedAway);
  // Drain: each release lets the next waiter start, which pushes its own release.
  while (release.length > 0) {
    release.shift()!();
    await sleep(1);
  }
  await Promise.all(accepted);
  check(`${lane}: once drained a new caller runs`, (await heavyWork(lane, async () => 7)) === 7);
}
{
  let ran = false;
  const failed = await heavyWork("results", async () => {
    throw new Error("boom");
  }).then(
    () => false,
    () => true,
  );
  await heavyWork("results", async () => {
    ran = true;
  });
  check("a job that throws gives its slot back", failed && ran);
}

console.log("\nWiring");
const root = resolve(import.meta.dirname, "..");
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
const files = walk(join(root, "src")).map((path) => ({ path: path.slice(root.length + 1), code: strip(readFileSync(path, "utf8")) }));

// The engines themselves, and the script-only original used to compare against, define the functions and are not callers.
const callers = (name: string) =>
  files.filter((f) => new RegExp(`\\b${name}\\(`).test(f.code) && !new RegExp(`function ${name}\\b`).test(f.code));
const laneOf: Record<string, "results" | "invoices"> = { computeClassResults: "results", generateInvoicesForTerm: "invoices" };
for (const engine of ["computeClassResults", "generateInvoicesForTerm"]) {
  const found = callers(engine);
  check(`${engine} has callers to guard (otherwise this scan is looking in the wrong place)`, found.length > 0, "none found");
  for (const file of found) {
    const lane = laneOf[engine]!;
    check(`${file.path} calls ${engine} behind heavyWork("${lane}", ...)`, new RegExp(`\\bheavyWork\\("${lane}",`).test(file.code) && /from "@\/lib\/heavy-work"/.test(file.code));
  }
}
for (const [path, why] of [
  ["src/lib/results-actions.ts", "the Compute button says the system is busy"],
  ["src/lib/invoice-actions.ts", "the invoice run says the system is busy"],
] as const) {
  const code = files.find((f) => f.path === path)!.code;
  check(`${path}: ${why} instead of failing, when the queue is full`, /instanceof LimiterFull/.test(code));
}
check("a full queue after a mark-sheet save falls into the existing 'totals could not be updated' path", /totalsError = true/.test(files.find((f) => f.path === "src/lib/sheet-actions.ts")!.code));

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
