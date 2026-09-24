import "server-only";
import { prisma } from "./prisma";
import type { SpotParams } from "./calib";

/**
 * Lesezugriff auf die gelernte Modellgüte.
 *
 * Gelernt wird NICHT mehr hier: das macht `scripts/skill_job.py` als eigener Databricks-Job.
 * Solange das Lernen in der App lief (gestartet aus instrumentation.ts), fror es ein, sobald
 * die App gestoppt oder gelöscht war — die Rohdaten wuchsen weiter, Modellgüte und
 * Nachkorrektur standen still. Jetzt ist das Lernen eine Eigenschaft der Datenbasis; die App
 * liest nur das Ergebnis und wendet es über calib.ts/consensus.ts auf die Anzeige an.
 *
 * Wer die Mathematik ändert, muss BEIDE Seiten ändern: scripts/skill_job.py (lernen) und
 * src/lib/calib.ts + src/lib/consensus.ts (anwenden).
 */

export type SkillRow = {
  idModel: number;
  label: string;
  resolution: number | null;
  mae: number | null; // roher Ø Fehler (Vorlauf < 48 h), recency-gewichtet
  bias: number | null; // roher Bias (Prognose − Messung), Vorlauf < 48 h
  samples: number; // effektive Stichprobe (dedupliziert, autokorrelationsbereinigt)
  score: number; // Konsens-Gewicht 1/σ² (Vorlauf 0–24 h, gewählte Variante)
};

/** Die materialisierten Güte-Zeilen eines Spots (Anzeige). */
export async function loadSkillRows(spotId: number): Promise<SkillRow[]> {
  const rows = await prisma.modelSkill.findMany({ where: { spotId } });
  return rows.map((r) => ({
    idModel: r.idModel,
    label: r.label,
    resolution: r.resolution,
    mae: r.mae,
    bias: r.bias,
    samples: r.samples,
    score: r.score,
  }));
}

/** Gelernte Parameter eines Spots (für den Konsens); null = noch keine → Prior. */
export async function loadSpotParams(spotId: number): Promise<SpotParams | null> {
  const s = await prisma.spotStat.findUnique({ where: { spotId }, select: { params: true } });
  return (s?.params as unknown as SpotParams | null) ?? null;
}
