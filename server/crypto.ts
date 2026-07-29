/**
 * Application-level encryption for the few genuinely sensitive secrets we persist ourselves (currently:
 * the Pronote rotating login token — see StoredPronote in store.ts). Everything else sensitive either
 * never touches our DB (Google/Composio OAuth tokens live in Composio's vault) or is already one-way
 * hashed (bcrypt password hashes). RLS + the service-role-only write path (store.ts) is the FIRST layer —
 * this is defense-in-depth on top: even a leaked DB row/backup doesn't hand over a live Pronote credential
 * without also holding CREDENTIAL_ENCRYPTION_KEY (server-side only, never in the client bundle).
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const KEY_ENV = "CREDENTIAL_ENCRYPTION_KEY";
// Derived once via scrypt so any passphrase-shaped env value works, not just a raw 32-byte hex/base64
// string — one less footgun when someone pastes `openssl rand -hex 32` vs. a plain password.
let cachedKey: Buffer | null = null;
function key(): Buffer | null {
  const raw = process.env[KEY_ENV];
  if (!raw) return null;
  if (!cachedKey) cachedKey = scryptSync(raw, "otto-credential-encryption", 32);
  return cachedKey;
}

// Same fail-closed pattern as the SUPABASE_SERVICE_KEY check in store.ts: refuse to boot in production
// without the key (a stored secret with no encryption key is a stored secret in plaintext), warn in dev.
if (!key()) {
  const msg = `${KEY_ENV} is not set — secrets we store (e.g. the Pronote login token) would be saved in ` +
    `plaintext, protected only by database access control.`;
  if (process.env.NODE_ENV === "production") {
    throw new Error(`[crypto] ${msg} Set ${KEY_ENV} (e.g. \`openssl rand -hex 32\`) before deploying.`);
  }
  console.warn(`[crypto] SECURITY: ${msg} Fine locally; set ${KEY_ENV} before you deploy.`);
}

const PREFIX = "enc:v1:"; // lets decryptSecret recognize + skip values written before this existed

/** Encrypt a secret for storage. Returns the plaintext unchanged (never silently drop data) when no key
 *  is configured — the boot-time check above is what enforces this can't happen in production. */
export function encryptSecret(plaintext: string): string {
  const k = key();
  if (!k) return plaintext;
  const iv = randomBytes(12); // GCM standard nonce size
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
}

/** Decrypt a value produced by encryptSecret. Passes through unrecognized/unencrypted values unchanged —
 *  a pre-existing plaintext row (written before CREDENTIAL_ENCRYPTION_KEY was configured) must still work,
 *  not crash the read path; it'll be re-encrypted on its next write (Pronote's token rotates every login). */
export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;
  const k = key();
  if (!k) return stored; // can't decrypt without the key — caller (e.g. Pronote login) will fail loudly instead
  try {
    const buf = Buffer.from(stored.slice(PREFIX.length), "base64");
    const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), enc = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", k, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch (e: any) {
    console.warn("[crypto] decryptSecret failed (wrong/rotated key?):", e?.message || e);
    return stored;
  }
}
