import type { PromptResourcePolicy } from "./types.ts";

export function hasResourcePolicy(policy: PromptResourcePolicy | undefined): boolean {
	return !!policy && (hasEffectiveAllowPolicy(policy.allow) || hasPatterns(policy.deny));
}

export function applyResourcePolicy(names: string[], policy: PromptResourcePolicy | undefined): string[] {
	return names.filter((name) => isResourceAllowed(name, policy));
}

export function isResourceAllowed(name: string, policy: PromptResourcePolicy | undefined): boolean {
	if (!policy) return true;
	if (hasEffectiveAllowPolicy(policy.allow) && !matchesAnyPattern(name, policy.allow)) return false;
	return !hasPatterns(policy.deny) || !matchesAnyPattern(name, policy.deny);
}

export function matchesAnyPattern(name: string, patterns: string[]): boolean {
	return patterns.some((pattern) => resourcePatternMatches(name, pattern));
}

export function resourcePatternMatches(name: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (!pattern.includes("*")) return name === pattern;
	const escaped = pattern.split("*").map(escapeRegExp).join(".*");
	return new RegExp(`^${escaped}$`).test(name);
}

function hasPatterns(value: string[] | undefined): value is string[] {
	return Array.isArray(value) && value.length > 0;
}

function hasEffectiveAllowPolicy(value: string[] | undefined): value is string[] {
	// empty allow = explicit "allow nothing" (effective deny-all); non-empty with only "*" = no-op
	return Array.isArray(value) && (!hasPatterns(value) || value.some((pattern) => pattern !== "*"));
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
