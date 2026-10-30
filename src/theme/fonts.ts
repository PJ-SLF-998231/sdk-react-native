import { MissingPeerError } from '../core/peer';

// Metro resolves this literal `require` at bundle time; see scripts/fix-optional-requires.mjs.
declare const require: (id: string) => any;

export interface FontModuleLike {
  loadAsync(map: Record<string, unknown>): Promise<void>;
}

/**
 * Registers fonts with expo-font (a lazy, optional peer). Fonts are the host's job; this is only a convenience:
 *   await loadShelfFonts({ Geist: require('./Geist.ttf') });
 * Pass `module` to skip the lazy require.
 */
export async function loadShelfFonts(map: Record<string, unknown>, options: { module?: FontModuleLike } = {}): Promise<void> {
  let mod: FontModuleLike | undefined = options.module;
  if (!mod) {
    try {
      mod = require('expo-font') as FontModuleLike;
    } catch {
      throw new MissingPeerError('expo-font', 'loadShelfFonts');
    }
  }
  await mod.loadAsync(map);
}
