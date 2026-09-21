#!/usr/bin/env node
/**
 * Löst einen Datenabruf am laufenden Server aus (POST /api/ingest?force=1).
 * Voraussetzung: der Dev-/App-Server läuft. Port über PORT (Standard 3000), optional
 * INGEST_SECRET für den Header.
 *
 *   npm run dev            # in einem Terminal
 *   npm run ingest         # in einem zweiten
 */
const port = process.env.PORT || "3000";
const url = `http://localhost:${port}/api/ingest?force=1`;
const headers = { "content-type": "application/json" };
if (process.env.INGEST_SECRET) headers["x-ingest-secret"] = process.env.INGEST_SECRET;

const res = await fetch(url, { method: "POST", headers });
const body = await res.json().catch(() => ({}));
console.log(JSON.stringify(body, null, 2));
if (!res.ok) process.exit(1);
