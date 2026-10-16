/**
 * The name printed under a school's icon on a phone's home screen.
 *
 * The short name the school set (STAMS, RATMMA) when it has one, because the label is about twelve characters
 * on a phone before it is cut off, and a full school name ("Reverend Asuamah Thompson Methodist Memorial
 * Academy") is cut to nothing useful. A school with no short name gets as many WHOLE words of its name as fit,
 * and a first word that is itself too long is cut. Never empty: it falls back to the product's own name.
 *
 * Pure (no server-only, no database) so the layouts, the manifest route and a verify script share one rule.
 */
export const GENERIC_LABEL = "School OS";
export const LABEL_FIT = 12;

// Control characters and runs of spaces would be printed under an icon or break a meta tag.
const clean = (s: string | null | undefined) => (s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();

export function homeScreenLabel(school: { shortName?: string | null; name?: string | null }): string {
  const short = clean(school.shortName);
  if (short) {
    return short;
  }
  const words = clean(school.name).split(" ").filter(Boolean);
  if (words.length === 0) {
    return GENERIC_LABEL;
  }
  let label = "";
  for (const word of words) {
    const next = label ? `${label} ${word}` : word;
    if (next.length > LABEL_FIT) {
      break;
    }
    label = next;
  }
  return label || words[0].slice(0, LABEL_FIT);
}
