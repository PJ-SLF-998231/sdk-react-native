import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, Linking, Pressable, Text, View, useWindowDimensions } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import type { AuthedSource, PreviewSize, ShelfDocument } from '../core/types';
import { useDocument } from '../hooks/useDocument';
import { useShelf } from '../provider';
import type { ShelfConnectionProps } from '../provider';
import { ListState, useListTheme } from '../shared/states';
import type { ShelfTheme } from '../theme/tokens';
import { loadZoomLibs } from './peers';
import { ZoomableImage } from './ZoomableImage';

const SIZE_ORDER: PreviewSize[] = ['small', 'medium', 'large'];

/** The sizes a document has, smallest first (unknown names ignored). */
export const availablePreviewSizes = (doc: Pick<ShelfDocument, 'preview_sizes'> | undefined): PreviewSize[] => SIZE_ORDER.filter((s) => doc?.preview_sizes?.includes(s));

/** Medium when there is one (sharp on a phone without a 2000 px download), else the largest available. */
export function defaultPreviewSize(available: readonly PreviewSize[]): PreviewSize | null {
  if (available.length === 0) return null;
  return available.includes('medium') ? 'medium' : (available[available.length - 1] as PreviewSize);
}

export interface DocumentPreviewProps extends ShelfConnectionProps {
  documentId: string;
  /** Rendition to show; unavailable names fall back to the default. Uncontrolled (the user's choice) when omitted. */
  size?: PreviewSize;
  /** List the document's `preview_sizes` as a selector under the picture. Default false. */
  showSizes?: boolean;
  onSizeChange?: (size: PreviewSize) => void;
  /** Pinch and pan when react-native-gesture-handler and react-native-reanimated are installed. Default true. */
  zoom?: boolean;
  theme?: ShelfTheme;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * The document's picture from the thumbnail endpoint at the chosen size, fetched with the client's credentials. A
 * document with no rendition (a type that cannot be previewed) shows a message and a way to open the original.
 */
export function DocumentPreview({ documentId, size, showSizes = false, onSizeChange, zoom = true, theme, style, testID, ...conn }: DocumentPreviewProps): React.ReactElement {
  const t = useListTheme(theme);
  const shelf = useShelf(conn);
  const { data: doc, loading, error, offline, refresh } = useDocument(documentId, { shelf });
  const available = useMemo(() => availablePreviewSizes(doc), [doc]);
  const [picked, setPicked] = useState<PreviewSize | null>(null);
  const wanted = size ?? picked;
  const current = wanted && available.includes(wanted) ? wanted : defaultPreviewSize(available);
  const [source, setSource] = useState<AuthedSource | null>(null);
  const [failed, setFailed] = useState(false);
  const [fetchError, setFetchError] = useState(false);
  const { width: winW, height: winH } = useWindowDimensions();
  const editedKey = doc ? `${doc.edited_at ?? doc.parsed_at ?? doc.created_at}` : '';

  useEffect(() => {
    setSource(null);
    setFailed(false);
    setFetchError(false);
    if (!current) return;
    let live = true;
    shelf.client.authedSource(shelf.client.thumbnailUrl(documentId, current)).then(
      (s) => live && setSource(s),
      () => live && setFetchError(true),
    );
    return () => {
      live = false;
    };
  }, [shelf.client, documentId, current, editedKey]);

  const openOriginal = () => {
    if (!doc) return;
    Linking.openURL(doc.download_url ?? shelf.client.originalUrl(doc.id, doc.filename)).catch(() => undefined);
  };
  const OpenButton = doc ? (
    <Pressable accessibilityRole="button" onPress={openOriginal} testID="preview-open-original" style={{ marginTop: t.space.md, paddingVertical: t.space.sm, paddingHorizontal: t.space.lg, borderRadius: t.radius.md, backgroundColor: t.colors.accent, alignSelf: 'center' }}>
      <Text style={{ color: t.colors.accentInk, fontSize: t.fontSize.sm, fontFamily: t.fonts.sans }}>Open original</Text>
    </Pressable>
  ) : null;

  if (!doc) {
    if (error) return <ListState kind="error" testID={testID} title={offline ? 'You are offline' : "Couldn't load the preview"} onRetry={() => void refresh()} theme={t} style={style} />;
    return <ListState kind="loading" testID={testID} title="Loading preview" theme={t} style={style} />;
  }
  if (!current || failed || fetchError) {
    return (
      <View testID={testID ?? 'document-preview'} style={[{ alignItems: 'center', padding: t.space.xl }, style]}>
        <Text style={{ color: t.colors.fg, fontSize: t.fontSize.md, fontFamily: t.fonts.sans, textAlign: 'center' }}>{!current ? 'No preview for this file' : "Couldn't load the preview"}</Text>
        <Text style={{ color: t.colors.muted, fontSize: t.fontSize.sm, fontFamily: t.fonts.sans, textAlign: 'center', marginTop: t.space.xs }}>
          {!current ? 'This type of file cannot be previewed here. You can open the original.' : 'You can still open the original.'}
        </Text>
        {OpenButton}
      </View>
    );
  }
  const w = winW;
  const h = Math.round(winH * 0.6);
  const imgSource = source ? { uri: source.uri, headers: source.headers } : null;
  const libs = zoom ? loadZoomLibs() : null;
  return (
    <View testID={testID ?? 'document-preview'} style={[{ alignItems: 'center' }, style]}>
      <View style={{ width: w, height: h, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', backgroundColor: t.colors.bgSoft }}>
        {!imgSource ? (
          <ActivityIndicator color={t.colors.accentText} accessibilityLabel="Loading" />
        ) : libs ? (
          <ZoomableImage libs={libs} source={imgSource} width={w} height={h} />
        ) : (
          <Image testID="preview-image" source={imgSource} style={{ width: w, height: h }} resizeMode="contain" accessibilityLabel={doc.filename} onError={() => setFailed(true)} />
        )}
      </View>
      {showSizes && available.length > 0 ? (
        <View accessibilityRole="radiogroup" testID="preview-sizes" style={{ flexDirection: 'row', marginTop: t.space.md }}>
          {available.map((s) => {
            const on = s === current;
            return (
              <Pressable
                key={s}
                testID={`preview-size-${s}`}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                onPress={() => {
                  setPicked(s);
                  onSizeChange?.(s);
                }}
                style={{ paddingVertical: t.space.sm, paddingHorizontal: t.space.lg, marginHorizontal: t.space.xs, borderRadius: t.radius.md, backgroundColor: on ? t.colors.accent : t.colors.bgSoft }}
              >
                <Text style={{ color: on ? t.colors.accentInk : t.colors.fg, fontSize: t.fontSize.sm, fontFamily: t.fonts.sans }}>{s[0]?.toUpperCase() + s.slice(1)}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {OpenButton}
    </View>
  );
}
