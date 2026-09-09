"use client";

import { useFormStatus } from "react-dom";

export function SubmitButton({
  children,
  pendingLabel,
  variant = "primary",
  className = "",
  formAction,
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  variant?: "primary" | "secondary" | "danger";
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

  const base =
    "rounded-lg px-3 py-2 text-sm font-medium transition disabled:opacity-60 disabled:cursor-not-allowed";
  const tone =
    variant === "primary"
      ? "bg-brand-600 text-white hover:bg-brand-700"
      : variant === "danger"
        ? "border border-red-200 bg-white text-red-700 hover:bg-red-50"
        : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50";

  return (
    <button
      type="submit"
      formAction={formAction}
      disabled={pending}
      className={`${base} ${tone} ${className}`}
    >
      {pending ? (pendingLabel ?? "Working…") : children}
    </button>
  );
}
