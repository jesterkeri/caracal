"use client";

import { usePathname } from "next/navigation";
import CaracalMark from "@/components/caracal-mark";

// The app's own pages share this header. The public client pages (/pay and /receipt)
// get none: a client paying an invoice needs no app navigation.
const LINKS = [
  { href: "/wallet", label: "Wallet" },
  { href: "/split", label: "Split" },
  { href: "/invoices", label: "Invoices" },
  { href: "/tax", label: "Tax" },
  { href: "/cashout", label: "Cash out" },
];

export default function AppNav() {
  const path = usePathname() ?? "/";
  // /signin carries its own brand in its hero, so it gets no header either.
  if (path.startsWith("/pay") || path.startsWith("/receipt") || path.startsWith("/signin")) return null;
  return (
    <header className="appbar">
      <a className="brand" href="/wallet">
        <CaracalMark className="h-7 w-auto text-[var(--c-green)]" />
        Caracal
      </a>
      {(
        <nav className="appbar-nav" aria-label="Main">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href} aria-current={path.startsWith(l.href) ? "page" : undefined}>
              {l.label}
            </a>
          ))}
        </nav>
      )}
      <span className="badge-testnet">Stellar testnet</span>
    </header>
  );
}
