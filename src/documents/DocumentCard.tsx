import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { formatBytes } from '../shared/format';
import { useListTheme } from '../shared/states';
import type { DocumentItemProps } from './DocumentRow';
import { Thumbnail } from './Thumbnail';

export const DOCUMENT_CARD_HEIGHT = 200;
export const DOCUMENT_CARD_THUMB_HEIGHT = 132;

export interface DocumentCardProps extends DocumentItemProps {
  /** Card width in dp (thumbnail width). The list passes its column width. Default 150. */
  width?: number;
}

/** A grid card: a large thumbnail over the file name and size. Fixed height so the list can compute layouts. */
export const DocumentCard = React.memo(function DocumentCard({ document: doc, onPress, onLongPress, client, thumbnailCache, theme, style, testID, width = 150 }: DocumentCardProps): React.ReactElement {
  const t = useListTheme(theme);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={doc.filename}
      onPress={onPress ? () => onPress(doc) : undefined}
      onLongPress={onLongPress ? () => onLongPress(doc) : undefined}
      style={[styles.card, { width, height: DOCUMENT_CARD_HEIGHT, borderRadius: t.radius.md, borderColor: t.colors.line, backgroundColor: t.colors.bg }, style]}
    >
      <Thumbnail document={doc} width={width - 2} height={DOCUMENT_CARD_THUMB_HEIGHT} client={client} cache={thumbnailCache} theme={t} style={{ borderRadius: 0 }} />
      <Text numberOfLines={2} style={{ color: t.colors.fg, fontSize: t.fontSize.sm, fontFamily: t.fonts.sans, margin: t.space.sm, marginBottom: 0 }}>
        {doc.filename}
      </Text>
      <Text numberOfLines={1} style={{ color: t.colors.muted, fontSize: t.fontSize.xs, fontFamily: t.fonts.mono, marginHorizontal: t.space.sm }}>
        {formatBytes(doc.size_bytes)}
      </Text>
    </Pressable>
  );
});

const styles = StyleSheet.create({ card: { borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' } });
