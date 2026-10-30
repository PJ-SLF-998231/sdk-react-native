/** The user (or the OS) refused a permission the capture needs. */
export class ShelfPermissionDeniedError extends Error {
  readonly permission: 'camera' | 'photos' | 'files';
  /** False when the OS will not ask again; only Settings can change it. */
  readonly canAskAgain: boolean;
  constructor(permission: 'camera' | 'photos' | 'files', canAskAgain = true) {
    super(`Shelf: ${permission} permission was denied.`);
    this.name = 'ShelfPermissionDeniedError';
    this.permission = permission;
    this.canAskAgain = canAskAgain;
  }
}
