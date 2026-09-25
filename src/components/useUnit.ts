"use client";
import { useCallback, useSyncExternalStore } from "react";
import type { WindUnit } from "@/lib/units";

// Gewählte Wind-Einheit, je Gerät gemerkt — eine Einstellung, die man einmal setzt; der
// Schalter steht deshalb im Fuß und nicht mehr im Kopf. Nur eine Bequemlichkeit: ohne Speicher
// (privates Fenster, gesperrt) gilt die Wahl bis zum Neuladen, sonst kn.
//
// useSyncExternalStore statt useEffect + setState: der Server rendert kn (er kennt die Wahl
// nicht), der Client schaltet nach dem Hydrieren ohne Warnung um, und ein Wechsel in einem
// anderen Tab kommt über das storage-Event an.
const KEY = "wc-unit";
const listeners = new Set<() => void>();
let chosen: WindUnit | null = null; // Wahl in dieser Sitzung — gilt auch ohne Speicher

function read(): WindUnit {
  if (chosen) return chosen;
  try {
    return localStorage.getItem(KEY) === "ms" ? "ms" : "kn";
  } catch {
    return "kn";
  }
}

function subscribe(cb: () => void) {
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    chosen = null;
    cb();
  };
  listeners.add(cb);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

export function useUnit(): [WindUnit, (u: WindUnit) => void] {
  const unit = useSyncExternalStore(subscribe, read, () => "kn" as WindUnit);
  const setUnit = useCallback((u: WindUnit) => {
    chosen = u;
    try {
      localStorage.setItem(KEY, u);
    } catch {
      // kein Speicher — `chosen` trägt die Wahl bis zum Neuladen
    }
    listeners.forEach((l) => l());
  }, []);
  return [unit, setUnit];
}
