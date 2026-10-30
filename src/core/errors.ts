import type { ShelfErrorLike } from './types';

export class ShelfError extends Error implements ShelfErrorLike {
  readonly status: number;
  readonly code: string;
  readonly field?: string;

  constructor(status: number, code: string, message: string, field?: string) {
    super(message);
    this.name = 'ShelfError';
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

/** The session is no longer authorised: a 401, or the proxy's 503 `not_configured` (key revoked/unset). */
export function isAuthLost(err: unknown): boolean {
  if (!(err instanceof ShelfError)) return false;
  return err.status === 401 || (err.status === 503 && err.code === 'not_configured');
}

/** The server could not be reached or is down (keep cached data). Never true for an abort. */
export function isOfflineError(err: unknown): boolean {
  if (err instanceof ShelfError) return err.status === 502 || (err.status === 503 && err.code !== 'not_configured');
  if ((err as { name?: string } | null)?.name === 'AbortError') return false;
  // React Native's fetch rejects with TypeError("Network request failed").
  return err instanceof TypeError;
}
