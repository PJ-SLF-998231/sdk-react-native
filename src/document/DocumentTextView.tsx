import React, { useMemo } from 'react';
import { FlatList, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useDocumentText } from '../hooks/useDocument';
import type { ShelfConnectionProps } from '../provider';
import { ListState, useListTheme } from '../shared/states';
import type { ShelfTheme } from '../theme/tokens';
import { chunkText, DEFAULT_CHUNK_CHARS } from './textChunks';
import type { TextChunk } from './textChunks';

export interface DocumentTextViewProps extends ShelfConnectionProps {
  documentId: string;
  /** Characters per rendered chunk. Default 3000. */
  chunkChars?: number;
  /** Text size in dp before the user's font scale. Defaults to the theme's md. */
  fontSize?: number;
  theme?: ShelfTheme;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const isDone = (s: string | undefined): boolean => s === 'done' || s === 'parsed';
const isFailed = (s: string | undefined): boolean => s === 'failed' || s === 'error';

/**
 * The document's extracted text, selectable and scaling with the system font size. It is cut into chunks drawn by a
 * virtualised list, so a very long text mounts a screenful of rows rather than one giant text node.
 */
export function DocumentTextView({ documentId, chunkChars = DEFAULT_CHUNK_CHARS, fontSize, theme, style, testID, ...conn }: DocumentTextViewProps): React.ReactElement {
  const t = useListTheme(theme);
  const { text, document: doc, loading, error, offline, refresh } = useDocumentText(documentId, conn);
  const chunks = useMemo(() => chunkText(text, chunkChars), [text, chunkChars]);
  const multiPage = useMemo(() => chunks.some((c) => c.page > 1), [chunks]);

  if (!doc) {
    if (loading) return <ListState kind="loading" testID={testID} title="Loading text" theme={t} style={style} />;
    if (error) return <ListState kind="error" testID={testID} title={offline ? 'You are offline' : "Couldn't load the text"} onRetry={() => void refresh()} theme={t} style={style} />;
    return <ListState kind="loading" testID={testID} title="Loading text" theme={t} style={style} />;
  }
  if (chunks.length === 0) {
    if (isFailed(doc.parse_status)) return <ListState kind="error" testID={testID} title="Text couldn't be read" message="This document could not be read." theme={t} style={style} />;
    if (!isDone(doc.parse_status)) return <ListState kind="loading" testID={testID} title="Reading the document" message="The text will appear when it has been read." theme={t} style={style} />;
    return <ListState kind="empty" testID={testID} title="No text" message="No text was found in this document." theme={t} style={style} />;
  }
  const size = fontSize ?? t.fontSize.md;
  return (
    <FlatList<TextChunk>
      testID={testID ?? 'document-text'}
      style={style}
      data={chunks}
      keyExtractor={(c) => c.key}
      initialNumToRender={6}
      maxToRenderPerBatch={8}
      windowSize={7}
      contentContainerStyle={{ padding: t.space.lg }}
      renderItem={({ item }) => (
        <View>
          {multiPage && item.pageStart ? (
            <Text accessibilityRole="header" style={{ color: t.colors.muted, fontSize: t.fontSize.xs, fontFamily: t.fonts.sans, marginTop: t.space.md, marginBottom: t.space.xs }}>{`Page ${item.page}`}</Text>
          ) : null}
          <Text selectable style={{ color: t.colors.fg, fontSize: size, lineHeight: Math.round(size * 1.5), fontFamily: t.fonts.sans }}>
            {item.text}
          </Text>
        </View>
      )}
    />
  );
}
