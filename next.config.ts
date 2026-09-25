import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: { unoptimized: true },

  // Der Service Worker darf nie aus einem HTTP-Cache kommen, sonst hängt ein Update fest.
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },

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
