import type { JsonValue } from "../../../state/merge.ts";
import { applyOp, type SeedOp, type StateOp } from "../../../state/state-manager.ts";
import type { TreeEdit } from "./index.ts";

function equal(left: JsonValue, right: JsonValue): boolean {
	if (Object.is(left, right)) return true;
	if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
	if (Array.isArray(left) !== Array.isArray(right)) return false;
	if (Array.isArray(left) && Array.isArray(right)) {
		if (left.length !== right.length) return false;
		for (let i = 0; i < left.length; i++) {
			if (i in left !== i in right) return false;
			if (i in left && !equal(left[i], right[i])) return false;
		}
		return true;
	}
	const a = left as Record<string, JsonValue>;
	const b = right as Record<string, JsonValue>;
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]));
}

function diff(before: JsonValue, after: JsonValue, path: string[], edits: TreeEdit[]): void {
	if (equal(before, after)) return;
	if (Array.isArray(before) && Array.isArray(after)) {
		if (after.length < before.length) {
			edits.push(path.length === 0 ? { op: "replaceRoot", value: after } : { op: "set", path, value: after });
			return;
		}
		for (let i = 0; i < before.length; i++) {
			if (i in before !== i in after)
				edits.push(
					i in after
						? { op: "set", path: [...path, String(i)], value: after[i] }
						: { op: "remove", path: [...path, String(i)] },
				);
			else if (i in before) diff(before[i], after[i], [...path, String(i)], edits);
		}
		for (let i = before.length; i < after.length; i++) {
			if (i !== before.length || !(i in after)) {
				edits.push(path.length === 0 ? { op: "replaceRoot", value: after } : { op: "set", path, value: after });
				return;
			}
			edits.push({ op: "set", path: [...path, String(i)], value: after[i] });
		}
		return;
	}
	if (
		before !== null &&
		after !== null &&
		typeof before === "object" &&
		typeof after === "object" &&
		!Array.isArray(before) &&
		!Array.isArray(after)
	) {
		const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
		for (const key of keys) {
			const hasBefore = Object.hasOwn(before, key);
			const hasAfter = Object.hasOwn(after, key);
			if (!hasAfter) edits.push({ op: "remove", path: [...path, key] });
			else if (!hasBefore) edits.push({ op: "set", path: [...path, key], value: after[key] });
			else diff(before[key], after[key], [...path, key], edits);
		}
		return;
	}
	if (path.length === 0) edits.push({ op: "replaceRoot", value: after });
	else edits.push({ op: "set", path, value: after });
}

/** Maps the exact StateManager transition to a deterministic sequence of TreeEdits. */
export function stateOpToTreeEdits(
	state: Record<string, JsonValue>,
	op: StateOp | SeedOp,
	path: string,
	value: JsonValue | undefined,
): TreeEdit[] {
	const before = structuredClone(state);
	const after = structuredClone(state);
	applyOp(after, op, path, value);
	const edits: TreeEdit[] = [];
	diff(before, after, [], edits);
	return edits;
}
