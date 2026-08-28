import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { type CustomValidator, SchemaValidator } from "../src/state/schema-validator.ts";
import type { JsonValue } from "../src/state/state-manager.ts";

describe("SchemaValidator.validate — remove", () => {
	it("rejects removing a required field (projects the post-deletion subtree)", () => {
		const v = new SchemaValidator();
		v.loadSchema("s", "character", Type.Object({ name: Type.String(), hp: Type.Number() }));
		const state: Record<string, JsonValue> = { character: { name: "A", hp: 1 } };

		const res = v.validate("character.name", "remove", undefined, state);

		expect(res.ok).toBe(false);
	});

	it("allows removing an optional field", () => {
		const v = new SchemaValidator();
		v.loadSchema("s", "character", Type.Object({ hp: Type.Optional(Type.Number()) }));
		const state: Record<string, JsonValue> = { character: { hp: 1 } };

		const res = v.validate("character.hp", "remove", undefined, state);

		expect(res.ok).toBe(true);
	});

	it("lets a custom validator veto a remove", () => {
		const v = new SchemaValidator();
		v.loadSchema("s", "character", Type.Object({ hp: Type.Optional(Type.Number()) }));
		const veto: CustomValidator = {
			namespace: "character",
			path: "hp",
			validate: (value) => (value === undefined ? null : value),
		};
		v.setCustomValidators([veto]);
		const state: Record<string, JsonValue> = { character: { hp: 1 } };

		const res = v.validate("character.hp", "remove", undefined, state);

		expect(res.ok).toBe(false);
	});

	it("rejects removing a namespace root when the schema has required fields", () => {
		const v = new SchemaValidator();
		v.loadSchema("s", "character", Type.Object({ name: Type.String() }));
		const state: Record<string, JsonValue> = { character: { name: "A" } };

		const res = v.validate("character", "remove", undefined, state);

		expect(res.ok).toBe(false);
	});

	it("allows removing a namespace root when the schema is all-optional", () => {
		const v = new SchemaValidator();
		v.loadSchema("s", "character", Type.Object({ hp: Type.Optional(Type.Number()) }));
		const state: Record<string, JsonValue> = { character: { hp: 1 } };

		const res = v.validate("character", "remove", undefined, state);

		expect(res.ok).toBe(true);
	});
});

describe("SchemaValidator.validate — merge", () => {
	it("rejects a non-object merge value", () => {
		const v = new SchemaValidator();
		v.loadSchema("s", "character", Type.Object({ hp: Type.Optional(Type.Number()) }));
		const state: Record<string, JsonValue> = { character: { hp: 1 } };

		const nullRes = v.validate("", "merge", null, state);
		expect(nullRes.ok).toBe(false);
		if (!nullRes.ok) expect(nullRes.reason).toContain("object");

		const numRes = v.validate("", "merge", 5, state);
		expect(numRes.ok).toBe(false);
		if (!numRes.ok) expect(numRes.reason).toContain("object");
	});

	it("rejects a null-namespace delete that would violate a required-field schema", () => {
		const v = new SchemaValidator();
		v.loadSchema("s", "character", Type.Object({ name: Type.String(), hp: Type.Number() }));
		const state: Record<string, JsonValue> = { character: { name: "A", hp: 1 } };

		const res = v.validate("", "merge", { character: null }, state);

		expect(res.ok).toBe(false);
	});

	it("allows a null-namespace delete under an all-optional schema", () => {
		const v = new SchemaValidator();
		v.loadSchema("s", "character", Type.Object({ hp: Type.Optional(Type.Number()) }));
		const state: Record<string, JsonValue> = { character: { hp: 1 } };

		const res = v.validate("", "merge", { character: null }, state);

		expect(res.ok).toBe(true);
	});

	it("runs custom validators on merge and rejects on veto", () => {
		const v = new SchemaValidator();
		v.loadSchema("s", "character", Type.Object({ mp: Type.Number() }));
		const rejectHighMp: CustomValidator = {
			namespace: "character",
			path: "mp",
			validate: (value) => (typeof value === "number" && value > 100 ? null : (value ?? null)),
		};
		v.setCustomValidators([rejectHighMp]);
		const state: Record<string, JsonValue> = { character: { mp: 0 } };

		const res = v.validate("", "merge", { character: { mp: 999 } }, state);

		expect(res.ok).toBe(false);
	});

	it("applies custom-validator corrections (clamp) during merge", () => {
		const v = new SchemaValidator();
		v.loadSchema("s", "character", Type.Object({ name: Type.String(), hp: Type.Number({ minimum: 0 }) }));
		const clampHp: CustomValidator = {
			namespace: "character",
			path: "hp",
			validate: (value) => (typeof value === "number" && value > 100 ? 100 : (value ?? null)),
		};
		v.setCustomValidators([clampHp]);
		const state: Record<string, JsonValue> = { character: { name: "A", hp: 1 } };

		const res = v.validate("", "merge", { character: { hp: 999 } }, state);

		expect(res.ok).toBe(true);
		expect(res.correctedValue).toMatchObject({ character: { hp: 100 } });
	});

	it("rejects a non-object namespace value in a merge", () => {
		const v = new SchemaValidator();
		v.loadSchema("s", "character", Type.Object({ name: Type.String() }));
		const state: Record<string, JsonValue> = { character: { name: "A" } };

		const res = v.validate("", "merge", { character: 5 }, state);

		expect(res.ok).toBe(false);
	});
});

describe("SchemaValidator.validate — whole-namespace replace/add", () => {
	it("rejects a JSON-encoded string value replacing a namespace root", () => {
		const v = new SchemaValidator();
		v.loadSchema("s", "character", Type.Object({ mood: Type.String() }));
		const state: Record<string, JsonValue> = { character: { mood: "calm" } };

		const res = v.validate("character", "replace", '{"mood": "angry"}', state);

		expect(res.ok).toBe(false);
	});

	it("rejects a JSON-encoded string value added at a namespace root", () => {
		const v = new SchemaValidator();
		v.loadSchema("s", "world", Type.Object({ time: Type.String() }));
		const state: Record<string, JsonValue> = { world: { time: "day" } };

		const res = v.validate("world", "add", '{"time": "night"}', state);

		expect(res.ok).toBe(false);
	});

	it("validates the incoming object on a whole-namespace replace (not the old state)", () => {
		const v = new SchemaValidator();
		v.loadSchema("s", "character", Type.Object({ name: Type.String(), hp: Type.Number() }));
		const state: Record<string, JsonValue> = { character: { name: "A", hp: 1 } };

		// hp missing in the replacement value → must fail even though the OLD state is valid
		const res = v.validate("character", "replace", { name: "B" }, state);

		expect(res.ok).toBe(false);
	});

	it("accepts a schema-valid whole-namespace replace", () => {
		const v = new SchemaValidator();
		v.loadSchema("s", "character", Type.Object({ name: Type.String(), hp: Type.Number() }));
		const state: Record<string, JsonValue> = { character: { name: "A", hp: 1 } };

		const res = v.validate("character", "replace", { name: "B", hp: 2 }, state);

		expect(res.ok).toBe(true);
	});
});

describe("SchemaValidator.clearSchemas", () => {
	it("removes all loaded schemas", () => {
		const v = new SchemaValidator();
		v.loadSchema("s1", "character", Type.Object({ hp: Type.Number() }));
		v.loadSchema("s2", "world", Type.Object({ name: Type.String() }));
		expect(v.getActiveNamespaces()).toEqual(["character", "world"]);

		v.clearSchemas();

		expect(v.getActiveNamespaces()).toEqual([]);
	});

	it("makes previously covered paths freeform (non-strict)", () => {
		const v = new SchemaValidator();
		v.loadSchema("s", "character", Type.Object({ hp: Type.Number({ minimum: 0 }) }));
		v.clearSchemas();
		const state: Record<string, JsonValue> = {};

		// Previously would fail (minimum: 0); after clearSchemas it's freeform
		const res = v.validate("character.hp", "replace", -5, state);
		expect(res.ok).toBe(true);
	});
});

describe("SchemaValidator.getDefaultValue", () => {
	it("collects defaults from a raw JSON Schema object (.json path)", () => {
		const v = new SchemaValidator();
		v.loadSchema("s", "world", {
			type: "object",
			properties: {
				day: { type: "number", default: 1 },
				scene: { type: "string", default: "午后" },
				present: { type: "array", items: { type: "string" } },
				empty: { type: "object", properties: { a: { type: "number", default: 2 } } },
			},
		});

		expect(v.getDefaultValue("world")).toEqual({
			day: 1,
			scene: "午后",
			present: [],
			empty: { a: 2 },
		});
	});

	it("short-circuits on a root-level default", () => {
		const v = new SchemaValidator();
		v.loadSchema("s", "world", {
			type: "object",
			default: { day: 9 },
			properties: { day: { type: "number" } },
		});

		expect(v.getDefaultValue("world")).toEqual({ day: 9 });
	});

	it("leaves primitives without defaults absent instead of inventing values", () => {
		const v = new SchemaValidator();
		v.loadSchema("s", "world", {
			type: "object",
			properties: { hp: { type: "number" }, mood: { type: "string" } },
		});

		expect(v.getDefaultValue("world")).toEqual({});
	});

	it("still materializes TypeBox schematics via Value.Create (.ts path regression)", () => {
		const v = new SchemaValidator();
		v.loadSchema("s", "world", Type.Object({ day: Type.Number({ default: 1 }), mood: Type.String() }));

		expect(v.getDefaultValue("world")).toEqual({ day: 1, mood: "" });
	});
});
