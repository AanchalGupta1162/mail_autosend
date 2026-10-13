import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import { Archivo, IBM_Plex_Mono, Public_Sans } from "next/font/google";
import "./globals.css";

const display = Archivo({ subsets: ["latin"], axes: ["wdth"], variable: "--font-display", display: "swap" });
const body = Public_Sans({ subsets: ["latin"], variable: "--font-body", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Outbox", template: "%s · Outbox" },
  description: "Schedule and track outreach emails.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f6f9" },
    { media: "(prefers-color-scheme: dark)", color: "#0e141c" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Every page renders per request so Next can attach the CSP nonce from proxy.ts.
  await connection();
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
