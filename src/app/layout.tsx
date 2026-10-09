import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { headers } from "next/headers";
import "./globals.css";
import { ServiceWorker } from "./service-worker";

/**
 * Plus Jakarta Sans carries the app — it has the weight range the headings need
 * (800 for a page title) and tabular figures that keep a column of cedis from
 * shifting as the digits change.
 *
 * Newsreader stays, but only for print: the masthead of a report card and of a
 * fee invoice. A serif page title read well on paper and looked apologetic on a
 * dashboard, which is why the app's own headings are now bold sans.
 *
 * ⚠️ Both are VENDORED in ./fonts, not fetched by next/font/google. The Google
 * loader downloads the CSS and files at BUILD time, so Google became a build
 * dependency: on 2026-10-09 production failed ("next/font/google queries have
 * exactly one entry") on a commit that had built cleanly locally and in CI, and
 * only a redeploy without the build cache recovered it. A file in the repo
 * cannot fail that way.
 *
 * The files are the Latin variable-weight cuts (200–800) from Fontsource 5.3.0,
 * under the SIL Open Font Licence (OFL-*.txt beside them). One variable file
 * covers every weight the app uses, so it is no heavier than the five static
 * weights it replaces. To update, take the same files from a newer
 * `@fontsource-variable/*` package — never re-add the Google import.
 */
const plusJakartaSans = localFont({
  src: "./fonts/plus-jakarta-sans-latin-wght-normal.woff2",
  weight: "200 800",
  variable: "--font-sans-ui",
  display: "swap",
});

const newsreader = localFont({
  src: [
    { path: "./fonts/newsreader-latin-wght-normal.woff2", weight: "200 800", style: "normal" },
    { path: "./fonts/newsreader-latin-wght-italic.woff2", weight: "200 800", style: "italic" },
  ],
  variable: "--font-display-serif",
  display: "swap",
  adjustFontFallback: "Times New Roman",
});

export const metadata: Metadata = {
  applicationName: "School OS",
  title: "School OS",
  description: "School management for African schools — by Nanicle Enterprise Solutions.",
  manifest: "/manifest.webmanifest",
  // Proves to Google Search Console that Nanicle controls this site, so the
  // marketing page can be crawled and indexed. Site-wide on purpose — every
  // route serves this meta tag, but Google only ever reads it off "/".
  verification: { google: "3lqUaFUOwnUxwmM9t9eVvY_2iJoLmh-M-e4DUyIyiYU" },
  appleWebApp: {
    capable: true,
    title: "School OS",
    statusBarStyle: "default",
  },
  // An admission number, a receipt number and a class code are all digit runs
  // that iOS Safari turns into "call" links on a phone. The portal is read on a
  // phone by definition, so this is not cosmetic.
  formatDetection: { telephone: false },
  icons: {
    icon: [
      { url: "/icons/icon.svg", type: "image/svg+xml" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

/**
 * ⚠️ themeColor follows the PAGE, not the brand, and it has to answer to both
 * themes.
 *
 * It paints the browser and status bar around the app. The manifest's own
 * theme_color is the brand green, which is right for the splash screen and the
 * task switcher, where the green icon is the thing being identified — but the
 * top of every screen in here is the white surface, or near-black in the dark
 * theme. A single green value would hang a green band above a white header,
 * and the black theme exists precisely so a head teacher can open the app at
 * night without being flashed.
 *
 * viewportFit: "cover" because the portal is read on phones with notches.
 */
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0e0d" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/**
 * Applied BEFORE first paint, which is the whole reason it is a raw script tag
 * and not a `useEffect`.
 *
 * A theme decided after hydration means every dark-mode page opens with a white
 * flash — worst at night, which is when the setting is for. It reads the saved
 * choice, falls back to the system's, and touches nothing else; if it throws
 * (Safari private mode denies localStorage), the app stays light rather than
 * blank.
 */
const THEME_SCRIPT = `
try {
  var saved = localStorage.getItem("theme");
  var system = window.matchMedia("(prefers-color-scheme: dark)").matches;
  if (saved === "dark" || (saved !== "light" && system)) {
    document.documentElement.classList.add("dark");
  }
  var skin = localStorage.getItem("skin");
  if (skin === "oneui" || skin === "oxygen" || skin === "pixel") {
    document.documentElement.dataset.skin = skin;
  }
} catch (e) {}
`;

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Set by src/proxy.ts. Next stamps its own scripts; this inline one is ours.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    /**
     * ⚠️ `suppressHydrationWarning` belongs on THIS element and nowhere else.
     *
     * THEME_SCRIPT below adds `dark` to <html> before React ever runs, which is
     * the point of it — so the class the server rendered and the class the
     * client finds are different BY DESIGN. React reported that as a hydration
     * mismatch on every page in dark mode ("this won't be patched up"), which
     * is noise that trains people to ignore the one that matters.
     *
     * It suppresses the warning for this element's own attributes only, not for
     * its children, so a real mismatch anywhere inside still shouts.
     */
    <html
      lang="en"
      suppressHydrationWarning
      className={`${plusJakartaSans.variable} ${newsreader.variable} h-full antialiased`}
    >
      <head>
        <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
