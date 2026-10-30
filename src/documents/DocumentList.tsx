import React, { useCallback, useMemo } from 'react';
import { ActivityIndicator, FlatList, Text, View, useWindowDimensions } from 'react-native';
import type { ListRenderItemInfo, StyleProp, ViewStyle } from 'react-native';
import { useShelf } from '../provider';
import { useDocuments } from '../hooks/useDocuments';
import type { UseDocumentsOptions } from '../hooks/useDocuments';
import type { ShelfItem } from '../core/types';
import { ListState, useListTheme } from '../shared/states';
import type { ShelfTheme } from '../theme/tokens';
import { DOCUMENT_CARD_HEIGHT, DocumentCard } from './DocumentCard';
import { DOCUMENT_ROW_HEIGHT, DocumentRow } from './DocumentRow';
import { loadFlashList } from './peers';
import type { ThumbnailCache } from './thumbnails';

const CARD_GAP = 12;
let warnedFlash = false;

export interface DocumentListProps extends UseDocumentsOptions {
  /** The folder to list; omit for the library root. */
  folderId?: string | null;
  /** `row` (default) or a `card` grid. */
  variant?: 'row' | 'card';
  /** Grid columns for `variant="card"`. Default 2. */
  columns?: number;
  onPressDocument?: (document: ShelfItem) => void;
  onLongPressDocument?: (document: ShelfItem) => void;
  /** Replace the default row/card. Keep it a fixed `itemHeight` so layouts stay computable. */
  renderDocument?: (info: { document: ShelfItem; index: number }) => React.ReactElement | null;
  /** Height of a custom item (renderDocument). Defaults to the row or card height. */
  itemHeight?: number;
  /**
   * The list implementation: `'flatlist'` (default), `'flashlist'` (needs the optional peer `@shopify/flash-list`; falls
   * back to FlatList with a one-time warning when it is missing), or your own component taking FlatList-like props.
   */
  listComponent?: 'flatlist' | 'flashlist' | React.ComponentType<any>;
  /** Extra props for the underlying list; they win over the SDK's defaults (windowSize, initialNumToRender, ...). */
  listProps?: Record<string, unknown>;
  thumbnailCache?: ThumbnailCache;
  theme?: ShelfTheme;
  header?: React.ReactElement | null;
  emptyTitle?: string;
  emptyMessage?: string;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * Documents of a folder in a virtualised list. Cached documents are on screen as soon as the cache is read, a
 * background request refreshes them, and further pages load on scroll. Only a window of rows is mounted; thumbnails
 * load for mounted rows only.
 */
export function DocumentList(props: DocumentListProps): React.ReactElement {
  const {
    folderId, variant = 'row', columns = 2, onPressDocument, onLongPressDocument, renderDocument, itemHeight, listComponent = 'flatlist', listProps, thumbnailCache, theme,
    header, emptyTitle = 'No documents', emptyMessage = 'Documents you add will show up here.', style, contentContainerStyle, testID,
    pageSize, recursive, client, baseUrl, getHeaders, fetch, onAuthLost, cacheScope, storage, offline, themeOverrides,
  } = props;
  const conn = { client, baseUrl, getHeaders, fetch, onAuthLost, cacheScope, storage, offline, theme, themeOverrides };
  const shelf = useShelf(conn);
  const t = useListTheme(theme ?? shelf.theme);
  const docs = useDocuments(folderId, { shelf, pageSize, recursive });
  const { width: screenWidth } = useWindowDimensions();
  const grid = variant === 'card' && !renderDocument;
  const numColumns = grid ? Math.max(1, columns) : 1;
  const cardWidth = Math.floor((screenWidth - t.space.lg * 2 - CARD_GAP * (numColumns - 1)) / numColumns);
  const rowLength = (renderDocument ? itemHeight : undefined) ?? (grid ? DOCUMENT_CARD_HEIGHT + CARD_GAP : variant === 'card' ? DOCUMENT_CARD_HEIGHT : DOCUMENT_ROW_HEIGHT);
  const clientForThumbs = shelf.client;

  const List = useMemo<React.ComponentType<any>>(() => {
    if (typeof listComponent === 'function' || (typeof listComponent === 'object' && listComponent !== null)) return listComponent as React.ComponentType<any>;
    if (listComponent === 'flashlist') {
      try {
        return loadFlashList();
      } catch (e) {
        if (!warnedFlash) {
          warnedFlash = true;
          console.warn(`[shelf] ${(e as Error).message} Falling back to FlatList.`);
        }
      }
    }
    return FlatList;
  }, [listComponent]);
  const isFlatList = List === FlatList;
  const isFlash = !isFlatList && listComponent === 'flashlist';

  const renderItem = useCallback(
    ({ item, index }: ListRenderItemInfo<ShelfItem>) => {
      if (renderDocument) return renderDocument({ document: item, index });
      return grid ? (
        <View style={{ width: cardWidth, marginRight: CARD_GAP, marginBottom: CARD_GAP }}>
          <DocumentCard document={item} width={cardWidth} onPress={onPressDocument} onLongPress={onLongPressDocument} client={clientForThumbs} thumbnailCache={thumbnailCache} theme={t} />
        </View>
      ) : variant === 'card' ? (
        <DocumentCard document={item} width={screenWidth - t.space.lg * 2} onPress={onPressDocument} onLongPress={onLongPressDocument} client={clientForThumbs} thumbnailCache={thumbnailCache} theme={t} />
      ) : (
        <DocumentRow document={item} onPress={onPressDocument} onLongPress={onLongPressDocument} client={clientForThumbs} thumbnailCache={thumbnailCache} theme={t} />
      );
    },
    [renderDocument, grid, variant, cardWidth, screenWidth, onPressDocument, onLongPressDocument, clientForThumbs, thumbnailCache, t],
  );

  const keyExtractor = useCallback((d: ShelfItem) => d.id, []);
  const getItemLayout = useCallback((_: unknown, index: number) => ({ length: rowLength, offset: rowLength * index, index }), [rowLength]);

  if (!docs.ready) {
    if (docs.error) {
      return <ListState kind="error" title={docs.offline ? 'You are offline' : 'Could not load documents'} message={docs.offline ? 'Connect to load this folder.' : undefined} onRetry={() => void docs.refresh()} theme={t} style={style} testID={testID} />;
    }
    return <ListState kind="loading" title="Loading documents" theme={t} style={style} testID={testID} />;
  }
  if (docs.items.length === 0) {
    return <ListState kind="empty" title={emptyTitle} message={emptyMessage} theme={t} style={style} testID={testID} />;
  }

  const footer = docs.loadingMore ? (
    <ActivityIndicator style={{ margin: t.space.lg }} color={t.colors.accentText} />
  ) : docs.error ? (
    <Text accessibilityLiveRegion="polite" style={{ color: t.colors.muted, fontSize: t.fontSize.xs, fontFamily: t.fonts.mono, textAlign: 'center', padding: t.space.md }}>
      {docs.offline ? 'Offline: showing saved documents' : 'Could not refresh: showing saved documents'}
    </Text>
  ) : null;

  // Windowing: mount about a screen and a half either side; batch renders so a fast scroll does not block the JS thread.
  const windowing = isFlash
    ? { estimatedItemSize: rowLength, drawDistance: rowLength * 12 }
    : { getItemLayout, initialNumToRender: Math.ceil(10 / numColumns), maxToRenderPerBatch: 10, updateCellsBatchingPeriod: 50, windowSize: 7, removeClippedSubviews: true };

  return (
    <List
      testID={testID}
      style={style}
      data={docs.items}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      numColumns={numColumns}
      key={`cols-${numColumns}`}
      ListHeaderComponent={header}
      ListFooterComponent={footer}
      onEndReached={docs.hasMore ? () => void docs.loadMore() : undefined}
      onEndReachedThreshold={1.5}
      onRefresh={() => void docs.refresh()}
      refreshing={false}
      contentContainerStyle={[grid ? { paddingHorizontal: t.space.lg, paddingTop: CARD_GAP } : null, contentContainerStyle]}
      {...windowing}
      {...listProps}
    />
  );
}

