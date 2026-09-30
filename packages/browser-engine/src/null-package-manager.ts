/**
 * Null PackageManager for shell-less profiles (12-C §9 seam 4: browser/hosted assemblies
 * inject this into DefaultResourceLoader; the npm/git disk channel is negotiated off).
 *
 * Reads resolve to empty resource sets (negotiated absence, 契约 §4 原则 2); mutation
 * operations fail structurally with the capability message instead of silently no-oping.
 */
import type {
	ConfiguredPackage,
	MissingSourceAction,
	PackageManager,
	PathMetadata,
	ProgressCallback,
	ResolvedPaths,
	ResolvedResource,
} from "../../coding-agent/src/core/package-manager.ts";

const EMPTY_PATHS: ResolvedPaths = { extensions: [], skills: [], prompts: [], themes: [] };

const NEGOTIATED_METADATA: PathMetadata = { source: "negotiated-off", scope: "project", origin: "top-level" };

function emptyResources(sources: string[]): ResolvedPaths {
	// Sources are recorded as disabled entries so callers can surface "why didn't my
	// package load" diagnostics instead of a silent empty set.
	const disabled: ResolvedResource[] = sources.map((path) => ({
		path,
		enabled: false,
		metadata: NEGOTIATED_METADATA,
	}));
	return { extensions: disabled, skills: [], prompts: [], themes: [] };
}

const NEGOTIATED_OFF =
	"pi-harness: npm/git package installation is negotiated off in this profile (shell capability unavailable); bundle extensions via extensions.factories instead";

export class NullPackageManager implements PackageManager {
	async resolve(_onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths> {
		return EMPTY_PATHS;
	}

	async install(): Promise<never> {
		throw new Error(NEGOTIATED_OFF);
	}

	async installAndPersist(): Promise<never> {
		throw new Error(NEGOTIATED_OFF);
	}

	async remove(): Promise<never> {
		throw new Error(NEGOTIATED_OFF);
	}

	async removeAndPersist(): Promise<never> {
		throw new Error(NEGOTIATED_OFF);
	}

	async update(): Promise<never> {
		throw new Error(NEGOTIATED_OFF);
	}

	listConfiguredPackages(): ConfiguredPackage[] {
		return [];
	}

	async resolveExtensionSources(sources: string[]): Promise<ResolvedPaths> {
		return emptyResources(sources);
	}

	addSourceToSettings(): boolean {
		return false;
	}

	removeSourceFromSettings(): boolean {
		return false;
	}

	setProgressCallback(_callback: ProgressCallback | undefined): void {}

	getInstalledPath(): string | undefined {
		return undefined;
	}
}
