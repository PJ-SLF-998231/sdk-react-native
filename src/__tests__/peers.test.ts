import type { ShelfMissingPeerError } from '../core/peer';

// The capture peers are optional and not installed in this repo, so a plain require throws exactly as in an app that
// left them out. jest.doMock(..., { virtual: true }) stands in for an installed one.
type Loaders = {
  image: typeof import('../shared/peer-image-picker');
  docs: typeof import('../shared/peer-document-picker');
  scanner: typeof import('../shared/peer-scanner');
  // The error classes of the same module registry as the loaders (isolateModules gives each load its own).
  peer: typeof import('../core/peer');
  shared: typeof import('../shared/peers');
};
function load(mocks: Record<string, () => unknown> = {}): Loaders {
  let out!: Loaders;
  // A fresh registry, so a later doMock of the same package replaces an earlier one. A virtual mock cannot be removed
  // again (jest.dontMock cannot resolve an uninstalled package), so the "missing peers" tests, which need the real
  // absence, run first, before any test mocks a package.
  jest.resetModules();
  jest.isolateModules(() => {
    for (const [name, factory] of Object.entries(mocks)) jest.doMock(name, factory, { virtual: true });
    out = { image: require('../shared/peer-image-picker'), docs: require('../shared/peer-document-picker'), scanner: require('../shared/peer-scanner'), peer: require('../core/peer'), shared: require('../shared/peers') };
  });
  return out;
}

const caught = (fn: () => unknown): ShelfMissingPeerError => {
  try {
    fn();
  } catch (e) {
    return e as ShelfMissingPeerError;
  }
  throw new Error('expected a throw');
};

describe('missing peers', () => {
  test.each([
    ['expo-image-picker', (l: Loaders) => l.image.loadExpoImagePicker(), 'the camera and photo library', 'npx expo install expo-image-picker'],
    ['expo-document-picker', (l: Loaders) => l.docs.loadExpoDocumentPicker(), 'the document picker', 'npx expo install expo-document-picker'],
    [
      'react-native-document-scanner-plugin',
      (l: Loaders) => l.scanner.loadDocumentScanner(),
      'document scanning',
      'npm install react-native-document-scanner-plugin && npx pod-install (needs a development build, not Expo Go)',
    ],
  ])('%s not installed: ShelfMissingPeerError naming the package, the feature and the install command', (pkg, run, feature, install) => {
    const l = load();
    const err = caught(() => run(l));
    expect(err).toBeInstanceOf(l.peer.ShelfMissingPeerError);
    expect(err).toBeInstanceOf(l.peer.MissingPeerError); // older instanceof checks still match
    expect(err.name).toBe('ShelfMissingPeerError');
    expect(err.packageName).toBe(pkg);
    expect(err.peer).toBe(pkg);
    expect(err.installCommand).toBe(install);
    expect(err.message).toBe(
      `@pj-slf-998231/sdk-react-native: ${feature} needs the optional peer "${pkg}", which is not installed. Install it with: ${install}. Or pass your own \`adapter\`.`,
    );
    expect(String((err as { cause?: { message?: string } }).cause?.message)).toMatch(`Cannot find module '${pkg}'`); // the require failure is kept
  });

  test('the feature in the message is the caller\'s', () => {
    expect(caught(() => load().image.loadExpoImagePicker('photo capture')).message).toContain('photo capture needs the optional peer "expo-image-picker"');
  });

});

describe('installed peers', () => {
  test('return the module as it is', () => {
    const picker = { launchCameraAsync: jest.fn() };
    const docs = { getDocumentAsync: jest.fn() };
    const l = load({ 'expo-image-picker': () => picker, 'expo-document-picker': () => docs });
    expect(l.image.loadExpoImagePicker()).toBe(picker);
    expect(l.docs.loadExpoDocumentPicker()).toBe(docs);
  });

  test("the scanner's default export is unwrapped; a module without one is used as it is", () => {
    const scanner = { scanDocument: jest.fn() };
    expect(load({ 'react-native-document-scanner-plugin': () => ({ __esModule: true, default: scanner }) }).scanner.loadDocumentScanner()).toBe(scanner);
    expect(load({ 'react-native-document-scanner-plugin': () => scanner }).scanner.loadDocumentScanner()).toBe(scanner);
  });
});

describe('a peer that resolves to nothing', () => {
  test('is missing too, without a cause', () => {
    const l = load({ 'expo-document-picker': () => null });
    const err = caught(() => l.docs.loadExpoDocumentPicker());
    expect(err).toBeInstanceOf(l.peer.ShelfMissingPeerError);
    expect(err.packageName).toBe('expo-document-picker');
    expect((err as { cause?: unknown }).cause).toBeUndefined();
  });
});

describe('missingPeer', () => {
  test('defaults the install command to npx expo install and keeps a cause only when given', () => {
    const { missingPeer } = load().shared;
    const plain = missingPeer('expo-sqlite', 'the SQLite cache');
    expect(plain.installCommand).toBe('npx expo install expo-sqlite');
    expect('cause' in plain).toBe(false);
    const cause = new Error('Cannot find module');
    expect((missingPeer('expo-sqlite', 'x', 'npm i expo-sqlite', cause) as { cause?: unknown }).cause).toBe(cause);
  });
});
