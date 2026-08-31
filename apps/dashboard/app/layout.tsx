import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

export const metadata: Metadata = {
  title: "fiat402 control tower",
  description: "Live judge-facing dashboard for the fiat402 x402 upi facilitator",
};

/**
 * Loaded as a CSS variable (--font-sans), not applied to `body` directly --
 * /console (a separate, passcode-gated surface sharing this same root
 * layout) must keep its existing system-sans look untouched. Only the
 * showcase page at "/" opts into var(--font-sans) via its own wrapper
 * class (see app/page.tsx's .showcase-page / globals.css).
 */
const inter = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.variable}>{children}</body>
    </html>
  );
}
