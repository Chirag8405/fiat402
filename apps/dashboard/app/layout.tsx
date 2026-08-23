import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "fiat402 control tower",
  description: "Live judge-facing dashboard for the fiat402 x402 upi facilitator",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
