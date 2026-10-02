/**
 * Pure SMS helpers with no server dependencies, so client components can
 * import them. Anything that talks to a gateway lives in sms.ts, which is
 * server-only — importing that from a client component is a build error.
 */

/**
 * Ghanaian mobile numbers arrive in every shape a human can type them:
 * 0244123456, 244123456, +233244123456, 233 244 123 456. Gateways want the
 * international form with no punctuation.
 */
/**
 * Ghana mobile network prefixes (after the 233 country code): MTN 24/25/53/54/55/59,
 * Telecel 20/50, AirtelTigo 26/27/56/57. A number that is not one of these is a
 * landline, a typo or another country, and a text or a login sent to it reaches
 * nobody the school meant — or a stranger.
 */
const MOBILE_PREFIXES = new Set(["20", "23", "24", "25", "26", "27", "28", "29", "50", "53", "54", "55", "56", "57", "59"]);

export function normalisePhone(input: string | null | undefined): string | null {
  if (!input) {
    return null;
  }
  const digits = input.replace(/[^\d+]/g, "").replace(/^\+/, "");

  let national: string | null = null;
  if (digits.startsWith("233") && digits.length === 12) {
    national = digits.slice(3);
  } else if (digits.startsWith("0") && digits.length === 10) {
    national = digits.slice(1);
  } else if (digits.length === 9 && !digits.startsWith("0")) {
    // Bare 9-digit local number, e.g. 244123456
    national = digits;
  }
  if (!national || !MOBILE_PREFIXES.has(national.slice(0, 2))) {
    return null;
  }
  return `233${national}`;
}

// Characters outside GSM-7 force the whole message into UCS-2, which cuts the
// segment length from 160 to 70 — the usual cause of a "why did one message
// cost three?" question from a bursar.
const GSM7 =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXTENDED = "^{}\\[~]|€";

export function isGsm7(text: string) {
  return [...text].every((char) => GSM7.includes(char) || GSM7_EXTENDED.includes(char));
}

export function countSegments(text: string): { segments: number; encoding: "GSM7" | "UCS2"; length: number } {
  if (text.length === 0) {
    return { segments: 0, encoding: "GSM7", length: 0 };
  }

  if (isGsm7(text)) {
    // Extended characters occupy two septets each.
    const length = [...text].reduce(
      (sum, char) => sum + (GSM7_EXTENDED.includes(char) ? 2 : 1),
      0,
    );
    const segments = length <= 160 ? 1 : Math.ceil(length / 153);
    return { segments, encoding: "GSM7", length };
  }

  const length = [...text].length;
  const segments = length <= 70 ? 1 : Math.ceil(length / 67);
  return { segments, encoding: "UCS2", length };
}

/** Rate per segment in GHS. Rough Ghanaian bulk-SMS pricing; make it a setting later. */
export const RATE_PER_SEGMENT = 0.035;

export function estimateCost(text: string, recipients: number) {
  return countSegments(text).segments * recipients * RATE_PER_SEGMENT;
}

export type MergeContext = Record<string, string | number | null | undefined>;

/**
 * Replace {{field}} placeholders. Unknown fields are blanked rather than left
 * as literal braces — a parent should never receive "Dear {{guardian_name}}".
 */
export function renderTemplate(body: string, context: MergeContext) {
  return body.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_match, key: string) => {
    const value = context[key.toLowerCase()];
    return value === null || value === undefined ? "" : String(value);
  });
}

export const MERGE_FIELDS = [
  "student_name",
  "guardian_name",
  "first_name",
  "class_name",
  "admission_no",
  "balance",
  "amount",
  "receipt_no",
  "term",
  "due_date",
  "reopening_date",
  "school_name",
] as const;
