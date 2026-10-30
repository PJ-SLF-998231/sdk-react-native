import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useShelfContext } from '../provider';
import { lightTheme } from '../theme/tokens';
import type { ShelfTheme } from '../theme/tokens';
import { useCaptureUpload } from './useCaptureUpload';
import type { UseCaptureUploadOptions } from './useCaptureUpload';
import type { CaptureState } from './types';

export type GlyphName = 'camera' | 'scan' | 'document' | 'image';

/** What a render-prop child receives to draw the button face itself. */
export interface CaptureFaceProps {
  onPress: () => void;
  state: CaptureState;
  disabled: boolean;
}

export interface CaptureButtonProps extends UseCaptureUploadOptions {
  /** Replace the label (a node), or draw the whole face with a render prop. */
  children?: React.ReactNode | ((face: CaptureFaceProps) => React.ReactNode);
  label?: string;
  /** Replace the default icon. `null` hides it. */
  icon?: React.ReactNode | null;
  disabled?: boolean;
  /** Text under the button when a permission was denied. */
  deniedMessage?: string;
  /** Hide the built-in denied notice (use `state` from a render prop or the hook instead). */
  hideDenied?: boolean;
  /** Show the failure message under the button (default true). */
  showError?: boolean;
  theme?: ShelfTheme;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  testID?: string;
}

/** Internal: the shared button, specialised by CameraButton, DocumentPickerButton and PhotoLibraryButton. */
export function CaptureButton(props: CaptureButtonProps & { glyph: GlyphName; defaultLabel: string; defaultDenied: string }): React.ReactElement {
  const ctx = useShelfContext();
  const t = props.theme ?? ctx?.theme ?? lightTheme;
  const c = t.colors;
  const { capture, state, denied, canAskAgain, openSettings, dismiss, error } = useCaptureUpload(props);
  const busy = state === 'busy';
  const disabled = Boolean(props.disabled) || busy;
  const label = props.label ?? props.defaultLabel;
  const onPress = () => {
    void capture();
  };

  const face =
    typeof props.children === 'function' ? (
      props.children({ onPress, state, disabled })
    ) : (
      <Pressable
        testID={props.testID}
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel ?? label}
        accessibilityState={{ disabled, busy }}
        disabled={disabled}
        onPress={onPress}
        style={[
          styles.button,
          { backgroundColor: c.accent, borderRadius: t.radius.md, paddingVertical: t.space.md, paddingHorizontal: t.space.lg, opacity: disabled && !busy ? 0.5 : 1 },
          props.style,
        ]}
      >
        {busy ? <ActivityIndicator color={c.accentInk} /> : props.icon === null ? null : (props.icon ?? <Glyph name={props.glyph} color={c.accentInk} />)}
        {props.children ?? <Text style={{ color: c.accentInk, fontSize: t.fontSize.md, fontFamily: t.fonts.sans, fontWeight: '600' }}>{label}</Text>}
      </Pressable>
    );

  return (
    <View>
      {face}
      {denied && !props.hideDenied ? (
        <View
          testID={props.testID ? `${props.testID}-denied` : undefined}
          accessibilityRole="alert"
          style={[styles.notice, { backgroundColor: c.bgSoft, borderColor: c.line, borderRadius: t.radius.md, padding: t.space.md, marginTop: t.space.sm }]}
        >
          <Text style={{ color: c.fg, fontSize: t.fontSize.sm, fontFamily: t.fonts.sans }}>
            {props.deniedMessage ?? props.defaultDenied}
            {canAskAgain ? ' Tap the button to try again, or open Settings.' : ' Turn it on in Settings, then come back.'}
          </Text>
          <View style={[styles.row, { marginTop: t.space.sm, gap: t.space.sm }]}>
            <Pressable accessibilityRole="button" accessibilityLabel="Open Settings" onPress={() => void openSettings()} style={[styles.small, { backgroundColor: c.accent, borderRadius: t.radius.sm }]}>
              <Text style={{ color: c.accentInk, fontSize: t.fontSize.sm, fontFamily: t.fonts.sans, fontWeight: '600' }}>Open Settings</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Not now" onPress={dismiss} style={[styles.small, { borderColor: c.line, borderWidth: 1, borderRadius: t.radius.sm }]}>
              <Text style={{ color: c.fg, fontSize: t.fontSize.sm, fontFamily: t.fonts.sans }}>Not now</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {state === 'error' && error && props.showError !== false ? (
        <Text accessibilityRole="alert" style={{ color: c.danger, fontSize: t.fontSize.sm, fontFamily: t.fonts.sans, marginTop: t.space.sm }}>
          {error.message}
        </Text>
      ) : null}
    </View>
  );
}

/** Tiny View-drawn icons, so the entries need no icon font or SVG peer. */
function Glyph({ name, color }: { name: GlyphName; color: string }): React.ReactElement {
  const box = { width: 18, height: 18, borderColor: color, borderWidth: 2 } as const;
  if (name === 'scan') return <View accessibilityElementsHidden importantForAccessibility="no" style={[box, { borderStyle: 'dashed', borderRadius: 3 }]} />;
  if (name === 'document') return <View accessibilityElementsHidden importantForAccessibility="no" style={[box, { width: 14, borderRadius: 2 }]} />;
  if (name === 'image') return <View accessibilityElementsHidden importantForAccessibility="no" style={[box, { borderRadius: 3 }]} />;
  return (
    <View accessibilityElementsHidden importantForAccessibility="no" style={[box, { borderRadius: 5, alignItems: 'center', justifyContent: 'center' }]}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
    </View>
  );
}

const styles = StyleSheet.create({
  button: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  notice: { borderWidth: 1 },
  row: { flexDirection: 'row' },
  small: { paddingVertical: 6, paddingHorizontal: 12 },
});
