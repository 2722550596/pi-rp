/** Browser-profile OPFS storage implementations (11-B): async FileSystem face, sync StorageBackend face, locks, layout. */

export { OpfsFileSystem } from "./file-system.ts";
export {
	BROWSER_AGENT_DIR,
	BROWSER_DEFAULT_WORKSPACE,
	BROWSER_WORKSPACE_ROOT,
	browserWorkspacePath,
	OpfsStateLocks,
	OpfsStorageBackend,
	opfsStatePaths,
} from "./storage.ts";
export type {
	OpfsDirectoryHandle,
	OpfsFile,
	OpfsFileHandle,
	OpfsSyncAccessHandle,
	OpfsWritableFileStream,
} from "./types.ts";
export { opfsErrorCode } from "./types.ts";
export { joinVirtualPath, normalizeVirtualPath, splitVirtualPath } from "./virtual-path.ts";
