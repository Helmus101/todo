// THE PERSISTENT STUDENT MODEL — Otto doesn't just remember conversations, it remembers HOW this student
// learns (spec §3 + §30). This is the durable, per-CONCEPT read every other adaptive subsystem reads from:
// the Socratic rung selection (server/hintLadder.ts), prerequisite stepping (server/conceptGraph.ts), the
// practice brief (server/practicePlan.ts) and the curriculum read (server/curriculum.ts).
//
// The SHAPES live in shared/agentTypes.ts (the client's transparency panel and the profile need them, and a
// server import there would drag server code into the browser bundle). This module is the behaviour.
//
// Two design rules from the spec are load-bearing:
//
//   1. It is EXTENSIBLE (§3: "don't hardcode the model around these exact fields forever"). Everything added
//      goes through normalizeStudentModel, which re-validates on every load exactly the way normalizeProfile
//      already does — so a new dimension is one field plus one line of clamping, never a migration. `extras`
//      is the escape hatch for a genuinely new scalar (engagement, working speed, preferred representation).
//
//   2. Every belief has EVIDENCE (§30: "prevents Otto from permanently labeling students based on one
//      mistake"). A misconception is not a boolean — it's a hypothesis with a count, a recency-decayed
//      confidence and the specific moments that produced it, and it can be RETIRED (§47) rather than
//      lingering forever.
//
// And per §18, none of this is the model's job to maintain: updates are DETERMINISTIC, derived from signals
// the app already observes (an objective ticked, a problem solved first try vs after a rung, an error logged,
// a board self-correction). The deeper qualitative read still comes from the existing once-a-day
// synthesizeStudentModel — so this adds no per-turn AI spend.
import {
  EVIDENCE_WEIGHT,
  EVIDENCE_SETBACK,
  CONCEPT_CAP,
  EVIDENCE_CAP,
  MISCONCEPTION_CAP,
  MISCONCEPTION_EVIDENCE_CAP,
  COMMON_ERROR_CAP,
  MISCONCEPTION_HALF_LIFE_DAYS,
  MISCONCEPTION_LIVE_THRESHOLD,
  MASTERY_EWMA,
  type ConceptRecord,
  type ConceptMisconception,
  type ConceptError,
  type ConceptEvidence,
  type EvidenceKind,
  type StudentModelShape,
} from "../shared/agentTypes.ts";
import type { DependenceMetric } from "../shared/types.ts";

export type {
  ConceptRecord, ConceptMisconception, ConceptError, ConceptEvidence, EvidenceKind, StudentModelShape,
};
export {
  EVIDENCE_WEIGHT, CONCEPT_CAP, EVIDENCE_CAP, MISCONCEPTION_CAP, MISCONCEPTION_EVIDENCE_CAP,
  COMMON_ERROR_CAP, MISCONCEPTION_HALF_LIFE_DAYS, MISCONCEPTION_LIVE_THRESHOLD, MASTERY_EWMA,
};

/** Convenience alias — the model type is the shared shape; nothing server-only is added to it. */
export type StudentModel = StudentModelShape;

/** How much weighted evidence it takes before `confidence` in the mastery reading approaches 1. */
const CONFIDENCE_FULL_AT = 6;

function clamp01(n: number): number { return Math.max(0, Math.min(1, n)); }
function round3(n: number): number { return Math.round(clamp01(n) * 1000) / 1000; }
function iso(now: Date): string { return now.toISOString(); }
function daysBetween(a: string | undefined, b: Date): number {
  if (!a) return Infinity;
  const t = Date.parse(a);
  return Number.isFinite(t) ? Math.max(0, (b.getTime() - t) / 86_400_000) : Infinity;
}

/** Canonical key for a concept label — case/punctuation/accent-insensitive so "Newton's 2nd Law", "newtons 2nd
 *  law" and "Newton's Second Law" are one concept instead of three near-duplicates. Accents are folded because
 *  the app is bilingual and a label can arrive from either the model or a French document. */
export function conceptKey(label: string): string {
  return String(label || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9+*/=<>^ -]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

function cleanLabel(label: string): string {
  return String(label || "").trim().replace(/\s+/g, " ").slice(0, 80);
}

export function emptyStudentModel(): StudentModelShape {
  return { concepts: {}, updatedAt: new Date(0).toISOString() };
}

/** A brand-new concept record: no data at all, which is NOT "mastery 0" — `confidence` is 0 and mastery starts
 *  neutral at 0.5, so an untouched concept never renders as a failure. */
export function blankConcept(key: string, label: string, subject: string | undefined, now: Date): ConceptRecord {
  return {
    key,
    label: cleanLabel(label) || key,
    ...(subject ? { subject: String(subject).trim().slice(0, 60) } : {}),
    mastery: 0.5,
    confidence: 0,
    attempts: 0, unaided: 0, hinted: 0, partial: 0, explained: 0,
    transferAttempts: 0, transferWins: 0, recalls: 0, recallWins: 0,
    misconceptions: [], commonErrors: [], strengths: [], evidence: [],
    updatedAt: iso(now),
    extras: {},
  };
}

/* ── derived ratios (single source of truth: the counters) ─────────────────────────────────────────── */

export function independentSuccess(rec: ConceptRecord): number {
  return rec.attempts > 0 ? rec.unaided / rec.attempts : 0;
}
export function hintDependence(rec: ConceptRecord): number {
  return rec.attempts > 0 ? (rec.hinted + rec.partial + rec.explained) / rec.attempts : 0;
}
export function transferSuccess(rec: ConceptRecord): number {
  return rec.transferAttempts > 0 ? rec.transferWins / rec.transferAttempts : 0;
}
export function recallStrength(rec: ConceptRecord): number {
  return rec.recalls > 0 ? rec.recallWins / rec.recalls : 0;
}

/** Recency-decayed confidence of one misconception (see MISCONCEPTION_HALF_LIFE_DAYS). */
export function decayedMisconceptionConfidence(m: ConceptMisconception, now: Date): number {
  if (m.retiredAt) return 0;
  const d = daysBetween(m.lastSeen, now);
  if (!Number.isFinite(d)) return clamp01(m.confidence);
  return clamp01(m.confidence * Math.pow(0.5, d / MISCONCEPTION_HALF_LIFE_DAYS));
}

/** The misconceptions the tutor should actually act on right now — live, not retired, still above the
 *  threshold after decay, strongest first. The ONLY function the prompt path should use; reading
 *  `rec.misconceptions` directly would resurrect stale beliefs. */
export function liveMisconceptions(rec: ConceptRecord, now: Date): { text: string; confidence: number; count: number; evidence: string[] }[] {
  return rec.misconceptions
    .map((m) => ({ text: m.text, confidence: decayedMisconceptionConfidence(m, now), count: m.count, evidence: m.evidence }))
    .filter((m) => m.confidence >= MISCONCEPTION_LIVE_THRESHOLD)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MISCONCEPTION_CAP);
}

/* ── the update path ────────────────────────────────────────────────────────────────────────────────── */

/** One observation to fold into the model. `label` is whatever the caller called the concept — the key is
 *  derived here, so no caller has to normalise. */
export interface ConceptEvidenceInput {
  label: string;
  subject?: string;
  kind: EvidenceKind;
  /** For `misconception`/`mistake`: the claim about what they got wrong ("treats normal force as mg"), which
   *  is what makes it a testable, retirable hypothesis rather than a tally. */
  detail?: string;
  /** A short note for the evidence trail (e.g. "ticked objective 2"). */
  evidence?: string;
}

/** Fold one observation into a single record — pure, so it is trivially unit-testable and safe to replay.
 *
 *  Mastery moves by EWMA toward the evidence kind's weight. Setbacks (a mistake, a failed transfer) pull it
 *  DOWN toward their low weight; wins pull it UP toward theirs. This asymmetry is what keeps one careless
 *  slip from reading as competence and one lucky guess from reading as mastery. */
export function applyEvidence(rec: ConceptRecord, ev: ConceptEvidenceInput, now: Date): ConceptRecord {
  const weight = EVIDENCE_WEIGHT[ev.kind] ?? 0.5;
  const next: ConceptRecord = {
    ...rec,
    misconceptions: [...rec.misconceptions],
    commonErrors: [...rec.commonErrors],
    strengths: [...rec.strengths],
    evidence: [...rec.evidence],
    extras: { ...rec.extras },
  };

  next.mastery = round3(rec.mastery + MASTERY_EWMA * (weight - rec.mastery));

  // Raw counters — the honest denominator for every ratio.
  switch (ev.kind) {
    case "solved-unaided": next.attempts++; next.unaided++; break;
    case "solved-after-hint": next.attempts++; next.hinted++; break;
    case "solved-after-partial": next.attempts++; next.partial++; break;
    case "solved-after-explanation": next.attempts++; next.explained++; break;
    case "self-corrected": next.attempts++; next.unaided++; break; // corrected it themselves = unaided
    case "mistake": case "misconception": next.attempts++; break;
    case "recall": next.recalls++; next.recallWins++; break;
    case "recall-miss": next.recalls++; break;
    case "transfer-success": next.transferAttempts++; next.transferWins++; break;
    case "transfer-fail": next.transferAttempts++; break;
    case "objective-done": break;
  }

  // Misconception bookkeeping — registering the stated claim is what lets it later be TESTED and RETIRED.
  if (ev.kind === "misconception" && ev.detail?.trim()) {
    const text = ev.detail.trim().slice(0, 300);
    const existing = next.misconceptions.find((m) => !m.retiredAt && m.text.toLowerCase() === text.toLowerCase());
    if (existing) {
      existing.count += 1;
      existing.lastSeen = iso(now);
      existing.confidence = clamp01(existing.confidence + 0.25); // re-observed → it IS still happening
      if (ev.evidence && !existing.evidence.includes(ev.evidence)) existing.evidence = [...existing.evidence, ev.evidence.slice(0, 200)].slice(-MISCONCEPTION_EVIDENCE_CAP);
    } else {
      next.misconceptions = [...next.misconceptions.filter((m) => !(m.retiredAt === undefined && m.text.toLowerCase() === text.toLowerCase())), {
        text,
        count: 1,
        firstSeen: iso(now),
        lastSeen: iso(now),
        confidence: 0.5,
        evidence: ev.evidence ? [ev.evidence.slice(0, 200)] : [],
      }].slice(-MISCONCEPTION_CAP);
    }
  }

  // A recurring CALCULATION error, tracked for a checklist-style fix rather than a re-teach.
  if (ev.kind === "mistake" && ev.detail?.trim()) {
    const text = ev.detail.trim().slice(0, 300);
    const existing = next.commonErrors.find((e) => e.text.toLowerCase() === text.toLowerCase());
    if (existing) { existing.count += 1; existing.lastSeen = iso(now); }
    else next.commonErrors = [...next.commonErrors, { text, count: 1, lastSeen: iso(now) }].slice(-COMMON_ERROR_CAP);
  }

  // A strength is derived, never asked for.
  if ((ev.kind === "solved-unaided" || ev.kind === "self-corrected" || ev.kind === "transfer-success") && ev.detail?.trim()) {
    const text = ev.detail.trim().slice(0, 200);
    if (!next.strengths.some((s) => s.toLowerCase() === text.toLowerCase())) next.strengths = [...next.strengths, text].slice(-COMMON_ERROR_CAP);
  }

  // Retire a live misconception the moment real evidence contradicts it: an unaided solve or a transfer
  // success on this concept is the strongest available signal that the hypothesis no longer holds (§47).
  if (ev.kind === "transfer-success" || ev.kind === "solved-unaided" || ev.kind === "self-corrected") {
    const wins = next.unaided + next.transferWins;
    next.misconceptions = next.misconceptions.map((m) =>
      !m.retiredAt && wins >= 2 && decayedMisconceptionConfidence(m, now) >= MISCONCEPTION_LIVE_THRESHOLD ? { ...m, retiredAt: iso(now) } : m);
  }

  const trail: ConceptEvidence = { at: iso(now), kind: ev.kind, ...(ev.detail ? { detail: ev.detail.slice(0, 200) } : {}) };
  next.evidence = [...next.evidence, trail].slice(-EVIDENCE_CAP);
  if (!EVIDENCE_SETBACK.includes(ev.kind)) next.lastDemonstrated = iso(now);
  next.updatedAt = iso(now);

  // Confidence in the mastery READING: grows with the WEIGHT of evidence gathered, not the number of turns —
  // so three turns of being told the answer leaves Otto appropriately unsure.
  const weightSum = next.evidence.reduce((s, e) => s + (EVIDENCE_WEIGHT[e.kind] ?? 0.5), 0);
  next.confidence = round3(Math.min(1, weightSum / CONFIDENCE_FULL_AT));
  next.mastery = round3(next.mastery);
  return next;
}

/** Fold one observation into the whole model, creating the record on first mention. Pure — the caller decides
 *  when to persist. */
export function recordConceptEvidence(model: StudentModelShape, ev: ConceptEvidenceInput, now: Date): StudentModelShape {
  const key = conceptKey(ev.label);
  if (!key) return model;
  const existing = model.concepts[key] || blankConcept(key, ev.label, ev.subject, now);
  const relabeled: ConceptRecord = {
    ...existing,
    label: cleanLabel(ev.label) || existing.label,
    ...(ev.subject && !existing.subject ? { subject: String(ev.subject).slice(0, 60) } : {}),
  };
  const updated = applyEvidence(relabeled, ev, now);
  return capConcepts({ concepts: { ...model.concepts, [key]: updated }, updatedAt: iso(now) });
}

/** Record the same observation against several concepts — used when one demonstration genuinely covers two
 *  (an objective that names a concept, a problem whose working exercises a prerequisite as well). */
export function recordConceptEvidenceMany(model: StudentModelShape, labels: string[], ev: ConceptEvidenceInput, now: Date): StudentModelShape {
  let next = model;
  for (const label of [...new Set(labels.map((l) => cleanLabel(l)).filter(Boolean))]) next = recordConceptEvidence(next, { ...ev, label }, now);
  return next;
}

/** Enforce CONCEPT_CAP by evicting the LEAST RECENTLY DEMONSTRATED concept (falling back to `updatedAt`).
 *  Never evicts by lowest mastery — dropping the concept the student is weakest at is exactly the wrong thing
 *  to forget. */
export function capConcepts(model: StudentModelShape): StudentModelShape {
  const keys = Object.keys(model.concepts);
  if (keys.length <= CONCEPT_CAP) return model;
  const ranked = keys.sort((a, b) => {
    const la = model.concepts[a].lastDemonstrated || model.concepts[a].updatedAt || "";
    const lb = model.concepts[b].lastDemonstrated || model.concepts[b].updatedAt || "";
    return lb.localeCompare(la); // newest first
  });
  const kept: Record<string, ConceptRecord> = {};
  for (const k of ranked.slice(0, CONCEPT_CAP)) kept[k] = model.concepts[k];
  return { ...model, concepts: kept };
}

/** Retire misconceptions whose decayed confidence has fallen below the threshold even with no contradicting
 *  observation — run by the daily sweep so old hypotheses clear for a student who stopped working on that
 *  concept entirely. Returns the same object when nothing changed (a cheap no-op for callers). */
export function pruneStaleMisconceptions(model: StudentModelShape, now: Date): StudentModelShape {
  let changed = false;
  const concepts: Record<string, ConceptRecord> = {};
  for (const [k, rec] of Object.entries(model.concepts)) {
    if (!rec.misconceptions.some((m) => !m.retiredAt && decayedMisconceptionConfidence(m, now) < MISCONCEPTION_LIVE_THRESHOLD)) {
      concepts[k] = rec;
      continue;
    }
    changed = true;
    concepts[k] = {
      ...rec,
      misconceptions: rec.misconceptions.map((m) => (!m.retiredAt && decayedMisconceptionConfidence(m, now) < MISCONCEPTION_LIVE_THRESHOLD ? { ...m, retiredAt: iso(now) } : m)),
    };
  }
  return changed ? { ...model, concepts, updatedAt: iso(now) } : model;
}

/* ── validation (the load-time boundary — same posture as normalizeProfile) ─────────────────────────── */

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function str(v: unknown, cap: number): string {
  return typeof v === "string" ? v.trim().slice(0, cap) : "";
}
function stamp(v: unknown): string | undefined {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : undefined;
}
function ratio(v: unknown): number {
  return round3(clamp01(num(v, 0)));
}
function count(v: unknown): number {
  return Math.max(0, Math.round(num(v)));
}

/** Re-validate a raw persisted model on every load. Anything malformed is dropped rather than trusted: this is
 *  AI-adjacent state that round-trips through storage, so "it's ours, it must be fine" isn't a safe assumption
 *  — the same reason normalizeProfile re-clamps every field it reads. */
export function normalizeStudentModel(raw: unknown): StudentModelShape | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as any;
  if (!r.concepts || typeof r.concepts !== "object") return undefined;
  const concepts: Record<string, ConceptRecord> = {};
  for (const [k, v] of Object.entries(r.concepts as Record<string, any>).slice(0, CONCEPT_CAP)) {
    if (!v || typeof v !== "object") continue;
    const key = conceptKey(str(v.key, 60) || k);
    const label = str(v.label, 80);
    if (!key || !label) continue;
    const misconceptions: ConceptMisconception[] = Array.isArray(v.misconceptions)
      ? v.misconceptions
          .slice(0, MISCONCEPTION_CAP)
          .map((m: any) => ({
            text: str(m?.text, 300),
            count: count(m?.count ?? 1),
            firstSeen: stamp(m?.firstSeen) || new Date(0).toISOString(),
            lastSeen: stamp(m?.lastSeen) || stamp(m?.firstSeen) || new Date(0).toISOString(),
            confidence: ratio(m?.confidence),
            evidence: Array.isArray(m?.evidence) ? m.evidence.map((x: any) => str(x, 200)).filter(Boolean).slice(0, MISCONCEPTION_EVIDENCE_CAP) : [],
            ...(stamp(m?.retiredAt) ? { retiredAt: stamp(m?.retiredAt)! } : {}),
          }))
          .filter((m: ConceptMisconception) => Boolean(m.text))
      : [];
    const commonErrors: ConceptError[] = Array.isArray(v.commonErrors)
      ? v.commonErrors
          .slice(0, COMMON_ERROR_CAP)
          .map((e: any) => ({ text: str(e?.text, 300), count: count(e?.count ?? 1), lastSeen: stamp(e?.lastSeen) || new Date(0).toISOString() }))
          .filter((e: ConceptError) => Boolean(e.text))
      : [];
    const evidence: ConceptEvidence[] = Array.isArray(v.evidence)
      ? v.evidence.slice(-EVIDENCE_CAP).map((e: any) => ({
          at: stamp(e?.at) || new Date(0).toISOString(),
          kind: (e && typeof e.kind === "string" && Object.prototype.hasOwnProperty.call(EVIDENCE_WEIGHT, e.kind) ? e.kind : "objective-done") as EvidenceKind,
          ...(str(e?.detail, 200) ? { detail: str(e?.detail, 200) } : {}),
        }))
      : [];
    const extras: Record<string, number | string> = {};
    if (v.extras && typeof v.extras === "object") {
      for (const [ek, ev] of Object.entries(v.extras as Record<string, unknown>).slice(0, 12)) {
        const ekClean = str(ek, 40);
        if (!ekClean) continue;
        if (typeof ev === "number" && Number.isFinite(ev)) extras[ekClean] = ev;
        else if (typeof ev === "string" && ev.trim()) extras[ekClean] = ev.trim().slice(0, 200);
      }
    }
    concepts[key] = {
      key,
      label,
      ...(str(v.subject, 60) ? { subject: str(v.subject, 60) } : {}),
      mastery: ratio(v.mastery ?? 0.5),
      confidence: ratio(v.confidence),
      attempts: count(v.attempts),
      unaided: count(v.unaided),
      hinted: count(v.hinted),
      partial: count(v.partial),
      explained: count(v.explained),
      transferAttempts: count(v.transferAttempts),
      transferWins: count(v.transferWins),
      recalls: count(v.recalls),
      recallWins: count(v.recallWins),
      misconceptions,
      commonErrors,
      strengths: Array.isArray(v.strengths) ? v.strengths.map((s: any) => str(s, 200)).filter(Boolean).slice(0, COMMON_ERROR_CAP) : [],
      evidence,
      ...(stamp(v.lastDemonstrated) ? { lastDemonstrated: stamp(v.lastDemonstrated)! } : {}),
      ...(stamp(v.nextReview) ? { nextReview: stamp(v.nextReview)! } : {}),
      updatedAt: stamp(v.updatedAt) || new Date(0).toISOString(),
      extras,
    };
  }
  return capConcepts({ concepts, updatedAt: stamp(r.updatedAt) || new Date(0).toISOString() });
}

/** Look a concept up by either its label or its key — the two ways callers name it. */
export function findConcept(model: StudentModelShape | undefined, labelOrKey: string): ConceptRecord | undefined {
  if (!model) return undefined;
  return model.concepts[conceptKey(labelOrKey)] || model.concepts[labelOrKey];
}

/* ── reading the model back out (the prompt path) ───────────────────────────────────────────────────── */

/** Concepts worth telling the tutor about this turn: subject-matched first (a Maths session shouldn't open
 *  with the student's History misconceptions), then by weakness — a weak concept is the one most likely to be
 *  the REAL problem behind what they're asking about (§4/§5). Only concepts with actual evidence are returned:
 *  a record created by a stray mention must never be presented as a belief. */
export function relevantConcepts(model: StudentModelShape, opts: { subject?: string; limit?: number; now?: Date } = {}): ConceptRecord[] {
  const now = opts.now || new Date();
  const subject = (opts.subject || "").toLowerCase();
  const all = Object.values(model.concepts).filter((c) => c.confidence > 0 || c.evidence.length > 0);
  const score = (c: ConceptRecord): number => {
    const subjectMatch = subject && (c.subject || "").toLowerCase() === subject ? 2 : 0;
    const live = liveMisconceptions(c, now).length > 0 ? 1 : 0;
    return subjectMatch + live;
  };
  return all
    .sort((a, b) => score(b) - score(a) || a.mastery - b.mastery) // same-subject + live misconceptions, then weakest first
    .slice(0, opts.limit ?? 8);
}

/** The prompt block. This is what turns the model from a database into a tutor's read of the kid: mastery as a
 *  BAND (never a fake-precise percentage in prose), live misconceptions with their confidence, the hint
 *  pattern, and — critically — what Otto must NOT assume. Silent when there is nothing on record, so a fresh
 *  account's prompt doesn't grow a block that says "no data" five ways. */
export function studentModelBlock(model: StudentModelShape | undefined, opts: { subject?: string; now?: Date; limit?: number } = {}): string {
  if (!model) return "";
  const now = opts.now || new Date();
  const concepts = relevantConcepts(model, { subject: opts.subject, now, limit: opts.limit });
  if (!concepts.length) return "";
  const band = (m: number): string => (m >= 0.8 ? "solid" : m >= 0.62 ? "working" : m >= 0.45 ? "shaky" : "very shaky");
  const lines: string[] = [];
  for (const c of concepts) {
    const bits: string[] = [`mastery ${band(c.mastery)}`];
    if (c.confidence < 0.35) bits.push("(thin evidence — treat as a guess, not a fact)");
    if (c.attempts > 0) {
      const ind = independentSuccess(c);
      bits.push(`${ind >= 0.6 ? "mostly" : ind >= 0.3 ? "sometimes" : "rarely"} solved unaided`);
      if (hintDependence(c) >= 0.5) bits.push("leans on hints");
    }
    if (c.transferAttempts > 0) bits.push(transferSuccess(c) >= 0.5 ? "applied it in a new context fine" : "hasn't transferred it to a new context yet");
    if (c.recalls > 0) bits.push(recallStrength(c) >= 0.6 ? "recalls it" : "recall is unreliable");
    lines.push(`- ${c.label}${c.subject ? ` (${c.subject})` : ""}: ${bits.join(" · ")}`);
    for (const m of liveMisconceptions(c, now)) {
      lines.push(`    ✗ likely misconception: "${m.text}" — seen ${m.count}×, confidence ${Math.round(m.confidence * 100)}%${m.evidence.length ? ` (e.g. ${m.evidence.slice(-1)[0]})` : ""}`);
    }
    for (const e of c.commonErrors.slice(0, 2)) lines.push(`    ! recurring slip: ${e.text} (${e.count}×)`);
    for (const s of c.strengths.slice(-1)) lines.push(`    ✓ can already: ${s}`);
    if (c.nextReview && Date.parse(c.nextReview) <= now.getTime()) lines.push(`    ↻ due for a quick retrieval check (not demonstrated since ${c.lastDemonstrated ? c.lastDemonstrated.slice(0, 10) : "unknown"})`);
  }
  return (
    `\nWHAT YOU ALREADY KNOW ABOUT THIS STUDENT (a persistent model built from real observations, with older ` +
    `evidence already aged out; you can see this and they can see it in their own "what Otto knows" panel, so ` +
    `never ask them to restate it and never read it back to them as a report):\n` +
    lines.join("\n") +
    `\nTreat "shaky"/"very shaky" as a pointer to WHERE to look, not a verdict on them — and where the ` +
    `evidence is thin, say so honestly ("I'm not sure that's the issue — let's test it") rather than ` +
    `confidently teaching the wrong thing.\n`
  );
}

/** A compact snapshot for the UI/API (the transparency panel, §30) — bands and counts, never a raw dump of
 *  every evidence string. */
export function studentModelSummary(model: StudentModelShape | undefined, now: Date = new Date()) {
  const concepts = model ? Object.values(model.concepts) : [];
  const misconceptions = concepts
    .flatMap((c) => liveMisconceptions(c, now).map((m) => ({ concept: c.label, conceptKey: c.key, ...m })))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 10);
  return {
    conceptCount: concepts.length,
    taught: concepts.filter((c) => c.mastery >= 0.62 && c.confidence >= 0.35).length,
    shaky: concepts.filter((c) => c.mastery < 0.45 && c.confidence >= 0.35).length,
    misconceptions,
    concepts: concepts
      .sort((a, b) => a.mastery - b.mastery)
      .slice(0, 24)
      .map((c) => ({
        key: c.key,
        label: c.label,
        subject: c.subject,
        mastery: c.mastery,
        confidence: c.confidence,
        band: c.mastery >= 0.8 ? "solid" : c.mastery >= 0.62 ? "working" : c.mastery >= 0.45 ? "shaky" : "very-shaky",
        attempts: c.attempts,
        unaided: c.unaided,
        liveMisconceptions: liveMisconceptions(c, now).length,
        lastDemonstrated: c.lastDemonstrated,
        evidence: c.evidence.slice(-3),
      })),
    updatedAt: model?.updatedAt,
  };
}

/** Fold an observed dependence series into a single hint-dependence read, so the model, the transparency panel
 *  and the anti-dependence gates share ONE number instead of three drifting ones. Returns null (never a
 *  fabricated 0) when there's no history. */
export function hintDependenceFromHistory(history: DependenceMetric[] | undefined): number | null {
  const recent = (history || []).slice(-3);
  if (!recent.length) return null;
  const help = recent.reduce((s, m) => s + (Number.isFinite(m.helpRatio) ? m.helpRatio : 0), 0) / recent.length;
  return round3(clamp01(help));
}
