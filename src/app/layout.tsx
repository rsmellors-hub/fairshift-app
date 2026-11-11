import type { Metadata } from "next";
import { Geist, Geist_Mono, Newsreader } from "next/font/google";

import { designV2Enabled } from "@/lib/design-flag";
import "./styles.css";
import "./design-v2.css";

// Design v2 type: Newsreader for display headings, Geist for text, Geist Mono for labels and identifiers.
const serif = Newsreader({ subsets: ["latin"], weight: ["400", "500"], style: ["normal", "italic"], variable: "--font-newsreader", display: "swap" });
const sans = Geist({ subsets: ["latin"], variable: "--font-geist", display: "swap" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });

export const metadata: Metadata = {
  title: {
    default: "FairShift — Workforce operating intelligence",
    template: "%s · FairShift",
  },
  description: "Demand intelligence, staffing decisions and transparent worker payments.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Every design-v2 rule is scoped to html[data-design="v2"], so with the flag off the page looks as before.
  const v2 = designV2Enabled();
  return (
    <html lang="en" data-design={v2 ? "v2" : undefined} className={v2 ? `${serif.variable} ${sans.variable} ${mono.variable}` : undefined}>
      <body>{children}</body>
    </html>
  );
}
