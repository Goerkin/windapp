#!/usr/bin/env node
/**
 * Vervollständigt den Next-Standalone-Build für den App-Betrieb.
 *
 * `next build` (output: "standalone") legt .next/standalone/server.js an, kopiert aber
 * static/ und public/ NICHT hinein. Dieses Skript holt das nach, damit `node run-app.mjs`
 * alles findet. Läuft nach dem Build (npm run build:app).
 */
import { cp, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const standalone = join(root, ".next", "standalone");
if (!existsSync(standalone)) {
  console.error("[assemble] .next/standalone fehlt — zuerst `next build` ausführen.");
  process.exit(1);
}

await mkdir(join(standalone, ".next"), { recursive: true });
await cp(join(root, ".next", "static"), join(standalone, ".next", "static"), {
  recursive: true,
});
if (existsSync(join(root, "public"))) {
  await cp(join(root, "public"), join(standalone, "public"), { recursive: true });
}

// Prisma (engineType "client") lädt query_compiler_bg.wasm zur Laufzeit über einen Pfad,
// nicht per import — Nexts File-Tracing kopiert die .wasm nicht ins Standalone. Ohne sie:
// "ENOENT ... query_compiler_bg.wasm". Deshalb hier nachziehen.
const prismaSrc = join(root, "node_modules", ".prisma", "client");
const prismaDst = join(standalone, "node_modules", ".prisma", "client");
if (existsSync(prismaSrc)) {
  await mkdir(prismaDst, { recursive: true });
  for (const f of await readdir(prismaSrc)) {
    if (f.endsWith(".wasm")) await cp(join(prismaSrc, f), join(prismaDst, f));
  }
}
console.log("[assemble] static/, public/ und Prisma-.wasm in .next/standalone kopiert.");
