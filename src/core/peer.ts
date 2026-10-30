/** Thrown by an adapter factory when its optional peer dependency is not installed. */
export class MissingPeerError extends Error {
  readonly peer: string;
  constructor(peer: string, adapter: string) {
    super(`@pj-slf-998231/sdk-react-native: ${adapter} needs the optional peer "${peer}". Install it (for Expo: npx expo install ${peer}) or pass another StorageAdapter.`);
    this.name = 'MissingPeerError';
    this.peer = peer;
  }
}

/**
 * Thrown when a feature needs an optional peer package that is not installed. Names the package and the command that
 * installs it. Subclass of {@link MissingPeerError}, so existing `instanceof MissingPeerError` checks still match.
 */
export class ShelfMissingPeerError extends MissingPeerError {
  readonly packageName: string;
  readonly installCommand: string;
  constructor(packageName: string, feature: string, installCommand: string = `npx expo install ${packageName}`, options?: { cause?: unknown }) {
    super(packageName, feature);
    this.name = 'ShelfMissingPeerError';
    this.packageName = packageName;
    this.installCommand = installCommand;
    this.message = `@pj-slf-998231/sdk-react-native: ${feature} needs the optional peer "${packageName}", which is not installed. Install it with: ${installCommand}. Or pass your own \`adapter\`.`;
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}
