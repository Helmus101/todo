// ANSWER KEYS NEVER LEAVE THE SERVER IN THE CLEAR. A tutor exercise or answer box used to travel to the browser with its key (answer, correct
// option, value, rubric, explanation) so a student could read every answer in devtools. Now the server SEALS the key into an opaque token
// (AES-256-GCM, key derived from SESSION_SECRET — stateless, so it works across serverless instances) bound to the student and to the item; the
// browser holds only the token and the server grades. A token from another student, for another item, or tampered with, opens to nothing.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import type { BoardEntry, TaskProblem } from "../../shared/types.ts";
import { isNumericAnswer } from "../../shared/types.ts";

let derived: Buffer | null = null;
const secretKey = (): Buffer => (derived ||= scryptSync(process.env.SESSION_SECRET || "dev-only-secret-not-for-production", "otto-tutor-key-seal-v1", 32));
const MAX_AGE_MS = 30 * 24 * 3600 * 1000; // a stored session can be resumed days later

/** The fields that make an exercise gradable: the only things a student must never be able to read. */
export interface KeyFields { answer?: string; correct?: number; value?: number; rubric?: TaskProblem["rubric"]; why?: string; expectedAnswer?: string }

export function sealKey(user: string, bindId: string, fields: KeyFields): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", secretKey(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify({ u: user, i: bindId, t: Date.now(), k: fields }), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url");
}

/** The sealed fields, or null for anything that is not a valid token for THIS student and THIS item. */
export function unsealKey(token: unknown, user: string, bindId: string): KeyFields | null {
  if (typeof token !== "string" || token.length < 40 || token.length > 4000) return null;
  try {
    const raw = Buffer.from(token, "base64url");
    const d = createDecipheriv("aes-256-gcm", secretKey(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    const body = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8"));
    if (body?.u !== user || body?.i !== bindId || Date.now() - Number(body?.t) > MAX_AGE_MS) return null;
    return body.k && typeof body.k === "object" ? (body.k as KeyFields) : null;
  } catch { return null; }
}

/** What the browser may hold for an exercise: the question and options, and a token — never the key, the correct option, the rubric or the explanation. */
export function sealProblem(p: TaskProblem, user: string): TaskProblem {
  const { answer, correct, value, rubric, why, ...rest } = p;
  if (answer == null && correct == null && value == null && !rubric && !why) return p;
  const mcq = Array.isArray(p.options) && p.options.length >= 2;
  return { ...rest, keyToken: sealKey(user, p.id, { answer, correct, value, rubric, why }), answerKind: mcq ? "mcq" : isNumericAnswer(answer) ? "number" : "text" };
}

/** An answer box's key is sealed the same way (its entry id is the binding). */
export function sealGap(e: BoardEntry, user: string): BoardEntry {
  if (e.kind !== "gap" || !e.expectedAnswer) return e;
  const { expectedAnswer, ...rest } = e;
  return { ...rest, keyToken: sealKey(user, e.id, { expectedAnswer }), answerKind: isNumericAnswer(expectedAnswer) ? "number" : "text" };
}

export function sealOutgoing(board: BoardEntry[], problems: TaskProblem[], user: string): { board: BoardEntry[]; problems: TaskProblem[] } {
  return { board: board.map((e) => sealGap(e, user)), problems: problems.map((p) => sealProblem(p, user)) };
}
