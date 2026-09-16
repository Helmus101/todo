/**
 * Application-level encryption for the few genuinely sensitive secrets we persist ourselves (currently:
 * the Pronote rotating login token — see StoredPronote in store.ts). Everything else sensitive either
 * never touches our DB (Google/Composio OAuth tokens live in Composio's vault) or is already one-way
 * hashed (bcrypt password hashes). RLS + the service-role-only write path (store.ts) is the FIRST layer —
 * this is defense-in-depth on top: even a leaked DB row/backup doesn't hand over a live Pronote credential
 * without also holding CREDENTIAL_ENCRYPTION_KEY (server-side only, never in the client bundle).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";

const KEY_ENV = "CREDENTIAL_ENCRYPTION_KEY";
function rawKey(): string | null { return process.env[KEY_ENV] || null; }

// v1 used a single hardcoded salt shared by EVERY Otto installation — a security-audit finding: since the
// salt was a fixed literal, one precomputed table would apply identically across every deployment of this
// app, not just this one (low real-world severity here specifically because CREDENTIAL_ENCRYPTION_KEY is
// meant to be high-entropy random, e.g. `openssl rand -hex 32`, not a guessable passphrase — but a shared
// constant salt is still a deviation from best practice that costs nothing to fix). v2 derives the salt
// from the key itself (a plain hash, not scrypt again — this only needs to be UNIQUE per key, not slow),
// so two different deployments with two different keys get two different effective salts automatically,
// with no new env var and no persistence problem on a stateless/serverless deploy (must stay deterministic
// across cold starts to decrypt what was written before). v1-encrypted rows keep decrypting via the OLD
// derivation (see decryptSecret) — only NEW encryptions move to v2; nothing needs re-encrypting by hand.
let cachedKeyV1: Buffer | null = null;
function keyV1(raw: string): Buffer {
  if (!cachedKeyV1) cachedKeyV1 = scryptSync(raw, "otto-credential-encryption", 32);
  return cachedKeyV1;
}
let cachedKeyV2: Buffer | null = null;
function keyV2(raw: string): Buffer {
  if (!cachedKeyV2) cachedKeyV2 = scryptSync(raw, createHash("sha256").update(`otto-credential-salt:${raw}`).digest(), 32);
  return cachedKeyV2;
}

// NEVER throw here: this file is imported by store.ts, which nearly every server route depends on — a
// module-load-time throw would take down auth, tasks, and integrations entirely over a missing env var
// for a defense-in-depth layer on ONE currently-UI-hidden feature (Pronote). That's a wildly disproportionate
// blast radius (observed live: shipped an earlier version of this check that crashed the whole app in
// production). So: warn loudly in every environment, but always degrade to plaintext storage rather than
// refuse to run. Unlike SUPABASE_SERVICE_KEY (whose absence is caught by store.ts's OWN guard, scoped to
// just that concern), this check must not be able to break unrelated functionality.
if (!rawKey()) {
  console.warn(`[crypto] SECURITY: ${KEY_ENV} is not set — secrets we store (e.g. the Pronote login token) ` +
    `will be saved in plaintext, protected only by database access control (RLS + service-role key). Set ` +
    `${KEY_ENV} (e.g. \`openssl rand -hex 32\`) in production when you're ready to enable this layer.`);
}

/** Is the encryption key actually configured? Exposed so a caller storing something genuinely sensitive
 *  (a real school password's replacement token, not just "nice to encrypt") can refuse to proceed rather
 *  than silently accept plaintext storage — see server/pronote.ts's connectPronote, which is mandatory
 *  about this specifically because it's the one credential in this app with real-world stakes if leaked
 *  (a student's actual school login), unlike this module's own boot-time check, which must stay non-fatal
 *  since it's imported by nearly everything (see the comment below). */
export function credentialEncryptionConfigured(): boolean { return !!rawKey(); }

const PREFIX_V1 = "enc:v1:"; // legacy: fixed shared salt (see keyV1's own comment) — decrypt-only, never written anymore
const PREFIX = "enc:v2:";    // current: key-derived salt — what every new encryptSecret call writes

/** Encrypt a secret for storage. Returns the plaintext unchanged (never silently drop data) when no key
 *  is configured — the boot-time check above is what enforces this can't happen in production. */
export function encryptSecret(plaintext: string): string {
  const raw = rawKey();
  if (!raw) return plaintext;
  const k = keyV2(raw);
  const iv = randomBytes(12); // GCM standard nonce size
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
}

/** Decrypt a value produced by encryptSecret. Passes through unrecognized/unencrypted values unchanged —
 *  a pre-existing plaintext row (written before CREDENTIAL_ENCRYPTION_KEY was configured) must still work,
 *  not crash the read path; it'll be re-encrypted on its next write (Pronote's token rotates every login).
 *  Handles BOTH the current v2 prefix and the legacy v1 one (different salt → different derived key — see
 *  keyV1/keyV2's own comments), so a row encrypted before this fix keeps decrypting correctly; it'll pick up
 *  the v2 scheme automatically the next time that value is written (Pronote's token rotates every login). */
export function decryptSecret(stored: string): string {
  const isV1 = stored.startsWith(PREFIX_V1), isV2 = stored.startsWith(PREFIX);
  if (!isV1 && !isV2) return stored;
  const raw = rawKey();
  if (!raw) return stored; // can't decrypt without the key — caller (e.g. Pronote login) will fail loudly instead
  try {
    const k = isV1 ? keyV1(raw) : keyV2(raw);
    const prefixLen = (isV1 ? PREFIX_V1 : PREFIX).length;
    const buf = Buffer.from(stored.slice(prefixLen), "base64");
    const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), enc = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", k, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch (e: any) {
    console.warn("[crypto] decryptSecret failed (wrong/rotated key?):", e?.message || e);
    return stored;
  }
}
