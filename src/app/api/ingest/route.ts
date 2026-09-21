import { ingestAll } from "@/lib/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Manuell einen Datenabruf auslösen (z. B. lokaler `npm run ingest` oder externer Cron).
 * Wenn INGEST_SECRET gesetzt ist, muss der Header `x-ingest-secret` passen.
 */
export async function POST(req: Request) {
  const secret = process.env.INGEST_SECRET;
  if (secret && req.headers.get("x-ingest-secret") !== secret) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const url = new URL(req.url);
    const force = url.searchParams.get("force") === "1";
    const res = await ingestAll(force ? {} : { minAgeMin: 15 });
    return Response.json({ ok: true, ...res });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export async function GET() {
  return Response.json({ ok: true, hint: "POST an diese Route löst einen Abruf aus." });
}
