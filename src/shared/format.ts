export function formatBytes(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** `2026-01-05` style, from the ISO string, with no locale dependence (stable in tests and across devices). */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  return iso.slice(0, 10);
}

export function extensionOf(filename: string): string {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(filename);
  return m ? (m[1] as string).toUpperCase() : '';
}
