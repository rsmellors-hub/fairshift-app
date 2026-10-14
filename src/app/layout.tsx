import type { Metadata } from "next";

import "./styles.css";

export const metadata: Metadata = {
  title: "FairShift — PayPal Sandbox Evidence",
  description: "FairShift inbound PayPal sandbox integration proof",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
