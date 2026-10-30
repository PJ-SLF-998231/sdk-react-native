import React, { useEffect, useRef } from 'react';
import { ScrollView, Text } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useDocumentSite } from '../hooks/useDocument';
import type { ShelfConnectionProps } from '../provider';
import { ListState, useListTheme } from '../shared/states';
import type { ShelfTheme } from '../theme/tokens';
import { SiteBlock } from './blocks';
import type { OpenLink } from './blocks';
import { parseSiteSpec } from './siteSpec';
import type { UnknownBlockReport } from './siteSpec';

export interface SiteRendererProps {
  /** A version-1 document-site spec, as GET /files/{id}/site returns it in `spec`. */
  spec: unknown;
  theme?: ShelfTheme;
  /** Called once per block this version cannot draw (unknown type, unusable props, unsupported spec version). */
  onUnknownBlock?: (report: UnknownBlockReport) => void;
  /** Replaces `Linking.openURL` for links in the spec's text. */
  onOpenLink?: OpenLink;
  /** Shown above the blocks, e.g. "Updating…". */
  notice?: string;
  style?: StyleProp<ViewStyle>;
}

/** Draws a site spec (no network): the blocks in layout order, unknown ones skipped and reported. */
export function SiteRenderer({ spec, theme, onUnknownBlock, onOpenLink, notice, style }: SiteRendererProps): React.ReactElement {
  const t = useListTheme(theme);
  const parsed = React.useMemo(() => parseSiteSpec(spec), [spec]);
  const report = useRef(onUnknownBlock);
  report.current = onUnknownBlock;
  useEffect(() => {
    for (const u of parsed.unknown) report.current?.(u);
  }, [parsed]);
  const tables = parsed.blocks.filter((b) => b.type === 'table').length;
  let tableNumber = 0;
  return (
    <ScrollView testID="site-view" style={style} contentContainerStyle={{ paddingBottom: t.space.xl }}>
      {notice ? <Text accessibilityLiveRegion="polite" style={{ color: t.colors.muted, fontSize: t.fontSize.sm, fontFamily: t.fonts.sans, padding: t.space.md, textAlign: 'center' }}>{notice}</Text> : null}
      {parsed.blocks.length === 0 ? (
        <ListState kind="empty" title="Nothing to show" message="This content can't be shown in this version of the app." theme={t} />
      ) : (
        parsed.blocks.map((b, i) => {
          if (b.type === 'table') tableNumber += 1;
          return <SiteBlock key={`${b.type}-${i}`} block={b} theme={t} onOpenLink={onOpenLink} tableNumber={tableNumber} tableCount={tables} />;
        })
      )}
    </ScrollView>
  );
}

export interface DocumentContentViewProps extends ShelfConnectionProps, Omit<SiteRendererProps, 'spec' | 'notice'> {
  documentId: string;
  theme?: ShelfTheme;
  /** The document is known to have a site (`has_site`): "no site yet" then means one is being prepared, and is re-read. */
  expectSite?: boolean;
  /** Re-read interval in ms while a site is being built (or expected). 0 stops polling. Default 10000. */
  pollMs?: number;
  testID?: string;
}

/** The document's generated site, fetched and drawn. Handles the site's pending, building, stale and failed states. */
export function DocumentContentView({ documentId, expectSite, pollMs = 10_000, theme, onUnknownBlock, onOpenLink, style, testID, ...conn }: DocumentContentViewProps): React.ReactElement {
  const t = useListTheme(theme);
  const site = useDocumentSite(documentId, conn);
  const data = site.data;
  const status = data?.status;
  const pending = status === 'building' || (status === 'none' && expectSite === true);
  const refresh = site.refresh;
  useEffect(() => {
    if (!pending || pollMs <= 0) return;
    const id = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(id);
  }, [pending, pollMs, refresh]);

  if (!data) {
    if (site.error) return <ListState kind="error" testID={testID} title={site.offline ? 'You are offline' : "Couldn't load the content"} onRetry={() => void refresh()} theme={t} style={style} />;
    return <ListState kind="loading" testID={testID} title="Loading content" theme={t} style={style} />;
  }
  if (data.spec !== undefined && data.spec !== null) {
    const updating = status === 'building' || data.stale === true;
    return <SiteRenderer spec={data.spec} theme={t} onUnknownBlock={onUnknownBlock} onOpenLink={onOpenLink} notice={updating ? 'Updating…' : undefined} style={style} />;
  }
  if (status === 'building' || (status === 'none' && expectSite)) return <ListState kind="loading" testID={testID} title="Content is being prepared" theme={t} style={style} />;
  if (status === 'failed') return <ListState kind="error" testID={testID} title="Content couldn't be generated" message={data.error ?? undefined} theme={t} style={style} />;
  return <ListState kind="empty" testID={testID} title="No generated content" message="This document has no generated content." theme={t} style={style} />;
}
