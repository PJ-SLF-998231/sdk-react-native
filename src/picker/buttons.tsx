import React, { useMemo } from 'react';
import { CaptureButton } from '../shared/CaptureButton';
import type { CaptureButtonProps } from '../shared/CaptureButton';
import type { CaptureAdapter } from '../shared/types';
import { createDocumentPickerAdapter, createPhotoLibraryAdapter } from './adapters';

export interface PickerButtonProps extends Omit<CaptureButtonProps, 'adapter'> {
  /** Your own source. Replaces the built-in adapter. */
  adapter?: CaptureAdapter;
  /** Let the user choose several files at once. */
  multiple?: boolean;
}

export interface DocumentPickerButtonProps extends PickerButtonProps {
  /** MIME types to offer, e.g. ['application/pdf', 'image/*']. Default: any file. */
  type?: string[];
}

/** Picks files from the Files app (expo-document-picker) and sends them through the outbox. */
export function DocumentPickerButton({ adapter, multiple, type, request, ...rest }: DocumentPickerButtonProps): React.ReactElement {
  const built = useMemo(() => adapter ?? createDocumentPickerAdapter(), [adapter]);
  return (
    <CaptureButton
      {...rest}
      request={{ ...request, ...(multiple !== undefined ? { multiple } : {}), ...(type ? { types: type } : {}) }}
      adapter={built}
      glyph="document"
      defaultLabel={multiple ? 'Choose files' : 'Choose file'}
      defaultDenied="Shelf needs access to your files."
    />
  );
}

/** Picks photos from the photo library (expo-image-picker) and sends them through the outbox. */
export function PhotoLibraryButton({ adapter, multiple, request, ...rest }: PickerButtonProps): React.ReactElement {
  const built = useMemo(() => adapter ?? createPhotoLibraryAdapter(), [adapter]);
  return (
    <CaptureButton
      {...rest}
      request={{ ...request, ...(multiple !== undefined ? { multiple } : {}) }}
      adapter={built}
      glyph="image"
      defaultLabel={multiple ? 'Choose photos' : 'Choose photo'}
      defaultDenied="Shelf needs access to your photos."
    />
  );
}
