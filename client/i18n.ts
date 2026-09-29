/**
 * i18n foundation — a keyed message catalog + t()/useT(), meant to gradually REPLACE the inline
 * `L(fr, en)` pattern (client/ui.tsx), not rip it out in one pass. `L()` bakes exactly two languages into
 * every call site — hundreds of them across the client — so adding a third language today would mean
 * editing every single one. A catalog entry is DATA: adding a language a real underserved population
 * actually speaks (Spanish, Arabic, Swahili, whatever the case calls for) becomes a translation pass over
 * this file, never a code change.
 *
 * Migrate call sites opportunistically: when you're already touching a file, convert its `L()` calls into
 * `t()`/`useT()` + catalog entries below. Both mechanisms read the SAME LangContext (client/ui.tsx), so
 * they coexist in the same render tree indefinitely — there is no flag day, no big-bang migration.
 */
import { useContext } from "react";
import { LangContext } from "./ui.tsx";

// Add a language here (pure data) once real translations exist for every key below — see the file doc
// comment. Nothing else in this module needs to change; callers that read SUPPORTED_LANGS (a future
// language picker in Settings) pick it up automatically.
export const SUPPORTED_LANGS = ["fr", "en"] as const;
export type Lang = typeof SUPPORTED_LANGS[number];

type CatalogEntry = Partial<Record<Lang, string>>;
type Catalog = Record<string, CatalogEntry>;

// One entry per distinct UI string, grouped by the screen/component it belongs to — keeps a translator
// (human or a future automated pass) able to work section by section instead of hunting through the app.
// `en` is the required fallback for every key (see `t()`) — every OTHER language may be partial while a
// translation is in progress; `en` may not, or a missing key silently degrades to English anyway.
const MESSAGES: Catalog = {
  // ── Study Mode: bottom bar (client/study/BottomBar.tsx) ──────────────────
  "studymode.bar.task": { fr: "Tâche", en: "Task" },
  "studymode.bar.materials": { fr: "Matériel", en: "Materials" },
  "studymode.bar.tools": { fr: "Outils", en: "Tools" },
  "studymode.bar.audio": { fr: "Audio", en: "Audio" },
  "studymode.bar.audioPlayingSuffix": { fr: " · en lecture", en: " · playing" },
  "studymode.bar.askOtto": { fr: "Ask Otto", en: "Ask Otto" },
  "studymode.bar.break": { fr: "Pause", en: "Break" },
  "studymode.bar.end": { fr: "Fin", en: "End" },

  // ── Dashboard header (client/App.tsx) ────────────────────────────────────
  "dashboard.greeting.morning": { fr: "Bonjour", en: "Good morning" },
  "dashboard.greeting.afternoon": { fr: "Bon après-midi", en: "Good afternoon" },
  "dashboard.greeting.evening": { fr: "Bonsoir", en: "Good evening" },
  "dashboard.allCaughtUp": { fr: "Tu es à jour.", en: "You're all caught up." },
  "dashboard.doneForToday": { fr: "C'est tout pour aujourd'hui.", en: "That's everything for today." },
  // {count}/{plural} are computed by the caller (a plain "" or "s"), not by this module — see t()'s own
  // doc comment on why this stays plain string interpolation instead of a full ICU plural engine.
  "dashboard.thingsLeft": { fr: "{count} chose{plural} à faire aujourd'hui", en: "{count} thing{plural} left today" },
  "dashboard.alreadyDone": { fr: " — {count} déjà faite{plural}", en: " — {count} already done" },
  "dashboard.nextUp": { fr: " Ensuite : {title}.", en: " Next up: {title}." },
  "dashboard.momentum": {
    fr: "Tu progresses vraiment en {subject} en ce moment — continue comme ça.",
    en: "You've been genuinely improving in {subject} lately — keep it up.",
  },
};

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key) => (key in vars ? String(vars[key]) : whole));
}

/** Looks up `key` for `lang`, falling back to English, then to the raw key itself — a missing/mistyped
 *  key should degrade to visible-but-wrong text, never a crash or a blank UI. Plain `{name}` interpolation
 *  only (no plural/gender rules) — deliberately minimal for a foundation with exactly 2 languages so far;
 *  reach for a real ICU MessageFormat library if/when a language with different plural rules is added. */
export function t(key: string, lang: Lang, vars?: Record<string, string | number>): string {
  const entry = MESSAGES[key];
  const template = entry?.[lang] ?? entry?.en ?? key;
  return interpolate(template, vars);
}

/** Same "read the ambient LangContext" pattern as useLang() (client/ui.tsx) — a component picks whichever
 *  of the two hooks matches how far its own strings have been migrated to the catalog. */
export function useT(): (key: string, vars?: Record<string, string | number>) => string {
  const lang = useContext(LangContext);
  return (key: string, vars?: Record<string, string | number>) => t(key, lang, vars);
}
