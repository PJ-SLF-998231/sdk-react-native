/** A file produced by the camera, scanner or a picker. Always a file URI; the bytes are never read into JS. */
export interface CapturedFile {
  uri: string;
  name: string;
  type: string;
  size?: number;
}

/** What a button asks its adapter for. */
export interface CaptureRequest {
  /** Allow several files in one go (pickers; the scanner returns one file per page). */
  multiple?: boolean;
  /** MIME types the document picker offers, e.g. ['application/pdf', 'image/*']. */
  types?: string[];
}

/**
 * Where files come from. The built-in adapters wrap optional peers; bare-RN hosts can pass their own through the
 * `adapter` prop. Resolve with `[]` when the user cancels. Throw {@link ShelfPermissionDeniedError} when a permission
 * is refused, so the button can show the denied state.
 */
export interface CaptureAdapter {
  capture(request: CaptureRequest): Promise<CapturedFile[]>;
}

/** idle: ready. busy: asking, capturing or queueing. denied: a permission was refused. error: anything else failed. */
export type CaptureState = 'idle' | 'busy' | 'denied' | 'error';
