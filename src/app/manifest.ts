import type { MetadataRoute } from "next";

// Web-App-Manifest: macht das Cockpit auf dem Handy installierbar („Zum Home-Bildschirm").
// Farben = dunkles Thema, passend zum Icon; der Splash-Screen ist nur kurz zu sehen.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Wind Cockpit · Brouwersdam & Mirns",
    short_name: "Wind Cockpit",
    description: "Kite-Windprognose für Brouwersdam & Mirns aus dem Konsens korrigierter Wettermodelle.",
    lang: "de",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0b1120",
    theme_color: "#0b1120",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
