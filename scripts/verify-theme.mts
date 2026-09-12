/**
 * A token re-cut for the dark is put back by paper and by print.
 *
 * The palette is one set of NAMES with four sets of values: the light theme,
 * `html.dark`, `.paper` (a report card is a document and is white at midnight),
 * and `@media print` (nobody wants a class list printed as a black page, and the
 * school buys the toner).
 *
 * The failure is mechanical and silent. Add a token, re-cut it for dark, forget
 * `.paper` — and a parent opening their child's report card at night gets a
 * document with one dark stripe through it. Nothing errors; it just looks wrong
 * to somebody who will never report it.
 *
 * So the invariant is simply: ANYTHING `html.dark` overrides, `.paper` and the
 * print block must override back. No judgement, no list to keep.
 *
 *   npm run verify:theme   (no database, no dev server)
 */
import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) {
    passed += 1;
  } else {
    failed += 1;
  }
}

const css = readFileSync("src/app/globals.css", "utf8");

/** The custom properties a block sets, by name. */
function tokensIn(startPattern: RegExp): Set<string> {
  const start = css.search(startPattern);
  if (start === -1) {
    return new Set();
  }
  // Walk braces from the block's opening one, so a nested block (the `html.dark`
  // inside `@media print`) is captured whole rather than cut at its first `}`.
  const open = css.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = css.slice(open, end);
  return new Set([...body.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
}

const theme = tokensIn(/^@theme\b/m);
const dark = tokensIn(/^html\.dark\b/m);
const paper = tokensIn(/^\.paper\b/m);
const print = tokensIn(/^@media print\b/m);

console.log("The four sets of values for one set of names");
check("@theme defines the palette", theme.size > 30, `${theme.size} tokens`);
check("html.dark re-cuts a substantial part of it", dark.size > 20, `${dark.size} tokens`);
check(".paper and print exist at all", paper.size > 0 && print.size > 0,
  `${paper.size} and ${print.size} tokens`);

/**
 * ⚠️ The one rule worth enforcing. A token dark mode changes and paper does not
 * change back is a dark value inside a white document.
 */
console.log("\nEverything dark re-cuts, paper puts back");
const missingFromPaper = [...dark].filter((token) => !paper.has(token));
check(
  "no token is left dark inside a .paper document",
  missingFromPaper.length === 0,
  missingFromPaper.length ? missingFromPaper.join(", ") : `${dark.size} checked`,
);

console.log("\nEverything dark re-cuts, print puts back");
const missingFromPrint = [...dark].filter((token) => !print.has(token));
check(
  "no token is left dark on paper that came out of a printer",
  missingFromPrint.length === 0,
  missingFromPrint.length ? missingFromPrint.join(", ") : `${dark.size} checked`,
);

/**
 * And the reverse: a name a block sets that nothing declares is a typo which
 * silently does nothing — which is how a token somebody "fixed" stays broken.
 *
 * ⚠️ `@theme` is not the whole vocabulary. The status pills are built from
 * Tailwind's OWN families, which this file never declares because it does not
 * need to re-tint them for light — it only re-cuts them for the dark, where a
 * bright green pill on a black page is a hole burnt in it. Those names are
 * legitimate overrides of a stock value, so they are allowed by name rather
 * than by dropping the check that catches the typos.
 */
const STOCK = ["green", "red", "amber", "blue"];
const declared = (token: string) =>
  theme.has(token) || STOCK.some((family) => token.startsWith(`--color-${family}-`));

console.log("\nNo block invents a name the palette does not have");
for (const [label, block] of [["html.dark", dark], [".paper", paper], ["@media print", print]] as const) {
  const unknown = [...block].filter((token) => !declared(token));
  check(
    `${label} only overrides tokens that exist`,
    unknown.length === 0,
    unknown.length ? unknown.join(", ") : `${block.size} checked`,
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
