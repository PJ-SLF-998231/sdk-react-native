import React from 'react';
import { Image } from 'react-native';
import type { ImageSourcePropType } from 'react-native';
import type { ZoomLibs } from './peers';

/**
 * Pinch to zoom (1x to 5x), drag to pan while zoomed, double-tap to reset. It needs the host app to render inside a
 * GestureHandlerRootView (react-native-gesture-handler's requirement), which is the host's setup, not the SDK's.
 */
export function ZoomableImage({ libs, source, width, height }: { libs: ZoomLibs; source: ImageSourcePropType; width: number; height: number }): React.ReactElement {
  const { Gesture, GestureDetector, Animated, useSharedValue, useAnimatedStyle, withTiming } = libs;
  const scale = useSharedValue(1);
  const saved = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const sx = useSharedValue(0);
  const sy = useSharedValue(0);
  const pinch = Gesture.Pinch()
    .onUpdate((e: { scale: number }) => {
      scale.value = Math.min(5, Math.max(1, saved.value * e.scale));
    })
    .onEnd(() => {
      saved.value = scale.value;
    });
  const pan = Gesture.Pan()
    .onUpdate((e: { translationX: number; translationY: number }) => {
      if (scale.value <= 1) return;
      x.value = sx.value + e.translationX;
      y.value = sy.value + e.translationY;
    })
    .onEnd(() => {
      sx.value = x.value;
      sy.value = y.value;
    });
  const reset = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      scale.value = withTiming(1);
      saved.value = 1;
      x.value = withTiming(0);
      y.value = withTiming(0);
      sx.value = 0;
      sy.value = 0;
    });
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }] }));
  return (
    <GestureDetector gesture={Gesture.Simultaneous(pinch, pan, reset)}>
      <Animated.View testID="preview-zoom" style={[{ width, height }, style]}>
        <Image source={source} style={{ width, height }} resizeMode="contain" accessibilityIgnoresInvertColors />
      </Animated.View>
    </GestureDetector>
  );
}
