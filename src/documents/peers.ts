import type React from "react";
import { ShelfMissingPeerError } from '../core/peer';

// Metro resolves these literal `require`s at bundle time; see scripts/fix-optional-requires.mjs.
declare const require: (id: string) => any;

/** The slice of expo-file-system (legacy API surface) the thumbnail cache uses. */
export interface FileSystemLike {
  cacheDirectory: string | null;
  getInfoAsync(uri: string): Promise<{ exists: boolean; size?: number }>;
  makeDirectoryAsync(uri: string, options?: { intermediates?: boolean }): Promise<void>;
  downloadAsync(url: string, fileUri: string, options?: { headers?: Record<string, string> }): Promise<{ status: number; uri: string }>;
  deleteAsync(uri: string, options?: { idempotent?: boolean }): Promise<void>;
  readAsStringAsync(uri: string): Promise<string>;
  writeAsStringAsync(uri: string, contents: string): Promise<void>;
}

/** expo-file-system SDK 54+ keeps the function API under `/legacy`; older SDKs have it at the package root. */
export function loadFileSystem(): FileSystemLike {
  let mod: any;
  try {
    mod = require('expo-file-system/legacy');
  } catch {
    try {
      mod = require('expo-file-system');
    } catch (cause) {
      throw new ShelfMissingPeerError('expo-file-system', 'the on-disk thumbnail cache', undefined, { cause });
    }
  }
  if (!mod || typeof mod.downloadAsync !== 'function') throw new ShelfMissingPeerError('expo-file-system', 'the on-disk thumbnail cache');
  return mod as FileSystemLike;
}

/** Whatever FlashList renders as; only the props this SDK passes are described. */
export type FlashListLike = React.ComponentType<any>;

export function loadFlashList(): FlashListLike {
  let mod: any;
  try {
    mod = require('@shopify/flash-list');
  } catch (cause) {
    throw new ShelfMissingPeerError('@shopify/flash-list', 'the FlashList-backed document list', 'npx expo install @shopify/flash-list', { cause });
  }
  if (!mod?.FlashList) throw new ShelfMissingPeerError('@shopify/flash-list', 'the FlashList-backed document list', 'npx expo install @shopify/flash-list');
  return mod.FlashList as FlashListLike;
}
