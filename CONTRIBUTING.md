# Contributing to Otto

Thanks for helping out. Otto is MIT-licensed and self-hostable, and the whole pitch is that people can *read the code that reads their mail* — so contributions that keep the code clear and the safety guarantees intact are especially welcome.

## Before you open a PR

Run the same checks CI does, and keep them green:

```bash
npm run typecheck   # tsc --noEmit
npm test            # pure-function suite — no network, no AI calls
npm run test:smoke  # HTTP smoke test against the Express app
npm run build       # production client build
```

## Ground rules

- **Never weaken the permission layer without a very good reason and a matching test.** The rule that the agent can't send, post, delete, or pay unattended is enforced in [`server/integrations.ts`](server/integrations.ts). New integration write actions are **deny-by-default** — to auto-allow one, add it explicitly to `ACTION_POLICIES` (a reviewed decision), never loosen the regex.
- **Add a test for behaviour changes.** The suite in [`tests/run.mjs`](tests/run.mjs) is pure-function by design (it must not hit the network or an AI provider) — factor logic so it's testable that way, as the existing dedupe/queue/cost/guardrail tests are.
- **Match the surrounding style.** Comments explain *why*, not *what*; keep them where the existing code keeps them.
- **Write for serverless.** Production runs on many short-lived Vercel instances: shared state goes in Supabase,
  never in a module-level `Map`; work that must finish after the response goes through `waitUntil` or the job queue.
- **Styles use the tokens.** Colours, spacing (`--space-1…8`), radii and type come from the single `:root` block in
  `client/styles.css` — no new hex colours or one-off pixel values.
- Keep changes focused — one concern per PR.

## What's most useful

- Grounding/quality improvements to generation and execution (with a way to measure them).
- New Composio integrations, added to the catalog + policy registry with tests.
- Docs and self-host ergonomics.

## Security

Found a vulnerability? Please **don't** open a public issue — see [`SECURITY.md`](SECURITY.md).
