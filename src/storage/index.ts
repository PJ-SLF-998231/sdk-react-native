export type { StorageAdapter } from './types';
export { MissingPeerError } from '../core/peer';
export { createMemoryAdapter } from './memory';
// Persistent adapters live on their own subpaths so unused ones (and their peers) never load:
//   @pj-slf-998231/sdk-react-native/storage/asyncstorage
//   @pj-slf-998231/sdk-react-native/storage/sqlite
