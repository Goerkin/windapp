#!/usr/bin/env node
/**
 * Legt die beiden Spots direkt in der DB an (reines pg, ohne Prisma-Client) — nützlich vor
 * dem ersten Poll und als `prisma db seed`. Nutzt DATABASE_URL; Schema aus LAKEBASE_SCHEMA
 * (Standard "public"). Für Lakebase vorher DATABASE_URL via scripts/lakebase-url.mjs setzen.
 */
import pg from "pg";

const SPOTS = [
  { id: 97, slug: "brouwersdam", name: "Brouwersdam", region: "Zeeland · NL", sortOrder: 0 },
  { id: 3642, slug: "mirns", name: "Mirns", region: "Friesland · IJsselmeer · NL", sortOrder: 1 },
];

const schema = process.env.LAKEBASE_SCHEMA || "public";
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL?.replace(/[?&]sslmode=require/, "").replace(/[?&]schema=[^&]*/, ""),
  // Lakebase verlangt TLS; das Zertifikat ist aus Node heraus nicht immer verifizierbar.
  ssl: process.env.DATABASE_URL?.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined,
});

await client.connect();
for (const s of SPOTS) {
  await client.query(
    `INSERT INTO "${schema}"."Spot" (id, slug, name, region, "sortOrder", "updatedAt")
     VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (id) DO UPDATE SET slug=$2, name=$3, region=$4, "sortOrder"=$5, "updatedAt"=now()`,
    [s.id, s.slug, s.name, s.region, s.sortOrder],
  );
  console.log(`[seed] Spot ${s.id} ${s.name}`);
}
await client.end();
console.log("[seed] fertig.");
