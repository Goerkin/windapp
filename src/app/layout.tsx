import type { Metadata, Viewport } from "next";
import { Inter, Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import ServiceWorker from "@/components/ServiceWorker";

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-inter",
  display: "swap",
});
const grotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-grotesk",
  display: "swap",
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Wind Cockpit · Brouwersdam & Mirns",
  description:
    "Windguru-Dashboard für Brouwersdam & Mirns — aktueller Wind, Modell-Konsens und Trend gegenüber früheren Datenständen.",
  // Als App auf dem iPhone-Homescreen (iOS liest das Manifest nur teilweise).
  appleWebApp: { capable: true, title: "Wind Cockpit", statusBarStyle: "default" },
  icons: { apple: "/apple-touch-icon.png" },
};

// Browserleiste in der Farbe des jeweiligen Themas (Werte = --color-bg aus globals.css).
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f6fb" },
    { media: "(prefers-color-scheme: dark)", color: "#080c17" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="de" className={`${inter.variable} ${grotesk.variable} ${mono.variable}`}>
      <body>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
