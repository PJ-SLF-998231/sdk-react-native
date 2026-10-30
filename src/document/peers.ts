import type React from "react";
// Metro resolves these literal `require`s at bundle time; see scripts/fix-optional-requires.mjs.
declare const require: (id: string) => any;

/** The slice of react-native-gesture-handler and react-native-reanimated the pinch/pan zoom uses. */
export interface ZoomLibs {
  Gesture: any;
  GestureDetector: React.ComponentType<any>;
  Animated: { View: React.ComponentType<any> };
  useSharedValue: (v: number) => { value: number };
  useAnimatedStyle: (fn: () => object) => object;
  withTiming: (v: number) => number;
}

let cached: ZoomLibs | null | undefined;

/**
 * Both libraries, or null when either is not installed (the preview then shows the plain image). Optional peers:
 * this never throws, because zoom is an enhancement, not a requirement.
 */
export function loadZoomLibs(): ZoomLibs | null {
  if (cached !== undefined) return cached;
  try {
    const gh = require('react-native-gesture-handler');
    const rea = require('react-native-reanimated');
    const Animated = rea?.default ?? rea;
    cached = gh?.Gesture && gh?.GestureDetector && Animated?.View && rea?.useSharedValue && rea?.useAnimatedStyle && rea?.withTiming
      ? { Gesture: gh.Gesture, GestureDetector: gh.GestureDetector, Animated, useSharedValue: rea.useSharedValue, useAnimatedStyle: rea.useAnimatedStyle, withTiming: rea.withTiming }
      : null;
  } catch {
    cached = null;
  }
  return cached;
}

/** Test hook: forget the cached probe. */
export function resetZoomLibsForTests(): void {
  cached = undefined;
}
