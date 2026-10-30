import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useFolder } from '../hooks/useFolders';
import { useShelf } from '../provider';
import type { ShelfConnectionProps } from '../provider';
import { useListTheme } from '../shared/states';
import type { ShelfTheme } from '../theme/tokens';
import { FolderBreadcrumb } from './FolderBreadcrumb';
import { folderCount } from './FolderCard';
import type { ShelfFolder } from '../core/types';

export interface FolderHeaderProps extends ShelfConnectionProps {
  /** The current folder; omit for the library root. */
  folderId?: string | null;
  /** Shown for the root and while the folder is not known yet. Default "All documents". */
  rootLabel?: string;
  /** Navigate to a crumb (null = root). Without it the breadcrumb is not interactive. */
  onNavigate?: (folder: ShelfFolder | null) => void;
  /** "New folder" button. Rendered only when given: integration keys have no folder writes. */
  onCreateFolder?: () => void;
  /** Extra actions at the right (a camera button, an upload badge, ...). */
  actions?: React.ReactNode;
  theme?: ShelfTheme;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Breadcrumb, folder name and document count; the folder comes from the cached folder list. */
export function FolderHeader({ folderId, rootLabel = 'All documents', onNavigate, onCreateFolder, actions, theme, style, testID, ...conn }: FolderHeaderProps): React.ReactElement {
  const shelf = useShelf({ ...conn, theme });
  const t = useListTheme(theme ?? shelf.theme);
  const { folder, path } = useFolder(folderId, { shelf });
  const title = folderId ? (folder?.name ?? '') : rootLabel;
  const n = folder ? folderCount(folder) : undefined;
  return (
    <View testID={testID} style={[{ backgroundColor: t.colors.bg, borderBottomColor: t.colors.lineSoft, borderBottomWidth: StyleSheet.hairlineWidth }, style]}>
      {folderId ? <FolderBreadcrumb path={path} rootLabel={rootLabel} onPress={onNavigate} theme={t} /> : null}
      <View style={[styles.row, { paddingHorizontal: t.space.lg, paddingVertical: t.space.md }]}>
        <View style={styles.title}>
          <Text accessibilityRole="header" numberOfLines={1} style={{ color: t.colors.fg, fontSize: t.fontSize.lg, fontFamily: t.fonts.serif }}>
            {title}
          </Text>
          {n !== undefined ? <Text style={{ color: t.colors.muted, fontSize: t.fontSize.xs, fontFamily: t.fonts.mono }}>{`${n} ${n === 1 ? 'document' : 'documents'}`}</Text> : null}
        </View>
        {onCreateFolder ? (
          <Pressable accessibilityRole="button" onPress={onCreateFolder} style={{ paddingVertical: t.space.sm, paddingHorizontal: t.space.md, borderRadius: t.radius.md, borderColor: t.colors.accent, borderWidth: 1, marginLeft: t.space.sm }}>
            <Text style={{ color: t.colors.accentText, fontSize: t.fontSize.sm, fontFamily: t.fonts.sans }}>New folder</Text>
          </Pressable>
        ) : null}
        {actions}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({ row: { flexDirection: 'row', alignItems: 'center' }, title: { flex: 1 } });
