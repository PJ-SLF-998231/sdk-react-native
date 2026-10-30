import { ShelfError, isAuthLost } from '../core/errors';

/**
 * - retriable: try again with backoff (no response, 5xx, 408, 429, a 409 that says the earlier attempt is still running).
 * - permanent: the API refused this file (other 4xx); only a manual retry tries again.
 * - auth: the credential is revoked or missing; the outbox purges and pauses.
 * - cancelled: the item was cancelled by the caller.
 */
export type ErrorKind = 'retriable' | 'permanent' | 'auth' | 'cancelled';

export function classifyUploadError(error: unknown): ErrorKind {
  if ((error as { name?: string } | null)?.name === 'AbortError') return 'cancelled';
  if (isAuthLost(error)) return 'auth';
  if (error instanceof ShelfError) {
    const s = error.status;
    if (s === 408 || s === 429 || s >= 500) return 'retriable';
    if (s === 409 && /in_use|in_progress|processing/i.test(error.code)) return 'retriable';
    if (s >= 400) return 'permanent';
    return 'retriable';
  }
  // TypeError("Network request failed"), an unreadable file, etc.: may well work next time.
  return 'retriable';
}

/** Delay before the next attempt after `attempts` failures so far: full jitter over a capped exponential. */
export function backoffDelay(attempts: number, opts: { baseMs: number; maxMs: number; random: () => number }): number {
  const ceiling = Math.min(opts.maxMs, opts.baseMs * 2 ** Math.max(0, attempts));
  return Math.floor(opts.random() * ceiling);
}
