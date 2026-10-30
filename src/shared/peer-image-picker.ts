import { missingPeer } from './peers';
import type { ImagePickerLike } from './peers';

// Metro resolves this literal `require` at bundle time; see scripts/fix-optional-requires.mjs.
declare const require: (id: string) => any;

export function loadExpoImagePicker(feature = 'the camera and photo library'): ImagePickerLike {
  let mod: unknown;
  try {
    mod = require('expo-image-picker');
  } catch (cause) {
    throw missingPeer('expo-image-picker', feature, undefined, cause);
  }
  if (!mod) throw missingPeer('expo-image-picker', feature, undefined);
  return mod as ImagePickerLike;
}
