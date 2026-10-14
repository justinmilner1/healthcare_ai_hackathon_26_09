import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Every route renders per request. The Content-Security-Policy carries a nonce minted in middleware.ts
// (design §10.8), and Next can only stamp that nonce onto its script tags while it is rendering a response
// to a real request: a statically prerendered page is built before any nonce exists, so its bootstrap
// scripts come out unsigned and `'strict-dynamic'` refuses them — the page loads and never hydrates. Route
// segment config in the root layout applies to everything under it, so this one line covers every page
// added later too. Nothing here is cacheable anyway: each page is one patient's or one clinician's data.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sweet Spot",
  description: "Sweetie talks to the patient before the visit. Sour hands the endocrinologist a one-page summary.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
