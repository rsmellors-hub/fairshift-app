import type { Metadata } from "next";

import "./styles.css";

export const metadata: Metadata = {
  title: {
    default: "FairShift — Workforce operating intelligence",
    template: "%s · FairShift",
  },
  description: "Demand intelligence, staffing decisions and transparent worker payments.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
