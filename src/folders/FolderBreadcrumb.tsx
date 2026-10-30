import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import type { ShelfFolder } from '../core/types';
import { useListTheme } from '../shared/states';
import type { ShelfTheme } from '../theme/tokens';

export interface FolderBreadcrumbProps {
  /** Root-to-current chain (`useFolder(id).path`). */
  path: readonly ShelfFolder[];
  /** Label of the root crumb. Default "All documents". */
  rootLabel?: string;
  /** Called with the tapped folder, or null for the root. The last crumb (current folder) is not pressable. */
  onPress?: (folder: ShelfFolder | null) => void;
  theme?: ShelfTheme;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function FolderBreadcrumb({ path, rootLabel = 'All documents', onPress, theme, style, testID }: FolderBreadcrumbProps): React.ReactElement {
  const t = useListTheme(theme);
  const crumbs: Array<{ folder: ShelfFolder | null; label: string }> = [{ folder: null, label: rootLabel }, ...path.map((f) => ({ folder: f, label: f.name }))];
  return (
    <ScrollView testID={testID} horizontal showsHorizontalScrollIndicator={false} accessibilityRole="header" style={style} contentContainerStyle={[styles.row, { paddingHorizontal: t.space.lg, paddingVertical: t.space.sm }]}>
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        return (
          <React.Fragment key={c.folder?.id ?? 'root'}>
            {i > 0 ? <Text style={{ color: t.colors.muted, marginHorizontal: t.space.xs, fontSize: t.fontSize.sm }}>/</Text> : null}
            <Pressable accessibilityRole="button" disabled={last || !onPress} onPress={() => onPress?.(c.folder)} hitSlop={6}>
              <Text style={{ color: last ? t.colors.fg : t.colors.accentText, fontSize: t.fontSize.sm, fontFamily: t.fonts.sans }}>{c.label}</Text>
            </Pressable>
          </React.Fragment>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({ row: { alignItems: 'center' } });
