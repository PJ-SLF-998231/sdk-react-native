import { ShelfError } from './errors';
import type { ShelfErrorLike } from './types';

/** Why the session lost authorisation: a 401 (`auth`) or the proxy's 503 `not_configured`. */
export type AuthLossReason = 'auth' | 'not_configured';
export type AuthEpisodeEndCause = 'success' | 'resume' | 'credential';

/** One stretch of "the credential is refused". Holds no credential, only its fingerprint. */
export interface AuthEpisode {
  readonly reason: AuthLossReason;
  /** The first refusal of the episode. */
  readonly error: ShelfErrorLike;
  /** Fingerprint of the credential that was refused, or null when unknown. */
  readonly fingerprint: string | null;
  readonly startedAt: number;
}

export type AuthEpisodeEvent = { type: 'start'; episode: AuthEpisode } | { type: 'end'; episode: AuthEpisode; cause: AuthEpisodeEndCause };

export interface AuthFailureOptions {
  /** Fingerprint of the credential the failing request used. A failure whose credential is no longer the current one is ignored. */
  fingerprint?: string | null;
}

/**
 * The auth state of one client. An episode starts at the first 401 / 503 `not_configured` and ends when auth is known
 * good again; while it is open further refusals neither start a new episode nor notify anyone.
 */
export interface AuthSession {
  /** The open episode, or null. */
  readonly active: AuthEpisode | null;
  /** Fingerprint of the credential last seen from `getHeaders`, or null before the first request. */
  readonly fingerprint: string | null;
  /** Marks the start of a request; hand the token to reportSuccess so a request that began before the episode cannot end it. */
  begin(): number;
  /** Records the credential a request is about to use. A fingerprint different from the open episode's ends it ('credential'). */
  observeCredential(fingerprint: string | null): void;
  /** Reports a 401 / 503 not_configured. Returns true when it opened a new episode, false when ignored (not auth loss, episode already open, stale credential). */
  reportAuthFailure(error: ShelfErrorLike, opts?: AuthFailureOptions): boolean;
  /** An authenticated request succeeded. Ends the open episode (only if the request began after it opened, when `token` is given). */
  reportSuccess(token?: number): boolean;
  /** The host has fixed the credential and asks to try again. Ends the open episode. */
  resume(): boolean;
  /**
   * Reopens an episode that was open before an app restart (the outbox's persisted pause), silently: no start event and no
   * onAuthLost, since the host was told when it first happened. A refusal while it is open stays silent; it ends on a
   * success, resume() or a different credential. Does nothing when an episode is already open.
   */
  restoreEpisode(episode: { reason: AuthLossReason; fingerprint: string | null; startedAt: number; error?: ShelfErrorLike }): boolean;
  /**
   * Installs how to read the current credential's fingerprint (createShelfClient does, over its getHeaders). The
   * credential never leaves the client; only its fingerprint does.
   */
  setCredentialReader(read: (() => Promise<string>) | null): void;
  /** Calls getHeaders once and resolves its fingerprint; rejects when getHeaders throws; null when no reader is installed. Does not touch the episode. */
  readCredential(): Promise<string> | null;
  /** Every episode start and end. Listener errors are swallowed. Returns the unsubscribe. */
  onEpisode(listener: (event: AuthEpisodeEvent) => void): () => void;
  /**
   * The host's onAuthLost: `get` is read when an episode starts (so a ref to the latest prop works). It is called once
   * per episode, and a function that several subscriptions resolve to (two providers given the same callback) is called once.
   */
  onAuthLost(get: () => ((error: ShelfErrorLike) => void) | undefined): () => void;
}

function reasonOf(error: ShelfErrorLike | null | undefined): AuthLossReason | null {
  if (!error) return null;
  if (error.status === 401) return 'auth';
  if (error.status === 503 && error.code === 'not_configured') return 'not_configured';
  return null;
}

export function createAuthSession(now: () => number = Date.now): AuthSession {
  let active: AuthEpisode | null = null;
  let openedAtSeq = 0;
  let seq = 0;
  let current: string | null = null;
  const listeners = new Set<(e: AuthEpisodeEvent) => void>();
  const hostGetters = new Set<() => ((error: ShelfErrorLike) => void) | undefined>();
  let delivered = new Set<unknown>();
  let reader: (() => Promise<string>) | null = null;

  const emit = (event: AuthEpisodeEvent): void => {
    for (const l of [...listeners]) {
      try {
        l(event);
      } catch {
        /* a listener must not break the request that triggered it */
      }
    }
  };

  function end(cause: AuthEpisodeEndCause): boolean {
    if (!active) return false;
    const episode = active;
    active = null;
    delivered = new Set();
    emit({ type: 'end', episode, cause });
    return true;
  }

  const session: AuthSession = {
    get active() {
      return active;
    },
    get fingerprint() {
      return current;
    },
    begin: () => ++seq,
    observeCredential(fp) {
      current = fp;
      if (active && active.fingerprint !== null && fp !== null && fp !== active.fingerprint) end('credential');
    },
    reportAuthFailure(error, opts = {}) {
      const reason = reasonOf(error);
      if (!reason) return false;
      const fp = opts.fingerprint ?? null;
      if (fp !== null && current !== null && fp !== current) return false; // refused under a credential already replaced
      if (active) return false;
      seq++;
      openedAtSeq = seq;
      const episode: AuthEpisode = { reason, error, fingerprint: fp ?? current, startedAt: now() };
      active = episode;
      emit({ type: 'start', episode });
      for (const get of [...hostGetters]) {
        let cb: ((e: ShelfErrorLike) => void) | undefined;
        try {
          cb = get();
        } catch {
          continue;
        }
        if (!cb || delivered.has(cb)) continue;
        delivered.add(cb);
        try {
          cb(error);
        } catch {
          /* a host callback must not mask the request error */
        }
      }
      return true;
    },
    reportSuccess(token) {
      if (!active) return false;
      if (token !== undefined && token < openedAtSeq) return false;
      return end('success');
    },
    resume: () => end('resume'),
    restoreEpisode(e) {
      if (active) return false;
      seq++;
      openedAtSeq = seq;
      active = {
        reason: e.reason,
        error: e.error ?? new ShelfError(e.reason === 'auth' ? 401 : 503, e.reason === 'auth' ? 'unauthorized' : 'not_configured', 'Authorisation lost before the app restarted'),
        fingerprint: e.fingerprint,
        startedAt: e.startedAt,
      };
      return true;
    },
    setCredentialReader(read) {
      reader = read;
    },
    readCredential: () => (reader ? reader() : null),
    onEpisode(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    onAuthLost(get) {
      hostGetters.add(get);
      return () => hostGetters.delete(get);
    },
  };
  return session;
}

// One session per client object, so every provider, hook and outbox that shares a client shares its episode.
const sessions = new WeakMap<object, AuthSession>();

/** Ties `session` to `client` (createShelfClient does this). */
export function bindAuthSession(client: object, session: AuthSession): void {
  sessions.set(client, session);
}

/**
 * The auth session of a client, keyed by object identity. A client built by createShelfClient has one from the start;
 * for any other object a session is created on first use. A copy of a client (`{...client}`) is a different object
 * with a different session: share the client itself.
 */
export function getAuthSession(client: object): AuthSession {
  let s = sessions.get(client);
  if (!s) sessions.set(client, (s = createAuthSession()));
  return s;
}
