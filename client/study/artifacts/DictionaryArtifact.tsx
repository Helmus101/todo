import { useEffect, useState } from "react";
import type { ArtifactState } from "../StudyTypes.ts";

interface DictionaryArtifactProps {
  artifact: ArtifactState;
  onChange: (contentState: Record<string, unknown>) => void;
  language?: "fr" | "en";
}

interface DictionaryEntry {
  word: string;
  phonetic?: string;
  meanings?: Array<{
    partOfSpeech: string;
    definitions: Array<{
      definition: string;
      example?: string;
      synonyms?: string[];
    }>;
  }>;
}

// freedictionaryapi.com — one clean API for both languages (dictionaryapi.dev has no real French
// coverage; fr.wiktionary.org's own REST "definition" endpoint returns 501, never implemented on that
// wiki). CORS reflects the request origin (confirmed live), and a not-found word comes back as 200 with
// an empty `entries` array rather than a 404. Groups its per-entry results by part of speech to match the
// `meanings` shape the UI already renders.
interface FreeDictResponse {
  word: string;
  entries?: Array<{
    partOfSpeech?: string;
    pronunciations?: Array<{ text: string }>;
    senses?: Array<{ definition: string; examples?: string[] }>;
  }>;
}

async function lookupWord(q: string, lang: "en" | "fr"): Promise<DictionaryEntry | null> {
  const res = await fetch(`https://freedictionaryapi.com/api/v1/entries/${lang}/${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error("Dictionary lookup failed.");
  const data = (await res.json()) as FreeDictResponse;
  if (!data.entries?.length) return null;
  const meanings = data.entries.map((e) => ({
    partOfSpeech: e.partOfSpeech || "",
    definitions: (e.senses || []).slice(0, 3).map((s) => ({ definition: s.definition, example: s.examples?.[0] })),
  })).filter((m) => m.definitions.length);
  if (!meanings.length) return null;
  const phonetic = data.entries.flatMap((e) => e.pronunciations || [])[0]?.text;
  return { word: data.word, phonetic, meanings };
}

export function DictionaryArtifact({ artifact, onChange, language = "en" }: DictionaryArtifactProps) {
  const savedWord = (artifact.contentState?.word as string) || "";
  const [word, setWord] = useState(savedWord);
  const [entry, setEntry] = useState<DictionaryEntry | null>((artifact.contentState?.entry as DictionaryEntry) || null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    setWord(savedWord);
  }, [savedWord]);

  const lookup = async () => {
    const q = word.trim();
    if (!q) return;
    setStatus("loading");
    setError("");
    try {
      const next = await lookupWord(q, language);
      setEntry(next);
      onChange({ ...artifact.contentState, word: q, entry: next });
      setStatus(next ? "idle" : "error");
      if (!next) setError("No definition found.");
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Dictionary lookup failed.");
    }
  };

  const meanings = entry?.meanings?.slice(0, 4) || [];

  return (
    <div className="sm-dictionary-body">
      <div className="sm-dictionary-search">
        <input
          value={word}
          onChange={(e) => setWord(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && lookup()}
          placeholder="Search a word"
          autoCapitalize="none"
          spellCheck={false}
        />
        <button className="sm-btn sm-btn-primary" onClick={lookup} disabled={!word.trim() || status === "loading"}>
          {status === "loading" ? "..." : "Look up"}
        </button>
      </div>

      <div className="sm-dictionary-results">
        {status === "error" && <p className="sm-dictionary-error">{error}</p>}
        {!entry && status !== "error" && (
          <p className="sm-artifact-empty">Type a word to see definitions inside Study Mode.</p>
        )}
        {entry && (
          <>
            <div className="sm-dictionary-head">
              <strong>{entry.word}</strong>
              {entry.phonetic && <span>{entry.phonetic}</span>}
            </div>
            {meanings.map((meaning, meaningIndex) => (
              <section className="sm-dictionary-meaning" key={`${meaning.partOfSpeech}-${meaningIndex}`}>
                <h3>{meaning.partOfSpeech}</h3>
                {meaning.definitions.slice(0, 3).map((definition, definitionIndex) => (
                  <div className="sm-dictionary-definition" key={definitionIndex}>
                    <p>{definition.definition}</p>
                    {definition.example && <blockquote>{definition.example}</blockquote>}
                    {definition.synonyms?.length ? (
                      <span className="sm-dictionary-synonyms">Synonyms: {definition.synonyms.slice(0, 6).join(", ")}</span>
                    ) : null}
                  </div>
                ))}
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
