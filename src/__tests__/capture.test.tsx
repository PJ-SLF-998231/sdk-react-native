import React from 'react';
import { Linking, Text } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { CameraButton, createPhotoCaptureAdapter, createScanAdapter, useCaptureUpload } from '../camera';
import type { CaptureAdapter, CapturedFile, UseCaptureUploadResult } from '../camera';
import { DocumentPickerButton, PhotoLibraryButton, createDocumentPickerAdapter, createPhotoLibraryAdapter } from '../picker';
import { MissingPeerError, ShelfMissingPeerError } from '../core/peer';
import { ShelfPermissionDeniedError } from '../shared/errors';
import { createOutbox } from '../upload';
import { createShelfClient } from '../core';
import { darkTheme } from '../theme';
import { item as apiItem, mockFetch, tick } from './helpers';

beforeAll(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined); // netinfo is not installed here
});

const photo: CapturedFile = { uri: 'file:///cache/photo-1.jpg', name: 'photo-1.jpg', type: 'image/jpeg' };
const adapterOf = (files: CapturedFile[]): CaptureAdapter & { capture: jest.Mock } => ({ capture: jest.fn(async () => files) });
const pressAsync = (el: Parameters<typeof fireEvent.press>[0]) =>
  act(async () => {
    fireEvent.press(el);
  });
const hang = (() => new Promise(() => undefined)) as unknown as typeof fetch;
const mkClient = (f: typeof fetch = hang) => createShelfClient({ baseUrl: 'https://y.test', fetch: f });

function withFormData<T>(run: (appended: [string, unknown][]) => Promise<T>): Promise<T> {
  const appended: [string, unknown][] = [];
  const g = globalThis as unknown as { FormData: unknown };
  const Real = g.FormData;
  g.FormData = class {
    append(k: string, v: unknown) {
      appended.push([k, v]);
    }
  };
  return run(appended).finally(() => {
    g.FormData = Real;
  });
}

describe('snapshots', () => {
  test('CameraButton idle (photo, scan, dark theme)', () => {
    const tree = render(
      <>
        <CameraButton client={mkClient()} adapter={adapterOf([])} />
        <CameraButton client={mkClient()} mode="scan" adapter={adapterOf([])} />
        <CameraButton client={mkClient()} adapter={adapterOf([])} theme={darkTheme} label="Snap" />
      </>,
    );
    expect(tree.toJSON()).toMatchSnapshot();
  });

  test('CameraButton busy', async () => {
    const adapter: CaptureAdapter = { capture: () => new Promise(() => undefined) };
    const tree = render(<CameraButton client={mkClient()} adapter={adapter} testID="cam" />);
    await pressAsync(screen.getByTestId('cam'));
    await waitFor(() => expect(screen.getByTestId('cam').props.accessibilityState.busy).toBe(true));
    expect(tree.toJSON()).toMatchSnapshot();
  });

  test('CameraButton denied', async () => {
    const adapter: CaptureAdapter = { capture: async () => Promise.reject(new ShelfPermissionDeniedError('camera', false)) };
    const tree = render(<CameraButton client={mkClient()} adapter={adapter} testID="cam" />);
    await pressAsync(screen.getByTestId('cam'));
    await screen.findByText(/Turn it on in Settings/);
    expect(tree.toJSON()).toMatchSnapshot();
  });

  test('picker buttons idle', () => {
    const a = adapterOf([]);
    const tree = render(
      <>
        <DocumentPickerButton client={mkClient()} adapter={a} />
        <DocumentPickerButton client={mkClient()} adapter={a} multiple type={['application/pdf']} />
        <PhotoLibraryButton client={mkClient()} adapter={a} />
        <PhotoLibraryButton client={mkClient()} adapter={a} multiple theme={darkTheme} />
      </>,
    );
    expect(tree.toJSON()).toMatchSnapshot();
  });
});

describe('missing optional peers', () => {
  test('each built-in adapter throws ShelfMissingPeerError naming the package and the install command', async () => {
    const cases: [() => Promise<unknown>, string, string][] = [
      [() => createPhotoCaptureAdapter().capture({}), 'expo-image-picker', 'npx expo install expo-image-picker'],
      [() => createPhotoLibraryAdapter().capture({}), 'expo-image-picker', 'npx expo install expo-image-picker'],
      [() => createDocumentPickerAdapter().capture({}), 'expo-document-picker', 'npx expo install expo-document-picker'],
      [() => createScanAdapter().capture({}), 'react-native-document-scanner-plugin', 'npm install react-native-document-scanner-plugin'],
    ];
    for (const [run, pkg, cmd] of cases) {
      const err = (await run().catch((e) => e)) as ShelfMissingPeerError;
      expect(err).toBeInstanceOf(ShelfMissingPeerError);
      expect(err).toBeInstanceOf(MissingPeerError);
      expect(err.name).toBe('ShelfMissingPeerError');
      expect(err.packageName).toBe(pkg);
      expect(err.message).toContain(pkg);
      expect(err.installCommand).toContain(cmd);
      expect(err.message).toContain(cmd);
    }
  });

  test('the button reports it through onError and shows it, without crashing the render', async () => {
    const onError = jest.fn();
    render(<CameraButton client={mkClient()} onError={onError} testID="cam" />);
    await pressAsync(screen.getByTestId('cam'));
    await screen.findByText(/expo-image-picker/);
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(ShelfMissingPeerError);
  });
});

describe('permission denied', () => {
  test('photo adapter: a refused camera permission throws ShelfPermissionDeniedError and never opens the camera', async () => {
    const mod = {
      requestCameraPermissionsAsync: jest.fn(async () => ({ granted: false, canAskAgain: false })),
      launchCameraAsync: jest.fn(),
      launchImageLibraryAsync: jest.fn(),
    };
    const err = await createPhotoCaptureAdapter({ module: mod }).capture({}).catch((e) => e);
    expect(err).toBeInstanceOf(ShelfPermissionDeniedError);
    expect(err.permission).toBe('camera');
    expect(err.canAskAgain).toBe(false);
    expect(mod.launchCameraAsync).not.toHaveBeenCalled();
  });

  test('the denied state explains, offers Settings through Linking, and can be dismissed', async () => {
    const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    const onError = jest.fn();
    const adapter: CaptureAdapter = { capture: async () => Promise.reject(new ShelfPermissionDeniedError('camera', false)) };
    render(<CameraButton client={mkClient()} adapter={adapter} onError={onError} testID="cam" />);
    expect(screen.queryByTestId('cam-denied')).toBeNull();
    await pressAsync(screen.getByTestId('cam'));
    await screen.findByText(/Shelf needs camera access/);
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(ShelfPermissionDeniedError);
    fireEvent.press(screen.getByLabelText('Open Settings'));
    expect(open).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByLabelText('Not now'));
    expect(screen.queryByTestId('cam-denied')).toBeNull();
    open.mockRestore();
  });
});

describe('success path', () => {
  test('enqueues on the outbox with the folder id and a client_ref, and never touches a picker peer', async () => {
    const outbox = createOutbox({ client: mkClient(), connectivity: false });
    const spy = jest.spyOn(outbox, 'enqueue');
    const adapter = adapterOf([photo]);
    const onCaptured = jest.fn();
    render(<CameraButton client={mkClient()} outbox={outbox} adapter={adapter} folderId="folder-7" onCaptured={onCaptured} testID="cam" />);
    await pressAsync(screen.getByTestId('cam'));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith({ uri: photo.uri, name: photo.name, type: photo.type, folder_id: 'folder-7' });
    const queued = await spy.mock.results[0]!.value;
    expect(queued.folder_id).toBe('folder-7');
    expect(queued.uri).toBe(photo.uri); // a file URI, no base64
    expect(queued.client_ref).toBe(queued.id);
    expect(queued.client_ref.length).toBeGreaterThan(8);
    expect(onCaptured).toHaveBeenCalledWith(photo);
    expect(adapter.capture).toHaveBeenCalledWith({});
    outbox.destroy();
  });

  test('the upload that follows carries folder_id and client_ref, and onUploaded fires with the server item', async () => {
    await withFormData(async (appended) => {
      const m = mockFetch([{ body: apiItem('doc-1') }]);
      const onUploaded = jest.fn();
      let h!: UseCaptureUploadResult;
      const client = mkClient(m.fetch);
      const H = () => {
        h = useCaptureUpload({ client, adapter: adapterOf([photo]), folderId: 'folder-7', connectivity: false, onUploaded });
        return null;
      };
      render(<H />);
      await act(async () => {
        await h.capture();
      });
      await waitFor(() => expect(onUploaded).toHaveBeenCalledTimes(1));
      expect(onUploaded.mock.calls[0]![0].id).toBe('doc-1');
      const fields = Object.fromEntries(appended.filter(([k]) => k !== 'file'));
      expect(fields.folder_id).toBe('folder-7');
      expect(typeof fields.client_ref).toBe('string');
      expect(appended.find(([k]) => k === 'file')![1]).toEqual({ uri: photo.uri, name: photo.name, type: photo.type });
      expect(m.calls[0]!.url).toBe('https://y.test/files');
      await act(tick);
    });
  });

  test('uploadMode="direct" uploads at once with a client_ref and skips the queue', async () => {
    await withFormData(async (appended) => {
      const m = mockFetch([{ body: apiItem('doc-2') }]);
      const onUploaded = jest.fn();
      let h!: UseCaptureUploadResult;
      const client = mkClient(m.fetch);
      const H = () => {
        h = useCaptureUpload({ client, adapter: adapterOf([photo]), folderId: 'f', uploadMode: 'direct', connectivity: false, onUploaded });
        return null;
      };
      render(<H />);
      await act(async () => {
        await h.capture();
      });
      expect(onUploaded).toHaveBeenCalledTimes(1);
      expect(h.items).toHaveLength(0);
      expect(appended.some(([k, v]) => k === 'client_ref' && typeof v === 'string')).toBe(true);
      expect(appended).toContainEqual(['folder_id', 'f']);
    });
  });

  test('cancelling the camera queues nothing and stays idle', async () => {
    const c0 = mkClient();
    const outbox = createOutbox({ client: mkClient(), connectivity: false });
    const spy = jest.spyOn(outbox, 'enqueue');
    let h!: UseCaptureUploadResult;
    const H = () => {
      h = useCaptureUpload({ client: c0, outbox, adapter: adapterOf([]) });
      return <Text>{h.state}</Text>;
    };
    render(<H />);
    await act(async () => {
      expect(await h.capture()).toEqual([]);
    });
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByText('idle')).toBeTruthy();
    outbox.destroy();
  });

  test('render-prop children receive onPress, state and disabled', async () => {
    const face = jest.fn(({ onPress, state, disabled }: { onPress: () => void; state: string; disabled: boolean }) => (
      <Text onPress={onPress} testID="face">{`${state}/${disabled}`}</Text>
    ));
    render(<CameraButton client={mkClient()} adapter={adapterOf([])}>{face}</CameraButton>);
    expect(screen.getByTestId('face').props.children).toBe('idle/false');
    await pressAsync(screen.getByTestId('face'));
    await waitFor(() => expect(screen.getByTestId('face').props.children).toBe('idle/false'));
  });

  test('a second press while busy is ignored', async () => {
    let release!: (f: CapturedFile[]) => void;
    const adapter: CaptureAdapter & { capture: jest.Mock } = { capture: jest.fn(() => new Promise<CapturedFile[]>((r) => (release = r))) };
    render(<CameraButton client={mkClient()} adapter={adapter} testID="cam" />);
    await pressAsync(screen.getByTestId('cam'));
    await pressAsync(screen.getByTestId('cam'));
    expect(adapter.capture).toHaveBeenCalledTimes(1);
    await act(async () => release([]));
  });
});

describe('adapters with injected peers', () => {
  test('photo: maps the asset to a file URI with name and type', async () => {
    const mod = {
      requestCameraPermissionsAsync: async () => ({ granted: true }),
      launchCameraAsync: jest.fn(async (_o?: Record<string, unknown>) => ({ canceled: false, assets: [{ uri: 'file:///c/IMG_1.heic', fileName: 'IMG_1.heic', mimeType: 'image/heic' }] })),
      launchImageLibraryAsync: jest.fn(),
    };
    const files = await createPhotoCaptureAdapter({ module: mod }).capture({});
    expect(files).toEqual([{ uri: 'file:///c/IMG_1.heic', name: 'IMG_1.heic', type: 'image/heic' }]);
    expect(mod.launchCameraAsync.mock.calls[0]![0]).toMatchObject({ base64: false });
  });

  test('document picker: forwards type and multiple, copies to cache', async () => {
    const getDocumentAsync = jest.fn(async () => ({ canceled: false, assets: [{ uri: 'file:///c/a.pdf', name: 'a.pdf', mimeType: 'application/pdf', size: 12 }] }));
    const files = await createDocumentPickerAdapter({ module: { getDocumentAsync } }).capture({ multiple: true, types: ['application/pdf'] });
    expect(getDocumentAsync).toHaveBeenCalledWith({ type: ['application/pdf'], multiple: true, copyToCacheDirectory: true });
    expect(files).toEqual([{ uri: 'file:///c/a.pdf', name: 'a.pdf', type: 'application/pdf', size: 12 }]);
  });

  test('photo library: multiple selection, canceled gives []', async () => {
    const launchImageLibraryAsync = jest.fn(async (_o?: Record<string, unknown>) => ({ canceled: true, assets: null }));
    const mod = { requestCameraPermissionsAsync: jest.fn(), launchCameraAsync: jest.fn(), launchImageLibraryAsync };
    expect(await createPhotoLibraryAdapter({ module: mod }).capture({ multiple: true })).toEqual([]);
    expect(launchImageLibraryAsync.mock.calls[0]![0]).toMatchObject({ allowsMultipleSelection: true, base64: false });
  });

  test('scanner: one file per page; cancel gives []; a permission error becomes denied', async () => {
    const ok = createScanAdapter({ module: { scanDocument: async () => ({ status: 'success', scannedImages: ['file:///s/1.jpg', 'file:///s/2.jpg'] }) } });
    const files = await ok.capture({ multiple: true });
    expect(files.map((f) => f.uri)).toEqual(['file:///s/1.jpg', 'file:///s/2.jpg']);
    expect(files.every((f) => f.type === 'image/jpeg')).toBe(true);
    expect(await createScanAdapter({ module: { scanDocument: async () => ({ status: 'cancel', scannedImages: [] }) } }).capture({})).toEqual([]);
    const denied = createScanAdapter({ module: { scanDocument: async () => Promise.reject(new Error('Camera permission not granted')) } });
    await expect(denied.capture({})).rejects.toBeInstanceOf(ShelfPermissionDeniedError);
  });
});
