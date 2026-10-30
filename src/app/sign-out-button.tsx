"use client";

import { useRef } from "react";
import { logout } from "@/lib/auth-actions";
import { wipeAll } from "@/lib/offline-store";

/**
 * Sign out, and take the class list and any unsent registers off this phone.
 *
 * The session going away does not by itself remove what was kept for offline
 * use, and the next person to pick up a shared phone should find none of it.
 * (A session that simply expires never reaches this button; `adoptOwner` covers
 * that by clearing the phone when somebody else signs in.)
 *
 * The wipe finishes BEFORE the form is sent: a page that is navigating away can
 * abandon an IndexedDB transaction that has not committed, and a sign-out that
 * leaves the register behind is worse than one that takes a few milliseconds
 * longer. It is capped at two seconds so a stuck store can never stop someone
 * signing out.
 */
export function SignOutButton({ className }: { className?: string }) {
  const form = useRef<HTMLFormElement>(null);
  const wiped = useRef(false);

  return (
    <form
      ref={form}
      action={logout}
      onSubmit={(event) => {
        if (wiped.current) return;
        event.preventDefault();
        const send = () => {
          wiped.current = true;
          form.current?.requestSubmit();
        };
        void Promise.race([wipeAll(), new Promise((resolve) => setTimeout(resolve, 2000))]).then(send, send);
      }}
    >
      <button type="submit" className={className}>
        Sign out
      </button>
    </form>
  );
}
