/**
 * A school's home-screen icon must never show black where the crest has padding.
 *
 * `schoolIcon` pads a non-square crest (`fit: "contain"`). Without naming the output format, a JPEG crest
 * stayed a JPEG, had no alpha to hold the transparent padding, and the padding came out BLACK: a black bar down
 * each side of the crest on the phone's home screen, with every printed document looking fine. This feeds
 * crests of several shapes and formats through the real function and reads the pixels back.
 *
 * Run: npm run verify:icon-compose   (no database, no server)
 */
import sharp from "sharp";
import { schoolIcon } from "@/lib/school-icon";

let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}

const RED = { r: 200, g: 30, b: 30 };
const shapes: [string, number, number][] = [["portrait", 300, 400], ["landscape", 400, 300], ["square", 300, 300]];
const formats = ["jpeg", "png", "webp"] as const;
const variants: [string, number, boolean][] = [["192", 192, false], ["maskable 512", 512, true], ["apple-touch 180", 180, true]];

for (const [shape, w, h] of shapes) {
  for (const format of formats) {
    const crest = await sharp({ create: { width: w, height: h, channels: 3, background: RED } }).toFormat(format).toBuffer();
    for (const [vname, size, maskable] of variants) {
      const icon = await schoolIcon(crest, size, { maskable });
      const { data, info } = await sharp(icon).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const px = (x: number, y: number) => { const i = (y * info.width + x) * info.channels; return [data[i], data[i + 1], data[i + 2]]; };
      // Darkest pixel anywhere in the icon: the crest is red (min channel 30) and the rest must be white, so
      // anything with every channel near 0 is padding that went black.
      let black = 0;
      for (let i = 0; i < data.length; i += info.channels) {
        if (data[i] < 20 && data[i + 1] < 20 && data[i + 2] < 20) black += 1;
      }
      const centre = px(size >> 1, size >> 1);
      check(`${shape} ${format}, ${vname}: no black anywhere, crest still in the middle`, black === 0 && centre[0] > 150 && centre[1] < 90, `${black} black px, centre ${centre}`);
    }
  }
}

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
