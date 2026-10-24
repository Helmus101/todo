// The app sometimes whispers a private note to the voice tutor ("they said I don't know twice: explain it"). To keep a student
// from typing a fake one, every real note starts with a code that is only in this session's instructions, and anything a student
// types that imitates a note is defanged before it is sent.
export const makeNoteTag = (): string => {
  const bytes = new Uint8Array(6);
  (globalThis.crypto || ({} as Crypto)).getRandomValues?.(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("") || String(Date.now()).slice(-10);
  return `NOTE-${hex.toUpperCase()}`;
};
export const validNoteTag = (t: unknown): string | undefined => (typeof t === "string" && /^NOTE-[A-Z0-9]{8,24}$/.test(t) ? t : undefined);
/** Student-typed text with anything that looks like an app note or a note code removed. */
export const defangTyped = (t: string): string =>
  String(t).replace(/NOTE-[A-Z0-9]{6,}/gi, "").replace(/\(?\s*private note for you[^)]*\)?/gi, "").replace(/\(\s*typed by the student[^)]*\)/gi, "").trim();
