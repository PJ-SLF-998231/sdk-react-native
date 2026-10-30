import { missingPeer } from './peers';
import type { DocumentScannerLike } from './peers';

// Metro resolves this literal `require` at bundle time; see scripts/fix-optional-requires.mjs.
declare const require: (id: string) => any;

export function loadDocumentScanner(feature = 'document scanning'): DocumentScannerLike {
  let mod: unknown;
  try {
    const m = require('react-native-document-scanner-plugin');
    mod = m?.default ?? m;
  } catch (cause) {
    throw missingPeer('react-native-document-scanner-plugin', feature, 'npm install react-native-document-scanner-plugin && npx pod-install (needs a development build, not Expo Go)', cause);
  }
  if (!mod) throw missingPeer('react-native-document-scanner-plugin', feature, 'npm install react-native-document-scanner-plugin && npx pod-install (needs a development build, not Expo Go)');
  return mod as DocumentScannerLike;
}
