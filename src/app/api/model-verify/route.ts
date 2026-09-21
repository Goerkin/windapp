import { loadModelVerification } from "@/lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Modell-Check: Vorhersage je Modell (fester Prognose-Stand) vs. Messung für einen Tag.
 *   GET /api/model-verify?spot=<id>[&day=YYYY-MM-DD]
 * Ohne `day` wird der jüngste Tag mit Messungen genommen. `days` in der Antwort erlaubt das
 * Durchblättern.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const spot = Number(url.searchParams.get("spot"));
  const day = url.searchParams.get("day") ?? undefined;
  if (!Number.isFinite(spot)) {
    return Response.json({ ok: false, error: "spot fehlt" }, { status: 400 });
  }
  try {
    const data = await loadModelVerification(spot, day);
    return Response.json({ ok: true, data });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
