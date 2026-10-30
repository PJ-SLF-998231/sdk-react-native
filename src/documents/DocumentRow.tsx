import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import type { ShelfClient } from '../core/client';
import type { ShelfItem } from '../core/types';
import { formatBytes, formatDate } from '../shared/format';
import { useListTheme } from '../shared/states';
import type { ShelfTheme } from '../theme/tokens';
import { Thumbnail } from './Thumbnail';
import type { ThumbnailCache } from './thumbnails';

export const DOCUMENT_ROW_HEIGHT = 72;
export const DOCUMENT_ROW_THUMB = 48;

export interface DocumentItemProps {
  document: ShelfItem;
  onPress?: (document: ShelfItem) => void;
  onLongPress?: (document: ShelfItem) => void;
  client?: ShelfClient;
  thumbnailCache?: ThumbnailCache;
  theme?: ShelfTheme;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const statusLabel = (s: string): string => (s === 'done' || s === 'parsed' ? '' : s === 'failed' || s === 'error' ? 'Could not read' : 'Reading');

/** A fixed-height list row: thumbnail, file name and a one-line summary. */
export const DocumentRow = React.memo(function DocumentRow({ document: doc, onPress, onLongPress, client, thumbnailCache, theme, style, testID }: DocumentItemProps): React.ReactElement {
  const t = useListTheme(theme);
  const status = statusLabel(doc.parse_status);
  const meta = [formatBytes(doc.size_bytes), formatDate(doc.created_at), status].filter(Boolean).join(' · ');
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`${doc.filename}${meta ? `, ${meta}` : ''}`}
      onPress={onPress ? () => onPress(doc) : undefined}
      onLongPress={onLongPress ? () => onLongPress(doc) : undefined}
      style={[styles.row, { height: DOCUMENT_ROW_HEIGHT, paddingHorizontal: t.space.lg, borderBottomColor: t.colors.lineSoft, backgroundColor: t.colors.bg }, style]}
    >
      <Thumbnail document={doc} width={DOCUMENT_ROW_THUMB} height={DOCUMENT_ROW_THUMB} client={client} cache={thumbnailCache} theme={t} />
      <View style={[styles.text, { marginLeft: t.space.md }]}>
        <Text numberOfLines={1} style={{ color: t.colors.fg, fontSize: t.fontSize.md, fontFamily: t.fonts.sans }}>
          {doc.filename}
        </Text>
        <Text numberOfLines={1} style={{ color: t.colors.muted, fontSize: t.fontSize.xs, fontFamily: t.fonts.mono, marginTop: 2 }}>
          {meta}
        </Text>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  text: { flex: 1 },
});
