# Data protection — current state, honestly

This document exists because Otto's likely users include minors in French public schools, and RGPD's
regime for children's data is stricter than the general one. It states what is true today, not what
we'd like to be true. Update it whenever the underlying architecture changes — a stale compliance
document is worse than none.

## What data Otto handles, and where it goes

| Data | Source | Stored | Sent to a third-party LLM |
|---|---|---|---|
| Pronote session token **and password** (the password is kept to re-login automatically when the token expires; cleared on disconnect or account deletion) | `server/pronote.ts` | Supabase, AES-256-GCM encrypted at rest (`server/crypto.ts`) | Never |
| Homework/test text, subject, grades | Pronote via `pawnote` | Supabase (plaintext row, RLS-protected) | **Yes** — sent to DeepSeek as prompt context on every run/chat turn (`server/claude.ts`: `academicBlock`, `assignmentBlock`) |
| Profile facts (about, preferences, people, projects, working hours) | User-entered | Supabase | **Yes** — `profileBlock` |
| Real name | User-entered | Supabase | **No** — deliberately excluded from `profileBlock` (see comment there); the model has no task-relevant need for it |
| Chat messages, generated notes/flashcards/quizzes | User + model | Supabase | **Yes** — this is the LLM's own output/input |

## The unresolved problem: DeepSeek is not a known-compliant processor

`server/claude.ts` calls `https://api.deepseek.com` — DeepSeek is a Chinese company. As of writing:

- **No confirmed EU/France data residency.** DeepSeek's API terms do not commit to processing requests
  within the EU.
- **No Data Processing Agreement (DPA) has been obtained.** A DPA is a baseline RGPD requirement for
  any processor handling data on your behalf, and doubly so for a minor's academic data.
- **No confirmed commitment that request content is excluded from model training.** Some providers
  offer this contractually; it has not been verified or contracted for DeepSeek here.

**This is very likely disqualifying for any official school pilot as currently configured.** It is not
a code bug — the code correctly sends only what the prompts need, nothing extraneous — but the
*destination* of that data is the problem. Two real paths forward, neither of which is a small patch:

1. **Swap the LLM provider to one with an EU/France presence and a real DPA.** Mistral AI (French,
   EU-hosted, offers a DPA) is the obvious candidate given the audience. This requires re-pointing
   `deepseekClient()` at a different base URL/SDK and re-verifying prompt/tool-call behavior against
   the new model — a real migration, not a config flag, and should be scoped as its own piece of work
   before any formal pilot conversation.
2. **Get a DPA and residency commitment directly from DeepSeek**, if one becomes available — unlikely
   to satisfy a rectorat/DPO in practice given the current landscape, but worth checking before
   assuming (1) is the only option.

Until one of these is resolved, treat any use of this app in an institutional/official capacity as
**out of scope** — informal use by consenting individuals (a family choosing to connect their own
Pronote account) is a materially different risk posture than a school-endorsed rollout.

**Decision (recorded, not left open): staying on DeepSeek.** Option (1) above was evaluated and
declined for now — Otto keeps using DeepSeek, not Mistral. This is a conscious call, not an oversight,
and it means the disqualifying-for-an-official-pilot posture above stands as written: this app is
positioned for informal/consenting-family use, not an institutional rollout, until that changes. If the
audience ever shifts toward schools/rectorats, this decision needs revisiting first — it's the actual
gate, not a code change.

## Pronote access itself

Separately from the LLM question: `server/pronote.ts` uses `pawnote`, an unofficial, reverse-engineered
client (not affiliated with or endorsed by Index-Éducation). Connecting requires the student's real
Pronote password, which is stored (AES-256-GCM encrypted, never logged) together with the session token so a
dead token can be replaced by an automatic re-login; but the *mechanism* —
a third-party app receiving a school-issued credential outside any ENT-sanctioned integration — is not
something a code change can make "authorized." Any move toward schools needs either a real
Index-Éducation/ENT partnership or dropping password-based Pronote login in favor of a channel that
doesn't require the credential at all (manual entry, calendar import, etc).

## What IS in place today

- Pronote token: AES-256-GCM at rest, key never in the client bundle, write path refuses to proceed
  if encryption isn't configured (`credentialEncryptionConfigured()` in `server/crypto.ts`).
- RLS + service-role-only write path on all persisted data (`supabase.sql`, `server/store.ts`).
- The agent's write actions are gated behind explicit user approval (`server/integrations.ts`,
  `ACTION_POLICIES`) — nothing autonomous can send/post/delete on the student's behalf.
- Prompt content is minimized where it costs nothing to do so (no real name sent; profile facts are
  capped to the most recent 12 per category).

None of this substitutes for a DPA or Pronote authorization — it reduces the blast radius of an
existing breach, it doesn't make the current data flow to DeepSeek or the Pronote login flow
institutionally compliant.

## GDPR checklist — where Otto stands (October 2026)

Honest status, not a certificate. "Done" means it exists in the code or the policy today.

| Requirement | Status | Where |
|---|---|---|
| Controller identified; contact for requests | Done | Privacy page "Who is responsible", footer of legal pages |
| Lawful basis per purpose, stated | Done | Privacy page "Why we may use your data" |
| Transparent about processors and transfers | Done, with a known gap (below) | Privacy page "Service providers", "International transfers" |
| Access (Art. 15) and portability (Art. 20) | Done | `GET /api/account/export` (profile, tasks, jobs, events, feedback) |
| Rectification (Art. 16) | Done | Settings → "What Otto knows about you" is editable |
| Erasure (Art. 17) | Done | `POST /api/account/delete` (needs the password): account, tasks, jobs, events, feedback, sessions, sign-in, and third-party grants |
| Restriction / objection (Art. 18, 21) | By request + Pause AI | Privacy page; Settings → pause; email |
| Withdraw consent | Done | Feedback publication is its own unchecked box and can be withdrawn in Settings; microphone is per-call; integrations can be disconnected |
| No tracking cookies; strictly-necessary storage only | Done | one session cookie + CSRF token + local storage; no banner needed |
| No visitor data sent to third parties on page load | Done | Google Fonts removed (fonts bundled, CSP no longer allows it); Vercel Analytics is cookieless page counting |
| Data minimisation in AI prompts | Done | No real name sent; tutor sessions stay in the browser; only labels go to the profile |
| Security of processing (Art. 32) | Done | see SECURITY.md: encrypted Pronote credentials, RLS, CSRF, rate limits, per-account login cap, password re-entry to delete |
| Breach notification (Art. 33/34) | Stated | Privacy page; process is: assess, notify CNIL within 72 h if required, notify users if high risk |
| Children | Partly | 15+ self-consent, parental consent flow for child accounts, shorter retention profile; see below |
| Records of processing (Art. 30) | This document + the table at the top | keep updated |

## What still needs a decision or an action from the owner (code cannot close these)

1. **DeepSeek (China)** receives typed tutor text and task content with no DPA, no EEA residency and no training opt-out
   commitment. The privacy page now says so plainly and tells users not to type sensitive data. The real fix is a
   provider with an EU DPA (e.g. Mistral) or a signed DPA from DeepSeek. This remains the largest gap.
2. **DPAs and transfer mechanisms** with Google, OpenAI, Supabase, Vercel, Sentry, Resend, Composio and Exa: confirm
   each provider's standard DPA is accepted in your account settings and keep copies. Choose EU regions where offered
   (Supabase and Vercel already can be).
3. **Retention.** Accounts are kept until deleted; there is no inactivity purge. Storage limitation (Art. 5(1)(e))
   expects a defined period. Recommended: warn by email, then delete accounts inactive for 24 months, and say so in
   the policy.
4. **Minors under 15 / school use.** `dataRetentionDays` is recorded on the profile at signup but not yet enforced by a
   job. A data protection impact assessment (DPIA) is advisable before any school deployment (see the top of this file).
5. **Email verification at signup** is off (accounts are created pre-confirmed). Turn on confirmation in Supabase Auth so
   nobody can register an address that is not theirs.
6. **Legal review.** The privacy policy and terms are plain-language drafts. Have them checked by a lawyer or the CNIL's
   guidance for small publishers before relying on them commercially.

