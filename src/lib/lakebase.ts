import "server-only";
import { Pool } from "pg";

/**
 * Verbindung zu Lakebase Postgres — übernommen aus ai-readiness-app.
 *
 * Lakebase authentifiziert mit einem OAuth-Token, das nach spätestens einer Stunde abläuft.
 * `pg` erlaubt `password` als Funktion — sie wird bei JEDEM neuen Verbindungsaufbau
 * aufgerufen; zusammen mit begrenzter Verbindungslebensdauer nimmt jede frische Verbindung
 * automatisch ein frisches Token.
 *
 * Drei Betriebsarten, in dieser Reihenfolge:
 *   1. PG_FORCE_ADAPTER=1 → Pool aus DATABASE_URL, kein Token (lokaler Adapter-Test).
 *   2. In einer Databricks App → Plattform spritzt PGHOST/PGDATABASE/LAKEBASE_ENDPOINT ein.
 *   3. Sonst (lokal/CI mit Databricks-Profil) → Endpoint aus Projekt/Branch, Host per REST.
 *
 * Ist keine erfüllt (lokal), läuft alles auf dem normalen Postgres-Pfad (DATABASE_URL).
 */

const TOKEN_TTL_MS = 40 * 60 * 1000;

function host(): string {
  let h = process.env.DATABRICKS_HOST?.replace(/\/+$/, "");
  if (!h) throw new Error("DATABRICKS_HOST fehlt (Lakebase-Modus)");
  if (!/^https?:\/\//.test(h)) h = `https://${h}`;
  return h;
}

export function lakebaseEnabled(): boolean {
  return (
    process.env.PG_FORCE_ADAPTER === "1" ||
    !!process.env.LAKEBASE_ENDPOINT ||
    (process.env.WIND_DB ?? "").toLowerCase() === "lakebase"
  );
}

let bearerCache: { token: string; exp: number } | null = null;

async function bearerToken(): Promise<string> {
  const pat = process.env.DATABRICKS_TOKEN;
  if (pat) return pat;

  if (bearerCache && Date.now() < bearerCache.exp) return bearerCache.token;

  const id = process.env.DATABRICKS_CLIENT_ID;
  const secret = process.env.DATABRICKS_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error("Weder DATABRICKS_TOKEN noch DATABRICKS_CLIENT_ID/SECRET gesetzt");
  }
  const res = await fetch(`${host()}/oidc/v1/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
    },
    body: "grant_type=client_credentials&scope=all-apis",
  });
  if (!res.ok) throw new Error(`OAuth-Token: HTTP ${res.status}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  bearerCache = { token: data.access_token, exp: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function endpointName(): string {
  const explicit = process.env.LAKEBASE_ENDPOINT;
  if (explicit) return explicit;
  const project = process.env.LAKEBASE_PROJECT ?? "windguru";
  const branch = process.env.LAKEBASE_BRANCH ?? "production";
  return `projects/${project}/branches/${branch}/endpoints/primary`;
}

async function resolveHost(): Promise<string> {
  if (process.env.PGHOST) return process.env.PGHOST;
  const res = await fetch(`${host()}/api/2.0/postgres/${endpointName()}`, {
    headers: { Authorization: `Bearer ${await bearerToken()}` },
  });
  if (!res.ok) throw new Error(`Endpoint-Auflösung: HTTP ${res.status}`);
  const data = (await res.json()) as { status?: { hosts?: { host?: string } } };
  const h = data.status?.hosts?.host;
  if (!h) throw new Error("Endpoint liefert keinen Host");
  return h;
}

let dbTokenCache: { token: string; exp: number } | null = null;

async function databaseToken(): Promise<string> {
  if (dbTokenCache && Date.now() < dbTokenCache.exp) return dbTokenCache.token;
  const res = await fetch(`${host()}/api/2.0/postgres/credentials`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await bearerToken()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ endpoint: endpointName() }),
  });
  if (!res.ok) throw new Error(`Lakebase-Credential: HTTP ${res.status}`);
  const data = (await res.json()) as { token: string };
  if (!data.token) throw new Error("Lakebase-Credential ohne Token");
  dbTokenCache = { token: data.token, exp: Date.now() + TOKEN_TTL_MS };
  return data.token;
}

export function makePgPool(): Pool {
  if (!lakebaseEnabled()) {
    return new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
  }
  return new Pool({
    host: process.env.PGHOST,
    database:
      process.env.PGDATABASE ?? process.env.LAKEBASE_DATABASE ?? "databricks_postgres",
    user: process.env.PGUSER ?? process.env.DATABRICKS_CLIENT_ID,
    password: async () => databaseToken(),
    ssl: { rejectUnauthorized: true },
    max: 4,
    maxLifetimeSeconds: 30 * 60,
    options: "-c statement_timeout=120000",
  });
}

export async function ensureHostResolved(): Promise<void> {
  if (lakebaseEnabled() && !process.env.PGHOST && process.env.LAKEBASE_ENDPOINT) {
    process.env.PGHOST = await resolveHost();
  }
}
