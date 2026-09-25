#!/usr/bin/env node
/**
 * Komplett-Einrichtung der Datenbasis auf einem Databricks-Workspace — ein Befehl, idempotent
 * (mehrfach ausführbar, überspringt Erledigtes):
 *
 *   npm install
 *   databricks auth login --host https://<workspace>.cloud.databricks.com   # einmalig, legt Profil an
 *   node scripts/setup.mjs --profile <profil>
 *
 * Richtet Lakebase, den Erfassungs-Job und den Lern-Job ein. Die Oberfläche ist eine reine
 * Leseansicht und läuft auf Vercel (README) — sie ist dafür nicht nötig.
 *
 * Schritte:
 *   1. Werkzeuge prüfen (Databricks CLI, Node ≥ 20)
 *   2. Lakebase-Projekt anlegen, falls nicht vorhanden (Branch „production", Endpoint „primary")
 *   3. Schema anlegen, Tabellen einspielen (Prisma), Altdaten umstellen, Spots eintragen
 *   4. Bundle deployen: Erfassungs-Job + Lern-Job
 *   5. Einen ersten Datenabruf und einen ersten Lernlauf starten
 *
 * Optionen:
 *   --profile <p>          Databricks-CLI-Profil (sonst DEFAULT)
 *   --target <t>           Bundle-Target (sonst dev)
 *   --project <id>         Lakebase-Projekt (windguru). Free Edition erlaubt nur EIN Projekt
 *                          je Account — hat der Account schon eins, dessen ID hier angeben.
 *   --data-only            nur Schritte 1–3 (Datenbank), kein Deploy
 */
import { execFileSync, spawnSync } from "node:child_process";
import pg from "pg";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);

const PROFILE = opt("profile", process.env.DATABRICKS_CONFIG_PROFILE || "DEFAULT");
const TARGET = opt("target", "dev");
const PROJECT = opt("project", "windguru");
const BRANCH = "production";
const SCHEMA = "windguru"; // muss zu databricks.yml (lakebase_schema) und LAKEBASE_SCHEMA auf Vercel passen

const step = (n, msg) => console.log(`\n\x1b[36m[${n}]\x1b[0m ${msg}`);
const ok = (msg) => console.log(`    \x1b[32m✓\x1b[0m ${msg}`);
const die = (msg) => {
  console.error(`\n\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
};

/** databricks-CLI aufrufen; JSON zurück (oder Rohtext). */
function dbx(cliArgs, { json = true, allowFail = false, profile = true } = {}) {
  const r = spawnSync("databricks", [...cliArgs, ...(profile ? ["-p", PROFILE] : []), ...(json ? ["-o", "json"] : [])], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) die(`Databricks CLI nicht gefunden (${r.error.message}). Installieren: https://docs.databricks.com/dev-tools/cli/install`);
  if (r.status !== 0) {
    if (allowFail) return null;
    die(`databricks ${cliArgs.join(" ")}\n${r.stderr || r.stdout}`);
  }
  if (!json) return r.stdout;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return r.stdout;
  }
}

/** Befehl mit sichtbarer Ausgabe ausführen (lange Schritte wie Build/Deploy). */
function run(cmd, cmdArgs, env = {}) {
  const r = spawnSync(cmd, cmdArgs, { stdio: "inherit", env: { ...process.env, ...env }, shell: process.platform === "win32" });
  if (r.status !== 0) die(`Fehlgeschlagen: ${cmd} ${cmdArgs.join(" ")}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. Werkzeuge ───────────────────────────────────────────────────────────────────────
step(1, "Werkzeuge prüfen");
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 20) die(`Node ≥ 20 nötig (gefunden ${process.versions.node}).`);
const cliVersion = dbx(["-v"], { json: false, profile: false }).trim();
ok(`Node ${process.versions.node}, ${cliVersion}`);
const host = dbx(["auth", "describe"])?.details?.host;
if (!host) die(`Profil „${PROFILE}" nicht angemeldet. Erst: databricks auth login --host <workspace-url> --profile ${PROFILE}`);
const user = dbx(["current-user", "me"]).userName;
ok(`Workspace ${host} als ${user}`);

// ── 2. Lakebase-Projekt ─────────────────────────────────────────────────────────────────
step(2, `Lakebase-Projekt „${PROJECT}"`);
const existing = dbx(["postgres", "get-project", `projects/${PROJECT}`], { allowFail: true });
if (existing?.name) {
  ok("existiert bereits");
} else {
  console.log("    lege an (dauert 1–3 min) …");
  const created = dbx(["postgres", "create-project", PROJECT], { allowFail: true });
  if (!created) {
    const all = dbx(["postgres", "list-projects"], { allowFail: true });
    const names = (Array.isArray(all) ? all : all?.projects ?? []).map((p) => p.name?.replace("projects/", ""));
    die(
      `Projekt konnte nicht angelegt werden. Free Edition erlaubt nur EIN Lakebase-Projekt je Account.` +
        (names.length ? `\n  Vorhanden: ${names.join(", ")} → erneut mit --project <id> starten` : "") +
        `\n  (dann auch lakebase_project in databricks.yml bzw. --var lakebase_project=<id> beim Deploy setzen)`,
    );
  }
  ok("angelegt");
}
const endpoint = `projects/${PROJECT}/branches/${BRANCH}/endpoints/primary`;
for (let i = 0; ; i++) {
  const ep = dbx(["postgres", "get-endpoint", endpoint], { allowFail: true });
  if (ep?.status?.hosts?.host) {
    ok(`Endpoint bereit (${ep.status.hosts.host})`);
    break;
  }
  if (i > 30) die(`Endpoint ${endpoint} nicht bereit.`);
  await sleep(10000);
}

// ── 3. Datenbank: Schema, Tabellen, Spots ───────────────────────────────────────────────
step(3, `Datenbank: Schema „${SCHEMA}", Tabellen, Spots`);
const dbEnv = {
  DATABRICKS_HOST: host,
  DATABRICKS_TOKEN: dbx(["auth", "token"]).access_token,
  PGUSER: user,
  LAKEBASE_PROJECT: PROJECT,
  LAKEBASE_BRANCH: BRANCH,
  LAKEBASE_SCHEMA: SCHEMA,
};
const lakebaseUrl = () =>
  execFileSync(process.execPath, ["scripts/lakebase-url.mjs"], { env: { ...process.env, ...dbEnv }, encoding: "utf8" }).trim();
const plainUrl = (u) => u.replace(/[?&]sslmode=require/, "").replace(/[?&]schema=[^&]*/, "");

async function sql(statements) {
  const client = new pg.Client({ connectionString: plainUrl(lakebaseUrl()), ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    for (const s of statements) await client.query(s);
  } finally {
    await client.end();
  }
}

await sql([`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`]);
ok("Schema vorhanden");
run("npx", ["prisma", "generate"]);
run("npx", ["prisma", "db", "push", "--skip-generate"], { DATABASE_URL: lakebaseUrl() });
ok("Tabellen aktuell");
run(process.execPath, ["scripts/migrate-runs.mjs"], { DATABASE_URL: lakebaseUrl(), LAKEBASE_SCHEMA: SCHEMA });
ok("Modell-Reihen umgestellt (ModelSeries → ModelRun)");
run(process.execPath, ["scripts/seed-spots.mjs"], { DATABASE_URL: lakebaseUrl(), LAKEBASE_SCHEMA: SCHEMA });
ok("Spots eingetragen");

if (flag("data-only")) {
  console.log("\n--data-only: fertig (kein Deploy).");
  process.exit(0);
}

// ── 4. Deploy ───────────────────────────────────────────────────────────────────────────
const deployVars = ["--var", `lakebase_project=${PROJECT}`];
step(4, "Bundle deployen (Erfassungs-Job + Lern-Job)");
run("databricks", ["bundle", "deploy", "-t", TARGET, "-p", PROFILE, ...deployVars]);
ok("deployt");

// ── 5. Erster Datenabruf + erster Lernlauf ──────────────────────────────────────────────
step(5, "Erster Datenabruf (Job) — dauert ~1–2 min");
run("databricks", ["bundle", "run", "windguru_ingest", "-t", TARGET, "-p", PROFILE, ...deployVars]);
ok("Daten da");

step(6, "Erster Lernlauf (Job)");
run("databricks", ["bundle", "run", "windguru_skill", "-t", TARGET, "-p", PROFILE, ...deployVars]);
ok("Güte und Nachkorrektur berechnet");

console.log("\n\x1b[32m✓ Fertig.\x1b[0m Die Datenbasis läuft (Erfassung alle 30 min, Lernen stündlich).");
console.log("  Ansehen: lokal `npm run dev` gegen dieselbe DB oder die Vercel-App (siehe README).");
