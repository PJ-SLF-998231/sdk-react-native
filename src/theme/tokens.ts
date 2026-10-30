/** Design tokens mirroring the web SDK's palette (styles.css), as React Native style values. */
export interface ShelfColors {
  accent: string;
  accentInk: string;
  accentText: string;
  bg: string;
  bgSoft: string;
  fg: string;
  fgSoft: string;
  muted: string;
  line: string;
  lineSoft: string;
  danger: string;
  ctaAccent: string;
}

/**
 * Font families by role. The host owns fonts: the defaults are `undefined`, which React Native renders with the
 * platform system font. Load fonts (see `loadShelfFonts`) and set the family names you registered.
 */
export interface ShelfFonts {
  sans?: string;
  serif?: string;
  mono?: string;
}

export interface ShelfTheme {
  mode: 'light' | 'dark';
  colors: ShelfColors;
  fonts: ShelfFonts;
  radius: { sm: number; md: number; lg: number };
  /** 4-point spacing scale. */
  space: { xs: number; sm: number; md: number; lg: number; xl: number };
  fontSize: { xs: number; sm: number; md: number; lg: number; xl: number };
}

/** Family names the web SDK ships; use them with `loadShelfFonts` if you bundle those font files. */
export const SHELF_FONT_NAMES = { sans: 'Geist', serif: 'Instrument Serif', mono: 'Geist Mono' } as const;

const shared = {
  fonts: {} as ShelfFonts,
  radius: { sm: 6, md: 10, lg: 16 },
  space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
  fontSize: { xs: 12, sm: 14, md: 16, lg: 20, xl: 28 },
};

export const lightTheme: ShelfTheme = {
  mode: 'light',
  colors: {
    accent: '#eab308',
    accentInk: '#1c1500',
    accentText: '#866300',
    bg: '#ffffff',
    bgSoft: '#f7f7f6',
    fg: '#14140f',
    fgSoft: '#57564c',
    muted: '#6e6d64',
    line: 'rgba(20, 20, 15, 0.12)',
    lineSoft: 'rgba(20, 20, 15, 0.07)',
    danger: '#b91c1c',
    ctaAccent: '#eab308',
  },
  ...shared,
};

export const darkTheme: ShelfTheme = {
  mode: 'dark',
  colors: {
    accent: '#facc15',
    accentInk: '#171300',
    accentText: '#facc15',
    bg: '#121210',
    bgSoft: '#1a1a17',
    fg: '#f3f2ea',
    fgSoft: '#a8a79c',
    muted: '#8e8d86',
    line: 'rgba(255, 255, 255, 0.12)',
    lineSoft: 'rgba(255, 255, 255, 0.07)',
    danger: '#f87171',
    ctaAccent: '#866300',
  },
  ...shared,
};

export type ThemeOverrides = {
  colors?: Partial<ShelfColors>;
  fonts?: ShelfFonts;
  radius?: Partial<ShelfTheme['radius']>;
  space?: Partial<ShelfTheme['space']>;
  fontSize?: Partial<ShelfTheme['fontSize']>;
};

/** `base` (light by default) with `overrides` merged in. */
export function createTheme(overrides: ThemeOverrides = {}, base: ShelfTheme = lightTheme): ShelfTheme {
  return {
    mode: base.mode,
    colors: { ...base.colors, ...overrides.colors },
    fonts: { ...base.fonts, ...overrides.fonts },
    radius: { ...base.radius, ...overrides.radius },
    space: { ...base.space, ...overrides.space },
    fontSize: { ...base.fontSize, ...overrides.fontSize },
  };
}

/** What the host asks for. Absent means light: the SDK never follows the device setting unless told to. */
export type ThemeMode = 'light' | 'dark' | 'system';

/**
 * Picks the base theme. 'system' is the explicit opt-in to follow the device; pass its current scheme
 * (React Native's `useColorScheme()`), which is ignored for 'light' and 'dark'.
 */
export function resolveTheme(mode: ThemeMode | undefined, systemScheme?: 'light' | 'dark' | null): ShelfTheme {
  if (mode === 'dark') return darkTheme;
  if (mode === 'system' && systemScheme === 'dark') return darkTheme;
  return lightTheme;
}
