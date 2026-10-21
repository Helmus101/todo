import { LANGUAGES, type LangCode } from "../shared/languages.ts";
import { useLanguage } from "./language.ts";

/** One select that switches the whole app (and the tutor) to another language. Names are written in their own language and never translated. */
export function LanguagePicker({ compact }: { compact?: boolean }) {
  const [lang, setLang] = useLanguage();
  return (
    <select className={`lang-picker${compact ? " compact" : ""}`} translate="no" value={lang} aria-label="Language" onChange={(e) => setLang(e.target.value as LangCode)}>
      {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
    </select>
  );
}
