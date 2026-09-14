/**
 * Do the colours this app actually pairs meet WCAG AA?
 *
 * ⚠️ Written because I had changed nearly every colour in the product twice
 * and checked none of them. A palette can be coherent, tokenised, guarded
 * against drift and still be unreadable — "it looks fine on my screen" is not a
 * measurement, and the people using this are reading a phone in a bright
 * Ghanaian school office.
 *
 * Pairs are listed by hand rather than inferred, because the question is which
 * colours MEET, and only the code knows that. Every pair below is one a screen
 * actually renders.
 *
 *   npm run verify:contrast   (no database, no dev server)
 */
import { readFileSync } from "node:fs";

const css = readFileSync("src/app/globals.css", "utf8");

/** Every custom property a block sets, resolved for that block. */
function block(pattern: RegExp): Map<string, string> {
  const start = css.search(pattern);
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
  const found = new Map<string, string>();
  for (const m of css.slice(open, end).matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gm)) {
    found.set(m[1], m[2].trim());
  }
  return found;
}

const LIGHT = block(/^@theme\b/m);
const DARK = block(/^html\.dark\b/m);

/** Tailwind's own families, which this file only re-cuts for the dark. */
const STOCK: Record<string, string> = {
  "--color-white": "#ffffff",
};

function rgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]: [number, number, number]) {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function ratio(a: string, b: string): number | null {
  const x = rgb(a);
  const y = rgb(b);
  if (!x || !y) return null;
  const l1 = luminance(x);
  const l2 = luminance(y);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

type Pair = {
  ink: string;
  on: string;
  where: string;
  /** 18.7px bold or 24px+ — AA drops to 3:1. */
  large?: boolean;
  /**
   * ⚠️ An icon, not text. WCAG asks 3:1 of "graphical objects and user
   * interface components", not the 4.5:1 it asks of body text.
   *
   * This matters, and getting it wrong the other way would have been worse
   * than not measuring: the first run of this script failed all five rail
   * chips at the text threshold, and "fixing" them would have meant darkening
   * five hues to satisfy a rule that does not apply to them. The chip contains
   * an `<Icon>` and nothing else — the item's LABEL beside it is slate, and is
   * measured separately.
   */
  graphic?: boolean;
};

/** Every combination a screen actually renders. */
const PAIRS: Pair[] = [];

for (const meaning of ["success", "warning", "danger", "info"]) {
  PAIRS.push({
    ink: `--color-${meaning}-ink`,
    on: `--color-${meaning}-tint`,
    where: `${meaning} badge and chip`,
  });
  PAIRS.push({
    ink: `--color-${meaning}-ink`,
    on: "--color-surface",
    where: `${meaning} text on a card`,
  });
}

for (const hue of ["overview", "people", "academics", "finance", "school"]) {
  PAIRS.push({
    ink: `--color-hue-${hue}-600`,
    on: `--color-hue-${hue}-50`,
    where: `${hue} rail chip icon`,
    graphic: true,
  });
}

PAIRS.push(
  { ink: "--color-slate-500", on: "--color-surface", where: "caption on a card" },
  { ink: "--color-slate-500", on: "--color-slate-50", where: "caption on the page" },
  { ink: "--color-slate-400", on: "--color-surface", where: "faintest text on a card" },
  { ink: "--color-slate-600", on: "--color-surface", where: "body on a card" },
  { ink: "--color-slate-900", on: "--color-surface", where: "heading on a card" },
  { ink: "--color-brand-ink", on: "--color-surface", where: "brand link text" },
  { ink: "--color-accent-600", on: "--color-surface", where: "the gold figure", large: true },
  { ink: "--color-white", on: "--color-brand-600", where: "primary button label" },
  { ink: "--color-slate-400", on: "--color-slate-100", where: "empty-state icon", graphic: true },
  { ink: "--color-slate-500", on: "--color-slate-100", where: "muted badge on a tint" },
  { ink: "--color-slate-500", on: "--color-hue-finance-band", where: "table header on a band" },
  { ink: "--color-slate-500", on: "--color-hue-people-band", where: "table header on a band" },
  // The landing page, which is the one screen read by people who have never
  // seen the product and will not persevere with it.
  { ink: "--color-accent-700", on: "--color-slate-50", where: "landing eyebrow on the page" },
  { ink: "--color-accent-700", on: "--color-surface", where: "landing eyebrow on a card" },
  { ink: "--color-brand-ink", on: "--color-brand-50", where: "landing feature icon", graphic: true },
  { ink: "--color-slate-600", on: "--color-slate-50", where: "landing body on the page" },
  { ink: "--color-slate-900", on: "--color-slate-50", where: "landing headline on the page" },
);

let failed = 0;
for (const [theme, tokens] of [["light", LIGHT], ["dark", DARK]] as const) {
  console.log(`\n${theme}`);
  for (const pair of PAIRS) {
    const ink = tokens.get(pair.ink) ?? LIGHT.get(pair.ink) ?? STOCK[pair.ink];
    const on = tokens.get(pair.on) ?? LIGHT.get(pair.on) ?? STOCK[pair.on];
    if (!ink || !on) {
      console.log(`  --   ${pair.where} — not defined in this theme`);
      continue;
    }
    const r = ratio(ink, on);
    if (r === null) {
      console.log(`  --   ${pair.where} — ${ink} on ${on} is not a plain hex`);
      continue;
    }
    // AA: 4.5 for body text, 3.0 for large text and for graphical objects.
    const need = pair.large || pair.graphic ? 3 : 4.5;
    const ok = r >= need;
    if (!ok) failed += 1;
    console.log(
      `  ${ok ? "ok  " : "FAIL"} ${pair.where} — ${r.toFixed(2)}:1 (needs ${need})`,
    );
  }
}

console.log(`\n${failed === 0 ? "every pair meets AA" : `${failed} pair(s) below AA`}`);
process.exit(failed === 0 ? 0 : 1);
