import { ShelfMissingPeerError } from '../core/peer';

// Metro resolves these literal `require`s at bundle time; see scripts/fix-optional-requires.mjs.
declare const require: (id: string) => any;

function load<T>(pkg: string, feature: string, get: () => unknown, installCommand?: string): T {
  let mod: unknown;
  try {
    mod = get();
  } catch (cause) {
    throw new ShelfMissingPeerError(pkg, feature, installCommand, { cause });
  }
  if (!mod) throw new ShelfMissingPeerError(pkg, feature, installCommand);
  return mod as T;
}

export interface ImagePickerLike {
  requestCameraPermissionsAsync(): Promise<{ granted: boolean; canAskAgain?: boolean }>;
  launchCameraAsync(options?: Record<string, unknown>): Promise<{ canceled: boolean; assets?: import('./files').AssetLike[] | null }>;
  launchImageLibraryAsync(options?: Record<string, unknown>): Promise<{ canceled: boolean; assets?: import('./files').AssetLike[] | null }>;
  UIImagePickerPreferredAssetRepresentationMode?: { Compatible?: unknown };
}
export interface DocumentPickerLike {
  getDocumentAsync(options?: Record<string, unknown>): Promise<{ canceled: boolean; assets?: import('./files').AssetLike[] | null }>;
}
export interface DocumentScannerLike {
  scanDocument(options?: Record<string, unknown>): Promise<{ scannedImages?: string[] | null; status?: string }>;
}

export const loadExpoImagePicker = (feature = 'the camera and photo library'): ImagePickerLike =>
  load<ImagePickerLike>('expo-image-picker', feature, () => require('expo-image-picker'));

export const loadExpoDocumentPicker = (feature = 'the document picker'): DocumentPickerLike =>
  load<DocumentPickerLike>('expo-document-picker', feature, () => require('expo-document-picker'));

export const loadDocumentScanner = (feature = 'document scanning'): DocumentScannerLike =>
  load<DocumentScannerLike>(
    'react-native-document-scanner-plugin',
    feature,
    () => {
      const m = require('react-native-document-scanner-plugin');
      return m?.default ?? m;
    },
    'npm install react-native-document-scanner-plugin && npx pod-install (needs a development build, not Expo Go)',
  );
