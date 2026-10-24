// Student-supplied text (names, notes, uploaded documents, Pronote lessons, memory) is put in front of the model. It is
// information about the student, never instructions, so it is flattened to one line, stripped of quoting and role markers,
// and capped before it goes into any prompt. The prompts also fence it with <student_data> and say it cannot change the rules.

const ROLE_MARKERS = /\b(?:system|assistant|developer|tutor|otto|user|human)\s*:/gi;
const OVERRIDES = /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(?:instructions?|rules?|prompt|previous|above|consignes?|r[èe]gles?)\b|\b(?:ignore[zr]?|oublie[zr]?)\b[^.\n]{0,30}\b(?:consignes?|instructions?|r[èe]gles?)\b|\b(?:you are now|from now on|act as|pretend to be|jailbreak|developer mode|mode d[ée]veloppeur|tu es maintenant|d[ée]sormais)\b/gi;

export function sanitizeForPrompt(input: unknown, max = 200): string {
  let s = String(input ?? "");
  s = s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " "); // newlines and control characters → one line
  s = s.replace(/[<>`"“”]+/g, "'"); // no tags, backticks or double quotes to break out of a quoted field
  s = s.replace(/^[#>*\-\s]+/, ""); // no leading heading / quote / list markers
  s = s.replace(/#{2,}/g, " ");
  s = s.replace(ROLE_MARKERS, (m) => m.replace(":", " -"));
  s = s.replace(OVERRIDES, "[removed]");
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max).trim() : s;
}

/** A person's name as stored: letters, marks, spaces, apostrophes, dots and hyphens only. */
export function cleanName(input: unknown, max = 40): string {
  return String(input ?? "").replace(/[^\p{L}\p{M} '’.\-]/gu, "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Wrap student-derived background in a fence the model is told never carries rules. */
export const STUDENT_DATA_OPEN = "<student_data>";
export const STUDENT_DATA_CLOSE = "</student_data>";
export const fenceStudentData = (body: string): string => (body.trim() ? `${STUDENT_DATA_OPEN}\n${body.trim()}\n${STUDENT_DATA_CLOSE}` : "");

/** Like sanitizeForPrompt but keeps the line structure: for a multi-line background block built from student-derived pieces. */
export function neutralizeBlock(input: unknown, maxLine = 900): string {
  return String(input ?? "").split(/\r?\n/).map((line) => {
    let l = line.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/[<>`]+/g, "'");
    l = l.replace(/(?<=^|[\s("'])(?:system|assistant|developer|user|human)\s*:/gi, (m) => m.replace(":", " -"));
    l = l.replace(OVERRIDES, "[removed]");
    return l.length > maxLine ? l.slice(0, maxLine) : l;
  }).join("\n");
}
