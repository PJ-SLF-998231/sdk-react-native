import type { SourceRef } from './siteSpec';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 2026-10-08 -> "8 Oct 2026", 2026-10 -> "Oct 2026", 2026 -> "2026". Fixed English names, not Intl, so it reads the same everywhere. */
export function formatSiteDate(date: string): string {
  const [year, month, day] = date.split('-');
  const name = month ? MONTHS[Number(month) - 1] : undefined;
  if (!name) return year ?? date;
  if (!day) return `${name} ${year}`;
  return `${Number(day)} ${name} ${year}`;
}

/** "1245.50" -> "1,245.50"; "-3" -> a true minus sign and "3". */
export function formatFigure(value: string): string {
  const negative = value.startsWith('-');
  const [whole = '', fraction] = (negative ? value.slice(1) : value).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '−' : ''}${grouped}${fraction !== undefined ? `.${fraction}` : ''}`;
}

export const formatAmount = (value: string, currency?: string): string => (currency ? `${currency} ${formatFigure(value)}` : formatFigure(value));

/** {page: 1, line: 12} -> "Page 1 · Line 12". */
export function formatRef(ref: SourceRef): string {
  const parts: string[] = [];
  if (ref.page !== undefined) parts.push(`Page ${ref.page}`);
  if (ref.line !== undefined) parts.push(`Line ${ref.line}`);
  return parts.join(' · ');
}
