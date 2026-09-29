// Consent & Privacy Service - parental consent and data retention foundation
// See Primer §10.3 for COPPA/GDPR-K requirements

import type { ConsentRecord } from "../shared/types.ts";

/**
 * Check if a user has valid consent for a given scope
 */
export function hasValidConsent(userId: string, scope: string[], consentRecords: ConsentRecord[]): boolean {
  const now = new Date().toISOString();
  const relevantRecords = consentRecords.filter(
    (r) => r.childId === userId && !r.revokedAt && r.grantedAt < now
  );

  // Check if all requested scopes are covered by at least one consent record
  return scope.every((s) =>
    relevantRecords.some((r) => r.scope.includes(s))
  );
}

/**
 * Record a new consent (e.g., after parent completes onboarding)
 */
export function recordConsent(consent: ConsentRecord): ConsentRecord {
  // In a real implementation, this would save to the database
  console.log(`[Consent] Consent recorded for child ${consent.childId}, scope: ${consent.scope.join(", ")}`);
  return consent;
}

/**
 * Revoke consent (e.g., parent changes settings)
 */
export function revokeConsent(childId: string, guardianId: string, scope: string[]): ConsentRecord {
  const revoked: ConsentRecord = {
    childId,
    guardianId,
    scope,
    grantedAt: new Date().toISOString(), // original grant time would be looked up
    revokedAt: new Date().toISOString(),
    method: "other",
  };
  console.log(`[Consent] Consent revoked for child ${childId}, scope: ${scope.join(", ")}`);
  return revoked;
}

/**
 * Get data retention schedule based on policy profile
 * Returns the number of days data should be retained
 */
export function getRetentionDays(ageBand: string, consentRegime: string): number {
  // Default retention from Primer §4.2
  // Band B-C (3-8): 30 days
  // Band D-F (9-18): 90 days
  // Teen consent regime: 90 days
  // Verifiable parental consent: 30 days

  if (ageBand === "A" || ageBand === "B" || ageBand === "C") {
    return 30;
  }
  if (ageBand === "D" || ageBand === "E" || ageBand === "F") {
    return 90;
  }
  if (consentRegime === "verifiable_parental") {
    return 30;
  }
  return 90; // Default for adult/teen
}

/**
 * Check if data should be deleted based on retention policy
 */
export function shouldDeleteData(createdAt: string, retentionDays: number): boolean {
  const created = new Date(createdAt);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  return created < cutoff;
}

/**
 * DSAR (Data Subject Access Request) - export user data
 * In a real implementation, this would gather all data for the user
 */
export function exportUserData(userId: string): unknown {
  console.log(`[DSAR] Exporting data for user ${userId}`);
  // Placeholder - would return all profile, chat, board, and related data
  return { userId, exportedAt: new Date().toISOString() };
}

/**
 * DSAR - delete user data
 * In a real implementation, this would cascade delete all user data
 */
export function deleteUserData(userId: string): void {
  console.log(`[DSAR] Deleting data for user ${userId}`);
  // Placeholder - would delete profile, chat, board, embeddings, etc.
}
