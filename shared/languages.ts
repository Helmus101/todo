/** The languages the app and the tutor can be used in (the ten most widely spoken that the app's users are likely to need). */
export const LANGUAGES = [
  { code: "en", name: "English", english: "English", dir: "ltr" },
  { code: "zh", name: "中文", english: "Chinese (Simplified)", dir: "ltr" },
  { code: "hi", name: "हिन्दी", english: "Hindi", dir: "ltr" },
  { code: "es", name: "Español", english: "Spanish", dir: "ltr" },
  { code: "fr", name: "Français", english: "French", dir: "ltr" },
  { code: "ar", name: "العربية", english: "Arabic", dir: "rtl" },
  { code: "pt", name: "Português", english: "Portuguese", dir: "ltr" },
  { code: "ru", name: "Русский", english: "Russian", dir: "ltr" },
  { code: "de", name: "Deutsch", english: "German", dir: "ltr" },
  { code: "ja", name: "日本語", english: "Japanese", dir: "ltr" },
] as const;
export type LangCode = (typeof LANGUAGES)[number]["code"];
export const isLangCode = (x: unknown): x is LangCode => LANGUAGES.some((l) => l.code === x);
export const languageName = (code: unknown): string => LANGUAGES.find((l) => l.code === code)?.english || "English";
