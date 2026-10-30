import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import type { ShelfFolder } from '../core/types';
import { useListTheme } from '../shared/states';
import type { ShelfTheme } from '../theme/tokens';

export const FOLDER_CARD_HEIGHT = 64;

export interface FolderCardProps {
  folder: ShelfFolder;
  onPress?: (folder: ShelfFolder) => void;
  /** Folder-write actions. Integration keys cannot write folders, so these render only when you pass the handler. */
  onRename?: (folder: ShelfFolder) => void;
  onDelete?: (folder: ShelfFolder) => void;
  theme?: ShelfTheme;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export const folderCount = (f: ShelfFolder): number | undefined => (typeof f.total_item_count === 'number' ? f.total_item_count : typeof f.item_count === 'number' ? f.item_count : undefined);

/** A folder row: a folder glyph, its name and how many documents it holds. */
export const FolderCard = React.memo(function FolderCard({ folder, onPress, onRename, onDelete, theme, style, testID }: FolderCardProps): React.ReactElement {
  const t = useListTheme(theme);
  const n = folderCount(folder);
  const count = n === undefined ? '' : `${n} ${n === 1 ? 'document' : 'documents'}`;
  return (
    <View testID={testID} style={[styles.row, { height: FOLDER_CARD_HEIGHT, paddingHorizontal: t.space.lg, borderBottomColor: t.colors.lineSoft, backgroundColor: t.colors.bg }, style]}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${folder.name}${count ? `, ${count}` : ''}`} onPress={onPress ? () => onPress(folder) : undefined} style={styles.main}>
        <View style={[styles.glyph, { width: 36, height: 28, borderRadius: t.radius.sm, backgroundColor: t.colors.bgSoft, borderColor: t.colors.accent }]} />
        <View style={[styles.text, { marginLeft: t.space.md }]}>
          <Text numberOfLines={1} style={{ color: t.colors.fg, fontSize: t.fontSize.md, fontFamily: t.fonts.sans }}>
            {folder.name}
          </Text>
          {count ? <Text style={{ color: t.colors.muted, fontSize: t.fontSize.xs, fontFamily: t.fonts.mono, marginTop: 2 }}>{count}</Text> : null}
        </View>
      </Pressable>
      {onRename ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`Rename ${folder.name}`} onPress={() => onRename(folder)} style={{ padding: t.space.sm }}>
          <Text style={{ color: t.colors.accentText, fontSize: t.fontSize.sm, fontFamily: t.fonts.sans }}>Rename</Text>
        </Pressable>
      ) : null}
      {onDelete ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`Delete ${folder.name}`} onPress={() => onDelete(folder)} style={{ padding: t.space.sm }}>
          <Text style={{ color: t.colors.danger, fontSize: t.fontSize.sm, fontFamily: t.fonts.sans }}>Delete</Text>
        </Pressable>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  main: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  glyph: { borderWidth: 1.5 },
  text: { flex: 1 },
});
