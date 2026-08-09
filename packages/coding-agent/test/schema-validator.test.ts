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
