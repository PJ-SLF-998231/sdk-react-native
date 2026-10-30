import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useDocument } from '../hooks/useDocument';
import { useShelf } from '../provider';
import type { ShelfConnectionProps } from '../provider';
import { ListState, useListTheme } from '../shared/states';
import type { ShelfTheme } from '../theme/tokens';
import { DocumentContentView } from './DocumentContentView';
import { DocumentPreview } from './DocumentPreview';
import { DocumentTextView } from './DocumentTextView';
import type { UnknownBlockReport } from './siteSpec';
import { activeTab, resolveTabs, TAB_LABELS } from './tabs';
import type { DocumentTab } from './tabs';
import type { OpenLink } from './blocks';

export interface DocumentScreenProps extends ShelfConnectionProps {
  documentId: string;
  /** Ordered subset of 'text' | 'preview' | 'content'. Default ['text', 'preview', 'content']. Content shows only when the document has a site. */
  tabs?: DocumentTab[];
  /** The tab shown first (when visible). Default: the first visible tab. */
  initialTab?: DocumentTab;
  /** Show the available preview sizes as a selector on the Preview tab. Default false. */
  showPreviewSizes?: boolean;
  onUnknownBlock?: (report: UnknownBlockReport) => void;
  onOpenLink?: OpenLink;
  onTabChange?: (tab: DocumentTab) => void;
  theme?: ShelfTheme;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** A document's file name and its Text / Preview / Content tabs. Works inside a <ShelfProvider> or with `client` / `baseUrl` + `getHeaders`. */
export function DocumentScreen({ documentId, tabs, initialTab, showPreviewSizes = false, onUnknownBlock, onOpenLink, onTabChange, theme, style, testID, ...conn }: DocumentScreenProps): React.ReactElement {
  const t = useListTheme(theme);
  // Resolve the connection once and hand it to each tab, so a baseUrl builds one client and one cache, not one per tab.
  const shelf = useShelf(conn);
  const { data: doc, loading, error, offline, refresh } = useDocument(documentId, { shelf });
  const [picked, setPicked] = useState<DocumentTab | null>(null);
  const visible = resolveTabs(tabs, doc ? doc.has_site === true : undefined);
  const tab = activeTab(visible, picked, initialTab);
  const common = { documentId, shelf, theme: t };

  if (!doc && !loading && error) {
    return <ListState kind="error" testID={testID} title={offline ? 'You are offline' : "Couldn't load the document"} onRetry={() => void refresh()} theme={t} style={style} />;
  }
  return (
    <View testID={testID ?? 'document-screen'} style={[{ flex: 1, backgroundColor: t.colors.bg }, style]}>
      {doc ? (
        <Text numberOfLines={2} accessibilityRole="header" style={{ color: t.colors.fg, fontSize: t.fontSize.lg, fontFamily: t.fonts.sans, fontWeight: '600', paddingHorizontal: t.space.lg, paddingTop: t.space.md }}>
          {doc.filename}
        </Text>
      ) : null}
      <View accessibilityRole="tablist" testID="document-tabs" style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: t.colors.lineSoft, marginTop: t.space.sm }}>
        {visible.map((id) => {
          const on = id === tab;
          return (
            <Pressable
              key={id}
              testID={`document-tab-${id}`}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              onPress={() => {
                setPicked(id);
                onTabChange?.(id);
              }}
              style={{ flex: 1, alignItems: 'center', paddingVertical: t.space.md, borderBottomWidth: 2, borderBottomColor: on ? t.colors.accent : 'transparent' }}
            >
              <Text style={{ color: on ? t.colors.fg : t.colors.muted, fontSize: t.fontSize.sm, fontFamily: t.fonts.sans, fontWeight: on ? '600' : '400' }}>{TAB_LABELS[id]}</Text>
            </Pressable>
          );
        })}
      </View>
      <View style={{ flex: 1 }}>
        {!doc ? (
          <ListState kind="loading" title="Loading document" theme={t} />
        ) : tab === 'text' ? (
          <DocumentTextView {...common} style={{ flex: 1 }} />
        ) : tab === 'preview' ? (
          <DocumentPreview {...common} showSizes={showPreviewSizes} />
        ) : tab === 'content' ? (
          <DocumentContentView {...common} expectSite onUnknownBlock={onUnknownBlock} onOpenLink={onOpenLink} style={{ flex: 1 }} />
        ) : null}
      </View>
    </View>
  );
}
