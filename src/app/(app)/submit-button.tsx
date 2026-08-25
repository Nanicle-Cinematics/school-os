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
  const { pending } = useFormStatus();

  const base =
    "rounded-lg px-3 py-2 text-sm font-medium transition disabled:opacity-60 disabled:cursor-not-allowed";
  const tone =
    variant === "primary"
      ? "bg-slate-900 text-white hover:bg-slate-800"
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
