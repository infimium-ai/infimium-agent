export type RetryConfig = {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
};

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 100,
  maxDelayMs: 2000,
  backoffMultiplier: 2
};

export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  isRetryable: (error: unknown) => boolean,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): Promise<T> {
  let lastError: unknown;
  let delayMs = config.initialDelayMs;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error: unknown) {
      lastError = error;

      if (!isRetryable(error)) {
        throw error;
      }

      if (attempt === config.maxAttempts) {
        throw error;
      }

      await delay(delayMs);
      delayMs = Math.min(delayMs * config.backoffMultiplier, config.maxDelayMs);
    }
  }

  throw lastError;
}

export function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("econnrefused") ||
    message.includes("connection refused") ||
    message.includes("failed to connect") ||
    message.includes("econnreset") ||
    message.includes("fetch failed") ||
    message.includes("etimedout") ||
    message.includes("timeout") ||
    message.includes("aborted") ||
    message.includes("network unreachable") ||
    message.includes("service unavailable") ||
    message.includes("temporarily unavailable")
  );
}

export class CircuitBreaker {
  private state: "closed" | "open" | "half_open" = "closed";
  private failureCount = 0;
  private lastFailureTime: number | null = null;
  private successCount = 0;

  constructor(
    private readonly failureThreshold: number = 3,
    private readonly resetTimeoutMs: number = 10_000,
    private readonly successThreshold: number = 2
  ) {}

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      const timeSinceFailure = Date.now() - (this.lastFailureTime ?? 0);
      if (timeSinceFailure < this.resetTimeoutMs) {
        throw new CircuitBreakerOpenError(
          `Circuit breaker is OPEN. Service unavailable (retry in ${Math.ceil((this.resetTimeoutMs - timeSinceFailure) / 1000)}s).`
        );
      }

      this.state = "half_open";
      this.successCount = 0;
    }

    try {
      const result = await operation();

      if (this.state === "half_open") {
        this.successCount += 1;
        if (this.successCount >= this.successThreshold) {
          this.state = "closed";
          this.failureCount = 0;
          this.lastFailureTime = null;
        }
      } else if (this.state === "closed") {
        this.failureCount = 0;
      }

      return result;
    } catch (error: unknown) {
      this.failureCount += 1;
      this.lastFailureTime = Date.now();

      if (this.failureCount >= this.failureThreshold) {
        this.state = "open";
      } else if (this.state === "half_open") {
        this.state = "open";
      }

      throw error;
    }
  }

  /**
   * Get current circuit state for diagnostics.
   */
  getState(): "closed" | "open" | "half_open" {
    return this.state;
  }

  reset(): void {
    this.state = "closed";
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.successCount = 0;
  }
}

export class CircuitBreakerOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircuitBreakerOpenError";
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
