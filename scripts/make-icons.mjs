/**
 * Erzeugt die App-Icons (PWA-Manifest, Apple-Homescreen, Favicon) aus dem Wind-Logo.
 * Einmalig bzw. nach Logo-Änderung ausführen: `node scripts/make-icons.mjs`.
 * Die PNGs landen eingecheckt in public/ — so braucht der Build kein sharp.
 */
import sharp from "sharp";
import { writeFile } from "node:fs/promises";

// Randlos gefüllt und das Logo auf die innere „sichere Zone" (~60 %) verkleinert: so taugt
// dasselbe Bild auch als maskable Icon (Android schneidet Kreis/Squircle heraus).
const svg = (rounded) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${rounded ? 112 : 0}" fill="#0b1120"/>
  <g transform="translate(112 112) scale(12)" fill="none" stroke="#22d3ee" stroke-width="2" stroke-linecap="round">
    <path d="M3 8h11a3 3 0 1 0-3-3"/>
    <path d="M3 13h15a3 3 0 1 1-3 3" opacity="0.7"/>
    <path d="M3 18h8" opacity="0.45"/>
  </g>
</svg>`;

const out = [
  ["public/icon-192.png", 192, false],
  ["public/icon-512.png", 512, false],
  ["public/apple-touch-icon.png", 180, false],
];
for (const [file, size, rounded] of out) {
  await sharp(Buffer.from(svg(rounded))).resize(size, size).png().toFile(file);
}
await writeFile("src/app/icon.svg", svg(true));
console.log("[icons]", out.map((o) => o[0]).join(", "), "+ src/app/icon.svg");
