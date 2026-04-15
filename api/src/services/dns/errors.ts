/**
 * Generic DNS operation error. The `cause` holds the provider-specific
 * error for server-side logging; it is NEVER exposed to API callers.
 */
export class DnsOperationError extends Error {
  readonly originalCause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'DnsOperationError';
    this.originalCause = cause;
  }
}
