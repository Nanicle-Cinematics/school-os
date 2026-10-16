import "server-only";

import sharp from "sharp";

/** Decoding a crest never needs more than this; a bigger declared size is a decompression bomb. */
export const MAX_CREST_PIXELS = 16_000_000;

/**
 * A school's crest, composited into a home-screen icon.
 *
 * The crest is uploaded for print — "a square image on a plain or transparent
 * background works best" is a suggestion, not a guarantee, so this always
 * flattens onto a white square rather than trusting the source to already be
 * one. `fit: "contain"` never crops the mark; a crest that loses its border on
 * a phone's launcher is worse than one with margin around it.
 *
 * ⚠️ `maskable` shrinks the crest to fit the W3C safe zone before compositing
 * — the central 80%-diameter circle every launcher promises to leave
 * unclipped, which in practice means keeping content inside roughly two thirds
 * of the canvas. `scripts/make-icons.mjs` gets this for free by hand-drawing
 * `maskable.svg` full-bleed; a school's crest has no such second drawing, so
 * the safe margin is added here instead. Getting this backwards means Android
 * crops the crest's edge off on a circular or squircle launcher.
 */
export async function schoolIcon(
  crestBytes: Buffer,
  size: number,
  opts: { maskable?: boolean } = {},
): Promise<Buffer> {
  const content = opts.maskable ? Math.round(size * 0.66) : Math.round(size * 0.88);

  const mark = await sharp(crestBytes, { limitInputPixels: MAX_CREST_PIXELS })
    .resize(content, content, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 0 } })
    // ⚠️ Name the format. Left alone, sharp writes the SOURCE's: a crest uploaded as a JPEG comes out as a JPEG,
    // which has no transparency, so the padding added by `contain` is flattened to BLACK. A crest that is not
    // exactly square then showed a black bar down each side on the home screen (and nowhere on paper, which
    // never goes through here). PNG keeps the padding transparent, and it lands on the white square below.
    .png()
    .toBuffer();

  return sharp({
    create: { width: size, height: size, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .composite([{ input: mark, gravity: "center" }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}
