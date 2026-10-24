/**
 * An uploaded file is accepted only if its declared type is ON the allowlist, and its bytes agree.
 *
 * Pure: no database and no server.
 *
 * The allowlists are plain objects, so a bare `ACCEPTED[file.type]` also finds what every object
 * inherits: a declared type of "constructor" or "toString" read as accepted. `bytesMatchType` refuses
 * such a file a moment later, so nothing was stored, but the allowlist was only holding because of the
 * second check. `readAttachment` is run for real; the crest action is a database-backed server action,
 * so its guard is read from source with comments stripped (this codebase explains its mistakes at
 * length, and the words would satisfy a search).
 *
 * Run: npm run verify:uploads
 */
import { readFileSync } from "node:fs";
import { readAttachment } from "@/lib/attachments";

let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}

const code = (path: string) =>
  readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const file = (type: string, bytes: number[] = PNG) => new File([new Uint8Array(bytes)], "slip", { type });

const good = await readAttachment(file("image/png"));
check("a real PNG is accepted (positive control)", good.ok);

// `File.type` lowercases what it is given, so only the inherited names with no capitals can arrive.
for (const type of ["constructor", "__proto__"]) {
  const read = await readAttachment(file(type));
  // Refused by the ALLOWLIST ("That is a … file"), not by the byte check that follows it.
  check(
    `declared type "${type}" is refused by the allowlist itself`,
    !read.ok && read.error.startsWith(`That is a ${type} file`),
    read.ok ? "accepted" : read.error,
  );
}

for (const type of ["image/svg+xml", "text/html", "application/javascript", ""]) {
  const read = await readAttachment(file(type));
  check(`"${type || "(no type)"}" is refused`, !read.ok);
}

const lie = await readAttachment(file("image/png", [0x3c, 0x73, 0x76, 0x67, 0x3e, 0, 0, 0, 0, 0, 0, 0]));
check("an SVG body declared as image/png is refused by its bytes", !lie.ok);

const crest = code("src/lib/asset-actions.ts");
check("the crest action looks its type up with hasOwn", /Object\.hasOwn\(\s*ACCEPTED\s*,\s*file\.type\s*\)/.test(crest));
check("the crest action has no bare lookup left in its condition", !/!\s*ACCEPTED\s*\[/.test(crest));

const slip = code("src/lib/attachments.ts");
check("the attachment reader looks its type up with hasOwn", /Object\.hasOwn\(\s*ACCEPTED_ATTACHMENTS\s*,\s*value\.type\s*\)/.test(slip));
check("the attachment reader has no bare lookup left in its condition", !/!\s*ACCEPTED_ATTACHMENTS\s*\[/.test(slip));

console.log(failures ? `\n${failures} failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
