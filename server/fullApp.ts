/** Accounts that always see the whole app (the others get the tutor only, until they open /full). Comma-separated in FULL_APP_EMAILS. */
export const FULL_APP_EMAILS = (process.env.FULL_APP_EMAILS || "phillipe@gafsi.net").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
/** Does this account use the full app? An explicit setting on the profile wins; otherwise the env list decides. */
export const isFullApp = (email: string | undefined, profile?: { fullAccess?: boolean }): boolean =>
  typeof profile?.fullAccess === "boolean" ? profile.fullAccess : FULL_APP_EMAILS.includes(String(email || "").toLowerCase());
