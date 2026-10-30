import React, { useEffect, useState } from 'react';
import { Image, PixelRatio, StyleSheet, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import type { ShelfClient } from '../core/client';
import type { ShelfItem } from '../core/types';
import { useShelfContext } from '../provider';
import { extensionOf } from '../shared/format';
import { useListTheme } from '../shared/states';
import type { ShelfTheme } from '../theme/tokens';
import { getDefaultThumbnailCache, pickPreviewSize, thumbnailKey } from './thumbnails';
import type { ThumbSource, ThumbnailCache } from './thumbnails';

export interface ThumbnailProps {
  document: Pick<ShelfItem, 'id' | 'filename' | 'preview_sizes'> & Partial<Pick<ShelfItem, 'edited_at' | 'parsed_at' | 'created_at'>>;
  /** Displayed width and height in dp; picks the smallest rendition that covers it at the device pixel ratio. */
  width: number;
  height: number;
  client?: ShelfClient;
  cache?: ThumbnailCache;
  theme?: ShelfTheme;
  style?: StyleProp<ViewStyle>;
  /** Override the device pixel ratio (tests). */
  pixelRatio?: number;
}

/**
 * Loads its picture only once it is mounted (a windowed list mounts only nearby rows, so off-screen rows load nothing),
 * from the on-disk cache when it has it, else downloads the right rendition once and caches it. Shows the file
 * extension on a plain tile until the picture is there, or when the document has no preview.
 */
export function Thumbnail({ document: doc, width, height, client: given, cache, theme, style, pixelRatio }: ThumbnailProps): React.ReactElement {
  const t = useListTheme(theme);
  const ctx = useShelfContext();
  const client = given ?? ctx?.client;
  const [source, setSource] = useState<ThumbSource | null>(null);
  const [failed, setFailed] = useState(false);
  const ratio = pixelRatio ?? PixelRatio.get();
  const size = pickPreviewSize(doc.preview_sizes, Math.max(width, height) * ratio);
  const key = size ? thumbnailKey(doc, size) : null;

  useEffect(() => {
    setSource(null);
    setFailed(false);
    if (!client || !size || !key) return;
    let live = true;
    const store = cache ?? getDefaultThumbnailCache();
    (async () => {
      const hit = await store.get(key);
      if (hit) return hit;
      const authed = await client.authedSource(client.thumbnailUrl(doc.id, size));
      return store.put(key, authed);
    })().then(
      (s) => live && setSource(s),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [client, cache, doc.id, size, key]);

  const ext = extensionOf(doc.filename);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.tile, { width, height, borderRadius: t.radius.sm, backgroundColor: t.colors.bgSoft, borderColor: t.colors.lineSoft }, style]}
    >
      {source && !failed ? (
        <Image source={source.headers ? { uri: source.uri, headers: source.headers } : { uri: source.uri }} style={{ width, height }} resizeMode="cover" onError={() => setFailed(true)} />
      ) : (
        <Text style={{ color: t.colors.muted, fontSize: t.fontSize.xs, fontFamily: t.fonts.mono }}>{ext || 'FILE'}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({ tile: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth } });
