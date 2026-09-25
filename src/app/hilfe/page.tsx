import type { Metadata } from "next";
import Link from "next/link";
import { TH, MIN_WINDOW_H, FRONT_TURN_DEG } from "@/lib/kite";
import { SPOTS } from "@/lib/spots";
import { compass } from "@/lib/units";
import { PALETTE } from "@/lib/palette";
import { HORIZON_H } from "@/lib/consensus";
import {
  VARIANTS,
  DEFAULT_VARIANT,
  LEAD_LABELS,
  LEARN,
  MAX_CORR_KN,
  RIDGE,
  priorMAE,
  priorSigma,
  variantOf,
  type Mode,
} from "@/lib/calib";

export const metadata: Metadata = {
  title: "Hilfe · Wind Cockpit",
  description: "Was das Wind Cockpit zeigt und wie die Zahlen im Detail zustande kommen.",
};

// Schwellen, Richtungen, Varianten und die Stellschrauben des Lern-Jobs kommen direkt aus dem
// Code (kite.ts / spots.ts / calib.ts) — die Hilfe bleibt so automatisch aktuell. Die Werte
// des Python-Lern-Jobs spiegelt LEARN; tests/learn-config.test.ts hält beide gleich.

const REPO_URL = "https://github.com/Goerkin/windapp";

const sector = ([from, to]: [number, number]) => `${compass(from)}–${compass(to)} (${from}°–${to}°)`;
const fmt = (v: number, d = 1) => v.toLocaleString("de-DE", { maximumFractionDigits: d });

const MODE_TEXT: Record<Mode, string> = {
  raw: "keine Korrektur — die Modellwerte, wie Windguru sie liefert",
  add: "fester Versatz je Modell, getrennt nach Windrichtung (N/O/S/W)",
  lin: "wie zuvor, zusätzlich windstärkeabhängig (z. B. „bei Flaute zu viel, bei Sturm zu wenig“)",
  linT: "wie zuvor, zusätzlich abhängig von Wasser- minus Lufttemperatur",
};

const TOC: { id: string; label: string }[] = [
  { id: "kurz", label: "Kurz gesagt" },
  { id: "anzeige", label: "Was siehst du wo?" },
  { id: "farben", label: "Farben & Schwellen" },
  { id: "richtungen", label: "Windrichtungen je Spot" },
  { id: "rechenweg", label: "Rechenweg im Überblick" },
  { id: "daten", label: "1 · Daten sammeln" },
  { id: "fehler", label: "2 · Aus Fehlern lernen" },
  { id: "korrektur", label: "3 · Korrektur je Modell" },
  { id: "gewicht", label: "4 · Gewichtung" },
  { id: "konsens", label: "5 · Konsens" },
  { id: "rueckschau", label: "6 · Ehrliche Rückschau" },
  { id: "wahrscheinlichkeit", label: "7 · Wahrscheinlichkeit" },
  { id: "kurzfrist", label: "8 · Kurzfrist-Korrektur" },
  { id: "fenster", label: "9 · Fahrfenster & Kennzahlen" },
  { id: "grenzen", label: "Grenzen" },
  { id: "quellen", label: "Datenquellen & Code" },
];

export default function HelpPage() {
  const def = variantOf(DEFAULT_VARIANT);
  return (
    <div className="mx-auto max-w-[900px] px-4 py-6 sm:px-6">
      <header className="mb-6 flex items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-700 text-ink sm:text-3xl">So arbeitet das Wind Cockpit</h1>
        <Link href="/" className="chip hover:border-accent">
          ← Cockpit
        </Link>
      </header>

      <nav className="panel-flat mb-4 p-4 text-sm" aria-label="Inhalt">
        <div className="mb-2 font-600 text-ink">Inhalt</div>
        <ol className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
          {TOC.map((t) => (
            <li key={t.id}>
              <a href={`#${t.id}`} className="text-body hover:text-accent">
                {t.label}
              </a>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-xs text-muted">
          Die ersten vier Abschnitte erklären die Anzeige. Ab „Rechenweg“ geht es für Neugierige ins Detail —
          mit den echten Formeln und Stellschrauben aus dem Code.
        </p>
      </nav>

      {/* ── Teil 1: Bedienung ─────────────────────────────────────────────────────────── */}

      <Section id="kurz" title="Kurz gesagt">
        <p>
          Das Cockpit nimmt die Vorhersagen von bis zu 16 Wettermodellen, die Windguru für Brouwersdam und
          Mirns bereitstellt, <b>vergleicht sie laufend mit der echten Messstation am Spot</b>, korrigiert ihre
          typischen Fehler, mischt sie nach ihrer nachgewiesenen Treffsicherheit und leitet daraus ab,{" "}
          <b>wann du wo fahren kannst</b> — mit einer Wahrscheinlichkeit, die rückblickend überprüft wird.
        </p>
      </Section>

      <Section id="anzeige" title="Was siehst du wo?">
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
          — das gilt für alle Wind-Grafiken. Darunter die Wahrscheinlichkeit je Stunde. Aufklappbar: wie sich
          die Vorhersage über die letzten Datenstände verändert hat.
        </Item>
        <Item name="Tag">Stundenverlauf, Fenster und Tabelle (2-h-Raster) für einen Tag im Tageslicht.</Item>
        <Item name="Analyse">
          Alle Einzelmodelle roh und korrigiert, und für jede Stunde die komplette Rechnung („Wie entsteht der
          Wert?“: Rohwert, Korrektur und Anteil jedes Modells — und welche Modelle warum fehlen). Dazu, was
          das Lernen je Modell, Vorlauf und Windrichtung herausgefunden hat, welches Modell hier richtig
          liegt, welche Rechenvariante gewinnt, ob die Prozente stimmen und wie genau der Konsens
          rückblickend war — also die <b>aktuellen Zahlen</b> zu allem, was ab „Rechenweg“ beschrieben ist.
        </Item>
      </Section>

      <Section id="farben" title="Farben & Schwellen">
        <p className="mb-3">Referenz ist ein Twintip-Fahrer mit 80 kg (größter Schirm ~14 m²):</p>
        <ColorScale />
      </Section>

      <Section id="richtungen" title="Windrichtungen je Spot">
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

      {/* ── Teil 2: Rechenweg ─────────────────────────────────────────────────────────── */}

      <Section id="rechenweg" title="Rechenweg im Überblick">
        <p>
          Die Grundidee: Jedes Wettermodell irrt sich an einem bestimmten Spot auf seine eigene, oft
          wiederkehrende Art. Wer lange genug mitschreibt, was ein Modell vorhergesagt hat und was die Station
          dann gemessen hat, kann diese Fehler lernen, herausrechnen und den Modellen, die hier gut liegen, mehr
          Gewicht geben. Das ist im Kleinen, was Wetterdienste „MOS“ (Model Output Statistics) nennen.
        </p>
        <Pipeline />
        <p className="mt-3">Drei getrennte Teile arbeiten zusammen:</p>
        <ul className="ml-4 mt-1 list-disc">
          <li>
            <b>Erfassungs-Job</b> (alle 30 min, rund um die Uhr): holt Modellläufe, Messungen und
            Wassertemperatur und speichert sie. Er ist der einzige, der Rohdaten schreibt.
          </li>
          <li>
            <b>Lern-Job</b> (stündlich): vergleicht frühere Prognosen mit den Messungen, lernt daraus die
            Korrekturen, Gewichte, die Kalibrierung der Prozente und das Abklingen der Kurzfrist-Korrektur und
            prüft alles ehrlich rückblickend.
          </li>
          <li>
            <b>Diese Seite</b>: liest den neuesten Datenstand und die gelernten Parameter und wendet sie bei
            jedem Aufruf an. Sie lernt und schreibt nichts — ist sie offline, lernt die Datenbasis trotzdem
            weiter.
          </li>
        </ul>
      </Section>

      <Section id="daten" title="1 · Daten sammeln">
        <p>
          Alle 30 Minuten entsteht ein <b>Datenstand</b> je Spot: die jeweils neuesten Läufe aller Modelle,
          die Windguru dort anbietet — hochauflösende Küstenmodelle wie HARMONIE, AROME oder ICON-D2 (1–3 km,
          reichen etwa 2–3 Tage) und globale wie ECMWF oder GFS (9–15 km, bis 15–16 Tage). Jede Modell-Reihe
          wird dabei nur einmal gespeichert, auch wenn sie in vielen Datenständen vorkommt. Dazu die
          Messstationen am Spot (Natural High liefert 10-Minuten-Mittel und wird bei jedem Abruf für die
          letzten Stunden nachgeholt, Mirns NKV nur mit dem jeweils aktuellen Wert) und die gemessene
          Wassertemperatur von Rijkswaterstaat.
        </p>
        <p className="mt-2">
          Weil alle alten Datenstände aufbewahrt werden, lässt sich später für jeden beliebigen Zeitpunkt
          nachvollziehen, <b>was die Modelle damals vorhergesagt haben</b> — die Grundlage für alles Weitere.
          Nach drei Wochen wird verdichtet: Es bleibt ein Datenstand je 6 Stunden.
        </p>
      </Section>

      <Section id="fehler" title="2 · Aus Fehlern lernen">
        <p>
          Für jede gemessene Stunde und jeden Modelllauf, der diese Stunde vorher vorhergesagt hat, entsteht
          eine <b>Fehler-Stichprobe</b>:
        </p>
        <Formula>Fehler = Prognose − Messung (Stundenmittel der Station)</Formula>
        <p>
          Zu jeder Stichprobe merkt sich der Lern-Job die Umstände: Welches Modell, wie weit im Voraus (die{" "}
          <b>Vorlauf-Stufe</b>: {LEAD_LABELS.join(", ")}), aus welcher Richtung, wie stark, und wie warm Wasser
          und Luft waren. Damit das Lernen nicht an Zufällen hängt, gelten ein paar Regeln:
        </p>
        <ul className="ml-4 mt-2 list-disc">
          <li>
            <b>Jeder Lauf zählt einmal.</b> Windguru liefert denselben Modelllauf oft über mehrere Datenstände
            hinweg. Je Modell wird höchstens ein Lauf pro {LEARN.runSpacingH} h berücksichtigt.
          </li>
          <li>
            <b>Jüngeres zählt mehr.</b> Gewicht einer Stichprobe = 0,5<sup>Alter / {LEARN.halfLifeDays} Tage</sup>{" "}
            — nach {LEARN.halfLifeDays} Tagen zählt sie halb, nach {2 * LEARN.halfLifeDays} ein Viertel. Gelernt
            wird aus den letzten {LEARN.windowDays} Tagen, bis {LEARN.horizonH / 24} Tage Vorlauf.
          </li>
          <li>
            <b>Nachbarstunden sind nicht unabhängig.</b> Liegt ein Modell um 14 Uhr daneben, dann meist auch um
            15 Uhr. Darum zählen {LEARN.autocorrH} Stunden nur wie eine unabhängige Beobachtung — das bremst
            übereifriges Lernen aus wenigen Wetterlagen.
          </li>
        </ul>
      </Section>

      <Section id="korrektur" title="3 · Korrektur je Modell">
        <p>
          Je Spot, Modell und Vorlauf-Stufe wird der erwartete Fehler als lineares Modell geschätzt:
        </p>
        <Formula>
          Fehler ≈ β₀ + s<sub>Richtung</sub> + β₁ · (Prognose − 12 kn) + β₂ · (T<sub>Wasser</sub> − T
          <sub>Luft</sub>)
        </Formula>
        <ul className="ml-4 list-disc">
          <li>
            <b>β₀ + s<sub>Richtung</sub></b>: fester Versatz, je Himmelsrichtung-Viertel (N/O/S/W) verschieden
            — z. B. „bei Westwind 2 kn zu viel“, weil das Modell die Abschattung durch den Damm nicht kennt.
          </li>
          <li>
            <b>β₁</b>: windstärkeabhängiger Fehler — manche Modelle übertreiben bei Flaute und unterschätzen
            Starkwind.
          </li>
          <li>
            <b>β₂</b>: Schichtung. Ist das Wasser wärmer als die Luft, wird die Luft durchmischt und an der
            Küste kommt mehr vom Höhenwind an; ist es kälter, liegt der Wind wie auf einer Glasplatte.
          </li>
        </ul>
        <p className="mt-2">
          Der korrigierte Wert ist dann <Mono>Prognose − erwarteter Fehler</Mono>, höchstens um ±{MAX_CORR_KN}{" "}
          kn verschoben und nie unter 0. Die Böen verschieben sich um denselben Betrag.
        </p>
        <Item name="Vorsicht bei wenig Daten („Shrinkage“)">
          Geschätzt wird per Ridge-Regression: Jeder Term startet bei „keine Korrektur“ und muss sich erst
          gegen eine Strafe durchsetzen. Anschaulich braucht der Gesamtversatz etwa {RIDGE[0]} effektive
          Stunden Evidenz, ein Richtungs-Versatz {RIDGE[1]}, die Windstärke- und Temperatur-Terme deutlich
          mehr. Mit wenigen Daten bleibt die Korrektur also klein — sie wächst erst, wenn der Fehler
          wiederholt und eindeutig auftritt.
        </Item>
        <Example>
          ICON-D2 sagt 16 kn aus West. Gelernt: β₀ = +0,9 kn, s<sub>West</sub> = +0,6 kn → erwarteter Fehler
          1,5 kn → korrigiert <b>14,5 kn</b>.
        </Example>
        <p className="mt-3">
          Welche Terme tatsächlich benutzt werden, ist nicht festgelegt — das entscheiden die Daten (Schritt 6).
          Zur Wahl stehen:
        </p>
        <ul className="ml-4 mt-1 list-disc">
          {VARIANTS.map((v) => (
            <li key={v.key}>
              <b>{v.label}</b>: {MODE_TEXT[v.mode]}
              {v.weights === "equal" ? ", alle Modelle gleich gewichtet" : ", gewichtet nach Güte"}.
            </li>
          ))}
        </ul>
      </Section>

      <Section id="gewicht" title="4 · Gewichtung">
        <p>
          Nach der Korrektur bleibt je Modell ein <b>Restfehler σ</b> (typische Abweichung in kn). Modelle mit
          kleinem Restfehler zählen mehr:
        </p>
        <Formula>Gewicht = 1 / σ²</Formula>
        <p>
          Ein Modell mit σ = 2 kn zählt also viermal so viel wie eines mit σ = 4 kn. Weil die Güte mit dem
          Vorlauf sinkt, wird σ je Vorlauf-Stufe getrennt bestimmt.
        </p>
        <p className="mt-2">
          Das Gewicht gilt <b>je Stunde</b>. Ein Kurzfrist-Modell wie HARMONIE zählt morgen genauso viel wie
          ein globales — übermorgen Abend ist seine Reichweite zu Ende, dann verteilt sich das Gewicht auf die
          übrigen. Über 16 Tage gerechnet sähe es deshalb unwichtig aus; die Analyse zeigt darum immer den
          Anteil im gewählten Zeitraum bzw. in der gewählten Stunde.
        </p>
        <Item name="Ohne Historie: feiner = besser">
          Solange ein Modell kaum Stichproben hat, gilt ein Startwert aus seiner Auflösung: erwarteter Fehler
          z. B. {fmt(priorMAE(2))} kn bei 2 km, {fmt(priorMAE(9))} kn bei 9 km, {fmt(priorMAE(13))} kn bei 13 km
          (σ ist das 1,25-Fache und wächst mit jeder Vorlauf-Stufe um 12 %). Der gemessene Restfehler wird mit
          diesem Startwert verrechnet, als wären es {LEARN.sigmaPriorN} zusätzliche Stunden:
        </Item>
        <Formula>
          σ = √( (Summe der Restfehler² + {LEARN.sigmaPriorN} · σ<sub>Start</sub>²) / (Stunden + {LEARN.sigmaPriorN}) )
        </Formula>
        <p>
          Beispiel ohne Daten: ein 2-km-Modell hat für 0–24 h σ = {fmt(priorSigma(2, 0))} kn, ein 13-km-Modell{" "}
          {fmt(priorSigma(13, 0))} kn — das feine Modell zählt damit rund{" "}
          {fmt((priorSigma(13, 0) / priorSigma(2, 0)) ** 2)}-mal so viel.
        </p>
      </Section>

      <Section id="konsens" title="5 · Konsens">
        <p>
          Je Stunde, bis {HORIZON_H / 24} Tage voraus, das gewichtete Mittel aller korrigierten Modelle, die
          diese Stunde abdecken (zwischen den Modell-Zeitschritten wird linear interpoliert):
        </p>
        <Formula>Konsens = Σ (Gewicht × korrigierter Wind) / Σ Gewicht</Formula>
        <p>
          Die Windrichtung wird als Vektor gemittelt (damit 350° und 10° nicht 180° ergeben). Temperatur, Regen
          und Wolken werden genauso gewichtet gemittelt. Aus der Streuung der Modelle um den Konsens entstehen
          Min/Max und die Standardabweichung.
        </p>
        <p className="mt-2">
          Ein Mittel glättet Spitzen — sehen zwei Modelle die Front um 11 bzw. 15 Uhr, zeigt der Konsens einen
          flachen Buckel. Darum nennt die Tageskarte zusätzlich die <b>Modell-Spitze</b>: erst jedes Modell für
          sich (Ø seiner 3 stärksten Tageslicht-Stunden), dann der Median darüber, gewichtet mit den
          Stundengewichten des Modells an diesem Tag.
        </p>
      </Section>

      <Section id="rueckschau" title="6 · Ehrliche Rückschau">
        <p>
          Die wichtigste Regel: <b>Eine Prognose wird nur mit dem geprüft, was damals schon bekannt war.</b>{" "}
          Wer mit denselben Daten lernt und prüft, bekommt schöne, aber falsche Zahlen. Deshalb spielt der
          Lern-Job die Vergangenheit nach:
        </p>
        <RollingSketch />
        <ol className="ml-4 mt-2 list-decimal">
          <li>
            Er wählt bis zu {LEARN.verifMaxSnaps} frühere Datenstände aus (frühestens {LEARN.verifMinHistoryD}{" "}
            Tage nach Beginn der Aufzeichnung, damit schon etwas gelernt werden konnte).
          </li>
          <li>Für jeden lernt er die Korrekturen <b>nur aus Messungen, die zu diesem Zeitpunkt vorlagen</b>.</li>
          <li>
            Dann rechnet er den Konsens jeder Variante so, wie er damals ausgesehen hätte, und vergleicht ihn{" "}
            {LEARN.verifLeads.join(", ")} h später mit der Messung.
          </li>
        </ol>
        <p className="mt-2">
          Daraus entstehen die Kennzahlen unter Analyse → Genauigkeit: mittlerer Fehler (MAE), systematische
          Abweichung (Bias) und die Trefferquote (höchstens {LEARN.verifTolKn} kn daneben). Berichtet wird
          dabei immer die Variante (und der Streuungsfaktor), die <b>zu diesem Zeitpunkt</b> gewählt gewesen
          wäre — nicht die, die sich am Ende als beste herausstellt. Sonst würde dieselbe Rückschau erst die
          Variante aussuchen und sie dann mit genau den Fällen loben, nach denen sie ausgesucht wurde.
        </p>
        <Item name="Welche Variante gilt?">
          Gewählt wird die <b>einfachste</b> Variante, die im Mittel über alle Vorläufe höchstens{" "}
          {fmt(LEARN.selectTolKn, 2)} kn schlechter ist als die beste. Eine aufwendigere Korrektur muss sich also
          klar lohnen. Das passiert erst ab {LEARN.selectMinN} Vergleichen bei 24 h Vorlauf — vorher gilt „
          {def.label}“.
        </Item>
      </Section>

      <Section id="wahrscheinlichkeit" title="7 · Wahrscheinlichkeit">
        <p>
          Statt nur zu zählen, wie viele Modelle über {TH.min} kn liegen, bringt jedes Modell seinen typischen
          Restfehler σ als Glockenkurve um seinen korrigierten Wert mit. Die Prozentzahl ist der gewichtete
          Anteil aller Kurven oberhalb der Schwelle (in der Statistik „Ensemble-Dressing“):
        </p>
        <Formula>
          P(Wind ≥ {TH.min} kn) = Σ Gewicht · (1 − Φ(({TH.min} − Wind) / σ)) / Σ Gewicht
        </Formula>
        <ProbSketch />
        <Example>
          Ein Modell sagt korrigiert 14,5 kn bei σ = 2 kn: (13 − 14,5) / 2 = −0,75 → 77 % seiner Kurve liegen
          über 13 kn. Ein zweites mit 11 kn und σ = 3 kn trägt 25 % bei. Bei gleichem Gewicht ergibt das 51 %.
        </Example>
        <Item name="Stimmen die Prozente?">
          Die Rückschau prüft auch das: Von allen Stunden mit „60–80 %“ sollten rund 70 % tatsächlich fahrbar
          gewesen sein. Sind die Kurven zu schmal oder zu breit, wird σ insgesamt mit einem Faktor aus{" "}
          {LEARN.sigmaScales.map((s) => fmt(s, 2)).join(" / ")} skaliert — gewählt nach dem Brier-Score, dem
          mittleren quadratischen Fehler der Prozente. Das geschieht erst ab {LEARN.probMinN} Vergleichen.
        </Item>
      </Section>

      <Section id="kurzfrist" title="8 · Kurzfrist-Korrektur">
        <p>
          Für die nächsten Stunden ist die Station selbst die beste Information. Weicht die Messung gerade von
          der Prognose ab, wird die Abweichung in die nächsten Stunden übertragen:
        </p>
        <Formula>Korrektur nach k Stunden = (Messung − Prognose jetzt) × Nachlauf(k)</Formula>
        <ul className="ml-4 list-disc">
          <li>„Messung jetzt“ = Mittel der letzten Stunde der Station, nur wenn höchstens 90 min alt.</li>
          <li>
            Der <b>Nachlauf</b> ist gelernt: Wie viel einer Abweichung war in der Vergangenheit k Stunden später
            noch da? Mit wenig Daten gilt ein Standard-Abklingen e<sup>−k/{LEARN.nowcastPriorTau}</sup>{" "}
            (halbiert sich nach ~2 h). Nach {LEARN.nowcastK} Stunden ist Schluss.
          </li>
          <li>
            Dreht der Wind laut Prognose um mehr als {FRONT_TURN_DEG}°, endet die Korrektur sofort — nach einer
            Front oder einsetzender Seebrise sagt die alte Abweichung nichts mehr.
          </li>
        </ul>
        <NowcastSketch />
      </Section>

      <Section id="fenster" title="9 · Fahrfenster & Kennzahlen">
        <Item name="Fahrbare Stunde">
          Eine Stunde gilt als fahrbar, wenn alles zusammenkommt:
          <ul className="ml-4 mt-1 list-disc">
            <li>Tageslicht (ab ½ h vor Sonnenaufgang bis ½ h vor Sonnenuntergang)</li>
            <li>Richtung nicht ungeeignet (s. Windrichtungen je Spot)</li>
            <li>mindestens 50 % Wahrscheinlichkeit für {TH.min} kn, inkl. Kurzfrist-Korrektur</li>
            <li>unter {TH.over} kn</li>
            <li>
              kein Schauerböen-Verdacht: ≥ 1,5 mm/h Regen und sehr böig (Böe ≥ 12 kn über dem Mittel oder ≥ 1,6 ×
              Mittelwind). Echte Gewitterdaten liefert Windguru nicht.
            </li>
          </ul>
        </Item>
        <Item name="Fahrfenster">
          Mindestens {MIN_WINDOW_H} zusammenhängende fahrbare Stunden am selben Tag. Als „bestes Fenster“ gilt
          das mit der größten sicheren Fahrzeit (Stunden × mittlere Wahrscheinlichkeit).
        </Item>
        <Item name="Tageswind">
          Durchschnitt der 3 stärksten Tageslicht-Stunden — eine kurze Spitze allein zählt nicht.
        </Item>
        <Item name="Trend">
          Derselbe Tageswind, berechnet aus früheren Datenständen (vor 6 h, 1, 3 und 7 Tagen). Unter 2 kn
          Unterschied gilt er als stabil.
        </Item>
        <Item name="Nur globale Modelle">
          Ab etwa Tag 3 fallen die hochauflösenden Küstenmodelle weg; danach rechnen nur noch ECMWF, GFS &amp;
          Co. mit ~9–15 km Maschenweite — Tendenz ja, Details nein. Solche Tage erscheinen blass.
        </Item>
      </Section>

      <Section id="grenzen" title="Grenzen">
        <ul className="ml-4 list-disc">
          <li>
            Die Korrektur ist nur so gut wie die Historie. In den ersten Wochen sind Unterschiede zwischen den
            Varianten oft noch Zufall — deshalb die Zurückhaltung bei wenig Daten.
          </li>
          <li>
            Eine Station misst an einem Punkt. Böen, Abdeckung durch den Damm oder lokale Effekte am Wasser
            können abweichen — und gelernt wird, was <b>diese Station</b> misst.
          </li>
          <li>
            Viele Modelle sind verwandt (z. B. die HARMONIE-Familie) und irren sich gemeinsam. Der Konsens ist
            deshalb weniger „unabhängige Meinungen“, als die Zahl 16 vermuten lässt.
          </li>
          <li>Die Prozente sind Wahrscheinlichkeiten, keine Garantien.</li>
        </ul>
      </Section>

      <Section id="quellen" title="Datenquellen & Code">
        <ul className="ml-4 list-disc">
          <li>Windguru — Modellvorhersagen (frei abrufbar; privates Dashboard, nicht affiliiert)</li>
          <li>
            Messstationen: Natural High (Brouwersdam, via Windguru, 10-min-Verlauf), Mirns NKV (soarcast/NKV,
            nur aktueller Wert)
          </li>
          <li>Wassertemperatur: Rijkswaterstaat (Brouwershavensche Gat, Bommenede, Friesekust IJsselmeer)</li>
        </ul>
        <p className="mt-2">
          Der komplette Rechenweg ist offen:{" "}
          <a href={REPO_URL} className="underline hover:text-accent" target="_blank" rel="noreferrer">
            {REPO_URL.replace("https://", "")}
          </a>
          . Gelernt wird in <Mono>scripts/skill_job.py</Mono>, angewendet in <Mono>src/lib/calib.ts</Mono> und{" "}
          <Mono>src/lib/consensus.ts</Mono>, die Kite-Logik steht in <Mono>src/lib/kite.ts</Mono>. Ein
          automatischer Test prüft, dass Lern- und Anzeigeseite Stunde für Stunde dasselbe rechnen.
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

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="panel mb-4 scroll-mt-4 p-5 text-sm leading-relaxed text-body">
      <h2 className="mb-3 font-display text-lg font-700 text-ink">{title}</h2>
      {children}
    </section>
  );
}

function Item({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="mb-3 mt-3">
      <div className="font-600 text-ink">{name}</div>
      <div>{children}</div>
    </div>
  );
}

function Formula({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="my-3 overflow-x-auto rounded-lg px-4 py-2.5 font-mono text-[13px] text-ink"
      style={{ background: "var(--tint-accent)" }}
    >
      {children}
    </div>
  );
}

function Example({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-3 border-l-2 pl-3 text-body" style={{ borderLeftColor: "var(--wg-amber)" }}>
      <span className="font-600 text-ink">Beispiel: </span>
      {children}
    </div>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-[12px] text-ink">{children}</code>;
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
    // Auf dem Handy wäre die Schrift bei voller Skalierung unlesbar — dort seitlich scrollen.
    <div className="mt-4 overflow-x-auto">
      <svg viewBox="0 0 840 170" className="w-full min-w-[640px]" role="img" aria-label="Rechenweg der Prognose">
        <defs>
          <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0 L10 5 L0 10 z" className="fill-muted" />
          </marker>
        </defs>
        {boxes.map((b, i) => (
          <g key={b.label}>
            <rect
              x={b.x}
              y={20}
              width={120}
              height={52}
              rx={10}
              className="fill-accent"
              fillOpacity={0.08}
              strokeOpacity={0.6}
              style={{ stroke: i === 5 ? "var(--wg-green)" : "var(--wg-teal)" }}
            />
            <text x={b.x + 60} y={43} textAnchor="middle" className="fill-ink" fontSize={14} fontWeight={600}>
              {b.label}
            </text>
            <text x={b.x + 60} y={61} textAnchor="middle" className="fill-muted" fontSize={11}>
              {b.sub}
            </text>
            {i < boxes.length - 1 && <line x1={b.x + 122} y1={46} x2={b.x + 138} y2={46} className="stroke-muted" markerEnd="url(#arr)" />}
          </g>
        ))}
        {/* Lernschleife — pink wie die Messung in den Diagrammen */}
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
    </div>
  );
}

/**
 * Zeitstrahl der ehrlichen Rückschau: gelernt wird nur links vom Prüf-Zeitpunkt, verglichen
 * wird rechts davon mit der Messung.
 */
function RollingSketch() {
  const xF = 200;
  const leads = [
    { h: 6, x: 228 },
    { h: 12, x: 262 },
    { h: 24, x: 322 },
    { h: 48, x: 392 },
  ];
  return (
    <svg viewBox="0 0 420 140" className="mt-3 w-full max-w-[560px]" role="img" aria-label="Rückschau: lernen nur mit Daten vor dem Prüf-Zeitpunkt">
      <rect x={8} y={36} width={xF - 8} height={44} rx={6} style={{ fill: "var(--tint-good)", stroke: "var(--wg-green)" }} strokeOpacity={0.5} />
      <text x={(8 + xF) / 2} y={54} textAnchor="middle" className="fill-ink" fontSize={13} fontWeight={600}>
        lernen
      </text>
      <text x={(8 + xF) / 2} y={71} textAnchor="middle" className="fill-body" fontSize={12}>
        nur Daten bis hier
      </text>
      <rect x={xF} y={36} width={412 - xF} height={44} rx={6} style={{ fill: "var(--tint-neutral)" }} className="stroke-faint" strokeDasharray="4 4" />
      <text x={(xF + 412) / 2} y={54} textAnchor="middle" className="fill-ink" fontSize={13} fontWeight={600}>
        prüfen
      </text>
      <text x={(xF + 412) / 2} y={71} textAnchor="middle" className="fill-body" fontSize={12}>
        Konsens von damals ↔ Messung
      </text>
      <text x={(xF + 412) / 2} y={26} textAnchor="middle" className="fill-muted" fontSize={11}>
        fürs Lernen unsichtbar
      </text>
      <line x1={xF} y1={16} x2={xF} y2={112} strokeWidth={2} style={{ stroke: "var(--wg-amber)" }} />
      <text x={xF - 6} y={108} textAnchor="end" fontSize={12} fontWeight={600} style={{ fill: "var(--wg-amber)" }}>
        Prüf-Zeitpunkt
      </text>
      {leads.map((l) => (
        <g key={l.h}>
          <circle cx={l.x} cy={96} r={4} fill="#f472b6" />
          <text x={l.x} y={116} textAnchor="middle" className="fill-muted" fontSize={11}>
            +{l.h} h
          </text>
        </g>
      ))}
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
    { mu: 11, sd: 2.4, color: "var(--wg-blue)" },
    { mu: 14, sd: 2.8, color: "var(--wg-teal)" },
    { mu: 16, sd: 3.4, color: "var(--wg-amber)" },
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
      <rect x={x(TH.min)} y={10} width={x(26) - x(TH.min)} height={H - 32} fillOpacity={0.08} style={{ fill: "var(--wg-green)" }} />
      {models.map((m) => (
        <polyline key={m.mu} points={curve(m.mu, m.sd)} fill="none" strokeWidth={2} style={{ stroke: m.color }} />
      ))}
      <line x1={x(TH.min)} y1={8} x2={x(TH.min)} y2={H - 22} strokeDasharray="5 4" style={{ stroke: "var(--wg-green)" }} />
      <text x={x(TH.min) + 4} y={20} fontSize={11} style={{ fill: "var(--wg-green)" }}>
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

/** Standard-Abklingen der Kurzfrist-Korrektur (ohne gelernte Werte): e^(−k/τ). */
function NowcastSketch() {
  const gain = Array.from({ length: LEARN.nowcastK + 1 }, (_, k) => Math.exp(-k / LEARN.nowcastPriorTau));
  return (
    <div className="mt-3 flex flex-wrap items-end gap-1.5" aria-label="Abklingen der Kurzfrist-Korrektur (Standardwerte)">
      {gain.map((g, k) => (
        <div key={k} className="flex w-8 flex-col items-center gap-1">
          <div className="flex h-12 w-4 items-end rounded bg-[color:var(--color-bg-2)]">
            <div className="w-full rounded" style={{ height: `${g * 100}%`, background: "var(--wg-amber)", opacity: 0.8 }} />
          </div>
          <span className="font-mono text-[10px] text-muted">+{k} h</span>
        </div>
      ))}
      <span className="ml-2 text-[11px] text-faint">Standard-Abklingen — die gelernten Werte stehen unter Analyse → Genauigkeit</span>
    </div>
  );
}
