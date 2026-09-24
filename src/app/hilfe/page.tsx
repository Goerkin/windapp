import type { Metadata } from "next";
import Link from "next/link";
import { TH } from "@/lib/kite";
import { SPOTS } from "@/lib/spots";
import { compass } from "@/lib/units";
import { PALETTE } from "@/lib/palette";
import { VARIANTS, LEAD_LABELS } from "@/lib/calib";

export const metadata: Metadata = {
  title: "Hilfe · Wind Cockpit",
  description: "Was das Wind Cockpit zeigt und wie die Zahlen zustande kommen.",
};

// Schwellen und Richtungen kommen direkt aus dem Code (kite.ts / spots.ts) — die Hilfe
// bleibt so automatisch aktuell.

const sector = ([from, to]: [number, number]) => `${compass(from)}–${compass(to)} (${from}°–${to}°)`;

export default function HelpPage() {
  return (
    <div className="mx-auto max-w-[900px] px-4 py-6 sm:px-6">
      <header className="mb-6 flex items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-700 text-ink sm:text-3xl">So liest du das Wind Cockpit</h1>
        <Link href="/" className="chip hover:border-accent">
          ← Cockpit
        </Link>
      </header>

      <Section title="Kurz gesagt">
        <p>
          Das Cockpit nimmt die Vorhersagen von bis zu 16 Wettermodellen, die Windguru für Brouwersdam und
          Mirns bereitstellt, <b>korrigiert jedes Modell anhand der echten Messstation am Spot</b>, mischt
          sie nach ihrer nachgewiesenen Treffsicherheit und leitet daraus ab, <b>wann du wo fahren kannst</b>{" "}
          — mit einer ehrlichen Wahrscheinlichkeit dazu.
        </p>
        <Pipeline />
      </Section>

      <Section title="Was siehst du wo?">
        <Item name="Übersicht (oben)">
          Je Spot: Wind jetzt (gemessen, sonst Prognose), die gemessene Wassertemperatur und die nächsten
          Fahrfenster. Darunter das <b>Kachel-Raster</b> bis zum übernächsten Wochenende — Wochenenden gelb
          umrahmt. Tippen auf einen Tag öffnet die Tagesansicht; die Raster beider Spots scrollen gemeinsam.
        </Item>
        <Item name="Kachel-Raster">
          Spalten = Tageslicht-Stunden im 3-h-Takt. Zeilen: <b>Wind</b> und <b>Böen</b> (farbig, s. u.),{" "}
          <b>Dir</b> = Windrichtung (rot hinterlegt = ablandig/ungeeignet, gelb = bedingt), <b>%</b> =
          Wahrscheinlichkeit für mindestens {TH.min} kn, <b>mm</b> = Regen (⚡ = Verdacht auf Schauerböen),{" "}
          <b>°C</b> = Luft. Grüner Strich über der Stunde = fahrbar. Blasse Tage = nur noch grobe globale
          Modelle, entsprechend unsicher. Pfeil neben dem Datum = Tageswind seit gestern stabil / steigend /
          fallend.
        </Item>
        <Item name="Fahrfenster">
          z. B. „Do. 24.9. 8–16 Uhr · 14–19 kn · NNW · Ø 61 %“: Zeitraum, schwächste–stärkste Stunde,
          mittlere Richtung („!“ = nur bedingt geeignet) und die <b>durchschnittliche</b> stündliche
          Wahrscheinlichkeit. Dass es über das ganze Fenster hält, ist etwas weniger wahrscheinlich.
        </Item>
        <Item name="Verlauf">
          <b>Türkis</b> = Konsens-Prognose, <b>lila gestrichelt</b> = Böen, <b>pink</b> = gemessen,{" "}
          <b>hellgrau gestrichelt</b> = die Prognose von vor 24 h (so siehst du, wie gut sie zuletzt lag),{" "}
          <b>gelb</b> = nach der aktuellen Messung korrigierte nächste Stunden, <b>grüne Fläche</b> =
          Fahrfenster, <b>grün gestrichelte Linie</b> = Mindestwind. Die dezenten <b>waagerechten
          Farbbänder</b> im Hintergrund entsprechen den Kachelfarben (knapp / fahrbar / gut / kräftig / zu viel)
          — so siehst du sofort, in welchem Bereich eine Linie liegt; das gilt für alle Wind-Grafiken. Darunter die Wahrscheinlichkeit je Stunde.
          Aufklappbar: wie sich die Vorhersage über die letzten Datenstände verändert hat.
        </Item>
        <Item name="Tag">Stundenverlauf, Fenster und Tabelle (2-h-Raster) für einen Tag im Tageslicht.</Item>
        <Item name="Analyse">
          Für Neugierige: alle Einzelmodelle, welches Modell hier richtig liegt, welches Rechenverfahren
          gewinnt, ob die Prozente stimmen und wie genau der Konsens rückblickend war.
        </Item>
      </Section>

      <Section title="Farben & Schwellen">
        <p className="mb-3">Referenz ist ein Twintip-Fahrer mit 80 kg (größter Schirm ~14 m²):</p>
        <ColorScale />
      </Section>

      <Section title="Windrichtungen je Spot">
        {SPOTS.map((s) => (
          <div key={s.id} className="mb-3">
            <div className="font-600 text-ink">{s.name}</div>
            <ul className="ml-4 list-disc text-body">
              <li>
                <span style={{ color: "var(--wg-green)" }}>gut:</span> {s.dirs.good.map(sector).join(", ")}
              </li>
              <li>
                <span style={{ color: "var(--wg-amber)" }}>bedingt:</span> {s.dirs.ok.map(sector).join(", ")}
              </li>
              <li>
                <span style={{ color: "var(--wg-red)" }}>ungeeignet:</span> alles andere
              </li>
              {s.dirs.hints?.map((h) => (
                <li key={h.text} className="text-muted">
                  {h.text}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </Section>

      <Section title="Wie entsteht die Prognose?">
        <Step n={1} title="Rohdaten">
          Alle 30 min werden die Modellläufe von Windguru abgeholt (hochauflösende Küstenmodelle wie
          HARMONIE, AROME, ICON-D2 bis ~2–3 Tage; globale wie ECMWF, GFS bis 15–16 Tage) — dazu die
          Messstationen (Natural High, Mirns NKV) und die Wassertemperatur (Rijkswaterstaat).
        </Step>
        <Step n={2} title="Nachkorrektur je Modell">
          Jedes Modell hat an jedem Spot seine Macken — z. B. „3 kn zu viel bei Westwind“. Aus dem Vergleich
          Vorhersage ↔ Messung wird je Modell und <b>Vorlauf-Stufe</b> ({LEAD_LABELS.join(", ")}) gelernt:
          ein fester Versatz je Richtung (N/O/S/W), je nach Variante auch windstärkeabhängig und abhängig
          von Wasser- minus Lufttemperatur. Wenig Daten ⇒ wenig Korrektur (statistisch „geschrumpft“).
          Jeder Modelllauf zählt dabei nur einmal, jüngere Tage zählen mehr (Halbwertszeit 7 Tage).
        </Step>
        <Step n={3} title="Gewichtung">
          Modelle, die nach der Korrektur hier genauer sind, zählen mehr: Gewicht = 1 / Restfehler². Weil die
          Güte vom Vorlauf abhängt, wird das je Vorlauf-Stufe getrennt bestimmt. Ohne Historie gilt: feiner
          aufgelöst = etwas besser.
        </Step>
        <Step n={4} title="Konsens">
          Je Stunde das gewichtete Mittel der korrigierten Modelle. Da ein Mittel Spitzen glättet, zeigt die
          Tageskarte zusätzlich die „Modell-Spitze“: jedes Modell für sich, dann der mittlere Wert.
        </Step>
        <Step n={5} title="Kurzfrist-Korrektur">
          Weicht die Station gerade von der Prognose ab, wird die Abweichung auf die nächsten Stunden
          übertragen — so stark, wie sie in der Vergangenheit typischerweise angehalten hat (aus den Daten
          gelernt). Dreht der Wind um mehr als 60°, endet die Korrektur.
          <NowcastSketch />
        </Step>
        <Step n={6} title="Wahrscheinlichkeit">
          Jedes Modell bringt seinen typischen Restfehler als Glockenkurve mit; die Prozentzahl ist der
          gewichtete Anteil der Kurven oberhalb von {TH.min} kn. Ob die Prozente stimmen, wird rückblickend
          geprüft (Brier-Score) und ggf. nachjustiert.
          <ProbSketch />
        </Step>
        <Step n={7} title="Fahrfenster">
          Mindestens 2 zusammenhängende Stunden mit: Tageslicht (ab ½ h vor Sonnenaufgang bis ½ h vor
          Sonnenuntergang), Richtung nicht ungeeignet, ≥ 50 % Wahrscheinlichkeit für {TH.min} kn, unter{" "}
          {TH.over} kn und ohne Schauerböen-Verdacht (≥ 1.5 mm/h Regen und sehr böig — echte Gewitterdaten
          liefert Windguru nicht).
        </Step>
      </Section>

      <Section title="Ehrliche Selbstkontrolle">
        <p>
          Welche Rechenvariante gilt, entscheiden die Daten: Für viele frühere Zeitpunkte wird jede Variante{" "}
          <b>nur mit den Messungen gelernt, die damals schon vorlagen</b>, und dann gegen die tatsächliche
          Messung geprüft. Gewählt wird die einfachste Variante, die höchstens 0.05 kn schlechter ist als die
          beste — erst, wenn genug Vergleiche vorliegen. Die Varianten:
        </p>
        <ul className="ml-4 mt-2 list-disc text-body">
          {VARIANTS.map((v) => (
            <li key={v.key}>{v.label}</li>
          ))}
        </ul>
      </Section>

      <Section title="Weitere Kennzahlen">
        <Item name="Tageswind">Durchschnitt der 3 stärksten Tageslicht-Stunden (eine kurze Spitze allein zählt nicht).</Item>
        <Item name="Trend">Vergleich des Tageswinds mit früheren Datenständen (6 h, 1 T, 3 T, 7 T).</Item>
        <Item name="Nur globale Modelle">
          Ab etwa Tag 3 fallen die hochauflösenden Küstenmodelle weg; danach rechnen nur noch ECMWF, GFS &amp;
          Co. mit ~9–15 km Maschenweite — Tendenz ja, Details nein.
        </Item>
      </Section>

      <Section title="Datenquellen">
        <ul className="ml-4 list-disc text-body">
          <li>Windguru — Modellvorhersagen (frei abrufbar; privates Dashboard, nicht affiliiert)</li>
          <li>Messstationen: Natural High (Brouwersdam, via Windguru), Mirns NKV (soarcast/NKV)</li>
          <li>Wassertemperatur: Rijkswaterstaat (Brouwershavensche Gat, Bommenede, Friesekust IJsselmeer)</li>
        </ul>
      </Section>

      <Section title="Grenzen">
        <p>
          Die Korrektur ist nur so gut wie die Historie: In den ersten Wochen sind die Unterschiede zwischen
          Varianten oft noch Zufall. Die Station misst an einem Punkt — Böen, Abdeckung durch den Damm oder
          lokale Effekte am Wasser können abweichen. Die Prozente sind Wahrscheinlichkeiten, keine Garantien.
        </p>
      </Section>

      <div className="mt-8 text-center">
        <Link href="/" className="chip hover:border-accent">
          ← zurück zum Cockpit
        </Link>
      </div>
    </div>
  );
}

// ── Bausteine ────────────────────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel mb-4 p-5 text-sm leading-relaxed text-body">
      <h2 className="mb-3 font-display text-lg font-700 text-ink">{title}</h2>
      {children}
    </section>
  );
}

function Item({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="font-600 text-ink">{name}</div>
      <div>{children}</div>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4 flex gap-3">
      <div
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-display text-sm font-700"
        style={{ background: "var(--tint-accent)", color: "var(--wg-teal)" }}
      >
        {n}
      </div>
      <div className="min-w-0">
        <div className="font-600 text-ink">{title}</div>
        <div>{children}</div>
      </div>
    </div>
  );
}

/** Schema: Rohdaten → Korrektur → Gewichtung → Konsens → Kurzfrist → Prozente/Fenster, mit Lernschleife. */
function Pipeline() {
  const boxes = [
    { x: 10, label: "16 Modelle", sub: "Windguru" },
    { x: 150, label: "Korrektur", sub: "je Modell" },
    { x: 290, label: "Gewichtung", sub: "1/Restfehler²" },
    { x: 430, label: "Konsens", sub: "je Stunde" },
    { x: 570, label: "Kurzfrist", sub: "Station jetzt" },
    { x: 710, label: "% & Fenster", sub: "Ergebnis" },
  ];
  return (
    <svg viewBox="0 0 840 170" className="mt-4 w-full" role="img" aria-label="Rechenweg der Prognose">
      <defs>
        <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" className="fill-muted" />
        </marker>
      </defs>
      {boxes.map((b, i) => (
        <g key={b.label}>
          <rect x={b.x} y={20} width={120} height={52} rx={10} className="fill-accent" fillOpacity={0.08} stroke={i === 5 ? PALETTE.green : PALETTE.teal} strokeOpacity={0.6} />
          <text x={b.x + 60} y={43} textAnchor="middle" className="fill-ink" fontSize={14} fontWeight={600}>
            {b.label}
          </text>
          <text x={b.x + 60} y={61} textAnchor="middle" className="fill-muted" fontSize={11}>
            {b.sub}
          </text>
          {i < boxes.length - 1 && <line x1={b.x + 122} y1={46} x2={b.x + 138} y2={46} className="stroke-muted" markerEnd="url(#arr)" />}
        </g>
      ))}
      {/* Lernschleife */}
      <rect x={150} y={118} width={260} height={40} rx={10} fill="rgba(244,114,182,.08)" stroke="#f472b6" strokeOpacity={0.6} />
      <text x={280} y={136} textAnchor="middle" className="fill-ink" fontSize={13} fontWeight={600}>
        Messstation ↔ frühere Prognosen
      </text>
      <text x={280} y={151} textAnchor="middle" className="fill-muted" fontSize={11}>
        eigener Lern-Job, stündlich
      </text>
      <path d="M210 118 V76" stroke="#f472b6" strokeOpacity={0.7} markerEnd="url(#arr)" fill="none" />
      <path d="M350 118 V76" stroke="#f472b6" strokeOpacity={0.7} markerEnd="url(#arr)" fill="none" />
      <path d="M410 138 H630 V76" stroke="#f472b6" strokeOpacity={0.7} markerEnd="url(#arr)" fill="none" />
    </svg>
  );
}

function ColorScale() {
  const steps = [
    { from: 0, to: TH.min - 3, color: PALETTE.grey, label: "zu wenig" },
    { from: TH.min - 3, to: TH.min, color: PALETTE.blue, label: "knapp" },
    { from: TH.min, to: TH.good, color: PALETTE.teal, label: "fahrbar" },
    { from: TH.good, to: TH.strong, color: PALETTE.green, label: "gut" },
    { from: TH.strong, to: TH.over, color: PALETTE.amber, label: "kräftig" },
    { from: TH.over, to: TH.over + 8, color: PALETTE.orange, label: "zu viel" },
    { from: TH.over + 8, to: null, color: PALETTE.red, label: "gefährlich" },
  ];
  return (
    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-7">
      {steps.map((s) => (
        <div key={s.label} className="rounded-md px-2 py-1.5 text-center" style={{ background: s.color + "d9", color: "#0b1220" }}>
          <div className="text-[12px] font-700">{s.label}</div>
          <div className="font-mono text-[11px]">{s.to == null ? `ab ${s.from}` : `${s.from}–${s.to - 1}`} kn</div>
        </div>
      ))}
    </div>
  );
}

/** Glockenkurven dreier Modelle + Schwelle: Anteil rechts der Linie = Wahrscheinlichkeit. */
function ProbSketch() {
  const W = 520;
  const H = 120;
  const x = (kn: number) => 20 + (kn / 26) * (W - 40);
  const models = [
    { mu: 11, sd: 2.4, color: PALETTE.gust },
    { mu: 14, sd: 2.8, color: PALETTE.teal },
    { mu: 16, sd: 3.4, color: PALETTE.amber },
  ];
  const curve = (mu: number, sd: number) => {
    const pts: string[] = [];
    for (let k = 0; k <= 26; k += 0.25) {
      const y = Math.exp(-((k - mu) ** 2) / (2 * sd * sd));
      pts.push(`${x(k).toFixed(1)},${(H - 22 - y * 70).toFixed(1)}`);
    }
    return pts.join(" ");
  };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 w-full max-w-[520px]" role="img" aria-label="Wahrscheinlichkeit aus Modell-Glockenkurven">
      <rect x={x(TH.min)} y={10} width={x(26) - x(TH.min)} height={H - 32} fill={PALETTE.green} fillOpacity={0.08} />
      {models.map((m) => (
        <polyline key={m.mu} points={curve(m.mu, m.sd)} fill="none" stroke={m.color} strokeWidth={2} />
      ))}
      <line x1={x(TH.min)} y1={8} x2={x(TH.min)} y2={H - 22} stroke={PALETTE.green} strokeDasharray="5 4" />
      <text x={x(TH.min) + 4} y={20} fill={PALETTE.green} fontSize={11}>
        {TH.min} kn
      </text>
      <line x1={20} y1={H - 22} x2={W - 20} y2={H - 22} className="stroke-faint" />
      {[0, 5, 10, 15, 20, 25].map((k) => (
        <text key={k} x={x(k)} y={H - 6} textAnchor="middle" className="fill-muted" fontSize={10}>
          {k}
        </text>
      ))}
    </svg>
  );
}

/** Abklingen der Kurzfrist-Korrektur: Anteil der aktuellen Abweichung, der k Stunden später noch gilt. */
function NowcastSketch() {
  const gain = [1, 0.72, 0.52, 0.38, 0.27, 0.2, 0.14, 0.1, 0];
  return (
    <div className="mt-2 flex items-end gap-1.5" aria-label="Abklingen der Kurzfrist-Korrektur (Beispiel)">
      {gain.map((g, k) => (
        <div key={k} className="flex w-8 flex-col items-center gap-1">
          <div className="flex h-12 w-4 items-end rounded bg-[color:var(--color-bg-2)]">
            <div className="w-full rounded" style={{ height: `${g * 100}%`, background: "var(--wg-amber)", opacity: 0.8 }} />
          </div>
          <span className="font-mono text-[10px] text-muted">+{k} h</span>
        </div>
      ))}
      <span className="ml-2 text-[11px] text-faint">Beispiel — die echten Werte stehen unter Analyse → Genauigkeit</span>
    </div>
  );
}
