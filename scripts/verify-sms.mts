/**
 * Checks the SMS helpers that decide who gets a message and what it costs.
 * Run: npm run verify:sms
 */
import { normalisePhone, countSegments, renderTemplate, estimateCost } from "@/lib/sms-shared";

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
    school_name: "St. Mary's",
  },
);
check(
  "all fields substituted",
  rendered === "Dear Ama Mensah, Kofi Mensah owes GHS 487.00. - St. Mary's",
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

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
