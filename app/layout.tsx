import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SDR Outreach Coverage",
  description: "Unique outbound contacts & companies tapped per SDR, by IST time period — sourced from HubSpot.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
