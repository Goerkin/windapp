// Flat Config, direkt.
//
// Vorher lief das über FlatCompat („...compat.extends('next/core-web-vitals')"). Das ist die
// Brücke für die ALTE .eslintrc-Schreibweise — eslint-config-next 16 exportiert selbst schon
// Flat-Config-Arrays. Der Umweg endete in einem Validierungsfehler, den ESLint nicht einmal
// ausgeben konnte („Converting circular structure to JSON"), weshalb `npm run lint` nur einen
// Stacktrace lieferte und die Prüfung faktisch abgeschaltet war.
import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

export default [
  { ignores: [".next/**", "node_modules/**", "scripts/**", "next-env.d.ts"] },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      // Die UI ist deutsch und benutzt „…" absichtlich. Die Regel verlangt dafür HTML-
      // Entities, was den Quelltext nur unleserlich macht — bewusst aus.
      "react/no-unescaped-entities": "off",

      // Echte Schuld, bewusst als Warnung: an ~11 Stellen wird Date.now() im Render gelesen
      // (relative Zeiten „vor 8 min", „jetzt"-Linie in den Charts). Daher die bekannte,
      // harmlose Hydration-Warnung beim Minutenwechsel. Der saubere Weg ist ein
      // useNowSec()-Hook (Startwert beim Mount, Takt 60 s) an allen Stellen — eine eigene
      // Änderung, nicht als Beifang.
      "react-hooks/purity": "warn",
      // Dito: der Datenabruf in ModelVerifyPanel setzt Zustand synchron im Effect.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
];
