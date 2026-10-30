import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useShelfContext } from '../provider';
import { lightTheme } from '../theme/tokens';
import type { ShelfTheme } from '../theme/tokens';
import type { OutboxItem, OutboxState } from './outbox';
import { useOnlineStatus } from './useOutbox';

function useTheme(override?: ShelfTheme): ShelfTheme {
  const ctx = useShelfContext();
  return override ?? ctx?.theme ?? lightTheme;
}

export function uploadStatusLabel(state: OutboxState, progress = 0, attempts = 0): string {
  if (state === 'uploading') return progress > 0 && progress < 1 ? `Uploading ${Math.round(progress * 100)}%` : 'Uploading';
  if (state === 'done') return 'Uploaded';
  if (state === 'failed') return 'Failed';
  return attempts > 0 ? 'Retrying' : 'Waiting';
}

export interface UploadStatusBadgeProps {
  /** An outbox item, or give `state` (+ `progress`) directly. */
  item?: Pick<OutboxItem, 'state' | 'progress' | 'attempts'>;
  state?: OutboxState;
  progress?: number;
  theme?: ShelfTheme;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** A small status pill: a dot and a label. Waiting is dashed, uploading and done use the accent, failed the danger colour. */
export function UploadStatusBadge({ item, state, progress, theme, style, testID }: UploadStatusBadgeProps): React.ReactElement {
  const t = useTheme(theme);
  const s = item?.state ?? state ?? 'pending';
  const label = uploadStatusLabel(s, item?.progress ?? progress, item?.attempts);
  const c = t.colors;
  const tone =
    s === 'failed'
      ? { text: c.danger, border: c.danger, bg: c.bg, dashed: false }
      : s === 'pending'
        ? { text: c.accentText, border: c.accentText, bg: c.bgSoft, dashed: true }
        : s === 'done'
          ? { text: c.accentText, border: c.accent, bg: c.bg, dashed: false }
          : { text: c.accentText, border: c.accent, bg: c.bg, dashed: false };
  return (
    <View
      testID={testID}
      accessibilityLabel={`Upload: ${label}`}
      style={[
        styles.pill,
        { backgroundColor: tone.bg, borderColor: tone.border, borderStyle: tone.dashed ? 'dashed' : 'solid', paddingVertical: t.space.xs, paddingHorizontal: t.space.md },
        style,
      ]}
    >
      <View style={[styles.dot, { backgroundColor: tone.text }]} />
      <Text style={{ color: tone.text, fontSize: t.fontSize.xs, fontFamily: t.fonts.mono, textTransform: 'uppercase', letterSpacing: 0.6 }}>{label}</Text>
    </View>
  );
}

export interface OfflineBannerProps {
  /** Omit to read it from netinfo (useOnlineStatus). */
  online?: boolean;
  /** Uploads waiting; shown in the message. */
  pendingCount?: number;
  /** Set when the outbox is paused because the key was revoked. */
  pauseReason?: 'auth' | 'manual' | null;
  theme?: ShelfTheme;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Shows when the device is offline (or uploads are paused after a revoked key). Renders nothing otherwise. */
export function OfflineBanner(props: OfflineBannerProps): React.ReactElement | null {
  const t = useTheme(props.theme);
  const status = useOnlineStatus();
  const online = props.online ?? status.online;
  const authPaused = props.pauseReason === 'auth';
  if (online && !authPaused) return null;
  const n = props.pendingCount ?? 0;
  const message = authPaused
    ? 'Uploads are paused because the connection to Shelf is no longer authorised.'
    : n > 0
      ? `You are offline. ${n} upload${n === 1 ? '' : 's'} will continue when you reconnect.`
      : 'You are offline. Uploads will continue when you reconnect.';
  const c = t.colors;
  const bar = authPaused ? c.danger : c.accentText;
  return (
    <View
      testID={props.testID}
      accessibilityRole="alert"
      style={[styles.banner, { backgroundColor: c.bgSoft, borderColor: c.line, borderRadius: t.radius.md, paddingVertical: t.space.md, paddingRight: t.space.lg, paddingLeft: t.space.lg + 3 }, props.style]}
    >
      <View style={[styles.bar, { backgroundColor: bar }]} />
      <Text style={{ color: c.fg, fontSize: t.fontSize.sm, fontFamily: t.fonts.sans }}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6, borderWidth: 1, borderRadius: 999 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  banner: { overflow: 'hidden', borderWidth: 1 },
  bar: { position: 'absolute', top: 0, bottom: 0, left: 0, width: 3 },
});
