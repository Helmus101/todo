# Product

<!-- impeccable:product-schema 1 -->

<!-- Drafted from the user's redesign brief and the codebase (AGENTS.md, server/tutorTurn). Not yet confirmed line by line; edit freely. -->

## Platform

web

## Users

IB (International Baccalaureate) students, mostly teenagers working on a phone or laptop, often tired, often stuck, often alone with homework, an exam, or coursework. Pronote-linked French schools are a real audience (French copy, Pronote connect). Secondary audience: students who use Otto's inbox/task assistant to organise deadlines.

## Product Purpose

Otto is an AI tutor that teaches instead of answering. A student talks to it by voice (Gemini Live) or types; the tutor is voice plus a running conversation. The shared board is switched off (`shared/features.ts` `BOARD_ENABLED = false`, 2026-11-15) and must not be the centre of any design. Success is the student reasoning their own way to the answer, not leaving with a solution they can't reproduce.

## Positioning

A Socratic thinking partner you talk to: it guides the student's own reasoning and will not hand over the answer to a question it just asked. Neighbouring chatbots return finished text; Otto holds a spoken conversation and asks before it tells.

## Operating Context

Voice sessions with a live transcript; typed chat; practice and exam-style exercises; mistake log; flashcards; journal; study stats; task/inbox assistant (Gmail, Calendar, Drive via Composio); Pronote context. Sessions run on Vercel.

## Capabilities and Constraints

- Gemini Live / OpenAI Realtime voice; the mic is closed while Otto thinks or speaks; the student interrupts with an Interrupt button.
- The board is off; the tutor screen is voice states plus the conversation transcript. Board code stays in the repo, untouched.
- Math in the conversation is rendered with KaTeX (`MathText`).
- Do not replace real behaviour with mock interactions; do not rewrite working systems.
- Client in `client/`, server in `server/`, one root package.json; Vite 6 on 5273, Express on 8788.

## Brand Commitments

Name "Otto". Prior decision (2026-10-13): flat, minimal, no shadows, red only for errors; the user has since reopened colour and asked for a distinctive identity.

## Evidence on Hand

No testimonials, grade outcomes, or user counts are in the repo as verified claims; `client/pages/Testimonials.tsx` exists and must not be treated as proof without checking its source. Do not invent proof.

## Product Principles

1. Teach, don't tell: the interface never rewards getting an answer fastest.
2. The person first: calm, human, small talk answered before the subject.
3. Voice first: the conversation is the product, so the transcript must be easy to follow without chat-bubble clutter.
4. Say what Otto is doing: listening, thinking, speaking, writing, always legible and never decorative.
5. One coherent journey: every feature serves reasoning, practice or reflection, not a feature list.

## Accessibility & Inclusion

WCAG AA contrast minimum, visible keyboard focus everywhere, reduced-motion respected, 44px touch targets on the phone, correct `lang` for French and English copy.
