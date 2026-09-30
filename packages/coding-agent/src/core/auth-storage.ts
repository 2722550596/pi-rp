/**
 * CredentialStore implementation backed by auth.json.
 * Provider auth orchestration belongs to ModelRuntime and pi-ai Models.
 */

import type { HarnessStores, StateLocks, StorageBackend } from "@earendil-works/pi-agent-core";
import { NodeStateLocks, NodeStorageBackend } from "@earendil-works/pi-agent-core/node";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { dirname, join } from "path";
import { getAgentDir } from "../config.ts";
import { raceWithAbortSignal } from "../utils/abort.ts";
import { normalizePath } from "../utils/paths.ts";
import { isCommandConfigValue, resolveConfigValue } from "./resolve-config-value.ts";

type AuthStorageData = Record<string, Credential>;

type LockResult<T> = {
	result: T;
	next?: string;
};

type AuthFileReload = {
	controller: AbortController;
	promise: Promise<AuthStorageData>;
	readers: number;
};

type AuthFileReadState = {
	data: AuthStorageData;
	revision?: string;
	reload?: AuthFileReload;
};

let sharedAuthFileReadState: { authPath: string; readState: AuthFileReadState } | undefined;

export interface AuthStorageBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	withLockAsync<T>(
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		options?: AuthOperationOptions,
	): Promise<T>;
}

export class FileAuthStorageBackend implements AuthStorageBackend {
	private authPath: string;
	private readonly storage: StorageBackend;
	private readonly locks: StateLocks;

	constructor(
		authPath: string = join(getAgentDir(), "auth.json"),
		storage: StorageBackend = NodeStorageBackend.shared,
		locks: StateLocks = NodeStateLocks.shared,
	) {
		this.authPath = normalizePath(authPath);
		this.storage = storage;
		this.locks = locks;
	}

	private ensureParentDir(): void {
		const dir = dirname(this.authPath);
		if (!this.storage.existsSync(dir)) {
			this.storage.mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
	}

	private ensureFileExists(): void {
		if (!this.storage.existsSync(this.authPath)) {
			// The encoding/mode write options collapse to: UTF-8 content, then chmod 0600 (the OPFS chmod is a no-op).
			this.storage.writeTextFileSync(this.authPath, "{}");
			this.storage.chmodSync?.(this.authPath, 0o600);
		}
	}

	private acquireLockSync(path: string): () => void {
		// Retry discipline (10×20ms busy wait, non-ELOCKED rethrow) lives inside the node StateLocks implementation.
		return this.locks.lockSync(path);
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => void) | undefined;
		try {
			release = this.acquireLockSync(this.authPath);
			const current = this.storage.existsSync(this.authPath)
				? this.storage.readTextFileSync(this.authPath)
				: undefined;
			const { result, next } = fn(current);
			if (next !== undefined) {
				this.storage.writeTextFileSync(this.authPath, next);
				this.storage.chmodSync?.(this.authPath, 0o600);
			}
			return result;
		} finally {
			if (release) {
				release();
			}
		}
	}

	private acquireLockAsync(
		signal: AbortSignal | undefined,
		onCompromised: (error: Error) => void,
	): Promise<() => Promise<void>> {
		// Stale-release window (30s), bounded exponential backoff, and abort handling live in the StateLocks
		// implementation; the node one preserves the former proper-lockfile parameters exactly.
		return this.locks.lockAsync(this.authPath, { signal, onCompromised });
	}

	async withLockAsync<T>(
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		options?: AuthOperationOptions,
	): Promise<T> {
		options?.signal?.throwIfAborted();
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => Promise<void>) | undefined;
		let lockCompromised = false;
		let lockCompromisedError: Error | undefined;
		const throwIfCompromised = () => {
			if (lockCompromised) {
				throw lockCompromisedError ?? new Error("Auth storage lock was compromised");
			}
		};

		try {
			release = await this.acquireLockAsync(options?.signal, (error) => {
				lockCompromised = true;
				lockCompromisedError = error;
			});

			throwIfCompromised();
			options?.signal?.throwIfAborted();
			const current = this.storage.existsSync(this.authPath)
				? this.storage.readTextFileSync(this.authPath)
				: undefined;
			const { result, next } = await fn(current);
			throwIfCompromised();
			options?.signal?.throwIfAborted();
			if (next !== undefined) {
				this.storage.writeTextFileSync(this.authPath, next);
				this.storage.chmodSync?.(this.authPath, 0o600);
			}
			throwIfCompromised();
			return result;
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					// Ignore unlock errors when lock is compromised.
				}
			}
		}
	}
}

export class ReadOnlyAuthStorage implements CredentialStore {
	private readonly authPath: string;
	private readonly storage: StorageBackend;
	private data: AuthStorageData | undefined;

	constructor(
		authPath: string = join(getAgentDir(), "auth.json"),
		storage: StorageBackend = NodeStorageBackend.shared,
	) {
		this.authPath = normalizePath(authPath);
		this.storage = storage;
	}

	private load(): AuthStorageData {
		if (this.data) return this.data;

		let parsed: unknown;
		try {
			parsed = JSON.parse(this.storage.readTextFileSync(this.authPath));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				this.data = {};
				return this.data;
			}
			throw new Error(`Failed to read auth.json: ${error instanceof Error ? error.message : String(error)}`);
		}

		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("Invalid auth.json: expected an object");
		}
		for (const [providerId, credential] of Object.entries(parsed)) {
			if (typeof credential !== "object" || credential === null || Array.isArray(credential)) {
				throw new Error(`Invalid auth.json credential for provider "${providerId}"`);
			}
			const value = credential as Record<string, unknown>;
			if (value.type === "api_key") {
				const validKey = value.key === undefined || typeof value.key === "string";
				const validEnv =
					value.env === undefined ||
					(typeof value.env === "object" &&
						value.env !== null &&
						!Array.isArray(value.env) &&
						Object.values(value.env).every((entry) => typeof entry === "string"));
				if (validKey && validEnv) continue;
			} else if (
				value.type === "oauth" &&
				typeof value.access === "string" &&
				typeof value.refresh === "string" &&
				typeof value.expires === "number" &&
				Number.isFinite(value.expires)
			) {
				continue;
			}
			throw new Error(`Invalid auth.json credential for provider "${providerId}"`);
		}

		this.data = parsed as AuthStorageData;
		return this.data;
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const credential = this.load()[providerId];
		options?.signal?.throwIfAborted();
		if (!credential) return undefined;
		if (credential.type !== "api_key" || !credential.key || isCommandConfigValue(credential.key)) {
			return structuredClone(credential);
		}
		return { ...credential, key: resolveConfigValue(credential.key, credential.env) };
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		const credentials = Object.entries(this.load()).map(([providerId, credential]) => ({
			providerId,
			type: credential.type,
		}));
		options?.signal?.throwIfAborted();
		return credentials;
	}

	async modify(
		_providerId: string,
		_fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		_options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		throw new Error("Read-only credential storage cannot modify auth.json");
	}

	async delete(_providerId: string, _options?: AuthOperationOptions): Promise<void> {
		throw new Error("Read-only credential storage cannot modify auth.json");
	}
}

export class InMemoryAuthStorageBackend implements AuthStorageBackend {
	private value: string | undefined;
	private asyncChain: Promise<unknown> = Promise.resolve();

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const { result, next } = fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}

	withLockAsync<T>(
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		options?: AuthOperationOptions,
	): Promise<T> {
		const previous = this.asyncChain;
		const operation = (async () => {
			await previous.catch(() => {});
			options?.signal?.throwIfAborted();
			const { result, next } = await fn(this.value);
			options?.signal?.throwIfAborted();
			if (next !== undefined) {
				this.value = next;
			}
			return result;
		})();
		this.asyncChain = operation.catch(() => {});
		return raceWithAbortSignal(operation, options?.signal);
	}
}

/**
 * Credential storage backed by a JSON file.
 */
export class AuthStorage implements CredentialStore {
	private storage: AuthStorageBackend;
	private authPath: string | undefined;
	/** Raw-file seam for revision stamps; undefined only for exotic assemblies (revision checks then never hit). */
	private fileStorage: StorageBackend | undefined;
	private readState: AuthFileReadState;

	private constructor(storage: AuthStorageBackend, authPath?: string, fileStorage?: StorageBackend) {
		this.storage = storage;
		this.authPath = authPath;
		// Node default keeps the former getFileRevision short-circuit behavior byte-identical.
		this.fileStorage = fileStorage ?? NodeStorageBackend.shared;
		this.readState =
			authPath && sharedAuthFileReadState?.authPath === authPath ? sharedAuthFileReadState.readState : { data: {} };
		if (authPath && !sharedAuthFileReadState) {
			sharedAuthFileReadState = { authPath, readState: this.readState };
		}
		if (authPath) {
			const revision = this.revisionOf(authPath);
			if (revision !== undefined && revision === this.readState.revision) return;
		}
		this.reload();
	}

	private revisionOf(path: string | undefined): string | undefined {
		if (!path) return undefined;
		return this.fileStorage?.fileRevisionSync?.(path);
	}

	static create(authPath: string = join(getAgentDir(), "auth.json"), stores?: HarnessStores): AuthStorage {
		const normalizedAuthPath = normalizePath(authPath);
		return new AuthStorage(
			new FileAuthStorageBackend(normalizedAuthPath, stores?.storage, stores?.locks),
			normalizedAuthPath,
			stores?.storage,
		);
	}

	static fromStorage(storage: AuthStorageBackend): AuthStorage {
		return new AuthStorage(storage);
	}

	static inMemory(data: AuthStorageData = {}): AuthStorage {
		const storage = new InMemoryAuthStorageBackend();
		storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
		return AuthStorage.fromStorage(storage);
	}

	private parseStorageData(content: string | undefined): AuthStorageData {
		if (!content) {
			return {};
		}
		return JSON.parse(content) as AuthStorageData;
	}

	private updateReadState(data: AuthStorageData, revision?: string): void {
		this.readState.data = data;
		this.readState.revision = revision;
	}

	/**
	 * Reload credentials from storage.
	 */
	reload(): void {
		let content: string | undefined;
		let revision: string | undefined;
		try {
			this.storage.withLock((current) => {
				content = current;
				revision = this.revisionOf(this.authPath);
				return { result: undefined };
			});
			this.updateReadState(this.parseStorageData(content), revision);
		} catch {
			// Preserve the last valid in-memory snapshot.
		}
	}

	private async reloadFromStorageAsync(options?: AuthOperationOptions): Promise<AuthStorageData> {
		return this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			const revision = this.revisionOf(this.authPath);
			this.updateReadState(currentData, revision);
			return { result: currentData };
		}, options);
	}

	private async readLatestData(options?: AuthOperationOptions): Promise<AuthStorageData> {
		options?.signal?.throwIfAborted();
		if (!this.authPath) {
			const reload = this.reloadFromStorageAsync(options);
			return options?.signal ? reload : reload.catch(() => this.readState.data);
		}
		const revision = this.revisionOf(this.authPath);
		if (revision !== undefined && revision === this.readState.revision) return this.readState.data;
		if (!this.readState.reload) {
			const controller = new AbortController();
			const reload: AuthFileReload = {
				controller,
				promise: this.reloadFromStorageAsync({ signal: controller.signal }),
				readers: 0,
			};
			this.readState.reload = reload;
			void reload.promise.then(
				() => {
					if (this.readState.reload === reload) this.readState.reload = undefined;
				},
				() => {
					if (this.readState.reload === reload) this.readState.reload = undefined;
				},
			);
		}

		const reload = this.readState.reload;
		reload.readers++;
		try {
			const result = raceWithAbortSignal(reload.promise, options?.signal);
			return options?.signal ? await result : await result.catch(() => this.readState.data);
		} finally {
			reload.readers--;
			if (reload.readers === 0 && this.readState.reload === reload) {
				this.readState.reload = undefined;
				reload.controller.abort();
			}
		}
	}

	async read(provider: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		const credential = (await this.readLatestData(options))[provider];
		options?.signal?.throwIfAborted();
		if (credential?.type !== "api_key") return credential;
		if (credential.key === undefined) return credential;
		return { ...credential, key: resolveConfigValue(credential.key, credential.env) };
	}

	async modify(
		provider: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		let latestData = this.readState.data;
		let revision: string | undefined;
		const result = await this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			const next = await fn(currentData[provider]);
			if (next === undefined) {
				latestData = currentData;
				revision = this.revisionOf(this.authPath);
				return { result: currentData[provider] };
			}

			const merged: AuthStorageData = { ...currentData, [provider]: next };
			latestData = merged;
			return { result: next, next: JSON.stringify(merged, null, 2) };
		}, options);
		this.updateReadState(latestData, revision);
		return result;
	}

	async delete(provider: string, options?: AuthOperationOptions): Promise<void> {
		let latestData = this.readState.data;
		await this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			delete currentData[provider];
			latestData = currentData;
			return { result: undefined, next: JSON.stringify(currentData, null, 2) };
		}, options);
		this.updateReadState(latestData);
	}

	/** List credential metadata without resolving configured key values. */
	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const entries = Object.entries(await this.readLatestData(options));
		options?.signal?.throwIfAborted();
		return entries.map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}
}

/**
 * One-off synchronous read of a stored credential from an auth.json file,
 * without instantiating a store or resolving configured key values.
 */
export function readStoredCredential(
	providerId: string,
	authPath: string = join(getAgentDir(), "auth.json"),
	storage: StorageBackend = NodeStorageBackend.shared,
): Credential | undefined {
	try {
		const data = JSON.parse(storage.readTextFileSync(normalizePath(authPath))) as AuthStorageData;
		return data[providerId];
	} catch {
		return undefined;
	}
}
