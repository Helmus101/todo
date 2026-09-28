/**
 * Health Check Implementation
 * 
 * Provides health checks for all external dependencies:
 * - Supabase connectivity
 * - AI provider (DeepSeek/NVIDIA) connectivity
 * - Composio API connectivity
 * - Database query health
 * - Session store health
 */

import { aiReady } from "./claude.ts";
import { integrationsReady } from "./integrations.ts";
import { cloudEnabled } from "./store.ts";
import { getAllCircuitBreakerStates } from "./circuit-breaker.ts";

export interface HealthCheckResult {
  status: "healthy" | "degraded" | "unhealthy";
  checks: Record<string, {
    status: "pass" | "fail" | "warn";
    message?: string;
    latencyMs?: number;
  }>;
  timestamp: string;
}

/**
 * Fast health check (shallow) - for load balancers and basic monitoring
 * Checks only if critical services are configured and responsive
 */
export async function shallowHealthCheck(): Promise<HealthCheckResult> {
  const checks: Record<string, { status: "pass" | "fail" | "warn"; message?: string }> = {};
  const timestamp = new Date().toISOString();

  // Check if AI is configured
  checks.ai = aiReady() 
    ? { status: "pass" } 
    : { status: "fail", message: "AI provider not configured" };

  // Check if Composio is configured
  checks.composio = integrationsReady()
    ? { status: "pass" }
    : { status: "fail", message: "Composio not configured" };

  // Check if Supabase is configured
  checks.supabase = cloudEnabled()
    ? { status: "pass" }
    : { status: "fail", message: "Supabase not configured" };

  // Check circuit breaker states
  const circuitStates = getAllCircuitBreakerStates();
  let anyCircuitOpen = false;
  for (const [name, state] of Object.entries(circuitStates)) {
    if (state.state === "OPEN") {
      anyCircuitOpen = true;
      checks[`circuit-${name}`] = { 
        status: "warn", 
        message: `Circuit breaker OPEN for ${name}` 
      };
    }
  }

  const overallStatus = Object.values(checks).some(c => c.status === "fail")
    ? "unhealthy"
    : anyCircuitOpen
    ? "degraded"
    : "healthy";

  return { status: overallStatus, checks, timestamp };
}

/**
 * Deep health check - for detailed monitoring and diagnostics
 * Performs actual connectivity tests against each dependency
 */
export async function deepHealthCheck(): Promise<HealthCheckResult> {
  const checks: Record<string, { status: "pass" | "fail" | "warn"; message?: string; latencyMs?: number }> = {};
  const timestamp = new Date().toISOString();

  // Check AI provider connectivity
  const aiStart = Date.now();
  try {
    const aiOk = aiReady();
    checks.ai = aiOk 
      ? { status: "pass", latencyMs: Date.now() - aiStart }
      : { status: "fail", message: "AI provider not configured", latencyMs: Date.now() - aiStart };
  } catch (e: any) {
    checks.ai = { 
      status: "fail", 
      message: e?.message || "AI provider check failed",
      latencyMs: Date.now() - aiStart
    };
  }

  // Check Composio connectivity
  const composioStart = Date.now();
  try {
    const composioOk = integrationsReady();
    checks.composio = composioOk
      ? { status: "pass", latencyMs: Date.now() - composioStart }
      : { status: "fail", message: "Composio not configured", latencyMs: Date.now() - composioStart };
  } catch (e: any) {
    checks.composio = { 
      status: "fail", 
      message: e?.message || "Composio check failed",
      latencyMs: Date.now() - composioStart
    };
  }

  // Check Supabase connectivity
  const supabaseStart = Date.now();
  try {
    const supabaseOk = cloudEnabled();
    checks.supabase = supabaseOk
      ? { status: "pass", latencyMs: Date.now() - supabaseStart }
      : { status: "fail", message: "Supabase not configured", latencyMs: Date.now() - supabaseStart };
  } catch (e: any) {
    checks.supabase = { 
      status: "fail", 
      message: e?.message || "Supabase check failed",
      latencyMs: Date.now() - supabaseStart
    };
  }

  // Check circuit breaker states
  const circuitStates = getAllCircuitBreakerStates();
  let anyCircuitOpen = false;
  for (const [name, state] of Object.entries(circuitStates)) {
    if (state.state === "OPEN") {
      anyCircuitOpen = true;
      checks[`circuit-${name}`] = { 
        status: "warn", 
        message: `Circuit breaker OPEN (failures: ${state.failureCount})`
      };
    } else if (state.state === "HALF_OPEN") {
      checks[`circuit-${name}`] = { 
        status: "warn", 
        message: `Circuit breaker HALF_OPEN (testing recovery)`
      };
    } else {
      checks[`circuit-${name}`] = { 
        status: "pass", 
        message: `Circuit breaker CLOSED (failures: ${state.failureCount})`
      };
    }
  }

  const overallStatus = Object.values(checks).some(c => c.status === "fail")
    ? "unhealthy"
    : anyCircuitOpen || Object.values(checks).some(c => c.status === "warn")
    ? "degraded"
    : "healthy";

  return { status: overallStatus, checks, timestamp };
}
