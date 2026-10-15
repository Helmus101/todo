// Assistance ledger, knowledge states and recap (server/tutorTurn/ledger.ts) — pure code, no model.
import { logAssistance, settleRetest, dueRetests, knowledgeState, buildRecap } from "../server/tutorTurn/ledger.ts";

export function runTutorLedgerSim(check, section) {
  section("Assistance ledger, knowledge states, recap");
  const t0 = new Date("2026-01-01T10:00:00Z");
  const later = new Date("2026-01-02T10:00:00Z");
  let l = logAssistance(undefined, { skill: "slope", level: 3, now: t0 });
  check("help below level 4 is not logged", l.length === 0);
  l = logAssistance(l, { skill: "slope", level: 4, now: t0 });
  l = logAssistance(l, { skill: "slope", level: 5, now: t0 });
  check("help at 4+ is logged once per skill per sitting", l.length === 1 && l[0].status === "pending");
  check("an unaided success in the SAME sitting does not settle it", !settleRetest(l, "slope", true, t0).settled);
  check("an assisted success never settles it", !settleRetest(l, "slope", false, later).settled);
  check("a retest is due next sitting", dueRetests(l, later).length === 1 && dueRetests(l, t0).length === 0);
  const s = settleRetest(l, "slope", true, later);
  check("an unaided success next sitting settles it", s.settled && s.ledger[0].status === "passed" && dueRetests(s.ledger, later).length === 0);
  const many = Array.from({ length: 80 }, (_, i) => ({ skill: "s" + i, level: 4, now: t0 })).reduce((acc, e) => logAssistance(acc, e), undefined);
  check("the ledger is capped at 50", many.length === 50);
  check("explaining alone leaves a skill at 'introduced'", knowledgeState({ unaided: 0, assisted: 0, mistakes: 0, seen: true }) === "introduced");
  check("success after help is 'assisted', not independent", knowledgeState({ unaided: 0, assisted: 1, mistakes: 0, seen: true }) === "assisted");
  check("one unaided success is 'independent', two 'repeated'", knowledgeState({ unaided: 1, assisted: 0, mistakes: 0, seen: true }) === "independent" && knowledgeState({ unaided: 2, assisted: 0, mistakes: 0, seen: true }) === "repeated");
  check("a skill with pending help and no unaided success is 'review_due'", knowledgeState({ unaided: 0, assisted: 1, mistakes: 0, seen: true, pendingRetest: true }) === "review_due");
  const rec = (o) => ({ at: "x", move: "elicit", support: 1, intent: "other", diagnosis: "unclear", words: 10, studentWords: 3, repaired: false, ms: 1, ...o });
  const r = buildRecap({ lang: "en", board: [{ id: "a", text: "$x=3$", kind: "result", at: "x" }], objectives: [{ label: "Solve linear equations" }], log: [rec({ verdict: "correct", support: 1 }), rec({ verdict: "correct", support: 4 }), rec({ verdict: "incorrect" })] });
  check("recap separates alone from helped", r.canDoAlone.length === 1 && r.canDoWithHelp.length === 1);
  check("recap reports mistakes, the key line and the open objective as the gap", r.mistakes.length === 1 && r.keyLines[0] === "$x=3$" && r.gaps[0] === "Solve linear equations" && /Solve linear/.test(r.next));
  const empty = buildRecap({ lang: "en", board: [], log: [] });
  check("an empty session claims nothing", !empty.canDoAlone.length && !empty.canDoWithHelp.length && !empty.learned.length);
}
