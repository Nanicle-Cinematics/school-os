"use client";

import { buttonClass, type ButtonVariant } from "./button-style";

/**
 * Print this page.
 *
 * Until now nothing in the app called `window.print()` anywhere — every print
 * route ended with "use your browser's print dialog", which assumes the person
 * at the printer knows to press Cmd+P and is on a laptop at all. A head teacher
 * handed a tablet has no such key.
 *
 * ⚠️ It must NOT be `primary`. `verify:design` enforces one primary button per
 * screen, and on every screen this appears the primary is the thing that
 * changes data — saving remarks, recording a payment. Printing is secondary to
 * all of them, which is also true of what it does.
 *
 * `print:hidden` because the button must never appear on the paper it produces.
 */
export function PrintButton({
  label = "Print",
  variant = "secondary",
}: {
  label?: string;
  variant?: ButtonVariant;
}) {
  return (
    <button type="button" onClick={() => window.print()} className={`${buttonClass(variant)} print:hidden`}>
      {label}
    </button>
  );
}
