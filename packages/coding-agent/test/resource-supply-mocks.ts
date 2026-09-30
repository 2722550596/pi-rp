import type { StorageBackend } from "@earendil-works/pi-agent-core";

/**
 * Shared in-memory StorageBackend for the resource-seam tests (18 号 §10): a faithful Map-backed
 * stand-in for the synchronous storage face with a selectable `kind`, so tests can drive the
 * opfs/host-fs source-label branches and the node-fs no-label branch without a real filesystem.
 */
export class MemoryStorageBackend implements StorageBackend {
	readonly kind: StorageBackend["kind"];
	readonly #files = new Map<string, string>();
	readonly #dirs = new Set<string>();

	constructor(kind: StorageBackend["kind"] = "opfs") {
		this.kind = kind;
	}

	seed(path: string, content: string): void {
		this.#files.set(path, content);
		const parts = path.split("/").filter(Boolean);
		parts.pop();
		let dir = "";
		for (const part of parts) {
			dir += `/${part}`;
			this.#dirs.add(dir);
		}
	}

	seedJson(path: string, value: unknown): void {
		this.seed(path, JSON.stringify(value));
	}

	existsSync(path: string): boolean {
		return this.#files.has(path) || this.#dirs.has(path);
	}

	readTextFileSync(path: string): string {
		const content = this.#files.get(path);
		if (content === undefined) throw new Error(`ENOENT: no such file, ${path}`);
		return content;
	}

	readTextLinesSync(path: string): string[] {
		return this.readTextFileSync(path).split("\n");
	}

	writeTextFileSync(path: string, data: string): void {
		this.#files.set(path, data);
		const parts = path.split("/").filter(Boolean);
		parts.pop();
		let dir = "";
		for (const part of parts) {
			dir += `/${part}`;
			this.#dirs.add(dir);
		}
	}

	appendTextFileSync(path: string, data: string): void {
		this.writeTextFileSync(path, (this.#files.get(path) ?? "") + data);
	}

	mkdirSync(path: string): void {
		let dir = "";
		for (const part of path.split("/").filter(Boolean)) {
			dir += `/${part}`;
			this.#dirs.add(dir);
		}
	}

	readdirSync(path: string): Array<{ name: string; isFile: boolean; isDirectory: boolean }> {
		if (!this.#dirs.has(path) && path !== "/") throw new Error(`ENOENT: no such directory, ${path}`);
		const prefix = path.endsWith("/") ? path : `${path}/`;
		const names = new Set<string>();
		for (const file of this.#files.keys()) {
			if (file.startsWith(prefix)) names.add(file.slice(prefix.length).split("/")[0]!);
		}
		for (const dir of this.#dirs) {
			if (dir.startsWith(prefix) && dir !== path.replace(/\/$/, "")) {
				names.add(dir.slice(prefix.length).split("/")[0]!);
			}
		}
		return [...names].map((name) => {
			const child = `${prefix}${name}`;
			return { name, isFile: this.#files.has(child), isDirectory: this.#dirs.has(child) && !this.#files.has(child) };
		});
	}

	statSync(path: string): { size: number; mtimeMs: number; isFile: boolean; isDirectory: boolean } {
		if (this.#files.has(path)) {
			return { size: this.#files.get(path)!.length, mtimeMs: 0, isFile: true, isDirectory: false };
		}
		if (this.#dirs.has(path)) return { size: 0, mtimeMs: 0, isFile: false, isDirectory: true };
		throw new Error(`ENOENT: no such path, ${path}`);
	}

	renameSync(source: string, destination: string): void {
		const content = this.#files.get(source);
		if (content === undefined) throw new Error(`ENOENT: no such file, ${source}`);
		this.#files.delete(source);
		this.writeTextFileSync(destination, content);
	}

	canonicalizeSync(path: string): string {
		return path;
	}
}
