import { ShelfPermissionDeniedError } from '../shared/errors';
import { assetToFile, stampedName } from '../shared/files';
import { loadDocumentScanner, loadExpoImagePicker } from '../shared/peers';
import type { DocumentScannerLike, ImagePickerLike } from '../shared/peers';
import type { CaptureAdapter } from '../shared/types';

/**
 * Photo: the system camera through `expo-image-picker` (launchCameraAsync). Pass `module` to inject it (tests, or a
 * custom wrapper); otherwise the peer is required lazily and a missing one throws ShelfMissingPeerError when used.
 * `expo-camera` is not wrapped: it needs a viewfinder screen of your own, so supply an `adapter` for it.
 */
export function createPhotoCaptureAdapter(options: { module?: ImagePickerLike; quality?: number } = {}): CaptureAdapter {
  return {
    async capture() {
      const ip = options.module ?? loadExpoImagePicker('taking photos');
      const perm = await ip.requestCameraPermissionsAsync();
      if (!perm.granted) throw new ShelfPermissionDeniedError('camera', perm.canAskAgain !== false);
      const r = await ip.launchCameraAsync({ mediaTypes: ['images'], quality: options.quality ?? 0.9, base64: false, exif: false });
      if (r.canceled || !r.assets?.length) return [];
      const now = new Date();
      return r.assets.map((a) => assetToFile(a, 'photo', now));
    },
  };
}

/** Scan: the native document scanner (`react-native-document-scanner-plugin`). One image file per scanned page. */
export function createScanAdapter(options: { module?: DocumentScannerLike; quality?: number } = {}): CaptureAdapter {
  return {
    async capture(request) {
      const scanner = options.module ?? loadDocumentScanner('scanning documents');
      let res;
      try {
        res = await scanner.scanDocument({ croppedImageQuality: options.quality ?? 90, ...(request.multiple ? {} : { maxNumDocuments: 1 }) });
      } catch (e) {
        // Android reports a refused camera permission as a plain error.
        if (e instanceof Error && /permission/i.test(e.message)) throw new ShelfPermissionDeniedError('camera', false);
        throw e;
      }
      const pages = res.scannedImages ?? [];
      if (res.status === 'cancel' || pages.length === 0) return [];
      const now = new Date();
      return pages.map((uri, i) => ({
        uri,
        name: stampedName(pages.length > 1 ? `scan-p${i + 1}` : 'scan', 'jpg', now),
        type: 'image/jpeg',
      }));
    },
  };
}
