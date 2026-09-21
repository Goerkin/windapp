#!/usr/bin/env node
/**
 * Startet den Next-Standalone-Server mit dem Port, den die Apps-Plattform vorgibt.
 *
 * Warum nicht direkt `command: [node, .next/standalone/server.js]`? Weil die Plattform den
 * Befehl OHNE Shell ausführt: `${DATABRICKS_APP_PORT}` würde NICHT ersetzt. Der Next-Server
 * liest PORT/HOSTNAME aus der Umgebung — dieser Starter setzt sie aus der von der Plattform
 * vergebenen Variable. Der Port MUSS aus DATABRICKS_APP_PORT kommen und die Adresse 0.0.0.0
 * sein (localhost => 502).
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

process.env.PORT = process.env.DATABRICKS_APP_PORT ?? process.env.PORT ?? "8000";
process.env.HOSTNAME = "0.0.0.0";
process.env.WIND_RUNTIME = process.env.WIND_RUNTIME ?? "databricks-app";

const standalone = join(here, ".next", "standalone", "server.js");
if (!existsSync(standalone)) {
  console.error(
    "[windguru] .next/standalone/server.js fehlt — bitte zuerst `npm run build:app` " +
      "ausführen. Siehe DATABRICKS.md.",
  );
  process.exit(1);
}

console.log(`[windguru] Starte Next-Standalone auf 0.0.0.0:${process.env.PORT}`);
// server.js startet beim Import selbst den Listener (und damit instrumentation.ts → Poller).
await import(standalone);
