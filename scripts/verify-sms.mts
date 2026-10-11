/**
 * Checks the SMS helpers that decide who gets a message and what it costs.
 * Run: npm run verify:sms
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalisePhone, countSegments, renderTemplate, estimateCost, pupilFieldsUsed } from "@/lib/sms-shared";
import { createLimiter } from "@/lib/concurrency";
import {
  DEFAULT_MESSAGE_TEMPLATES,
  TRANSACTIONAL,
  defaultTemplateBody,
} from "@/lib/message-defaults";

let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) {
    failures += 1;
  }
}

console.log("Phone normalisation");
check("local 0-prefixed", normalisePhone("0244123456") === "233244123456");
check("international +233", normalisePhone("+233244123456") === "233244123456");
check("already 233", normalisePhone("233244123456") === "233244123456");
check("bare 9-digit", normalisePhone("244123456") === "233244123456");
check("spaces and dashes", normalisePhone("024 412-3456") === "233244123456");
check("rejects too short", normalisePhone("0244") === null);
check("rejects junk", normalisePhone("not a phone") === null);
check("rejects empty", normalisePhone("") === null && normalisePhone(null) === null);
check("rejects a landline", normalisePhone("0302123456") === null);
check("rejects an unknown network prefix", normalisePhone("0111234567") === null && normalisePhone("233991234567") === null);
check("accepts every mobile network", ["0201234567", "0241234567", "0261234567", "0501234567", "0541234567", "0571234567"].every((n) => normalisePhone(n) !== null));

console.log("\nPupil-only placeholders (typed numbers have no pupil)");
check(
  "finds pupil fields, however they are spaced or cased",
  JSON.stringify(pupilFieldsUsed("Dear {{ Student_Name }}, owing GHS {{balance}} ({{BALANCE}})")) ===
    JSON.stringify(["{{student_name}}", "{{balance}}"]),
);
check(
  "name, school and term fields are fine without a pupil",
  pupilFieldsUsed("Hello {{first_name}} {{guardian_name}} from {{school_name}}, {{term}}, back on {{reopening_date}}").length === 0,
);
check("a plain message uses none", pupilFieldsUsed("School is closed on Friday.").length === 0);

console.log("\nSegment counting");
check("short message is one segment", countSegments("Hello").segments === 1);
check("exactly 160 is one segment", countSegments("a".repeat(160)).segments === 1);
check("161 becomes two", countSegments("a".repeat(161)).segments === 2);
check("306 is two", countSegments("a".repeat(306)).segments === 2);
check("307 is three", countSegments("a".repeat(307)).segments === 3);

const smart = countSegments("Fees due — pay now");
check("an em dash forces UCS2", smart.encoding === "UCS2", `got ${smart.encoding}`);
// é is IN the GSM-7 alphabet, so it does NOT force UCS2 — use an em dash, which
// is genuinely outside it. Getting this wrong is easy and expensive: it decides
// whether a 71-character message costs one segment or two.
check("accented GSM-7 chars stay single-segment", countSegments("é".repeat(71)).segments === 1);
check("UCS2 caps at 70 per segment", countSegments("—".repeat(71)).segments === 2);
check("UCS2 at exactly 70 is one segment", countSegments("—".repeat(70)).segments === 1);
check("plain ASCII stays GSM7", countSegments("Fees due - pay now").encoding === "GSM7");

console.log("\nMerge fields");
const rendered = renderTemplate(
  "Dear {{guardian_name}}, {{student_name}} owes GHS {{balance}}. - {{school_name}}",
  {
    guardian_name: "Ama Mensah",
    student_name: "Kofi Mensah",
    balance: "487.00",
    school_name: "Hope Education Complex",
  },
);
check(
  "all fields substituted",
  rendered === "Dear Ama Mensah, Kofi Mensah owes GHS 487.00. - Hope Education Complex",
  rendered,
);
check(
  "unknown field becomes empty, never literal braces",
  renderTemplate("Hi {{nope}}!", {}) === "Hi !",
);
check("whitespace inside braces tolerated", renderTemplate("{{ balance }}", { balance: 5 }) === "5");

console.log("\nCost");
const oneSeg = estimateCost("Short message", 100);
const twoSeg = estimateCost("a".repeat(200), 100);
check("100 recipients, 1 segment", Math.abs(oneSeg - 3.5) < 0.001, `GHS ${oneSeg.toFixed(2)}`);
check("doubles with a second segment", Math.abs(twoSeg - 7.0) < 0.001, `GHS ${twoSeg.toFixed(2)}`);

// ── Every name the app sends by is a template it actually ships ─────────────
// A MessageTemplate is found by NAME, and a name that misses does not raise —
// it sends nothing at all. So a literal that drifts from the shipped list is
// indistinguishable from a school having no templates, which is the bug this
// whole file exists to stop coming back.
console.log("\nTransactional template names");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
  });
}

const shipped = new Set(DEFAULT_MESSAGE_TEMPLATES.map((t) => t.name));
const sentBy = new Set<string>();
for (const file of walk("src/lib")) {
  for (const m of readFileSync(file, "utf8").matchAll(/templateName: "([^"]+)"/g)) {
    sentBy.add(m[1]);
  }
}
const unknown = [...sentBy].filter((name) => !shipped.has(name));
check(
  "no send site names a template that is not shipped",
  unknown.length === 0,
  unknown.length ? `unknown: ${unknown.join(", ")}` : `${sentBy.size} literal name(s), all shipped`,
);

const missingTransactional = Object.values(TRANSACTIONAL).filter((name) => !shipped.has(name));
check(
  "every TRANSACTIONAL name is shipped",
  missingTransactional.length === 0,
  missingTransactional.join(", "),
);

// The fallback is what a school with no templates actually sends, so it has to
// render — a stray merge field here reaches a parent as an empty gap.
const receipt = renderTemplate(defaultTemplateBody(TRANSACTIONAL.paymentReceived) ?? "", {
  guardian_name: "Ama Mensah",
  student_name: "Kofi Mensah",
  amount: "250.00",
  balance: "487.00",
  receipt_no: "RCPT/0001",
  school_name: "Hope Education Complex",
});
check("the packaged receipt renders", receipt.includes("GHS 250.00") && receipt.includes("RCPT/0001"), receipt);
check("and leaves no unfilled merge field", !receipt.includes("{{"), receipt);

// A campaign records each message's outcome as its own write, and under RLS every write holds
// one of the app role's four connections. dispatchQueued caps those writes with this limiter
// (three at a time) so ten of them do not fill the pool; the cap is only as good as the limiter.
console.log("\nThe write limiter a campaign send is capped by");
{
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const run = createLimiter(3);
  let active = 0;
  let peak = 0;
  const started: number[] = [];
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, n) =>
      run(async () => {
        started.push(n);
        active += 1;
        peak = Math.max(peak, active);
        await sleep(5 + (n % 4) * 3);
        active -= 1;
        return n * 2;
      }),
    ),
  );
  check("never more than three run at once", peak <= 3, `peak ${peak}`);
  check("and does use all three, so it is not just running one at a time", peak === 3, `peak ${peak}`);
  check("every task completes and gets its own result", results.every((value, n) => value === n * 2));
  check("tasks start in the order they asked", started.every((value, n) => value === n), started.join(","));

  const single = createLimiter(1);
  const ran: string[] = [];
  const failing = single(async () => {
    ran.push("first");
    throw new Error("the write failed");
  }).catch(() => "rejected");
  const after = single(async () => {
    ran.push("second");
    return "ran";
  });
  check("a failed task is passed to its caller", (await failing) === "rejected");
  // Raced against a timer: a slot that leaked would leave `after` waiting for ever, and the
  // script would end on Node's "unsettled top-level await" instead of saying what broke.
  const afterOutcome = await Promise.race([after, sleep(500).then(() => "never ran")]);
  check("and gives its slot back, so the next one still runs", afterOutcome === "ran" && ran.join() === "first,second", `${afterOutcome} (${ran.join()})`);

  let refused = 0;
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    try {
      createLimiter(bad);
    } catch {
      refused += 1;
    }
  }
  check("a limit that is not a whole number of at least one is refused", refused === 4, `${refused} of 4`);
}

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
