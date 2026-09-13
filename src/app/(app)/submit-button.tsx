"use client";

import { useFormStatus } from "react-dom";
import { buttonClass, type ButtonVariant } from "./button-style";

export function SubmitButton({
  children,
  pendingLabel,
  variant = "primary",
  className = "",
  formAction,
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  variant?: ButtonVariant;
  className?: string;
  /** Lets one form drive two actions, e.g. "preview" alongside "send". */
  formAction?: (formData: FormData) => void | Promise<void>;
}) {
  // `action` says WHICH action is in flight. Without comparing it, every
  // SubmitButton in a form shows its pending label on any submit — so the
  // messages screen said "Sending…" while you were only previewing, and the
  // parent-invite screen said "Creating…" while you were only checking. On
  // buttons that spend money or create accounts that is genuinely alarming.
  const status = useFormStatus();
  const pending = status.pending && (!formAction || status.action === formAction);

  /* One definition, shared with Button and ButtonLink — see button-style.ts.
     This used to carry its own `base` and `tone`, so a submit button and the
     link beside it in the same form had different heights and radii. */
  return (
    <button
      type="submit"
      formAction={formAction}
      disabled={pending}
      className={buttonClass(variant, "md", className)}
    >
      {pending ? (pendingLabel ?? "Working…") : children}
    </button>
  );
}
