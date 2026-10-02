/**
 * Is this the same person as the guardian already on file under that number?
 *
 * A phone number alone decides who a child is linked to, and linking is what
 * lets that guardian's portal login see the child's fees and results. A number
 * mistyped by one digit therefore silently handed a child to another family. The
 * names must agree — every word of the shorter one appears in the longer — or
 * the caller must stop and ask.
 *
 * Shared by single admission, adding a guardian, and the spreadsheet import, so
 * all three refuse the same way.
 */
export function sameGuardian(typed: string, onFile: string) {
  const words = (text: string) =>
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  const a = words(typed);
  const b = words(onFile);
  if (a.length === 0 || b.length === 0) {
    return false;
  }
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.every((word) => long.includes(word));
}
