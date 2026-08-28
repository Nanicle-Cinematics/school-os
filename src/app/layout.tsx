import type { Metadata } from "next";
import { Newsreader, Public_Sans } from "next/font/google";
import "./globals.css";

/**
 * Public Sans for everything read at a glance — rows, forms, figures — and
 * Newsreader for the few places a school's own voice belongs: page titles, the
 * numbers on the dashboard, and the head of a report card. Both are self-hosted
 * by next/font, so a school on a slow link is not waiting on Google.
 */
const sans = Public_Sans({
  variable: "--font-sans-ui",
  subsets: ["latin"],
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

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
