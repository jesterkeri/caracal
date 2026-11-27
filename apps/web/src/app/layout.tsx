import { Suspense } from "react";
import type { Metadata } from "next";
import { Poppins, Geist_Mono } from "next/font/google";
import AppNav from "@/components/app-nav";
import "./globals.css";

// One sans family (Poppins, as in the design) and one mono for addresses and hashes.
const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Caracal",
  description: "A passkey wallet on Stellar testnet for freelancers paid in USDC: invoices, an automatic tax, goal and spend split, a tax estimate and cash out.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${poppins.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/* AppNav reads usePathname: on dynamic routes (/pay, /receipt) a prerender needs it inside Suspense. */}
        <Suspense fallback={null}>
          <AppNav />
        </Suspense>
        {children}
      </body>
    </html>
  );
}
