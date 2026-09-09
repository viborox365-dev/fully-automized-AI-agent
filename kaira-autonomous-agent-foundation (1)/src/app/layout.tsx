import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Nav } from "./nav";

const display = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-sg",
  weight: ["400", "500", "600", "700"],
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jm",
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Kaira — Autonomous Operator",
  description:
    "Kaira is a persistent, local-first autonomous AI operator. Objectives in, verified work out. Open-source models, modular agent architecture.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable}`}>
      <body className="min-h-dvh bg-base text-ink antialiased">
        <div className="bg-stage min-h-dvh">
          <Nav />
          <main className="mx-auto w-full max-w-6xl px-5 pb-24 pt-8 sm:px-8">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
