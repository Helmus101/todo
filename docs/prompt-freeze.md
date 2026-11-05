# Prompt freeze

Otto's teaching behaviour is defined in three places that are **frozen** together, because they are one idea: what the tutor is told, what is judged live, and what is tested.

| Frozen | Where | Why |
| --- | --- | --- |
| The charter (ten commitments with real bad/good pairs) | `shared/tutorCharter.ts` | The only definition of core behaviour; it opens the voice instructions. |
| The situation cards and their cooldowns | `shared/situations.ts` | Guidance delivered at the moment it matters (private note, no reply of its own). |
| The judge rubric | rendered from the charter (`renderJudgeRubric`) | The live turn check reads the same words the tutor was given. |

`prompt.lock.json` holds a SHA-256 of each. `npm test` fails when one changed without a new lock (set `PROMPT_UNLOCK=1` while editing).

## What may still change without unfreezing
IB subject packs and school detail (`shared/ibPacks/`), the long reference text in `shared/tutorPrompt.ts` / `shared/tutorConduct.ts` (the charter wins when they disagree), model ids, turn-taking numbers (`patient` in `useGeminiLive.ts`), the board mechanics (`boardTool.ts`, `apply.ts`), the trigger regexes of a card (the card's text and id stay frozen; fix a trigger with a test).

## Unfreeze procedure
1. Say which commitment failed, with the transcript that shows it (real session, or a persona in `scripts/tutor-sim.ts`).
2. Prefer fixing code (a guard, a trigger, the board) before touching the charter text.
3. Edit with `PROMPT_UNLOCK=1`, then run `npm run prompt:freeze`. It replays the freeze personas (`arccos-test-review`, `arccos-noisy-mic`, `rational-from-asymptotes`, `explosion-ratio`, `doing-own-problems`, `exam-tomorrow-wants-answer`, `board-watcher`) and fails on any **hard flag**, which is a check made by code (stock-praise opener, a posed problem missing from the board, a promise of the board with no write, a reply over 90 words, wrong arithmetic on the board). Only a passing run rewrites the lock.
4. The judge's flags (handed-over answer, wrong step, maths error, false board claim) are **leads, not a gate**: read each one in the transcript. In the first runs it was wrong about half the time (it called a correct step wrong, and marked "it's on the board" false in turns where the pen's own log shows the line written).

## What the simulator cannot show
The real voice model (turn-taking, transcription of real speech, the pen tool on Gemini Live). After any unfreeze, do one live voice session on Math AA HL with pauses, a mumbled line, "let's just solve it" and a challenge.

## Status when this was first locked (2026-11-03)
The lock was written by hand (`npm run prompt:lock`), not by a passing `npm run prompt:freeze`: the last full run (7 personas x 10 turns, DeepSeek, about 4 cents) raised one code-verified hard flag ("That's exactly right" as an opener) and the judge's leads contained one real answer leak (the tutor said "29 over root 59 is your answer" on the vector-distance persona, which the live turn check also flags). Earlier runs had zero answer leaks on the arccos and rational-function personas. Treat the lock as "this text is the baseline", not as "this passed".

## 2026-11-05: tenth commitment, "adapt-the-help"
Added after the user said the tutor was not guiding well: when a question has not landed, change the move (explain the idea, never the answer; a smaller step; a parallel example; a picture) instead of asking the same kind of question again. The lock was rewritten by hand. The freeze suite was NOT re-run for this change: DeepSeek returned `402 Insufficient Balance`. Top it up, run `npm run prompt:freeze`, and read the transcripts.

