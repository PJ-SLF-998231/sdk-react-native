import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useShelfContext } from '../provider';
import { lightTheme } from '../theme/tokens';
import type { ShelfTheme } from '../theme/tokens';

export function useListTheme(override?: ShelfTheme): ShelfTheme {
  const ctx = useShelfContext();
  return override ?? ctx?.theme ?? lightTheme;
}

export interface ListStateProps {
  kind: 'loading' | 'empty' | 'error';
  title?: string;
  message?: string;
  onRetry?: () => void;
  theme?: ShelfTheme;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** The loading / empty / error panel shared by the folder and document lists. */
export function ListState({ kind, title, message, onRetry, theme, style, testID }: ListStateProps): React.ReactElement {
  const t = useListTheme(theme);
  const c = t.colors;
  return (
    <View testID={testID} accessibilityRole={kind === 'error' ? 'alert' : undefined} accessibilityLiveRegion="polite" style={[styles.box, { padding: t.space.xl }, style]}>
      {kind === 'loading' ? <ActivityIndicator color={c.accentText} accessibilityLabel="Loading" /> : null}
      {title ? <Text style={{ color: kind === 'error' ? c.danger : c.fg, fontSize: t.fontSize.md, fontFamily: t.fonts.sans, textAlign: 'center' }}>{title}</Text> : null}
      {message ? <Text style={{ color: c.muted, fontSize: t.fontSize.sm, fontFamily: t.fonts.sans, textAlign: 'center', marginTop: t.space.xs }}>{message}</Text> : null}
      {onRetry ? (
        <Pressable accessibilityRole="button" onPress={onRetry} style={{ marginTop: t.space.md, paddingVertical: t.space.sm, paddingHorizontal: t.space.lg, borderRadius: t.radius.md, backgroundColor: c.accent }}>
          <Text style={{ color: c.accentInk, fontSize: t.fontSize.sm, fontFamily: t.fonts.sans }}>Try again</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({ box: { alignItems: 'center', justifyContent: 'center' } });
