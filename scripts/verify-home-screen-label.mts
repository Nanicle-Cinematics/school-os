/**
 * The name under a school's home-screen icon.
 *
 * Pure rule (`homeScreenLabel`) plus where it is applied: the staff layout, the parent layout and the manifest
 * route must all use the SAME function, or an iPhone and an Android phone label the same school differently.
 *
 * Run: npm run verify:home-screen-label   (no database, no server)
 */
import { readFileSync } from "node:fs";
import { GENERIC_LABEL, LABEL_FIT, homeScreenLabel } from "@/lib/home-screen-label";

let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}
const code = (path: string) =>
  readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

console.log("The rule");
const FULL = "Reverend Asuamah Thompson Methodist Memorial Academy";
check("the short name is used as written", homeScreenLabel({ shortName: "RATMMA", name: FULL }) === "RATMMA");
check("surrounding space and stray whitespace are cleaned", homeScreenLabel({ shortName: "  RAT\n MMA  ", name: FULL }) === "RAT MMA");
check("control characters never reach a meta tag", !/[\u0000-\u001f]/.test(homeScreenLabel({ shortName: "A\u0000B\u0007C", name: FULL })));
check("no short name: whole words of the name that fit", homeScreenLabel({ shortName: null, name: FULL }) === "Reverend", homeScreenLabel({ shortName: null, name: FULL }));
check("a blank short name counts as none", homeScreenLabel({ shortName: "   ", name: "Hope Academy" }) === "Hope Academy");
check("a short full name is used whole", homeScreenLabel({ name: "Hope School" }) === "Hope School");
check("a first word longer than the fit is cut, not dropped", homeScreenLabel({ name: "Abcdefghijklmnopqrstuvwxyz School" }) === "Abcdefghijkl");
check("it never exceeds the fit when built from the name", homeScreenLabel({ name: FULL }).length <= LABEL_FIT);
check("nothing at all gives the product name, never an empty label", homeScreenLabel({ shortName: null, name: "" }) === GENERIC_LABEL && homeScreenLabel({}) === GENERIC_LABEL);

console.log("\nWhere it is applied");
for (const [file, name] of [["src/app/(app)/layout.tsx", "the staff layout"], ["src/app/(portal)/layout.tsx", "the parent layout"]] as const) {
  const src = code(file);
  check(`${name} sets the iPhone title from it`, /appleWebApp:\s*\{[^}]*title:\s*label/.test(src) && /homeScreenLabel\(/.test(src));
  check(`${name} sets the application name from it`, /applicationName:\s*label/.test(src));
  check(`${name} keeps the other appleWebApp fields the root layout sets (it replaces that object)`, /capable:\s*true/.test(src) && /statusBarStyle/.test(src));
}
const route = code("src/app/api/manifest/route.ts");
check("the manifest route sets short_name from it", /short_name\s*=\s*homeScreenLabel\(/.test(route));
check("and serves a manifest to a school with NO crest too", !/if \(!icons\) \{\s*return fallback\(\)/.test(route));

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
