import { useEffect, useState } from "react";
import type { ArtifactState } from "../StudyTypes.ts";

interface DictionaryArtifactProps {
  artifact: ArtifactState;
  onChange: (contentState: Record<string, unknown>) => void;
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

export function DictionaryArtifact({ artifact, onChange }: DictionaryArtifactProps) {
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
      const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error(res.status === 404 ? "No definition found." : "Dictionary lookup failed.");
      const data = (await res.json()) as DictionaryEntry[];
      const next = data[0] || null;
      setEntry(next);
      onChange({ ...artifact.contentState, word: q, entry: next });
      setStatus("idle");
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
