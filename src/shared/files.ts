const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', heif: 'image/heif', webp: 'image/webp', gif: 'image/gif',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function mimeFromName(name: string, fallback = 'application/octet-stream'): string {
  const ext = name.split('?')[0]!.split('.').pop()?.toLowerCase() ?? '';
  return MIME[ext] ?? fallback;
}

export function nameFromUri(uri: string): string | undefined {
  const last = decodeURIComponent(uri.split('?')[0]!.split('/').pop() ?? '');
  return last && last.includes('.') ? last : undefined;
}

/** A timestamped name like `photo-20260101-101530.jpg`, used when the source gives none. */
export function stampedName(prefix: string, ext: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${prefix}-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.${ext}`;
}

export interface AssetLike {
  uri: string;
  fileName?: string | null;
  name?: string | null;
  mimeType?: string | null;
  type?: string | null;
  fileSize?: number | null;
  size?: number | null;
}

/** Normalises an expo picker asset into a CapturedFile (file URI, name, MIME type). */
export function assetToFile(a: AssetLike, prefix: string, now?: Date): import('./types').CapturedFile {
  const name = a.fileName || a.name || nameFromUri(a.uri) || stampedName(prefix, 'jpg', now);
  const mime = a.mimeType || (a.type && a.type.includes('/') ? a.type : undefined) || mimeFromName(name, a.type === 'image' ? 'image/jpeg' : undefined);
  const size = a.fileSize ?? a.size ?? undefined;
  return { uri: a.uri, name, type: mime, ...(size != null ? { size } : {}) };
}
