import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { NodeStorageBackend } from "@earendil-works/pi-agent-core/node";
import type { SessionMetadata } from "@earendil-works/pi-protocol";
import type { CreateSessionOptions } from "@earendil-works/pi-server";
import { assertValidSessionId, SessionManager } from "../core/session-manager.ts";
import { acquireHostRootLock, type HostRootLock, securePrivatePath } from "./host-root-lock.ts";

interface SessionManifest {
	version: 1;
	status: "pending" | "committed";
	metadata: SessionMetadata;
	cwd: string;
	sessionFile: string;
	model?: CreateSessionOptions["model"];
	thinkingLevel?: CreateSessionOptions["thinkingLevel"];
}

class PrivateSessionStorage extends NodeStorageBackend {
	override mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): void {
		const created = !this.existsSync(path);
		super.mkdirSync(path, { ...options, mode: 0o700 });
		if (created && process.platform !== "win32") securePrivatePath(path, true);
	}

	override writeTextFileSync(path: string, data: string, options?: { flag?: "w" | "wx" }): void {
		const created = !this.existsSync(path);
		super.writeTextFileSync(path, data, options);
		if (created && process.platform !== "win32") securePrivatePath(path, false);
	}

	override appendTextFileSync(path: string, data: string): void {
		const created = !this.existsSync(path);
		super.appendTextFileSync(path, data);
		if (created && process.platform !== "win32") securePrivatePath(path, false);
	}
}

const PRIVATE_SESSION_STORAGE = new PrivateSessionStorage();

export class SessionStoreError extends Error {
	readonly code: "not_found" | "session_locked" | "invalid_request";

	constructor(code: "not_found" | "session_locked" | "invalid_request", message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SessionStoreError";
		this.code = code;
	}
}

export interface CodingAgentServerSessionStore {
	acquire(): Promise<void>;
	listSessions(): Promise<SessionMetadata[]>;
	create(
		options: CreateSessionOptions,
	): Promise<{ sessionManager: SessionManager; metadata: SessionMetadata; sessionOptions: CreateSessionOptions }>;
	open(
		protocolSessionId: string,
	): Promise<{ sessionManager: SessionManager; metadata: SessionMetadata; sessionOptions: CreateSessionOptions }>;
	release(protocolSessionId: string): Promise<void>;
	commitCreate(protocolSessionId: string, effectiveSessionOptions: CreateSessionOptions): Promise<void>;
	discardFailedCreate(protocolSessionId: string): Promise<void>;
}

/** File-backed durable protocol-ID catalog with one fixed SessionManager file per ID. */
export class FileCodingAgentServerSessionStore implements CodingAgentServerSessionStore {
	readonly sessionStorageDir: string;
	private rootLock: HostRootLock | undefined;
	private storageRoot: string | undefined;
	private readonly leases = new Set<string>();
	private readonly createdHere = new Set<string>();

	constructor(sessionStorageDir: string) {
		this.sessionStorageDir = resolve(sessionStorageDir);
	}

	/** Must complete before list/create/open and before PiServer listeners start. */
	async acquire(): Promise<void> {
		if (this.rootLock) return;
		const lock = await acquireHostRootLock(this.sessionStorageDir);
		this.rootLock = lock;
		this.storageRoot = lock.rootPath;
		try {
			await this.sweepPendingCreates();
		} catch (error) {
			try {
				lock.close();
			} catch (closeError) {
				throw new AggregateError([error, closeError], "Failed to acquire and release session storage root", {
					cause: error,
				});
			} finally {
				this.rootLock = undefined;
				this.storageRoot = undefined;
			}
			throw error;
		}
	}

	async close(): Promise<void> {
		if (this.leases.size > 0) {
			throw new Error(`Cannot release session storage root while ${this.leases.size} session lease(s) remain`);
		}
		this.rootLock?.close();
		this.createdHere.clear();
		this.rootLock = undefined;
		this.storageRoot = undefined;
	}

	async listSessions(): Promise<SessionMetadata[]> {
		this.assertAcquired();
		const root = this.rootPath();
		const entries = await readdir(root, { withFileTypes: true });
		const sessions: SessionMetadata[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const manifest = await this.readManifest(join(root, entry.name)).catch((error: unknown) => {
				if (isMissing(error)) return undefined;
				throw error;
			});
			if (manifest && manifest.metadata.id !== entry.name) {
				throw new Error(`Session manifest ID does not match its directory: ${entry.name}`);
			}
			if (manifest?.status === "committed") {
				sessions.push({
					...manifest.metadata,
					updatedAt: await this.sessionUpdatedAt(manifest, join(root, entry.name)),
				});
			}
		}
		return sessions.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	}

	async create(
		options: CreateSessionOptions,
	): Promise<{ sessionManager: SessionManager; metadata: SessionMetadata; sessionOptions: CreateSessionOptions }> {
		this.assertAcquired();
		const id = options.id;
		this.validateId(id);
		this.claim(id);
		const sessionDir = this.sessionDir(id);
		let createdDirectory = false;
		try {
			try {
				await mkdir(sessionDir, { mode: 0o700 });
			} catch (error) {
				if (isAlreadyExists(error)) {
					const existing = await lstat(sessionDir);
					if (existing.isSymbolicLink()) throw new Error(`Session directory must not be a symlink: ${sessionDir}`);
					throw new SessionStoreError("session_locked", `Session ${id} already exists`, { cause: error });
				}
				throw error;
			}
			createdDirectory = true;
			if (process.platform !== "win32") securePrivatePath(sessionDir, true);
			await this.assertSafeSessionDirectory(sessionDir);
			const cwd = resolve(options.cwd ?? process.cwd());
			const sessionManager = SessionManager.create(cwd, sessionDir, { id }, PRIVATE_SESSION_STORAGE);
			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("SessionManager did not create a persistent session file");
			if (dirname(resolve(sessionFile)) !== resolve(sessionDir) || !resolve(sessionFile).endsWith(`_${id}.jsonl`)) {
				throw new Error(`SessionManager file path does not match its fixed per-session directory: ${id}`);
			}
			const metadata: SessionMetadata = {
				id,
				createdAt: Date.now(),
				...(options.name === undefined ? {} : { sessionName: options.name }),
				cwd,
			};
			const sessionOptions: CreateSessionOptions = {
				id,
				cwd,
				...(options.name === undefined ? {} : { name: options.name }),
				...(options.model === undefined ? {} : { model: options.model }),
				...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
			};
			const manifest: SessionManifest = {
				status: "pending",
				version: 1,
				metadata,
				cwd,
				sessionFile,
				...(options.model === undefined ? {} : { model: options.model }),
				...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
			};
			await this.writeManifest(sessionDir, manifest);
			this.createdHere.add(id);
			return { sessionManager, metadata, sessionOptions };
		} catch (error) {
			this.leases.delete(id);
			if (createdDirectory) {
				try {
					await this.assertSafeSessionDirectory(sessionDir);
					await rm(sessionDir, { recursive: true, force: true });
				} catch (cleanupError) {
					throw new AggregateError([error, cleanupError], `Session ${id} creation and rollback both failed`, {
						cause: error,
					});
				}
			}
			throw error;
		}
	}

	async open(
		protocolSessionId: string,
	): Promise<{ sessionManager: SessionManager; metadata: SessionMetadata; sessionOptions: CreateSessionOptions }> {
		this.assertAcquired();
		this.validateId(protocolSessionId);
		this.claim(protocolSessionId);
		try {
			const sessionDir = this.sessionDir(protocolSessionId);
			const manifest = await this.readManifest(sessionDir);
			if (!manifest || manifest.status !== "committed") throw this.notFound(protocolSessionId);
			if (manifest.metadata.id !== protocolSessionId) {
				throw new Error(`Session manifest ID does not match its directory: ${protocolSessionId}`);
			}
			const expectedDir = resolve(sessionDir);
			const expectedFile = resolve(manifest.sessionFile);
			if (dirname(expectedFile) !== expectedDir || !expectedFile.endsWith(`_${protocolSessionId}.jsonl`)) {
				throw new Error(`Session manifest path does not match its fixed session path: ${protocolSessionId}`);
			}
			await this.assertSafeSessionFile(expectedFile, expectedDir);
			const sessionManager = SessionManager.open(
				manifest.sessionFile,
				expectedDir,
				manifest.cwd,
				PRIVATE_SESSION_STORAGE,
			);
			if (
				sessionManager.getSessionId() !== protocolSessionId ||
				resolve(sessionManager.getSessionFile() ?? "") !== expectedFile
			) {
				throw new Error(`SessionManager identity does not match durable session: ${protocolSessionId}`);
			}
			const sessionOptions: CreateSessionOptions = {
				id: protocolSessionId,
				cwd: manifest.cwd,
				...(manifest.metadata.sessionName === undefined ? {} : { name: manifest.metadata.sessionName }),
				...(manifest.model === undefined ? {} : { model: manifest.model }),
				...(manifest.thinkingLevel === undefined ? {} : { thinkingLevel: manifest.thinkingLevel }),
			};
			return { sessionManager, metadata: manifest.metadata, sessionOptions };
		} catch (error) {
			this.leases.delete(protocolSessionId);
			if (isMissing(error)) throw this.notFound(protocolSessionId);
			throw error;
		}
	}

	/** Persist final runtime model settings and commit a successful create atomically. */
	async commitCreate(protocolSessionId: string, effectiveSessionOptions: CreateSessionOptions): Promise<void> {
		this.assertAcquired();
		this.validateId(protocolSessionId);
		if (!this.createdHere.has(protocolSessionId) || !this.leases.has(protocolSessionId)) {
			throw new Error(`Session ${protocolSessionId} is not an uncommitted create owned by this store`);
		}
		if (
			effectiveSessionOptions.id !== protocolSessionId ||
			effectiveSessionOptions.model === undefined ||
			effectiveSessionOptions.thinkingLevel === undefined
		) {
			throw new SessionStoreError(
				"invalid_request",
				`Final model and thinking level are required for ${protocolSessionId}`,
			);
		}
		const sessionDir = this.sessionDir(protocolSessionId);
		const manifest = await this.readManifest(sessionDir);
		if (!manifest) throw this.notFound(protocolSessionId);
		if (manifest.metadata.id !== protocolSessionId) {
			throw new Error(`Session manifest ID does not match its directory: ${protocolSessionId}`);
		}
		const effectiveCwd = resolve(effectiveSessionOptions.cwd ?? manifest.cwd);
		const committedManifest: SessionManifest = {
			...manifest,
			cwd: effectiveCwd,
			metadata: {
				...manifest.metadata,
				cwd: effectiveCwd,
				...(effectiveSessionOptions.name === undefined ? {} : { sessionName: effectiveSessionOptions.name }),
			},
			model: effectiveSessionOptions.model,
			thinkingLevel: effectiveSessionOptions.thinkingLevel,
			status: "committed",
		};
		await this.writeManifest(sessionDir, committedManifest, true);
		this.createdHere.delete(protocolSessionId);
	}

	/** Drop only this process's active writer lease; persistent metadata and JSONL remain. */
	async release(protocolSessionId: string): Promise<void> {
		this.leases.delete(protocolSessionId);
	}

	/** Remove only a newly created record that has not been exposed to callers. */
	async discardFailedCreate(protocolSessionId: string): Promise<void> {
		this.assertAcquired();
		if (!this.createdHere.has(protocolSessionId)) return;
		await this.assertSafeSessionDirectory(this.sessionDir(protocolSessionId));
		await rm(this.sessionDir(protocolSessionId), { recursive: true, force: true });
		this.createdHere.delete(protocolSessionId);
		this.leases.delete(protocolSessionId);
	}

	private assertAcquired(): void {
		if (!this.rootLock) throw new Error("Session store must acquire its root ownership lock before use");
	}

	private rootPath(): string {
		if (!this.storageRoot) throw new Error("Session store must acquire its root ownership lock before use");
		return this.storageRoot;
	}

	private claim(id: string): void {
		if (this.leases.has(id)) {
			throw new SessionStoreError("session_locked", `Session ${id} already has an active writer`);
		}
		this.leases.add(id);
	}

	private validateId(id: string): void {
		try {
			assertValidSessionId(id);
		} catch (error) {
			throw new SessionStoreError("invalid_request", `Invalid session ID: ${id}`, { cause: error });
		}
	}

	private sessionDir(id: string): string {
		return join(this.rootPath(), id);
	}

	private manifestPath(sessionDir: string): string {
		return join(sessionDir, "manifest.json");
	}

	private async sessionUpdatedAt(manifest: SessionManifest, sessionDir: string): Promise<number> {
		this.assertManifestSessionPath(manifest, manifest.metadata.id, sessionDir);
		try {
			await this.assertSafeSessionFile(manifest.sessionFile, resolve(sessionDir));
			const file = await lstat(manifest.sessionFile);
			if (file.isSymbolicLink() || !file.isFile()) {
				throw new Error(`Session JSONL must be a regular non-symlink file: ${manifest.sessionFile}`);
			}
			return Math.max(manifest.metadata.createdAt, Math.trunc(file.mtimeMs));
		} catch (error) {
			if (isMissing(error)) return manifest.metadata.createdAt;
			throw error;
		}
	}
	private async sweepPendingCreates(): Promise<void> {
		const root = this.rootPath();
		const entries = await readdir(root, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			try {
				assertValidSessionId(entry.name);
			} catch {
				continue;
			}
			const sessionDir = join(root, entry.name);
			await this.assertSafeSessionDirectory(sessionDir);
			const children = await readdir(sessionDir, { withFileTypes: true });
			let manifest: SessionManifest | undefined;
			try {
				manifest = await this.readManifest(sessionDir);
			} catch (error) {
				if (!isMissing(error)) throw error;
				if (children.length === 0) {
					await rm(sessionDir);
					continue;
				}
				const temporaryManifests = children.filter(
					(child) => child.isFile() && /^\.manifest-[0-9a-f-]+\.tmp$/i.test(child.name),
				);
				if (temporaryManifests.length === 0 || temporaryManifests.length !== children.length) {
					throw new Error(`Session directory has contents but no valid manifest: ${sessionDir}`, { cause: error });
				}
				for (const child of temporaryManifests) {
					const temporaryPath = join(sessionDir, child.name);
					await this.assertSafeSessionFile(temporaryPath, resolve(sessionDir));
					const value: unknown = JSON.parse(await readFile(temporaryPath, "utf8"));
					if (!isManifest(value) || value.status !== "pending" || value.metadata.id !== entry.name) {
						throw new Error(`Invalid pending manifest temporary file: ${temporaryPath}`);
					}
					this.assertManifestSessionPath(value, entry.name, sessionDir);
				}
				await rm(sessionDir, { recursive: true });
				continue;
			}
			if (!manifest || manifest.status !== "pending") continue;
			if (manifest.metadata.id !== entry.name) {
				throw new Error(`Session manifest ID does not match its directory: ${entry.name}`);
			}
			this.assertManifestSessionPath(manifest, entry.name, sessionDir);
			for (const child of children) {
				if (child.isSymbolicLink() || !child.isFile()) {
					throw new Error(
						`Pending session directory contains an unsupported entry: ${join(sessionDir, child.name)}`,
					);
				}
				const childPath = join(sessionDir, child.name);
				if (
					child.name !== "manifest.json" &&
					child.name !== basename(manifest.sessionFile) &&
					!/^\.manifest-[0-9a-f-]+\.tmp$/i.test(child.name)
				) {
					throw new Error(`Pending session directory contains an unknown file: ${childPath}`);
				}
				await this.assertSafeSessionFile(childPath, resolve(sessionDir));
				if (/^\.manifest-[0-9a-f-]+\.tmp$/i.test(child.name)) {
					const value: unknown = JSON.parse(await readFile(childPath, "utf8"));
					if (!isManifest(value) || value.metadata.id !== entry.name) {
						throw new Error(`Invalid manifest temporary file: ${childPath}`);
					}
					this.assertManifestSessionPath(value, entry.name, sessionDir);
				}
			}
			await rm(sessionDir, { recursive: true });
		}
	}

	private assertManifestSessionPath(manifest: SessionManifest, id: string, sessionDir: string): void {
		const expectedDir = resolve(sessionDir);
		const expectedFile = resolve(manifest.sessionFile);
		if (dirname(expectedFile) !== expectedDir || !expectedFile.endsWith(`_${id}.jsonl`)) {
			throw new Error(`Session manifest path does not match its fixed session path: ${id}`);
		}
	}
	private async readManifest(sessionDir: string): Promise<SessionManifest | undefined> {
		await this.assertSafeSessionDirectory(sessionDir);
		const manifestPath = this.manifestPath(sessionDir);
		await this.assertSafeSessionFile(manifestPath, resolve(sessionDir));
		const raw = await readFile(manifestPath, "utf8");
		const value: unknown = JSON.parse(raw);
		if (!isManifest(value)) throw new Error(`Invalid session manifest: ${manifestPath}`);
		return value;
	}

	private async writeManifest(sessionDir: string, manifest: SessionManifest, replaceExisting = false): Promise<void> {
		await this.assertSafeSessionDirectory(sessionDir);
		const target = this.manifestPath(sessionDir);
		const temporary = join(sessionDir, `.manifest-${randomUUID()}.tmp`);
		try {
			await writeFile(temporary, `${JSON.stringify(manifest)}\n`, { flag: "wx", mode: 0o600 });
			if (process.platform !== "win32") securePrivatePath(temporary, false);
			try {
				await lstat(target);
				if (!replaceExisting) throw new Error(`Session manifest already exists: ${target}`);
				await this.assertSafeSessionFile(target, resolve(sessionDir));
			} catch (error) {
				if (!isMissing(error)) throw error;
				if (replaceExisting) throw new Error(`Session manifest is missing during replacement: ${target}`);
			}
			await this.assertSafeSessionFile(temporary, resolve(sessionDir));
			await rename(temporary, target);
		} catch (error) {
			await rm(temporary, { force: true });
			throw error;
		}
	}

	private async assertSafeSessionDirectory(sessionDir: string): Promise<void> {
		const root = this.rootPath();
		const expected = join(root, basename(sessionDir));
		const details = await lstat(sessionDir);
		if (details.isSymbolicLink() || !details.isDirectory() || resolve(sessionDir) !== expected) {
			throw new Error(`Session directory must be a direct, non-symlink child of the storage root: ${sessionDir}`);
		}
		if ((await realpath(sessionDir)) !== expected) {
			throw new Error(`Session directory resolves outside its expected location: ${sessionDir}`);
		}
	}

	private async assertSafeSessionFile(filePath: string, expectedDir: string): Promise<void> {
		const details = await lstat(filePath);
		if (details.isSymbolicLink() || !details.isFile()) {
			throw new Error(`Session storage file must be a regular non-symlink file: ${filePath}`);
		}
		const canonical = await realpath(filePath);
		if (dirname(canonical) !== expectedDir)
			throw new Error(`Session file resolves outside its session directory: ${filePath}`);
	}

	private notFound(id: string): SessionStoreError {
		return new SessionStoreError("not_found", `Session ${id} was not found`);
	}
}

function isAlreadyExists(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isManifest(value: unknown): value is SessionManifest {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<SessionManifest>;
	return (
		candidate.version === 1 &&
		(candidate.status === "pending" || candidate.status === "committed") &&
		typeof candidate.cwd === "string" &&
		typeof candidate.metadata === "object" &&
		candidate.metadata !== null &&
		typeof candidate.metadata.id === "string" &&
		typeof candidate.metadata.createdAt === "number"
	);
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export { HostRootOwnedError } from "./host-root-lock.ts";
