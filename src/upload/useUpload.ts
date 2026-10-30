import { useCallback, useMemo, useRef, useState } from 'react';
import { useOutbox } from './useOutbox';
import type { UseOutboxOptions } from './useOutbox';
import type { EnqueueInput, OutboxItem, OutboxSnapshot } from './outbox';

export interface UseUploadOptions extends UseOutboxOptions {
  /** Default destination folder for enqueue(). */
  folderId?: string;
}

export interface UseUploadResult {
  /** Queues a file (persisted first, uploaded when a slot and the network allow). Resolves with the queued item. */
  enqueue: (file: Pick<EnqueueInput, 'uri' | 'name' | 'type'> & Partial<EnqueueInput>) => Promise<OutboxItem>;
  /** Items enqueued through this hook instance, live. */
  items: readonly OutboxItem[];
  /** The whole queue (including items from earlier sessions). */
  all: readonly OutboxItem[];
  counts: OutboxSnapshot['counts'];
  online: boolean;
  paused: boolean;
  pauseReason: OutboxSnapshot['pauseReason'];
  cancel: (id: string) => Promise<void>;
  retry: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  retryAll: () => Promise<void>;
  resume: () => void;
}

/** Enqueue files and watch their status. Built on the shared outbox (see useOutbox). */
export function useUpload(options: UseUploadOptions = {}): UseUploadResult {
  const o = useOutbox(options);
  const [mine, setMine] = useState<readonly string[]>([]);
  const folderRef = useRef(options.folderId);
  folderRef.current = options.folderId;
  const { enqueue: enq } = o;
  const enqueue = useCallback<UseUploadResult['enqueue']>(
    async (file) => {
      const item = await enq({ ...file, folder_id: file.folder_id ?? folderRef.current });
      setMine((m) => [...m, item.id]);
      return item;
    },
    [enq],
  );
  const { snapshot } = o;
  const items = useMemo(() => snapshot.items.filter((i) => mine.includes(i.id)), [snapshot, mine]);
  return {
    enqueue,
    items,
    all: snapshot.items,
    counts: snapshot.counts,
    online: snapshot.online,
    paused: snapshot.paused,
    pauseReason: snapshot.pauseReason,
    cancel: o.cancel,
    retry: o.retry,
    remove: o.remove,
    retryAll: o.retryAll,
    resume: o.resume,
  };
}
