import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking } from 'react-native';
import { useShelf } from '../provider';
import { useOutbox } from '../upload/useOutbox';
import type { UseOutboxOptions } from '../upload/useOutbox';
import type { OutboxItem } from '../upload/outbox';
import type { ShelfItem } from '../core/types';
import { ShelfPermissionDeniedError } from './errors';
import type { CaptureAdapter, CaptureRequest, CaptureState, CapturedFile } from './types';

export interface UseCaptureUploadOptions extends UseOutboxOptions {
  /** Where files come from (a built-in adapter or your own). */
  adapter: CaptureAdapter;
  /** Passed to the adapter: `multiple`, `types`. */
  request?: CaptureRequest;
  /** Destination folder id. Omit to upload to the shelf root. */
  folderId?: string;
  /**
   * `outbox` (default): files are queued in the persistent outbox, so they survive being offline or the app
   * closing, and are retried. `direct`: upload straight away; a failure goes to onError and nothing is kept.
   */
  uploadMode?: 'outbox' | 'direct';
  /** A file was captured or picked (before it is queued). */
  onCaptured?: (file: CapturedFile) => void;
  /** The server accepted a file. In outbox mode this fires when the queued upload finishes, possibly much later. */
  onUploaded?: (result: ShelfItem) => void;
  /** Capture failed, a permission was denied, or an upload ended in failure. */
  onError?: (error: Error) => void;
}

export interface UseCaptureUploadResult {
  /** Opens the camera / scanner / picker and uploads what comes back. Resolves with the files (empty when cancelled). */
  capture: () => Promise<CapturedFile[]>;
  state: CaptureState;
  error: Error | undefined;
  /** True when state is `denied`. */
  denied: boolean;
  /** False when the OS will not ask again (the user must use Settings). */
  canAskAgain: boolean;
  /** Opens the app's page in the system Settings. */
  openSettings: () => Promise<void>;
  /** Clears a denied or error state. */
  dismiss: () => void;
  /** Outbox items queued by this hook instance (outbox mode). */
  items: readonly OutboxItem[];
}

function newRef(): string {
  return `cap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The headless core of every capture and picker button. */
export function useCaptureUpload(options: UseCaptureUploadOptions): UseCaptureUploadResult {
  const { adapter, request, folderId } = options;
  const ctx = useShelf(options);
  const ob = useOutbox(options);
  const [state, setState] = useState<CaptureState>('idle');
  const [error, setError] = useState<Error | undefined>();
  const [mine, setMine] = useState<readonly string[]>([]);

  const live = useRef({ ...options, folderId, request });
  live.current = { ...options, folderId, request };
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const settled = useRef(new Set<string>());

  // Outbox mode: report the queued uploads this instance started, once each, when they finish or give up.
  const { items: all } = ob.snapshot;
  const items = useMemo(() => all.filter((i) => mine.includes(i.id)), [all, mine]);
  useEffect(() => {
    for (const it of items) {
      const key = `${it.id}:${it.state}:${it.attempts}`;
      if (it.state === 'done' && it.result && !settled.current.has(key)) {
        settled.current.add(key);
        live.current.onUploaded?.(it.result);
      } else if (it.state === 'failed' && it.error?.permanent && !settled.current.has(key)) {
        settled.current.add(key);
        live.current.onError?.(Object.assign(new Error(it.error.message), { code: it.error.code, status: it.error.status }));
      }
    }
  }, [items]);

  const fail = useCallback((e: unknown) => {
    const err = e instanceof Error ? e : new Error(String(e));
    if (mounted.current) {
      setError(err);
      setState(err instanceof ShelfPermissionDeniedError ? 'denied' : 'error');
    }
    live.current.onError?.(err);
  }, []);

  const capture = useCallback(async (): Promise<CapturedFile[]> => {
    if (busy.current) return [];
    busy.current = true;
    setError(undefined);
    setState('busy');
    try {
      const files = await adapter.capture(live.current.request ?? {});
      for (const f of files) live.current.onCaptured?.(f);
      const folder = live.current.folderId;
      for (const f of files) {
        if (live.current.uploadMode === 'direct') {
          const res = await ctx.client.upload({ uri: f.uri, name: f.name, type: f.type }, { ...(folder ? { folder_id: folder } : {}), client_ref: newRef() });
          live.current.onUploaded?.(res);
        } else {
          const queued = await ob.outbox.enqueue({ uri: f.uri, name: f.name, type: f.type, ...(folder ? { folder_id: folder } : {}) });
          if (mounted.current) setMine((m) => [...m, queued.id]);
        }
      }
      if (mounted.current) setState('idle');
      return files;
    } catch (e) {
      fail(e);
      return [];
    } finally {
      busy.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter, ctx.client, ob.outbox, fail]);

  const openSettings = useCallback(async () => {
    try {
      await Linking.openSettings();
    } catch (e) {
      live.current.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  }, []);
  const dismiss = useCallback(() => {
    setState('idle');
    setError(undefined);
  }, []);

  return {
    capture,
    state,
    error,
    denied: state === 'denied',
    canAskAgain: !(error instanceof ShelfPermissionDeniedError) || error.canAskAgain,
    openSettings,
    dismiss,
    items,
  };
}
