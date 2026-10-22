// The unlisted "in depth" page: one static HTML document, written to be read by an AI assistant (or a person) who has been
// handed the URL and asked to evaluate Otto. It is NOT linked from anywhere, NOT in the sitemap, NOT in robots.txt, and
// carries noindex, so only someone who knows the route finds it. It has no scripts, so a fetcher that never runs JavaScript
// sees everything. Rules for this file:
//  - Every statement describes what the shipped app does (or says plainly that it does not). Nothing here is a promise of results.
//  - The tutor's real behaviour rules and the IB knowledge it loads are quoted VERBATIM from the code, so the page cannot drift.
//  - Limits and unverified things are stated as prominently as strengths.
import { IB_KNOWLEDGE } from "./ibCurriculum.ts";
import { ibPacks } from "./ibSubjects.ts";
import { TUTOR_CONDUCT } from "./tutorConduct.ts";

/** The route. Not guessable on purpose; change it here (and in vercel.json) to move the page. */
export const BRIEF_PATH = "/otto-in-depth-7k3q";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const p = (s: string) => `<p>${esc(s)}</p>`;
const ul = (items: string[]) => `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
const h2 = (id: string, s: string) => `<h2 id="${id}">${esc(s)}</h2>`;
const h3 = (s: string) => `<h3>${esc(s)}</h3>`;
const pre = (s: string) => `<pre>${esc(s)}</pre>`;
const table = (head: string[], rows: string[][]) => `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;

const CONCERNS: string[][] = [
  // [concern, what Otto does about it, what is still true]
  ["Recognising an explanation is mistaken for understanding it (risks 1, 6, 9, 11)", "The tutor asks for the student's plan and first attempt before any help, fades help as they succeed, and before closing a topic gives a fresh problem to solve with no help. The model of the student records whether each thing was solved alone, after a hint, or only after an explanation, and Settings shows 'Solved on your own: X of Y attempts'.", "These are instructions to an AI model, which may not follow every one every time. The 'solved alone' figure is Otto's own tally, not an independent test."],
  ["Hints supply the structure the exam will not (2, 3, 5, 14)", "The student must state the plan first. After a hint they restate the plan in their own words. Now and then the tutor drops all cues and gives a bare exam question.", "A guided session is still easier than a silent exam. Timed past papers remain the real test."],
  ["Forgetting after a good session; weak delayed practice (7, 59, 62, 63)", "Each concept has a mastery estimate, recall results and a review date (Settings shows 'review now' when one is due). The tutor is told to open with a fresh, unannounced question on something that once needed help, and to skip what the evidence shows is solid.", "Scheduling quality has not been measured against a fixed-interval or no-memory baseline."],
  ["Poor transfer to unfamiliar questions (8, 36, 64)", "Evidence kinds include transfer-success and transfer-fail. The tutor is told to change the context or combine topics after a method works, and to pose multi-step, unfamiliar-context problems for advanced courses.", "Whether this improves transfer on real exams has not been studied."],
  ["False confidence and poor calibration (9, 12, 81)", "The tutor sometimes asks 'how sure are you, 1 to 5?' before saying whether a hard answer is right, then says honestly whether the confidence matched.", "Confidence is not stored or graphed yet."],
  ["Too much scaffolding; too little struggle (3, 4, 5, 13, 82)", "Try-first, a hint ladder (smaller question, nudge, a different worked example, then explanation), and 'check your own answer first' (put it back in, units, a limiting case) before Otto points out an error.", "Calibrating productive versus unproductive struggle is hard for any tutor, human or AI."],
  ["Endless hints waste time; Socratic questioning becomes a bottleneck (46, 49, 50, 52)", "If the student already knows it, the tutor confirms briefly and goes harder. Stuck after two tries, or frustrated: it stops asking and explains plainly, then checks with a fresh example. Quick facts are stated in one line. Side topics are parked. Typing is always available.", "A model can still be too chatty on a given turn."],
  ["Everything is too easy (43, 96)", "The tutor is instructed to start at real exam level, go up immediately after a right answer, never pose one-step plug-in problems for advanced courses, and not ask what any student at that level knows (units, standard formulas). For IB Higher Level it is pitched at Paper 2 and Paper 3 standard.", "Difficulty is judged by the model; a student who finds it too easy or too hard can say so."],
  ["Wrong equations, steps, signs, units, graphs, diagrams (16 to 23, 29)", "Before confirming or stating a result the tutor is told to check it a second way (units, sign convention stated aloud, order of magnitude, a limiting case) and to state the assumptions a method needs. In code, every equality on the board is evaluated numerically before it is written, and a line whose own arithmetic is false is dropped. Units the student has not said are not pre-written on the board.", "The check covers numeric equalities only; it cannot verify a derivation's logic, a graph's shape, or an economics diagram. No accuracy benchmark exists for Otto; do not treat its output as infallible."],
  ["Ambiguous questions; wrongly marking a valid alternative method (24, 25, 26, 27)", "The tutor is told to state which reading it takes or ask, to accept any valid method and judge it on its own terms, to ask a second question before calling a mistake a misconception, and to check every multiple-choice option, not only the right one.", "Instruction-following by a language model is probabilistic."],
  ["Invented facts, statistics, quotations (28, 84)", "The tutor is told never to state a statistic, quotation, date or source unless sure, to say what it is unsure of, and in essays and discussion subjects to ask what the evidence is and what would count against the claim.", "It can still be confidently wrong. Verify facts that matter."],
  ["No measured error rate (30, 15, 100)", "Stated plainly: there is none. See the evaluation protocol below, which lets you measure it on your own material.", "This is a real, open gap."],
  ["Does not match the IB syllabus, command terms, mark scheme (31 to 35, 39, 40)", "Students who say they are in the IB (Settings) get IB structure, command terms, method/accuracy mark habits and a per-subject pack built from school course outlines (quoted below). Test mode marks like an examiner (method, accuracy, reasoning, follow-through), says which marks would be lost, and states it is an estimate.", "Not official, not endorsed by the IB, and syllabi change. Practice questions are exam-style, not official papers; mark schemes are not reproduced. Use past papers and your teacher for official standards."],
  ["Under-prepares for timed exams (37, 38, 54)", "Test mode shows the marks and a time budget of about a minute per mark and gives no feedback until the answer is in. The tutor recommends official past papers under time when more tutoring is not the best use of time.", "Otto does not run a clock; the student keeps time."],
  ["Redundant for strong students, e.g. SAT Math 800 (44, 96, 99)", "For strong students the tutor is told to run a short diagnostic, spend time only on specific weaknesses, and say so when more tutoring is not the best use of their time.", "For a student with no specific weakness, Otto adds little."],
  ["Time overhead; voice slower than writing; speech recognition errors (46 to 48, 72)", "Typing is always one tap away. If speech recognition garbles maths, the tutor is told to confirm what it heard before using it, and not to guess a garbled answer into a right one. If live voice cannot start, a typed fallback and a fallback voice take over.", "Voice is a convenience, not evidence of better learning."],
  ["Memory is wrong, stale or narrow (56 to 58, 60, 63, 65)", "The student model keeps unaided, hinted, explained, mistake and misconception evidence separate; a misconception is recorded as a stated claim so that it can later be tested and retired. The tutor is told to treat memory as a hypothesis to re-test, never as fact. The student can see it (Settings, 'What you're working on') and reset it.", "The model is a heuristic summary; its accuracy has not been validated."],
  ["The board looks authoritative; fragmented long solutions (66, 70, 71)", "A visible note under the voice bar says Otto can be wrong even when the board looks tidy. The board has undo, and a one-line summary is added when a problem is finished.", "Typeset maths looks right even when it is not."],
  ["Over-reliance; outsourcing the first step; losing the habit of challenging the tutor (76 to 85)", "Plan-first, fading help, a solo check at the end of a topic, and an explicit invitation to disagree: when the student disagrees the tutor re-derives and concedes plainly if they are right. It suggests one more similar problem later with no AI at all.", "Whether a student over-relies depends on how they use it. Attempt problems alone first."],
  ["Privacy: data leaves the device, many providers, voice, sensitive profile (86 to 95)", "Details in the privacy section below, and in the privacy policy. Tutoring sessions, boards and drawings are stored only in the browser. Pronote credentials are stored encrypted (AES-256-GCM) and deleted on disconnect. The account can be exported and deleted in Settings. Local data is wiped on sign-out and when a different account signs in on the same browser.", "Audio, transcripts and board content are sent to AI providers whose own retention and terms apply. An operator can restrict the tutor to Google only; by default DeepSeek is a fallback. Otto does not control provider retention."],
  ["Pronote import errors; school data exposure (74, 90)", "Pronote is read-only (homework, tests, grades, lessons), never written to, optional, and disconnectable. There is no official Pronote API, so access uses the student's own login, which is why it is stored encrypted.", "An unofficial integration can break or return incomplete data. Check due dates against Pronote."],
  ["Product changes; accountability (73, 94, 95)", "The privacy policy and terms are public. Responsibility for checking output stays with the student, and the tutor says so.", "Features, models and providers can change."],
  ["No comparative evidence of learning gains (15, 97, 100)", "None exists, and this page does not claim one. The research page describes the principles the method is built on (explaining aloud, retrieval practice). No outcomes study of Otto itself has been run.", "Decide with the protocol below, not with this page."],
];

export function ottoBriefHtml(): string {
  const packs = ibPacks();
  const sections: string[] = [];

  sections.push(`
<h1>Otto, in depth</h1>
<p class="lede">A detailed, honest brief on Otto, written so that an AI assistant (or a person) who has been given this link can evaluate it properly. It describes what the shipped app does, shows the tutor's real behaviour rules word for word, and says plainly what is not claimed. Read section 14 before you judge any strength.</p>
<nav aria-label="Contents"><ol>
<li><a href="#what">What Otto is</a></li><li><a href="#session">What a session looks like</a></li><li><a href="#method">How Otto teaches</a></li><li><a href="#board">The whiteboard and how it is kept honest</a></li>
<li><a href="#ib">IB depth</a></li><li><a href="#others">Other programmes and subjects</a></li><li><a href="#pronote">Pronote integration</a></li><li><a href="#memory">Memory and personalisation</a></li>
<li><a href="#data">Data, privacy and security</a></li><li><a href="#cost">Cost, languages, devices</a></li><li><a href="#concerns">Common concerns, one by one</a></li><li><a href="#evaluate">How to evaluate Otto fairly</a></li>
<li><a href="#fit">Who it suits and who should use something else</a></li><li><a href="#limits">What is not claimed</a></li><li><a href="#verbatim">The tutor's rules, verbatim</a></li><li><a href="#facts">Quick facts</a></li></ol></nav>`);

  sections.push(h2("what", "1. What Otto is"));
  sections.push(p("Otto is a voice-first AI tutor with a shared whiteboard, delivered as a web app (https://hiotto.vercel.app). The student talks to it out loud (typing also works), it asks guiding questions instead of handing over answers, explains plainly when the student is stuck, and writes the working on a board as the conversation goes: typeset maths, graphs, diagrams, tables, multiple choice. It is built first for school students on the IB Diploma and also works for AP, SAT, GCSE, the French Bac and other programmes."));
  sections.push(p("It is not the product at heyotto.app, which is a different company and product."));
  sections.push(ul([
    "Voice: the browser streams audio to a live-voice AI service (Google Gemini Live first, OpenAI Realtime as a fallback) using a short-lived credential. The tutor speaks with a male voice.",
    "Typed chat: the student can type at any time; the same tutor answers.",
    "Board: a separate step writes the board after each spoken exchange, under strict rules about what may be written (section 4).",
    "Memory: short notes about what the student has worked on, shown to them in Settings, so a session can start where the last one stopped.",
    "Optional integration: Pronote (a French school portal) so Otto knows what homework and tests are due.",
    "Optional hardware: an Arduino button that starts and stops the tutor from the desk.",
  ]));

  sections.push(h2("session", "2. What a session looks like"));
  sections.push(ul([
    "The student picks a subject (or types their own) and presses Start talking. Otto greets them in a sentence or two and starts from what it knows (earlier sessions, what is due in Pronote), or asks what they are working on.",
    "The student answers out loud. Their words appear on screen as they speak. Otto replies in one to three short spoken sentences and ends with one question.",
    "After each exchange the board is updated: the problem, the student's correct steps (never ahead of them), definitions and rules Otto explained, and figures when a picture helps.",
    "The student can interrupt, type, share a photo or PDF of a worksheet, draw on the board (Otto sees the drawing), undo a board change, or end the call.",
    "Sessions are saved in the browser so any past session can be reopened and continued; resuming picks up exactly where the last turn stopped.",
  ]));

  sections.push(h2("method", "3. How Otto teaches"));
  sections.push(p("The default is Socratic: the student does the thinking and Otto asks. The tutor's instructions, in the words it is actually given, are in section 15. In summary:"));
  sections.push(ul([
    "Try first: the student states a plan and makes a first attempt before any help. Hints climb one rung at a time: a smaller question, a concrete nudge, a different worked example, then a direct explanation.",
    "It does not drag hints out: if the student already knows something it moves on; if they are stuck after two tries or frustrated it explains plainly, then checks with a fresh example.",
    "It never hands over the answer to the problem the student is solving, even when asked, but states quick facts (a definition, a formula, a constant) plainly.",
    "Pitched hard enough: it starts at the level of a real exam question for the course, goes up immediately after a right answer, and for advanced courses poses multi-step problems in unfamiliar contexts. It does not ask what any student at that level knows.",
    "Proves it was the student, not Otto: before closing a topic it gives a fresh problem with no help and says honestly whether the student did it alone.",
    "Test mode on request: exam-style questions with the marks shown and a time budget, no feedback until answered, then marked like an examiner with the marks that would be lost, labelled as an estimate.",
    "Calibration, transfer, delayed re-checking of things once needed help with, and an explicit invitation to disagree with Otto.",
    "Honest about its limits: it states what it is unsure of, never invents sources or numbers, never claims to match an official mark scheme, and tells the student to check anything important.",
  ]));
  sections.push(p("These behaviours are instructions given to an AI language model. They shape its behaviour strongly but are not guarantees on any single turn."));

  sections.push(h2("board", "4. The whiteboard and how it is kept honest"));
  sections.push(p("A separate AI step (the board writer) reads each spoken exchange and writes the board. It is deliberately constrained so that the board does not do the student's work for them or look more authoritative than it is."));
  sections.push(ul([
    "It writes only what the student has actually said or reached, never the next step, and writes a result exactly as spoken (a number said without a unit is written without a unit while the tutor is still asking about the unit).",
    "It writes nothing while the tutor is correcting the student, and never writes the corrected answer.",
    "It writes the problem once, definitions and rules the tutor explained, and figures (graphs of functions, geometry, tables, flows, timelines) when a picture teaches faster.",
    "Code check: before any line is written, the numeric equalities on it are evaluated (fractions, roots, powers, plus or minus). A line whose own arithmetic is false is dropped. Lines it cannot read (algebra, units, text) are never dropped.",
    "Limits: the check does not verify logic, graph shapes or economics diagrams. The board can still be wrong, and a note under the voice bar says so.",
  ]));

  sections.push(h2("ib", "5. IB depth"));
  sections.push(p("Settings asks one question: 'Are you in the IB Diploma?'. If the answer is no, none of the IB material below is used and Otto is a general tutor. If yes, the tutor is given the general IB knowledge and, for the subject of the session, a subject pack. The packs were built from a school's 2026 to 2028 course outlines, which are adapted from the IB subject guides. They record topic maps, which parts are Higher Level only, and the papers and weightings. Where the outlines were silent, nothing was invented."));
  sections.push(p("Practice questions for IB students can also be drawn from registered sources (IB Documents, Revision Village, Save My Exams, IB Maths Resources, ThinkIB, IB Academy, Khan Academy) found by live web search, adapted and linked, and never presented as official. If a site is behind a login or returns nothing, Otto generates the question instead."));
  sections.push(h3("General IB knowledge given to the tutor (verbatim)"));
  sections.push(pre(IB_KNOWLEDGE));
  for (const pk of packs) { sections.push(h3(`Subject pack: ${pk.title} (verbatim)`)); sections.push(pre(pk.text)); }
  sections.push(p("Not covered by a pack yet: Business Management, Psychology, Environmental Systems and Societies, Visual Arts and other courses. For those the tutor uses the general IB knowledge and the rule to say so when unsure of a current requirement."));

  sections.push(h2("others", "6. Other programmes and subjects"));
  sections.push(ul([
    "SAT: short self-contained questions in the real format (four options, one best answer, distractors built from typical mistakes) and Reading and Writing passages put on the board, harder after a correct answer.",
    "AP, GCSE, the French Bac and other courses: the same teaching method applied to that curriculum, without IB terms. AP students also get question sources (AP Central and similar).",
    "Maths and sciences: the givens and the unknown first, a figure, the student's equations line by line.",
    "Essay and discussion subjects (history, economics essays, languages, literature): get the student's position first, then claim, evidence and reasoning; one strength and the single most important improvement; the student rewrites. Otto never writes the essay.",
    "Languages: the interface and the tutor work in ten languages (English, Chinese, Hindi, Spanish, French, Arabic, Portuguese, Russian, German, Japanese).",
  ]));

  sections.push(h2("pronote", "7. Pronote integration"));
  sections.push(p("Pronote is the school portal used by many French and international schools. With the student's consent Otto reads their homework (the cahier de texte), upcoming tests, grades and the lesson content their teachers publish, so it can start from what is actually due and build questions from the student's own lessons. It is read-only: nothing is ever sent, handed in or written back. There is no official Pronote API, so access uses the student's own login through an unofficial library. The credentials are stored encrypted (AES-256-GCM) and deleted when the student disconnects. It is optional; Otto works fully without it. It can break or return incomplete data because it is unofficial, so due dates should be checked against Pronote."));

  sections.push(h2("memory", "8. Memory and personalisation"));
  sections.push(ul([
    "The student model keeps, per concept: how solid it is, how many attempts were solved alone, after a hint, after an explanation or partly, mistakes and misconceptions (a misconception is stored as a stated claim, so it can be tested and retired), recall results, transfer results, and a review date.",
    "Settings shows it ('What you're working on') with a plain figure: 'Solved on your own: X of Y attempts', and how often a method held up in a new context.",
    "It is background for the tutor, not fact: the tutor is told to re-test it, to update it when the student now does something alone, and not to nag about a weakness it has not rechecked recently.",
    "The student can see and reset it. It is stored on the account; conversations, boards and drawings are not.",
    "Its accuracy as a measure of mastery has not been validated.",
  ]));

  sections.push(h2("data", "9. Data, privacy and security"));
  sections.push(h3("Where data goes"));
  sections.push(ul([
    "Voice: streamed from the browser straight to Google Gemini Live (or OpenAI Realtime as a fallback), with a credential made for a single call. Otto's server does not receive the audio. Transcripts come back from the provider.",
    "Typed tutor messages and the board writer: Google Gemini is the first choice. If it fails, DeepSeek answers instead (DeepSeek processes data outside the EU). An operator setting can disable the DeepSeek fallback for the tutor.",
    "Task preparation, homework help and interface translation use DeepSeek.",
    "Drawings and photos: a picture is sent to the voice provider so Otto can see it, and to Google's image reading when asked.",
    "If live voice cannot start, a fallback voice reads Otto's replies; the text of those replies is sent to a speech-synthesis service for that purpose.",
    "Accounts, profile, memory notes, tasks and usage counts are stored with Supabase. Pronote credentials are stored encrypted. Errors can be reported to an error-monitoring service without the student's messages. The password-reset email goes through an email provider.",
    "Otto's privacy policy states that it does not sell data, use it for advertising, or use content to train foundation models. What the AI providers do under their own terms is theirs; Otto does not control their retention.",
  ]));
  sections.push(h3("What stays on the device"));
  sections.push(p("Tutoring sessions (conversation, board, drawings, session summaries) are saved only in the browser. They do not follow the student to another device and are not recoverable if the browser data is cleared. Local data is wiped on sign-out, and also if a different account signs in on the same browser."));
  sections.push(h3("Control"));
  sections.push(p("In Settings the student can view the memory, reset it, export all account data, delete the account (which erases the profile, tasks, memory, connections and sign-in and revokes connected apps), and disconnect Pronote."));
  sections.push(h3("Security measures present in the app"));
  sections.push(ul([
    "Passwords handled by Supabase Auth; session cookies are httpOnly, secure and same-site; CSRF tokens on state-changing requests; rate limits on login, AI and other expensive routes; a weekly AI allowance per account.",
    "Row-level security on database tables; the server refuses to start in production without its key settings.",
    "Model-written interactive scenes run in a sandboxed iframe with a strict content security policy that blocks network access.",
    "Outbound page fetches are checked against private-network addresses and size-capped; when the tutor can read a student's mailbox it may only open pages that a search returned, so injected text cannot send data to an arbitrary address.",
    "An uploaded account export cannot raise the AI budget or change access flags.",
    "Expired sessions, rate-limit rows and old job records are pruned daily.",
  ]));
  sections.push(p("None of this is an independent security audit. Read the privacy policy (/privacy) and terms (/terms) before connecting a school account."));

  sections.push(h2("cost", "10. Cost, languages, devices"));
  sections.push(ul([
    "Free for now, with a weekly AI allowance per account; a student who uses it up can ask for more.",
    "Ten languages for the interface and the tutor.",
    "A web app that runs in a modern browser; the optional Arduino button needs Chrome or Edge (Web Serial).",
    "The app can be installed as a web app; it needs a connection to function.",
  ]));

  sections.push(h2("concerns", "11. Common concerns, one by one"));
  sections.push(p("This table answers a list of 100 ways an AI tutor can be a bad tool (learning effectiveness, accuracy, exam preparation, time, memory, interface, dependence, privacy, and the strategic case for a particular student). The numbers in brackets refer to that list if you have it; each row names its concern in full, so you do not need it. The third column is what is still true after the mitigation; it matters as much as the second."));
  sections.push(table(["Concern", "What Otto does about it", "What is still true"], CONCERNS));

  sections.push(h2("evaluate", "12. How to evaluate Otto fairly"));
  sections.push(p("No outcomes study of Otto exists, so the decision should rest on a small test of your own, not on this page."));
  sections.push(ul([
    "Pick one subject you find hard. Choose 20 comparable problems of the same difficulty. Do ten with Otto and ten with your normal method, with similar time limits.",
    "Before you ask Otto for help, attempt each problem alone. Note whether you could have started without a hint.",
    "A few days later, solve fresh problems of the same type with no assistance and no feedback until the end, under time. Mark them with official mark schemes or a teacher, not with Otto.",
    "Measure unaided accuracy, time taken (including the session), and repeated errors. Compare the two groups.",
    "Check Otto's own explanations against your textbook or teacher, especially multi-step derivations and anything factual.",
    "Look at Settings: 'Solved on your own: X of Y'. If that figure does not rise over weeks, the tutoring is not working for you.",
    "Keep it only if your independent performance improves without a large rise in total study time. If sessions only feel easier, they have not earned a place.",
  ]));

  sections.push(h2("fit", "13. Who it suits and who should use something else"));
  sections.push(ul([
    "Likely to help: a student who wants to understand and solve problems themselves, learns by talking it through, and keeps repeating the same mistakes. Maths, physics, chemistry and economics with visible working are the strongest fit; the IB packs make it more specific for IB students.",
    "Likely redundant: a student with no specific weakness (for example an already top SAT Math score), routine homework on topics they already know, or anyone who just wants a fast answer. A normal AI assistant is quicker for that.",
    "Use something else for: timed exam practice and official marking (past papers, mark schemes, a teacher), high-stakes factual accuracy, foundational remediation that needs a human, detailed essay assessment against official criteria, and anything where the cost of an error is high.",
  ]));

  sections.push(h2("limits", "14. What is not claimed"));
  sections.push(ul([
    "No claim that Otto improves grades or exam results. No outcomes study has been done.",
    "No accuracy benchmark. Otto can make mistakes in maths, physics, economics, history and anything else, and the board can look right while being wrong.",
    "No claim of official status: practice questions are exam-style, estimated marks are not official, and Otto is not endorsed by the IBO, the College Board or any exam body.",
    "No claim that every tutor behaviour in section 3 happens on every turn; they are instructions to a probabilistic model.",
    "No claim that the memory model correctly measures mastery.",
    "No claim that the Pronote integration is stable; it is unofficial.",
    "No claim of independent security certification.",
    "No claim about what AI providers do with data beyond what Otto's policy and their own terms say.",
    "The IB packs reflect one school's outlines for the 2026 to 2028 cohorts and do not cover every IB course.",
    "A student who is in distress or needs sustained human help should talk to a teacher or a person they trust, not an AI tutor.",
  ]));

  sections.push(h2("verbatim", "15. The tutor's behaviour rules, verbatim"));
  sections.push(p("These are the shared conduct rules both the voice tutor and the typed tutor are given, exactly as written in the code. Further instructions cover tone, the board, pacing and pitching the difficulty."));
  sections.push(pre(TUTOR_CONDUCT));

  sections.push(h2("facts", "16. Quick facts"));
  sections.push(table(["Item", "Fact"], [
    ["Product", "Otto, a voice-first AI tutor with a shared whiteboard (web app)"],
    ["Address", "https://hiotto.vercel.app"],
    ["Not to be confused with", "heyotto.app, a different product"],
    ["Built first for", "IB Diploma students; also AP, SAT, GCSE, French Bac and others"],
    ["Live voice", "Google Gemini Live, with OpenAI Realtime as fallback; male voice"],
    ["Typed tutor and board writer", "Google Gemini first; DeepSeek as fallback; operator can disable the fallback"],
    ["Task preparation, translation", "DeepSeek"],
    ["School integration", "Pronote, read-only, optional, unofficial"],
    ["Where sessions are stored", "Only in the student's browser"],
    ["Where the profile and memory are stored", "On the account (Supabase)"],
    ["Pronote credentials", "Encrypted, AES-256-GCM, deleted on disconnect"],
    ["Cost", "Free for now with a weekly AI allowance"],
    ["Languages", "English, Chinese, Hindi, Spanish, French, Arabic, Portuguese, Russian, German, Japanese"],
    ["Policies", "/privacy, /terms, /research"],
  ]));

  const body = sections.join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Otto, in depth: a detailed, honest brief</title>
<meta name="description" content="A detailed brief on Otto, a voice-first AI tutor with a shared whiteboard built first for the IB Diploma: how it teaches, what it does about the usual failure modes of AI tutors, data handling, and what is not claimed.">
<meta name="robots" content="noindex, nofollow">
<style>
:root{color-scheme:light dark}
body{font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;max-width:860px;margin:0 auto;padding:32px 20px 80px;color:#1c1b19;background:#fff}
h1{font-size:2.4rem;line-height:1.1;margin:0 0 12px;letter-spacing:-.02em}
h2{font-size:1.5rem;margin:44px 0 10px;padding-top:18px;border-top:3px solid #1c1b19}
h3{font-size:1.05rem;margin:22px 0 6px}
.lede{font-size:1.1rem;color:#3a3935}
a{color:inherit}
pre{white-space:pre-wrap;word-wrap:break-word;background:#f5f3ef;border:1px solid #e3dfd7;border-radius:8px;padding:14px;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
table{width:100%;border-collapse:collapse;font-size:14px;margin:12px 0}
th,td{border-top:1px solid #e3dfd7;padding:8px 10px;vertical-align:top;text-align:left}
th{font-weight:600;background:#f5f3ef}
nav ol{columns:2;padding-left:20px}
@media(max-width:640px){nav ol{columns:1}}
@media(prefers-color-scheme:dark){body{background:#151412;color:#ece9e2}.lede{color:#c9c5bb}pre,th{background:#1f1d1a;border-color:#34312c}td,th{border-color:#34312c}h2{border-color:#ece9e2}}
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}
