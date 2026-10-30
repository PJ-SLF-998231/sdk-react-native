export { createShelfClient } from './client';
export type { ShelfClient } from './client';
export { ShelfError, isAuthLost, isOfflineError } from './errors';
export type * from './types';
export { createAuthSession, getAuthSession, bindAuthSession } from './session';
export type { AuthSession, AuthEpisode, AuthEpisodeEvent, AuthEpisodeEndCause, AuthLossReason, AuthFailureOptions } from './session';
export { credentialFingerprint, sha256Hex } from './fingerprint';
