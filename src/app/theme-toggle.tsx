"use client";

import { useSyncExternalStore } from "react";

/**
 * Light or dark, remembered.
 *
 * Three states would be the honest model — light, dark, follow the system — but
 * a head teacher pressing a sun icon wants the lights to change, not to be asked
 * about inheritance. So the button toggles, and "never chosen" still follows the
 * system until the first press (see THEME_SCRIPT in the root layout).
 *
 * The class on <html> is EXTERNAL state — a script set it before React existed,
 * see THEME_SCRIPT in the root layout — so it is read with
 * useSyncExternalStore rather than copied into an effect. The server snapshot is
 * null, so nothing renders until the browser can answer, and an icon never flips
 * on hydration.
 */
const subscribe = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
};

export function ThemeToggle({ className = "" }: { className?: string }) {
  const dark = useSyncExternalStore(
    subscribe,
    () => document.documentElement.classList.contains("dark"),
    () => null,
  );

  if (dark === null) {
    // Same footprint as the button, so the header does not jump.
    return <span className="h-8 w-8 shrink-0" aria-hidden="true" />;
  }

  const flip = () => {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("theme", next ? "dark" : "light");
    } catch {
      // A browser refusing storage still gets the theme for this page.
    }
  };

  return (
    <button
      type="button"
      onClick={flip}
      aria-pressed={dark}
      title={dark ? "Switch to light" : "Switch to dark"}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 ${className}`}
    >
      <span className="sr-only">{dark ? "Switch to light mode" : "Switch to dark mode"}</span>
      {dark ? (
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="12" cy="12" r="4" />
          <path
            strokeLinecap="round"
            d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"
          />
        </svg>
      )}
    </button>
  );
}
