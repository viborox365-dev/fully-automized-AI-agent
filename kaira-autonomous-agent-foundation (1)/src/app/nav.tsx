"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Waypoints, MemoryStick, Wrench } from "lucide-react";

const LINKS = [
  { href: "/", label: "MISSION CONTROL", icon: Waypoints },
  { href: "/memory", label: "MEMORY", icon: MemoryStick },
  { href: "/tools", label: "TOOL BENCH", icon: Wrench },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-base/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-5 sm:px-8">
        <Link href="/" className="group flex items-baseline gap-2.5">
          <span className="font-display text-lg font-bold tracking-[0.28em] text-ink">
            KAIRA
          </span>
          <span className="font-mono text-[10px] tracking-[0.2em] text-mist group-hover:text-ember transition-colors">
            AUTONOMOUS OPERATOR
          </span>
        </Link>
        <nav className="flex items-center gap-1">
          {LINKS.map(({ href, label, icon: Icon }) => {
            const active =
              href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-2 rounded-lg px-3 py-1.5 font-mono text-[11px] tracking-[0.14em] transition-colors ${
                  active
                    ? "bg-emberdim text-ember"
                    : "text-mist hover:text-ink hover:bg-white/[0.04]"
                }`}
              >
                <Icon size={13} strokeWidth={2.2} />
                <span className="hidden sm:inline">{label}</span>
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
