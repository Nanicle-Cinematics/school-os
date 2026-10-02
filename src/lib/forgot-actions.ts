"use server";

import { clientIp, takeAttempt } from "@/lib/rate-limit";
import { requestPasswordReset, completePasswordReset } from "@/lib/password-reset";

/**
 * The two steps of a forgotten password, as thin as they can be: the reasoning
 * lives in password-reset.ts, which a verify script can import — a "use server"
 * module reaches next/navigation and cannot be.
 */

export type ForgotState = {
  error?: string;
  /** Set once a code has been asked for, which moves the form to step two. */
  sent?: boolean;
  ok?: string;
  /** Carried between steps so the parent types their number once. */
  phone?: string;
};

/**
 * ⚠️ "Sent" and "there is nobody to send to" MUST answer identically. Anything
 * else turns this box into a way for a stranger to ask whether a given number
 * belongs to a parent at the school.
 */
const NEUTRAL =
  "If that number has a parent login, a code is on its way. It expires in 15 minutes.";

/** Generous: a whole mobile carrier can share one outward address. */
const RESET_REQUESTS_PER_IP_HOUR = 20;

export async function askForCode(_prev: ForgotState, formData: FormData): Promise<ForgotState> {
  const phone = String(formData.get("phone") ?? "").trim();

  // Each code costs the school an SMS, so one address may ask for only so many an
  // hour, whichever numbers it types. Over the limit answers exactly like a sent
  // code, so the limit itself is not a way to probe who has a login.
  const ip = await clientIp();
  if (!(await takeAttempt(`reset-ip:${ip}`, RESET_REQUESTS_PER_IP_HOUR, 60 * 60 * 1000))) {
    return { sent: true, phone, ok: NEUTRAL };
  }

  const outcome = await requestPasswordReset(phone);

  switch (outcome.kind) {
    case "invalid-phone":
      return { error: "Enter your phone number the way you know it, e.g. 0244000000." };
    case "undeliverable":
      return {
        error:
          "This school cannot send texts yet, so a code cannot reach you. Please ask the school " +
          "office to reset your password for you.",
      };
    default:
      // "sent" and "silent" are the same answer on purpose.
      return { sent: true, phone, ok: NEUTRAL };
  }
}

export async function useCode(_prev: ForgotState, formData: FormData): Promise<ForgotState> {
  const phone = String(formData.get("phone") ?? "").trim();
  const code = String(formData.get("code") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  const outcome = await completePasswordReset({ phone, code, password, confirm });

  switch (outcome.kind) {
    case "ok":
      return { ok: "Your password is set. Sign in with your phone number and your new password." };
    case "mismatch":
      return { sent: true, phone, error: "The two passwords do not match." };
    case "weak-password":
      return { sent: true, phone, error: "A password needs at least 8 characters." };
    case "invalid-phone":
      return { error: "Enter your phone number the way you know it, e.g. 0244000000." };
    default:
      return {
        sent: true,
        phone,
        error:
          "That code is wrong or has expired. Ask for a new one — a code lasts 15 minutes and " +
          "works once.",
      };
  }
}
