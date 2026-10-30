import { ShelfPermissionDeniedError } from '../shared/errors';
import { assetToFile } from '../shared/files';
import { loadExpoDocumentPicker } from '../shared/peer-document-picker';
import { loadExpoImagePicker } from '../shared/peer-image-picker';
import type { DocumentPickerLike, ImagePickerLike } from '../shared/peers';
import type { CaptureAdapter } from '../shared/types';

/** Files app / document provider through `expo-document-picker`. Files are copied to the cache so they have a file URI. */
export function createDocumentPickerAdapter(options: { module?: DocumentPickerLike } = {}): CaptureAdapter {
  return {
    async capture(request) {
      const dp = options.module ?? loadExpoDocumentPicker('picking documents');
      const r = await dp.getDocumentAsync({ type: request.types?.length ? request.types : '*/*', multiple: Boolean(request.multiple), copyToCacheDirectory: true });
      if (r.canceled || !r.assets?.length) return [];
      return r.assets.map((a) => assetToFile(a, 'document'));
    },
  };
}

/** The photo library through `expo-image-picker` (launchImageLibraryAsync). */
export function createPhotoLibraryAdapter(options: { module?: ImagePickerLike } = {}): CaptureAdapter {
  return {
    async capture(request) {
      const ip = options.module ?? loadExpoImagePicker('picking photos');
      let r;
      try {
        r = await ip.launchImageLibraryAsync({
          mediaTypes: ['images'],
          allowsMultipleSelection: Boolean(request.multiple),
          base64: false,
          exif: false,
          ...(ip.UIImagePickerPreferredAssetRepresentationMode?.Compatible !== undefined
            ? { preferredAssetRepresentationMode: ip.UIImagePickerPreferredAssetRepresentationMode.Compatible }
            : {}),
        });
      } catch (e) {
        if (e instanceof Error && /permission/i.test(e.message)) throw new ShelfPermissionDeniedError('photos', false);
        throw e;
      }
      if (r.canceled || !r.assets?.length) return [];
      const now = new Date();
      return r.assets.map((a) => assetToFile(a, 'photo', now));
    },
  };
}
