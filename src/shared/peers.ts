import { ShelfMissingPeerError } from '../core/peer';

/**
 * Builds the error for an absent optional peer. Each loader lives in its own file (peer-*.ts) with a literal `require`
 * directly inside a `try` block: Metro then treats the peer as an optional dependency, so an app that bundles only one
 * entry does not have to install the peers of the others.
 */
export function missingPeer(pkg: string, feature: string, installCommand?: string, cause?: unknown): ShelfMissingPeerError {
  return new ShelfMissingPeerError(pkg, feature, installCommand, cause === undefined ? undefined : { cause });
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
