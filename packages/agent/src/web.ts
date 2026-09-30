// Browser/hosted implementation surface. Kept separate from the main barrel so browser consumers never pull
// node-only modules, mirroring the "./node" subexport for node implementations.
export * from "./harness/env/browser.ts";
export * from "./harness/env/hosted.ts";
export * from "./harness/env/opfs/index.ts";
export type {
	HarnessStores,
	StateLocks,
	StatePaths,
	StateStores,
	StorageBackend,
} from "./harness/env/storage-backend.ts";
