"use client";

import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/**
 * Whether the phone believes it has a connection.
 *
 * "Believes" is the word: `navigator.onLine` is true on a network with no
 * internet behind it, so a failed request, not this, is what decides that a
 * register could not be sent. This only chooses what to SAY and when to try.
 * The server render assumes online, so a signed-in page never flashes "No signal".
 */
export function useOnline() {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
}
