# Security Policy

Otto reads people's inbox, calendar, and Drive, so security reports are taken seriously and triaged quickly.

## Reporting a vulnerability

**Please do not open a public issue for security problems.** Instead, email **tjong.willem@gmail.com** with:

- a description of the issue and its impact,
- steps to reproduce (a proof-of-concept if you have one), and
- any suggested remediation.

You'll get an acknowledgement within **72 hours**, and a fix or mitigation plan for confirmed issues as fast as is practical. Please give a reasonable window to remediate before any public disclosure.

## Scope

Most relevant to Otto's threat model:

- **The permission layer** — the guarantee that the agent can never run an irreversible *outbound* or *destructive* action unattended. The enforcement lives in [`server/integrations.ts`](server/integrations.ts) (`isGatedAction` / `isWriteGatedAction`, backed by the `ACTION_POLICIES` registry and a deny-by-default fallback). A way to make the agent send, post, delete, or pay without an explicit user click is the highest-severity class of bug.
- **Prompt injection** — content in a read email/event/doc steering the agent into a gated action or exfiltrating data.
- **Auth / session** — anything that lets one account read or act on another's data.
- **Secret exposure** — refresh tokens, password hashes, or API keys reachable by a non-service principal. Note the server **refuses to boot in production without `SUPABASE_SERVICE_KEY`** and ships RLS deny-by-default (see [`supabase.sql`](supabase.sql)).

## Handling secrets when you self-host

- Keep `SUPABASE_SERVICE_KEY` server-side only; it bypasses RLS.
- Set a strong `SESSION_SECRET` (`openssl rand -hex 32`) and `CRON_SECRET` in production.
- Never commit a real `.env`. Bring your own `DEEPSEEK_API_KEY` and `COMPOSIO_API_KEY`.

## Dependency audit — known, accepted, not yet patchable

`npm audit --omit=dev` reports one high-severity advisory, and it is **unfixable today**, so it is
recorded here instead of being silently ignored:

| Advisory | Package | Path | Status |
| --- | --- | --- | --- |
| [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv) (CVE-2026-85393) | `node-forge` | `@blockshub/pawnote-lts` → `node-forge` | **No patched version exists** — the advisory lists *Patched versions: none* for `<= 1.4.0`, and `1.4.0` is the latest release. `npm audit fix --force` would only *downgrade* the tree, so it is deliberately not run. |

The advisory is about RSA **PKCS#1 v1.5 signature verification** accepting extra nested
`DigestAlgorithm` elements. Reachability in this codebase was checked, not assumed:

- Otto's own code never imports `node-forge` (`grep -rn "node-forge" server scripts` → no matches).
- The only consumer is `@blockshub/pawnote-lts` (the Pronote client). Its compiled bundle contains
  **zero `.verify(` calls** — it uses node-forge for `cipher.createCipher`/`createDecipher` (AES),
  `md.md5`/`md.sha*`, `util.*`, `jsbn.BigInteger`, and `pki.rsa.setPublicKey` (encrypting to Pronote's
  public key during the login handshake). The vulnerable verification path is never entered.
- Even if it were, forging a signature would require the school's Pronote server to be the attacker —
  a party that already receives the student's own credentials.

Re-check this entry whenever `node-forge` ships a patched release (`npm audit` will start passing on
its own once the tree resolves to a fixed version), and drop it at that point.
