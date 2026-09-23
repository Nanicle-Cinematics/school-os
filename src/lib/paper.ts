import type { CSSProperties } from "react";

/**
 * The crest, faded, behind a printed document.
 *
 * Returns the two custom properties `.paper` reads (see globals.css). Both are
 * opt-in: `.paper` is also worn by the attendance register, the class page and
 * the expense form, which are screens and must not pick up a watermark. A
 * document asks for one by spreading this onto its root element.
 *
 * ⚠️ The veil is what makes it a watermark rather than a picture. A background
 * image cannot carry an opacity, so the crest is covered by a near-opaque white
 * layer instead — 0.94 is faint enough to read a table of marks through and
 * strong enough to survive a cheap inkjet, which is what a Ghanaian school
 * office actually prints on.
 *
 * Returns an empty object when the school has uploaded no crest, so a document
 * for a school without one is exactly as it was.
 */
export function paperWatermark(crestUrl: string | null | undefined): CSSProperties {
  if (!crestUrl) {
    return {};
  }
  return {
    // Quoted: a crest URL carries a `?v=` cache-buster, and an unquoted url()
    // containing certain characters is a parse error that silently drops the
    // whole background-image — taking the veil with it.
    ["--paper-crest" as string]: `url("${crestUrl}")`,
    ["--paper-veil" as string]: "rgba(255, 255, 255, 0.94)",
  };
}
