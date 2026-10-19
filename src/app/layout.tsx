import type { Metadata, Viewport } from "next";
import { Nunito } from "next/font/google";
import "./globals.css";
import { SimProvider } from "@/client/provider";
import { Shell } from "@/components/layout/shell";

export const metadata: Metadata = {
  title: "Aura BaaS Resilience Simulator",
  description: "Simulated Banking-as-a-Service resilience platform: deterministic gateway protections, AI-assisted incident investigation with labelled fallback, human-approved actions, and honest AI-on vs AI-off measurement. All data is synthetic.",
};

const nunito = Nunito({ subsets: ["latin"], variable: "--font-nunito", display: "swap" });

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={nunito.variable}>
      <body className="antialiased">
        <SimProvider>
          <Shell>{children}</Shell>
        </SimProvider>
      </body>
    </html>
  );
}
