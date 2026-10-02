import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { HarnessStores, StateLocks, StorageBackend } from "@earendil-works/pi-agent-core";
import { NodeStorageBackend } from "@earendil-works/pi-agent-core/node";
import { getProjectConfigDirName } from "../config.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import { nodeHarnessStores } from "./node-stores.ts";

export type ProjectTrustDecision = boolean | null;

export interface ProjectTrustStoreEntry {
	path: string;
	decision: boolean;
}

export interface ProjectTrustUpdate {
	path: string;
	decision: ProjectTrustDecision;
}

export interface ProjectTrustOption {
	label: string;
	trusted: boolean;
	updates: ProjectTrustUpdate[];
	savedPath?: string;
}

type TrustFile = Record<string, boolean | null | undefined>;

const TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES = [
	"settings.json",
	"extensions",
	"skills",
	"prompts",
	"themes",
	"SYSTEM.md",
	"APPEND_SYSTEM.md",
] as const;

function normalizeCwd(cwd: string): string {
	return canonicalizePath(resolvePath(cwd));
}

function findNearestTrustEntry(data: TrustFile, cwd: string): ProjectTrustStoreEntry | null {
	let currentDir = normalizeCwd(cwd);
	while (true) {
		const value = data[currentDir];
		if (value === true || value === false) {
			return { path: currentDir, decision: value };
		}

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) {
			return null;
		}
		currentDir = parentDir;
	}
}

export function getProjectTrustParentPath(cwd: string): string | undefined {
	const trustPath = normalizeCwd(cwd);
	const parentDir = dirname(trustPath);
	return parentDir === trustPath ? undefined : parentDir;
}

export function getProjectTrustOptions(cwd: string, options?: { includeSessionOnly?: boolean }): ProjectTrustOption[] {
	const trustPath = normalizeCwd(cwd);
	const trustOptions: ProjectTrustOption[] = [
		{ label: "Trust", trusted: true, updates: [{ path: trustPath, decision: true }], savedPath: trustPath },
	];
	const parentPath = getProjectTrustParentPath(cwd);
	if (parentPath !== undefined) {
		trustOptions.push({
			label: `Trust parent folder (${parentPath})`,
			trusted: true,
			updates: [
				{ path: parentPath, decision: true },
				{ path: trustPath, decision: null },
			],
			savedPath: parentPath,
		});
	}
	if (options?.includeSessionOnly) {
		trustOptions.push({ label: "Trust (this session only)", trusted: true, updates: [] });
	}
	trustOptions.push({
		label: "Do not trust",
		trusted: false,
		updates: [{ path: trustPath, decision: false }],
		savedPath: trustPath,
	});
	if (options?.includeSessionOnly) {
		trustOptions.push({ label: "Do not trust (this session only)", trusted: false, updates: [] });
	}
	return trustOptions;
}

function readTrustFile(path: string, storage: StorageBackend): TrustFile {
	if (!storage.existsSync(path)) {
		return {};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(storage.readTextFileSync(path));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read trust store ${path}: ${message}`);
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Invalid trust store ${path}: expected an object`);
	}

	const data: TrustFile = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (value !== true && value !== false && value !== null) {
			throw new Error(`Invalid trust store ${path}: value for ${JSON.stringify(key)} must be true, false, or null`);
		}
		data[key] = value;
	}
	return data;
}

function writeTrustFile(path: string, data: TrustFile, storage: StorageBackend): void {
	const sorted: TrustFile = {};
	for (const key of Object.keys(data).sort()) {
		const value = data[key];
		if (value === true || value === false || value === null) {
			sorted[key] = value;
		}
	}
	storage.mkdirSync(dirname(path), { recursive: true });
	storage.writeTextFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`);
}

function acquireTrustLockSync(path: string, locks: StateLocks, storage: StorageBackend): () => void {
	const trustDir = dirname(path);
	storage.mkdirSync(trustDir, { recursive: true });
	// lockfilePath (`${path}.lock`) and the 10×20ms retry discipline live in the StateLocks implementation; the node
	// one preserves the former proper-lockfile call exactly.
	return locks.lockSync(trustDir, { lockfilePath: `${path}.lock` });
}

function withTrustFileLock<T>(path: string, stores: HarnessStores, fn: () => T): T {
	const release = acquireTrustLockSync(path, stores.locks, stores.storage);
	try {
		return fn();
	} finally {
		release();
	}
}

/**
 * Returns true when cwd has project-local resources that must be gated by
 * project trust: trust-requiring entries under cwd/.pi, or .agents/skills in
 * cwd or one of its ancestors. Returns false when no such project resources
 * exist. The user/global ~/.agents/skills directory is always treated as a
 * trusted user resource and is ignored here, even when cwd is $HOME.
 */
export function hasTrustRequiringProjectResources(
	cwd: string,
	storage: StorageBackend = NodeStorageBackend.shared,
	additionalProjectResourcePaths: readonly string[] = [],
): boolean {
	// HOME resolution is a node-entry concern (the browser profile is trusted-by-default per the frozen decision, so
	// this probe is never assembled there); the workspace/config existence probes below run through the storage seam.
	const homeDir = canonicalizePath(resolvePath(process.env.HOME || homedir()));
	const userAgentsSkillsDir = join(homeDir, ".agents", "skills");
	let currentDir = canonicalizePath(resolvePath(cwd));

	const configDir = join(currentDir, getProjectConfigDirName());
	if (TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES.some((entry) => storage.existsSync(join(configDir, entry)))) {
		return true;
	}
	if (additionalProjectResourcePaths.some((path) => storage.existsSync(resolvePath(path, cwd)))) {
		return true;
	}

	while (true) {
		const agentsSkillsDir = join(currentDir, ".agents", "skills");
		if (agentsSkillsDir !== userAgentsSkillsDir && storage.existsSync(agentsSkillsDir)) {
			return true;
		}

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) {
			return false;
		}
		currentDir = parentDir;
	}
}

export class ProjectTrustStore {
	private trustPath: string;
	private stores: HarnessStores;

	constructor(agentDir: string, stores: HarnessStores = nodeHarnessStores()) {
		this.trustPath = join(resolvePath(agentDir), "trust.json");
		this.stores = stores;
	}

	get(cwd: string): ProjectTrustDecision {
		return this.getEntry(cwd)?.decision ?? null;
	}

	getEntry(cwd: string): ProjectTrustStoreEntry | null {
		return withTrustFileLock(this.trustPath, this.stores, () => {
			const data = readTrustFile(this.trustPath, this.stores.storage);
			return findNearestTrustEntry(data, cwd);
		});
	}

	set(cwd: string, decision: ProjectTrustDecision): void {
		this.setMany([{ path: cwd, decision }]);
	}

	setMany(decisions: ProjectTrustUpdate[]): void {
		withTrustFileLock(this.trustPath, this.stores, () => {
			const data = readTrustFile(this.trustPath, this.stores.storage);
			for (const { path, decision } of decisions) {
				const key = normalizeCwd(path);
				if (decision === null) {
					delete data[key];
				} else {
					data[key] = decision;
				}
			}
			writeTrustFile(this.trustPath, data, this.stores.storage);
		});
	}
}
