import { lightTheme, darkTheme, createTheme, resolveTheme, loadShelfFonts, SHELF_FONT_NAMES } from '../theme';
import { MissingPeerError } from '../core/peer';

test('light is the default; dark is opt-in; system is followed only when asked', () => {
  expect(resolveTheme(undefined, 'dark')).toBe(lightTheme);
  expect(resolveTheme('light', 'dark')).toBe(lightTheme);
  expect(resolveTheme('dark', 'light')).toBe(darkTheme);
  expect(resolveTheme('system', 'dark')).toBe(darkTheme);
  expect(resolveTheme('system', 'light')).toBe(lightTheme);
  expect(resolveTheme('system', null)).toBe(lightTheme);
});

test('tokens: both palettes define every colour; fonts default to the system font', () => {
  expect(Object.keys(darkTheme.colors).sort()).toEqual(Object.keys(lightTheme.colors).sort());
  expect(lightTheme.colors.bg).toBe('#ffffff');
  expect(darkTheme.colors.bg).toBe('#121210');
  expect(lightTheme.fonts).toEqual({});
});

test('createTheme merges overrides without mutating the base', () => {
  const t = createTheme({ colors: { accent: '#00f' }, fonts: { sans: SHELF_FONT_NAMES.sans } }, darkTheme);
  expect(t.mode).toBe('dark');
  expect(t.colors.accent).toBe('#00f');
  expect(t.colors.bg).toBe(darkTheme.colors.bg);
  expect(t.fonts.sans).toBe('Geist');
  expect(darkTheme.colors.accent).toBe('#facc15');
  expect(darkTheme.fonts).toEqual({});
});

test('loadShelfFonts uses an injected module, else a clear MissingPeerError', async () => {
  const loadAsync = jest.fn(async () => undefined);
  await loadShelfFonts({ Geist: 1 }, { module: { loadAsync } });
  expect(loadAsync).toHaveBeenCalledWith({ Geist: 1 });
  await expect(loadShelfFonts({})).rejects.toBeInstanceOf(MissingPeerError);
  await expect(loadShelfFonts({})).rejects.toThrow(/expo-font/);
});
