# Data protection — current state, honestly

This document exists because Otto's likely users include minors in French public schools, and RGPD's
regime for children's data is stricter than the general one. It states what is true today, not what
we'd like to be true. Update it whenever the underlying architecture changes — a stale compliance
document is worse than none.

## What data Otto handles, and where it goes

| Data | Source | Stored | Sent to a third-party LLM |
|---|---|---|---|
| Pronote login token (replaces the real password after first login) | `server/pronote.ts` | Supabase, AES-256-GCM encrypted at rest (`server/crypto.ts`) | Never |
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

## Pronote access itself

Separately from the LLM question: `server/pronote.ts` uses `pawnote`, an unofficial, reverse-engineered
client (not affiliated with or endorsed by Index-Éducation). Connecting requires the student's real
Pronote password once; the resulting token is encrypted at rest and never logged, but the *mechanism* —
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
