/**
 * The button's looks, with no component attached.
 *
 * Kept as its own module so a SERVER component (`Button`, `ButtonLink` in
 * primitives.tsx) and a CLIENT one (`SubmitButton`, which needs
 * `useFormStatus`) can share one definition. Before this there were two: the
 * primitive's, and a second set of tones inside SubmitButton — which is why a
 * submit button and the link beside it in the same form were different heights
 * and different radii.
 */

export const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full font-semibold transition disabled:opacity-55 disabled:pointer-events-none";

/**
 * ⚠️ ONE primary per screen.
 *
 * The filled style was pasted verbatim nineteen times across the app while the
 * shared link component had four uses, so screens ended up with three filled
 * green buttons of equal weight and no main action. Filled means "this is the
 * thing to do here"; everything else — including a row of equally-weighted row
 * actions — is secondary or ghost.
 */
export const BUTTON_VARIANT = {
  primary: "bg-brand-600 text-white shadow-pill hover:bg-brand-700 active:scale-[0.98]",
  secondary:
    "border border-hairline bg-surface text-slate-700 shadow-card hover:bg-slate-100 active:scale-[0.98]",
  ghost: "border border-hairline bg-transparent text-slate-600 hover:bg-slate-100",
  /* Ghost-shaped, danger-inked. Used for destructive actions that sit IN a
     list — a filled tint on every row of a twenty-seven row table shouts
     louder than the page's actual primary. The tint arrives on hover, where
     the pointer already is. */
  danger: "border border-hairline bg-transparent text-danger-ink hover:bg-danger-tint",
} as const;

export const BUTTON_SIZE = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4.5 py-2.5 text-sm",
} as const;

export type ButtonVariant = keyof typeof BUTTON_VARIANT;
export type ButtonSize = keyof typeof BUTTON_SIZE;

export function buttonClass(
  variant: ButtonVariant = "secondary",
  size: ButtonSize = "md",
  className?: string,
) {
  return `${BUTTON_BASE} ${BUTTON_VARIANT[variant]} ${BUTTON_SIZE[size]} ${className ?? ""}`.trim();
}
