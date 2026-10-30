import React, { useMemo } from 'react';
import { CaptureButton } from '../shared/CaptureButton';
import type { CaptureButtonProps } from '../shared/CaptureButton';
import type { CaptureAdapter } from '../shared/types';
import { createPhotoCaptureAdapter, createScanAdapter } from './adapters';

export interface CameraButtonProps extends Omit<CaptureButtonProps, 'adapter'> {
  /** `photo` (default): take a photo. `scan`: scan a document with the native scanner. */
  mode?: 'photo' | 'scan';
  /** Your own source (bare RN, an expo-camera screen, ...). Replaces the built-in adapter for the mode. */
  adapter?: CaptureAdapter;
}

/**
 * Takes a photo or scans a document and sends it to Shelf through the persistent outbox (so it survives being
 * offline); set `uploadMode="direct"` to upload immediately instead. Works inside <ShelfProvider> or with `client` /
 * `baseUrl` + `getHeaders`.
 */
export function CameraButton({ mode = 'photo', adapter, ...rest }: CameraButtonProps): React.ReactElement {
  const built = useMemo(() => adapter ?? (mode === 'scan' ? createScanAdapter() : createPhotoCaptureAdapter()), [adapter, mode]);
  return (
    <CaptureButton
      {...rest}
      adapter={built}
      glyph={mode === 'scan' ? 'scan' : 'camera'}
      defaultLabel={mode === 'scan' ? 'Scan document' : 'Take photo'}
      defaultDenied="Shelf needs camera access to capture documents."
    />
  );
}
