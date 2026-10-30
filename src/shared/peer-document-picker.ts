import { missingPeer } from './peers';
import type { DocumentPickerLike } from './peers';

// Metro resolves this literal `require` at bundle time; see scripts/fix-optional-requires.mjs.
declare const require: (id: string) => any;

export function loadExpoDocumentPicker(feature = 'the document picker'): DocumentPickerLike {
  let mod: unknown;
  try {
    mod = require('expo-document-picker');
  } catch (cause) {
    throw missingPeer('expo-document-picker', feature, undefined, cause);
  }
  if (!mod) throw missingPeer('expo-document-picker', feature, undefined);
  return mod as DocumentPickerLike;
}
