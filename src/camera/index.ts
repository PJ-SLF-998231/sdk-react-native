export { CameraButton } from './CameraButton';
export type { CameraButtonProps } from './CameraButton';
export { createPhotoCaptureAdapter, createScanAdapter } from './adapters';
export { useCaptureUpload } from '../shared/useCaptureUpload';
export type { UseCaptureUploadOptions, UseCaptureUploadResult } from '../shared/useCaptureUpload';
export type { CaptureButtonProps, CaptureFaceProps } from '../shared/CaptureButton';
export type { CaptureAdapter, CaptureRequest, CaptureState, CapturedFile } from '../shared/types';
export { ShelfPermissionDeniedError } from '../shared/errors';
export { ShelfMissingPeerError } from '../core/peer';
