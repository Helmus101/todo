/**
 * Plaid (bank-account linking) — /finance, an ADDITIONAL proactive source alongside Gmail/Calendar/Pronote
 * (see discover.ts's plaidToItems). SANDBOX ONLY for now, deliberately: production access needs a real Plaid
 * business approval AND, for this app's actual French-lycée audience, confirmed bank coverage first (Plaid's
 * strength is US/Canada; EU coverage via Tink is inconsistent) — neither has been done, so PLAID_ENV defaults
 * to "sandbox" (Plaid's own fake test institutions, e.g. "Platypus Bank") regardless of what's set, unless
 * explicitly overridden once those two things are actually true. Same posture as pronote.ts's own mock mode:
 * the whole flow (Link → exchange → fetch → proactive tasks) is real and fully exercisable without touching
 * an actual bank account or costing anything.
 *
 * Same "credential lives here, encrypted at rest, never in a client-visible response" posture as Pronote:
 * the access token is loaded/saved via server/store.ts's loadState/saveState (StoredPlaid), AES-256-GCM
 * encrypted at the DB layer (server/crypto.ts) exactly like Pronote's token.
 */
import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from "plaid";
import { createHash } from "node:crypto";
import { loadState, saveState, type StoredPlaid } from "./store.ts";
import { reportError } from "./sentry.ts";

// Plaid's client_user_id must be an opaque per-user identifier, NOT the email itself — Plaid's API rejects
// a raw email with "should not contain sensitive information like an email" (a real 400, hit live). A
// one-way hash keeps it stable/unique per account (same email → same id, so Plaid can dedupe/rate-limit
// per real user) without ever sending the email itself to Plaid.
function plaidUserId(email: string): string {
  return createHash("sha256").update(email.toLowerCase()).digest("hex");
}

const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID;
const PLAID_SECRET = process.env.PLAID_SECRET;
// Deliberately hardcoded to sandbox regardless of PLAID_ENV — see the file-level comment above for why this
// isn't a simple env passthrough like other integrations. Flip this the day production access + French bank
// coverage are BOTH actually confirmed, not before.
const PLAID_ENV: keyof typeof PlaidEnvironments = "sandbox";

export function plaidConfigured(): boolean {
  return !!(PLAID_CLIENT_ID && PLAID_SECRET) || MOCK_ENABLED;
}

// Fully offline mock — no Plaid credentials, no network call at all, same purpose and gating pattern as
// pronote.ts's own PRONOTE_MOCK: lets the WHOLE /finance flow (connect → recurring-bill detection →
// proactive task) be exercised and demoed with zero real Plaid account. Enable with PLAID_MOCK=1 in .env,
// then the /finance page's "Try with demo data" button does the rest — no Plaid Link modal, no real
// institution. Deliberately includes ONE genuinely-recurring monthly charge (so plaidToItems in discover.ts
// has something real to detect) and one one-off purchase (so "seen only once → no candidate" also has
// something to demonstrate against) — same "one weak, one strong" demonstration posture as pronote.ts's mockGrades.
const MOCK_ENABLED = process.env.PLAID_MOCK === "1";
const MOCK_ACCESS_TOKEN = "mock-access-token";
function mockSnapshot(): { accounts: PlaidAccountSummary[]; transactions: PlaidTransaction[] } {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  return {
    accounts: [{ id: "mock-checking", name: "Compte courant (démo)", type: "checking", balance: 412.5 }],
    transactions: [
      { id: "mock-tx-1", name: "Netflix", amount: 13.49, date: daysAgo(32), pending: false },
      { id: "mock-tx-2", name: "Netflix", amount: 13.49, date: daysAgo(2), pending: false },
      { id: "mock-tx-3", name: "Spotify", amount: 10.99, date: daysAgo(29), pending: false },
      { id: "mock-tx-4", name: "Spotify", amount: 10.99, date: daysAgo(1), pending: false },
      { id: "mock-tx-5", name: "Librairie Gibert", amount: 24.9, date: daysAgo(6), pending: false }, // one-off, no pattern
    ],
  };
}
/** Dev/demo-only connect path — bypasses Plaid Link entirely (see MOCK_ENABLED's own comment). Mirrors
 *  pronote.ts's mock-URL "connect" the same way: only does anything when PLAID_MOCK=1, otherwise a no-op
 *  error so this can never accidentally fake a connection in a real deployment. */
export async function connectMock(email: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!MOCK_ENABLED) return { ok: false, error: "Demo mode isn't enabled on this server." };
  const state = await loadState(email);
  const plaid: StoredPlaid = { accessToken: MOCK_ACCESS_TOKEN, itemId: "mock-item", institutionName: "Banque Démo", connectedAt: new Date().toISOString() };
  await saveState(email, { ...state, plaid });
  return { ok: true };
}

let cachedClient: PlaidApi | null = null;
function client(): PlaidApi {
  if (cachedClient) return cachedClient;
  if (!plaidConfigured()) throw new Error("Set PLAID_CLIENT_ID and PLAID_SECRET in web/.env.");
  const configuration = new Configuration({
    basePath: PlaidEnvironments[PLAID_ENV],
    baseOptions: { headers: { "PLAID-CLIENT-ID": PLAID_CLIENT_ID, "PLAID-SECRET": PLAID_SECRET } },
  });
  cachedClient = new PlaidApi(configuration);
  return cachedClient;
}

export async function plaidConnected(email: string): Promise<{ connected: boolean; institutionName?: string }> {
  const { plaid } = await loadState(email);
  return plaid ? { connected: true, institutionName: plaid.institutionName } : { connected: false };
}

/** Step 1 of Plaid Link — a short-lived token the CLIENT uses to open Plaid's own hosted Link modal. Never
 *  touches account credentials itself; Plaid Link handles the actual bank login entirely on Plaid's side. */
export async function createLinkToken(email: string): Promise<{ linkToken: string }> {
  try {
    const res = await client().linkTokenCreate({
      user: { client_user_id: plaidUserId(email) },
      client_name: "Otto",
      products: [Products.Transactions],
      // US only — a fresh Plaid developer account (sandbox included) only has US enabled by default; FR/EU
      // country access has to be explicitly requested from Plaid and isn't granted automatically just by
      // being in sandbox mode. Requesting a country the account isn't approved for is exactly what Plaid's
      // API rejects with a plain 400 (INVALID_REQUEST / COUNTRY_NOT_SUPPORTED) — which surfaced client-side
      // as an unhelpful generic "Request failed with status code 400" before this was caught and unwrapped
      // below. Sandbox's fake test institutions (e.g. "Platypus Bank") are US-based anyway, so this doesn't
      // lose anything for testing — see the file-level comment on why FR/EU isn't targeted yet regardless.
      country_codes: [CountryCode.Us],
      language: "en",
    });
    return { linkToken: res.data.link_token };
  } catch (e: any) {
    // Plaid's Node client wraps axios — the raw Error's .message is just "Request failed with status code
    // 400", useless for figuring out WHY. The actual reason lives in the response body.
    const detail = e?.response?.data?.error_message || e?.response?.data?.error_code;
    throw new Error(detail || e?.message || "Couldn't start the Plaid connection.");
  }
}

/** Step 2 — the client hands back Link's public_token after a successful bank login; exchange it for a
 *  long-lived access_token and persist it (encrypted, see StoredPlaid's own comment). */
export async function exchangePublicToken(email: string, publicToken: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const exch = await client().itemPublicTokenExchange({ public_token: publicToken });
    const accessToken = exch.data.access_token;
    const itemId = exch.data.item_id;
    let institutionName: string | undefined;
    try {
      const item = await client().itemGet({ access_token: accessToken });
      if (item.data.item.institution_id) {
        const inst = await client().institutionsGetById({ institution_id: item.data.item.institution_id, country_codes: [CountryCode.Us] });
        institutionName = inst.data.institution.name;
      }
    } catch { /* best-effort — connection still succeeds without a display name */ }
    const state = await loadState(email);
    const plaid: StoredPlaid = { accessToken, itemId, institutionName, connectedAt: new Date().toISOString() };
    await saveState(email, { ...state, plaid });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.response?.data?.error_message || e?.message || "Couldn't connect that account." };
  }
}

export async function disconnectPlaid(email: string): Promise<void> {
  const state = await loadState(email);
  if (state.plaid && state.plaid.accessToken !== MOCK_ACCESS_TOKEN) {
    try { await client().itemRemove({ access_token: state.plaid.accessToken }); } catch { /* best-effort — still forget it locally either way */ }
  }
  await saveState(email, { ...state, plaid: undefined });
}

export interface PlaidTransaction { id: string; name: string; amount: number; date: string; pending: boolean; }
export interface PlaidAccountSummary { id: string; name: string; type: string; balance: number | null; }

/** Recent transactions + current balances — read-only, exactly what /finance displays and what
 *  discover.ts's plaidToItems reasons over for proactive task candidates. Best-effort: a Plaid hiccup
 *  returns empty rather than ever throwing into a page render or the discovery pipeline. */
export async function plaidSnapshot(email: string): Promise<{ accounts: PlaidAccountSummary[]; transactions: PlaidTransaction[] }> {
  const { plaid } = await loadState(email);
  if (!plaid) return { accounts: [], transactions: [] };
  if (plaid.accessToken === MOCK_ACCESS_TOKEN) return mockSnapshot();
  try {
    const accountsRes = await client().accountsGet({ access_token: plaid.accessToken });
    const accounts: PlaidAccountSummary[] = accountsRes.data.accounts.map((a: any) => ({
      id: a.account_id, name: a.name, type: a.subtype || a.type, balance: a.balances.current ?? null,
    }));
    const end = new Date(), start = new Date(end.getTime() - 30 * 86_400_000);
    const txRes = await client().transactionsGet({
      access_token: plaid.accessToken,
      start_date: start.toISOString().slice(0, 10),
      end_date: end.toISOString().slice(0, 10),
      options: { count: 50 },
    });
    const transactions: PlaidTransaction[] = txRes.data.transactions.map((t: any) => ({
      id: t.transaction_id, name: t.name, amount: t.amount, date: t.date, pending: t.pending,
    }));
    return { accounts, transactions };
  } catch (e: any) {
    console.warn("[plaid] snapshot failed:", e?.response?.data?.error_message || e?.message);
    // Was fully silent before — this compounds with the client's own snapshot fetch (client/App.tsx's
    // FinancePage), which used to swallow the resulting empty response too, so a real Plaid outage was
    // invisible end to end.
    reportError("plaid-snapshot", e);
    return { accounts: [], transactions: [] };
  }
}
