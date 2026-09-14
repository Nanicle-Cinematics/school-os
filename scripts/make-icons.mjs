/**
 * Rasterise the app icons from their source SVGs.
 *
 * The icons are generated rather than hand-drawn so the mark can never drift
 * from the one on the login page: both are a #12805c rounded square with a
 * white S, and this file is where that stops being a coincidence.
 *
 * ⚠️ `maskable.svg` is deliberately a DIFFERENT drawing, not a resize of
 * icon.svg. Android crops a maskable icon to whatever shape the launcher likes
 * — circle, squircle, teardrop — so it must bleed to the edges with no corner
 * radius of its own, and keep the letter inside the central 80% safe zone.
 * Feeding it the rounded artwork produces a green circle with clipped corners.
 *
 * Run: node scripts/make-icons.mjs
 */
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const icons = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

const jobs = [
  { from: "icon.svg", to: "icon-192.png", size: 192 },
  { from: "icon.svg", to: "icon-512.png", size: 512 },
  { from: "maskable.svg", to: "maskable-512.png", size: 512 },
  // iOS applies its own squircle mask, so the apple touch icon is the
  // full-bleed drawing. Rounding it ourselves shows dark corners behind Apple's
  // mask on a dark home screen.
  { from: "maskable.svg", to: "apple-touch-icon.png", size: 180 },
];

for (const job of jobs) {
  const info = await sharp(join(icons, job.from))
    .resize(job.size, job.size)
    .png({ compressionLevel: 9 })
    .toFile(join(icons, job.to));
  console.log(`  ${job.to.padEnd(22)} ${info.width}x${info.height}  ${info.size} bytes`);
}
