"use client";
import { useEffect } from "react";

// Meldet den Service Worker (public/sw.js) an. Nur im Produktions-Build: im Dev-Server
// würde er alte Seiten aus dem Cache liefern und Hot-Reload verwirren.
export default function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {});
  }, []);
  return null;
}
