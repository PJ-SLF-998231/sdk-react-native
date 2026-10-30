import React, { useCallback, useMemo } from 'react';
import { FlatList } from 'react-native';
import type { ListRenderItemInfo, StyleProp, ViewStyle } from 'react-native';
import { useFolders } from '../hooks/useFolders';
import { useShelf } from '../provider';
import type { ShelfConnectionProps } from '../provider';
import type { ShelfFolder } from '../core/types';
import { ListState, useListTheme } from '../shared/states';
import type { ShelfTheme } from '../theme/tokens';
import { FOLDER_CARD_HEIGHT, FolderCard } from './FolderCard';

export interface FolderListProps extends ShelfConnectionProps {
  /** Show the children of this folder; omit for top-level folders. */
  parentId?: string | null;
  /** Ignore the hierarchy and list every folder. */
  flat?: boolean;
  onPressFolder?: (folder: ShelfFolder) => void;
  /** Folder-write handlers. The matching button renders only when its handler is given (folder writes need a read_write key). */
  onRenameFolder?: (folder: ShelfFolder) => void;
  onDeleteFolder?: (folder: ShelfFolder) => void;
  header?: React.ReactElement | null;
  emptyTitle?: string;
  emptyMessage?: string;
  theme?: ShelfTheme;
  style?: StyleProp<ViewStyle>;
  listProps?: Record<string, unknown>;
  testID?: string;
}

/** Folders at one level (or all of them), from the cache first, revalidated in the background. */
export function FolderList(props: FolderListProps): React.ReactElement {
  const { parentId, flat, onPressFolder, onRenameFolder, onDeleteFolder, header, emptyTitle = 'No folders', emptyMessage = 'Folders you create will show up here.', theme, style, listProps, testID, ...conn } = props;
  const shelf = useShelf({ ...conn, theme });
  const t = useListTheme(theme ?? shelf.theme);
  const folders = useFolders({ shelf });
  const rows = useMemo(() => (flat ? (folders.data ?? []) : (folders.data ?? []).filter((f) => (f.parent_id ?? null) === (parentId ?? null))), [folders.data, flat, parentId]);
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<ShelfFolder>) => <FolderCard folder={item} onPress={onPressFolder} onRename={onRenameFolder} onDelete={onDeleteFolder} theme={t} />,
    [onPressFolder, onRenameFolder, onDeleteFolder, t],
  );
  const keyExtractor = useCallback((f: ShelfFolder) => f.id, []);
  const getItemLayout = useCallback((_: unknown, index: number) => ({ length: FOLDER_CARD_HEIGHT, offset: FOLDER_CARD_HEIGHT * index, index }), []);

  if (folders.data === undefined) {
    if (folders.error) {
      return <ListState kind="error" title={folders.offline ? 'You are offline' : 'Could not load folders'} message={folders.offline ? 'Connect to load your folders.' : undefined} onRetry={() => void folders.refresh()} theme={t} style={style} testID={testID} />;
    }
    return <ListState kind="loading" title="Loading folders" theme={t} style={style} testID={testID} />;
  }
  if (rows.length === 0) return <ListState kind="empty" title={emptyTitle} message={emptyMessage} theme={t} style={style} testID={testID} />;
  return (
    <FlatList
      testID={testID}
      style={style}
      data={rows}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      getItemLayout={getItemLayout}
      ListHeaderComponent={header}
      initialNumToRender={12}
      windowSize={7}
      maxToRenderPerBatch={12}
      onRefresh={() => void folders.refresh()}
      refreshing={false}
      {...listProps}
    />
  );
}
