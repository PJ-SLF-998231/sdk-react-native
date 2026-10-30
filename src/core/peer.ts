/** Thrown by an adapter factory when its optional peer dependency is not installed. */
export class MissingPeerError extends Error {
  readonly peer: string;
  constructor(peer: string, adapter: string) {
    super(`@pj-slf-998231/sdk-react-native: ${adapter} needs the optional peer "${peer}". Install it (for Expo: npx expo install ${peer}) or pass another StorageAdapter.`);
    this.name = 'MissingPeerError';
    this.peer = peer;
  }
}
