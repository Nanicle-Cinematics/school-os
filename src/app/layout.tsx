import type { Metadata } from "next";
import { Newsreader, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

/**
 * Plus Jakarta Sans carries the app — it has the weight range the headings need
 * (800 for a page title) and tabular figures that keep a column of cedis from
 * shifting as the digits change.
 *
 * Newsreader stays, but only for print: the masthead of a report card and of a
 * fee invoice. A serif page title read well on paper and looked apologetic on a
 * dashboard, which is why the app's own headings are now bold sans.
 *
 * Both are self-hosted by next/font, so a school on a slow link is not waiting
 * on Google.
 */
const sans = Plus_Jakarta_Sans({
  variable: "--font-sans-ui",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
});

const display = Newsreader({
  variable: "--font-display-serif",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "School OS",
  description: "School management for Ghanaian schools — by Nanicle Enterprise Solutions.",
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
} catch (e) {}
`;

export default function RootLayout({ children }: LayoutProps<"/">) {
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
      className={`${sans.variable} ${display.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
