import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class HostRootOwnedError extends Error {
	readonly code = "busy" as const;
	readonly details = { reason: "root_owned" } as const;

	constructor(message = "Session storage root is already owned by another process", options?: ErrorOptions) {
		super(message, options);
		this.name = "HostRootOwnedError";
	}
}

/**
 * Hold an SQLite EXCLUSIVE transaction for the lifetime of this handle. SQLite's
 * kernel-managed file locks cannot be reclaimed based on age; process death
 * closes the descriptor and rolls back the transaction.
 */
export class HostRootLock {
	readonly rootPath: string;
	private database: DatabaseSync | undefined;

	private constructor(database: DatabaseSync, rootPath: string) {
		this.database = database;
		this.rootPath = rootPath;
	}

	static async acquire(rootPath: string): Promise<HostRootLock> {
		const root = await realpath(rootPath);
		await assertLocalFilesystem(root);
		await securePrivatePath(root, true);
		const databasePath = join(root, "host_lock.sqlite");
		await ensureRegularFileWithoutSymlink(root, databasePath, true);
		let database: DatabaseSync | undefined;
		try {
			database = new DatabaseSync(databasePath);
			await ensureRegularFileWithoutSymlink(root, databasePath, false);
			database.exec("PRAGMA busy_timeout = 0");
			database.exec("BEGIN EXCLUSIVE");
			database.exec("CREATE TABLE IF NOT EXISTS host_lock (namespace TEXT PRIMARY KEY, owner TEXT NOT NULL)");
			database
				.prepare("INSERT OR REPLACE INTO host_lock(namespace, owner) VALUES (?, ?)")
				.run("host_lock", `${process.pid}:${Date.now()}`);
			return new HostRootLock(database, root);
		} catch (error) {
			database?.close();
			if (isSqliteLocked(error)) throw new HostRootOwnedError(undefined, { cause: error });
			throw error;
		}
	}

	close(): void {
		const database = this.database;
		if (!database) return;
		this.database = undefined;
		try {
			database.exec("ROLLBACK");
		} finally {
			database.close();
		}
	}
}

export function parseLinuxMountInfo(contents: string): Array<{ mountPoint: string; fsType: string }> {
	return contents
		.split("\n")
		.map((line) => {
			const separator = line.indexOf(" - ");
			if (separator < 0) return undefined;
			const before = line.slice(0, separator).split(" ");
			const after = line.slice(separator + 3).split(" ");
			return { mountPoint: unescapeMount(before[4] ?? ""), fsType: after[0] ?? "" };
		})
		.filter((entry): entry is { mountPoint: string; fsType: string } => entry !== undefined);
}

/** Parse macOS `mount -p` fstab-format rows (special, mountpoint, type, ...). */
export function parseMacMountTable(contents: string): Array<{ mountPoint: string; fsType: string }> {
	return contents
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.filter((fields) => fields.length >= 3)
		.map((fields) => ({ mountPoint: unescapeMount(fields[1] ?? ""), fsType: fields[2] ?? "" }));
}

export function findMountForPath(
	path: string,
	mounts: readonly { mountPoint: string; fsType: string }[],
	caseInsensitive = false,
): { mountPoint: string; fsType: string } | undefined {
	const candidate = normalizeForComparison(path, caseInsensitive);
	return mounts
		.filter(({ mountPoint }) => {
			const mount = normalizeForComparison(mountPoint, caseInsensitive).replace(/[\\/]+$/, "") || sep;
			return candidate === mount || candidate.startsWith(mount === sep ? sep : `${mount}${sep}`);
		})
		.sort((a, b) => b.mountPoint.length - a.mountPoint.length)[0];
}

export function isSupportedLocalFilesystem(platform: NodeJS.Platform, fsType: string): boolean {
	const supported: Partial<Record<NodeJS.Platform, readonly string[]>> = {
		linux: ["ext4", "xfs", "btrfs", "zfs"],
		darwin: ["apfs", "hfs", "ufs"],
		win32: ["fixed"],
	};
	return supported[platform]?.includes(fsType.trim().toLowerCase()) ?? false;
}

export function parseWindowsDriveType(value: string): boolean {
	return isSupportedLocalFilesystem("win32", value.trim());
}

export function parseWindowsLocalVolumeInfo(value: string): boolean {
	const [driveType, driveFormat] = value.trim().split(/\r?\n/);
	return (
		parseWindowsDriveType(driveType ?? "") &&
		["exfat", "fat", "fat32", "ntfs", "refs"].includes((driveFormat ?? "").trim().toLowerCase())
	);
}
export function isWindowsLocalVolumePath(path: string, driveType: string): boolean {
	const localPath = path.startsWith("\\\\?\\") ? path.slice(4) : path;
	return (
		!localPath.startsWith("\\\\") &&
		!localPath.startsWith("//") &&
		/^[A-Za-z]:[\\/]/.test(localPath) &&
		parseWindowsDriveType(driveType)
	);
}

function isSqliteLocked(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = (error as NodeJS.ErrnoException).code;
	return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || /database is (?:locked|busy)/i.test(error.message);
}

async function assertLocalFilesystem(root: string): Promise<void> {
	const platform = process.platform;
	if (platform === "linux") {
		const mountInfo = await readFile("/proc/self/mountinfo", "utf8");
		const mount = findMountForPath(root, parseLinuxMountInfo(mountInfo));
		if (!mount || !isSupportedLocalFilesystem(platform, mount.fsType)) {
			throw new Error(`Session storage root is not on a verified local filesystem: ${root}`);
		}
		return;
	}
	if (platform === "darwin") {
		const mounts = execFileSync("/sbin/mount", ["-p"], { encoding: "utf8" });
		const mount = findMountForPath(root, parseMacMountTable(mounts));
		if (!mount || !isSupportedLocalFilesystem(platform, mount.fsType)) {
			throw new Error(`Session storage root is not on a verified local filesystem: ${root}`);
		}
		return;
	}
	if (platform === "win32") {
		const localPath = root.startsWith("\\\\?\\") ? root.slice(4) : root;
		if (localPath.startsWith("\\\\") || localPath.startsWith("//") || !isAbsolute(localPath)) {
			throw new Error(`UNC or unverified session storage root is not supported: ${root}`);
		}
		if (!/^[A-Za-z]:[\\/]/.test(localPath)) {
			throw new Error(`Cannot resolve a local drive for session storage root: ${root}`);
		}
		const volumeInfo = execFileSync(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"$drive = [System.IO.Path]::GetPathRoot($env:PI_HOST_ROOT); if (!$drive) { exit 23 }; $info = [System.IO.DriveInfo]::new($drive); [Console]::Out.WriteLine($info.DriveType.ToString()); [Console]::Out.WriteLine($info.DriveFormat)",
			],
			{
				encoding: "utf8",
				windowsHide: true,
				env: { ...process.env, PI_HOST_ROOT: localPath },
			},
		);
		if (
			!isWindowsLocalVolumePath(root, volumeInfo.split(/\r?\n/)[0] ?? "") ||
			!parseWindowsLocalVolumeInfo(volumeInfo)
		) {
			throw new Error(`Session storage root is not on a supported fixed local volume: ${root}`);
		}
		return;
	}
	throw new Error(`Cannot verify local filesystem root locking on ${platform}`);
}

/** Enforce private access on host-owned root/session files and directories. */
export function securePrivatePath(path: string, directory: boolean): void {
	if (process.platform === "win32") {
		const inheritance = directory
			? "[System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit"
			: "[System.Security.AccessControl.InheritanceFlags]::None";
		const script = [
			"$acl = Get-Acl -LiteralPath $env:PI_PRIVATE_PATH -ErrorAction Stop",
			"$acl.SetAccessRuleProtection($true, $false)",
			"foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }",
			"$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
			`$inheritance = ${inheritance}`,
			"$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)",
			"$acl.SetAccessRule($rule)",
			"Set-Acl -LiteralPath $env:PI_PRIVATE_PATH -AclObject $acl -ErrorAction Stop",
		].join("; ");
		execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
			encoding: "utf8",
			windowsHide: true,
			env: { ...process.env, PI_PRIVATE_PATH: path },
		});
		return;
	}
	chmodSync(path, directory ? 0o700 : 0o600);
}

async function ensureRegularFileWithoutSymlink(root: string, filePath: string, create: boolean): Promise<void> {
	let created = false;
	if (create) {
		try {
			const handle = await open(filePath, "wx", 0o600);
			await handle.close();
			created = true;
		} catch (error) {
			if (!isAlreadyExists(error)) throw error;
		}
	}
	const details = await lstat(filePath);
	if (details.isSymbolicLink() || !details.isFile()) {
		throw new Error(`Expected a regular non-symlink file: ${filePath}`);
	}
	const canonical = await realpath(filePath);
	if (dirname(canonical) !== root) throw new Error(`Lock database resolves outside the session root: ${filePath}`);
	if (created && process.platform !== "win32") securePrivatePath(filePath, false);
}

function normalizeForComparison(value: string, caseInsensitive: boolean): string {
	const normalized = resolve(value).replace(/[\\/]+$/, "") || sep;
	return caseInsensitive ? normalized.toLowerCase() : normalized;
}

function isAlreadyExists(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function unescapeMount(value: string): string {
	return value.replace(/\\(040|011|012|134)/g, (_match, octal: string) =>
		String.fromCharCode(Number.parseInt(octal, 8)),
	);
}

export async function acquireHostRootLock(rootPath: string): Promise<HostRootLock> {
	await mkdir(rootPath, { recursive: true, mode: 0o700 });
	return HostRootLock.acquire(rootPath);
}
