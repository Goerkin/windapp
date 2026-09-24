import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone-Build: ein selbsttragender Node-Server unter .next/standalone/server.js,
  // der nur die tatsächlich genutzten node_modules mitnimmt. Grundlage für den Betrieb als
  // Databricks App (siehe run-app.mjs und DATABRICKS.md) und hält die Auslieferung unter
  // den Größen-/Zeitgrenzen der Apps-Plattform.
  output: "standalone",
  images: { unoptimized: true },

  // Der Hintergrund-Poller läuft im Node-Server (instrumentation.ts). instrumentationHook
  // ist in Next 16 Standard; hier nur dokumentiert, dass wir darauf bauen.
  // Prisma (engineType "client") lädt query_compiler_bg.wasm zur Laufzeit über einen Pfad,
  // nicht per import — ohne diesen Eintrag fehlt sie im Funktionspaket (Vercel: ENOENT).
  // '/**' statt '/*', damit auch verschachtelte Routen wie /api/dashboard erfasst werden.
  outputFileTracingIncludes: {
    "/**": ["./node_modules/.prisma/client/*.wasm"],
  },
  outputFileTracingExcludes: {
    "*": [
      "node_modules/@img/**",
      "node_modules/sharp/**",
      "node_modules/.prisma/client/*.so.node",
      "node_modules/@prisma/engines/**",
    ],
  },
};

export default nextConfig;
