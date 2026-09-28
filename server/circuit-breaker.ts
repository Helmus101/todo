/**
 * Circuit Breaker Pattern Implementation
 * 
 * Prevents cascading failures from external dependencies by:
 * - Tracking consecutive failures
 * - Opening the circuit after threshold is reached
 * - Allowing a single request through in half-open state
 * - Closing the circuit after a successful request
 * 
 * States:
 * - CLOSED: Requests pass through normally
 * - OPEN: Requests fail immediately without calling the dependency
 * - HALF_OPEN: One request allowed to test if dependency has recovered
 */

export interface CircuitBreakerConfig {
  failureThreshold: number;    // Number of consecutive failures before opening
  timeoutMs: number;            // How long to stay in OPEN state before HALF_OPEN
  resetTimeoutMs: number;       // How long to wait in HALF_OPEN before returning to CLOSED
}

export interface CircuitBreakerState {
  state: "CLOSED" | "OPEN" | "HALF_OPEN";
  failureCount: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  nextAttemptTime: number | null;
}

type CircuitBreakerResult<T> = 
  | { success: true; data: T }
  | { success: false; error: Error; reason: "circuit-open" | "call-failed" };

export class CircuitBreaker {
  private state: CircuitBreakerState = {
    state: "CLOSED",
    failureCount: 0,
    lastFailureTime: null,
    lastSuccessTime: null,
    nextAttemptTime: null,
  };

  constructor(private config: CircuitBreakerConfig, private name: string) {}

  private shouldAllowRequest(): boolean {
    const now = Date.now();

    switch (this.state.state) {
      case "CLOSED":
        return true;
      
      case "OPEN":
        // Check if we should transition to HALF_OPEN
        if (this.state.nextAttemptTime && now >= this.state.nextAttemptTime) {
          this.state.state = "HALF_OPEN";
          this.state.nextAttemptTime = null;
          console.log(`[circuit-breaker] ${this.name}: OPEN → HALF_OPEN`);
          return true;
        }
        return false;
      
      case "HALF_OPEN":
        // Allow one request to test if dependency has recovered
        return true;
    }
  }

  private recordSuccess(): void {
    this.state.failureCount = 0;
    this.state.lastSuccessTime = Date.now();
    
    if (this.state.state === "HALF_OPEN") {
      this.state.state = "CLOSED";
      console.log(`[circuit-breaker] ${this.name}: HALF_OPEN → CLOSED`);
    }
  }

  private recordFailure(): void {
    this.state.failureCount++;
    this.state.lastFailureTime = Date.now();

    if (this.state.failureCount >= this.config.failureThreshold) {
      this.state.state = "OPEN";
      this.state.nextAttemptTime = Date.now() + this.config.timeoutMs;
      console.error(`[circuit-breaker] ${this.name}: CLOSED/HALF_OPEN → OPEN (failures: ${this.state.failureCount})`);
    }
  }

  /**
   * Execute a function through the circuit breaker
   * Returns CircuitBreakerResult with success/failure status
   */
  async execute<T>(fn: () => Promise<T>): Promise<CircuitBreakerResult<T>> {
    if (!this.shouldAllowRequest()) {
      return { 
        success: false, 
        error: new Error(`Circuit breaker OPEN for ${this.name}`), 
        reason: "circuit-open" 
      };
    }

    try {
      const data = await fn();
      this.recordSuccess();
      return { success: true, data };
    } catch (error) {
      this.recordFailure();
      return { 
        success: false, 
        error: error instanceof Error ? error : new Error(String(error)), 
        reason: "call-failed" 
      };
    }
  }

  /**
   * Get current circuit breaker state for monitoring
   */
  getState(): CircuitBreakerState {
    return { ...this.state };
  }

  /**
   * Manually reset the circuit breaker to CLOSED state
   * Useful for testing or manual recovery
   */
  reset(): void {
    this.state = {
      state: "CLOSED",
      failureCount: 0,
      lastFailureTime: null,
      lastSuccessTime: null,
      nextAttemptTime: null,
    };
    console.log(`[circuit-breaker] ${this.name}: manually reset to CLOSED`);
  }
}

// Pre-configured circuit breakers for common dependencies
export const circuitBreakers = {
  ai: new CircuitBreaker(
    { failureThreshold: 5, timeoutMs: 60_000, resetTimeoutMs: 30_000 },
    "ai-provider"
  ),
  composio: new CircuitBreaker(
    { failureThreshold: 8, timeoutMs: 120_000, resetTimeoutMs: 60_000 },
    "composio"
  ),
  supabase: new CircuitBreaker(
    { failureThreshold: 10, timeoutMs: 30_000, resetTimeoutMs: 15_000 },
    "supabase"
  ),
};

/**
 * Get all circuit breaker states for health monitoring
 */
export function getAllCircuitBreakerStates(): Record<string, CircuitBreakerState> {
  return {
    ai: circuitBreakers.ai.getState(),
    composio: circuitBreakers.composio.getState(),
    supabase: circuitBreakers.supabase.getState(),
  };
}
