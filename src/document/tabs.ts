export type DocumentTab = 'text' | 'preview' | 'content';

/** Default order: Text, Preview, Content. */
export const DEFAULT_TABS: readonly DocumentTab[] = ['text', 'preview', 'content'];
export const TAB_LABELS: Record<DocumentTab, string> = { text: 'Text', preview: 'Preview', content: 'Content' };

/**
 * The tabs to show: `tabs` in the order given (unknown names and repeats dropped; an empty or invalid list means the
 * default order), minus Content unless the document has a site (`has_site` true; unknown while loading counts as no).
 */
export function resolveTabs(tabs: readonly string[] | undefined, hasSite: boolean | undefined): DocumentTab[] {
  const wanted = (tabs ?? DEFAULT_TABS).filter((t, i, all): t is DocumentTab => (DEFAULT_TABS as readonly string[]).includes(t) && all.indexOf(t) === i);
  const list = wanted.length ? wanted : [...DEFAULT_TABS];
  return list.filter((t) => t !== 'content' || hasSite === true);
}

/** The tab to show: the user's pick, else `initial`, each only if visible, else the first visible one. */
export function activeTab(visible: readonly DocumentTab[], picked: DocumentTab | null, initial: DocumentTab | undefined): DocumentTab | null {
  if (picked && visible.includes(picked)) return picked;
  if (initial && visible.includes(initial)) return initial;
  return visible[0] ?? null;
}
