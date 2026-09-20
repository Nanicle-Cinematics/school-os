"use client";

import { useSyncExternalStore } from "react";
import { Palette } from "lucide-react";

/**
 * Which phone-OS look the app wears: Classic (the documented default), One UI,
 * Oxygen or Pixel. Colour is still light/dark's job — see the SKINS block in
 * globals.css — so this only sets `data-skin` on <html>, and THEME_SCRIPT in the
 * root layout restores it before first paint for the same no-flash reason the
 * dark class is restored there.
 *
 * Read with useSyncExternalStore like the theme toggle: the attribute is
 * external state a script wrote before React existed.
 */
export const SKINS = [
  { id: "classic", label: "Classic" },
  { id: "oneui", label: "One UI" },
  { id: "oxygen", label: "Oxygen" },
  { id: "pixel", label: "Pixel" },
] as const;
type SkinId = (typeof SKINS)[number]["id"];

const subscribe = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-skin"] });
  return () => observer.disconnect();
};
const current = (): SkinId => (document.documentElement.dataset.skin as SkinId | undefined) ?? "classic";

export function SkinPicker({ className = "" }: { className?: string }) {
  const skin = useSyncExternalStore(subscribe, current, () => null);
  if (skin === null) return <span className="h-8 w-8 shrink-0" aria-hidden="true" />;

  const choose = (next: SkinId) => {
    if (next === "classic") delete document.documentElement.dataset.skin;
    else document.documentElement.dataset.skin = next;
    try {
      localStorage.setItem("skin", next);
    } catch {
      // Storage refused: the skin still applies for this page.
    }
  };

  return (
    <label className={`relative flex h-8 shrink-0 items-center ${className}`} title="Look">
      <Palette className="pointer-events-none absolute left-2 h-4 w-4 text-slate-500" aria-hidden="true" />
      <span className="sr-only">Look</span>
      <select
        value={skin}
        onChange={(e) => choose(e.target.value as SkinId)}
        className="h-8 cursor-pointer appearance-none rounded-lg bg-transparent pl-8 pr-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 focus:outline-none"
      >
        {SKINS.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
    </label>
  );
}
