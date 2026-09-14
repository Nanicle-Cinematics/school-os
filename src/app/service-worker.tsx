"use client";

import { useEffect } from "react";

/**
 * Registers the service worker, which is what makes the app installable.
 *
 * Production only: a worker registered by `next dev` caches the dev build's
 * hashed assets and then serves them after the next edit, which presents as
 * Fast Refresh silently doing nothing.
 *
 * Registration waits for idle so it never competes with the first paint. On
 * this link that matters — a round trip is seconds, and installability is worth
 * nothing to someone still waiting for the page. A failure is swallowed on
 * purpose: the app works uninstalled, so a browser that refuses the worker
 * should lose the home-screen icon and nothing else.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator) || process.env.NODE_ENV !== "production") {
      return;
    }

    let idle: number | null = null;
    const register = () => {
      const run = () => {
        navigator.serviceWorker.register("/sw.js").catch(() => {});
      };
      if ("requestIdleCallback" in window) {
        idle = window.requestIdleCallback(run, { timeout: 3000 });
      } else {
        // globalThis, not window: TS narrows `window` to never in this
        // branch because its lib types claim requestIdleCallback always
        // exists — which is exactly the assumption Safari disproves.
        idle = globalThis.setTimeout(run, 1200) as unknown as number;
      }
    };

    const cancel = () => {
      if (idle == null) return;
      if ("cancelIdleCallback" in window) window.cancelIdleCallback(idle);
      else globalThis.clearTimeout(idle);
    };

    if (document.readyState === "complete") {
      register();
      return cancel;
    }

    window.addEventListener("load", register, { once: true });
    return () => {
      window.removeEventListener("load", register);
      cancel();
    };
  }, []);

  return null;
}
