#!/usr/bin/env node
/**
 * Druckt eine fertige Postgres-URL für Lakebase auf stdout — zum Ausführen der
 * Prisma-Migrationen gegen die Databricks-Datenbank:
 *
 *   DATABASE_URL="$(node scripts/lakebase-url.mjs)" npx prisma migrate deploy
 *
 * Braucht lokal: DATABRICKS_HOST + Auth (DATABRICKS_TOKEN als PAT ODER
 * DATABRICKS_CLIENT_ID/SECRET), dazu Endpoint/Host/DB/User.
 */
const host = (process.env.DATABRICKS_HOST || "").replace(/\/+$/, "");
if (!host) fail("DATABRICKS_HOST fehlt");

const project = process.env.LAKEBASE_PROJECT || "windguru";
const branch = process.env.LAKEBASE_BRANCH || "production";
const endpoint =
  process.env.LAKEBASE_ENDPOINT ||
  `projects/${project}/branches/${branch}/endpoints/primary`;
const database = process.env.PGDATABASE || "databricks_postgres";
const schema = process.env.LAKEBASE_SCHEMA || "windguru";
const user =
  process.env.PGUSER || process.env.DATABRICKS_CLIENT_ID || fail("PGUSER fehlt");

function fail(msg) {
  console.error(`[lakebase-url] ${msg}`);
  process.exit(1);
}

async function bearer() {
  if (process.env.DATABRICKS_TOKEN) return process.env.DATABRICKS_TOKEN;
  const id = process.env.DATABRICKS_CLIENT_ID;
  const secret = process.env.DATABRICKS_CLIENT_SECRET;
  if (!id || !secret) fail("Kein DATABRICKS_TOKEN und kein CLIENT_ID/SECRET");
  const res = await fetch(`${host}/oidc/v1/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
    },
    body: "grant_type=client_credentials&scope=all-apis",
  });
  if (!res.ok) fail(`OAuth-Token: HTTP ${res.status}`);
  return (await res.json()).access_token;
}

async function pgHost() {
  if (process.env.PGHOST) return process.env.PGHOST;
  const res = await fetch(`${host}/api/2.0/postgres/${endpoint}`, {
    headers: { Authorization: `Bearer ${await bearer()}` },
  });
  if (!res.ok) fail(`Endpoint-Auflösung: HTTP ${res.status}`);
  const data = await res.json();
  return data?.status?.hosts?.host || fail("Endpoint liefert keinen Host");
}

async function dbToken() {
  const res = await fetch(`${host}/api/2.0/postgres/credentials`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await bearer()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ endpoint }),
  });
  if (!res.ok) fail(`Lakebase-Credential: HTTP ${res.status}`);
  return (await res.json()).token || fail("Credential ohne Token");
}

const [h, token] = await Promise.all([pgHost(), dbToken()]);
const url =
  `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(token)}` +
  `@${h}:5432/${database}?sslmode=require&schema=${schema}`;
process.stdout.write(url + "\n");
