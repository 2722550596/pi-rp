import { describe, expect, it } from "vitest";
import { createHarness } from "./test-harness.ts";

/**
 * Path-changing operations must notify through the session event stream —
 * reroll/editMessage/setActivePreset emit leaf_changed / entry_edited /
 * preset_activated after their mutation + restore completes, so the TUI can
 * react uniformly instead of hard-coding manual re-renders.
 */
describe("path-changing session events", () => {
	it("reroll emits leaf_changed, branching to the last user message", async () => {
		const harness = await createHarness();
		try {
			await harness.session.prompt("First turn");

			const before = harness.eventsOfType("leaf_changed").length;
			const rerolled = await harness.session.reroll();

			expect(rerolled).toBe(true);
			const leafEvents = harness.eventsOfType("leaf_changed");
			expect(leafEvents).toHaveLength(before + 1);
			const ev = leafEvents[leafEvents.length - 1]!;
			expect(ev.oldLeafId).not.toBe(ev.newLeafId);
			// The new leaf is the user message the branch moved to.
			const newLeafEntry = ev.newLeafId ? harness.sessionManager.getEntry(ev.newLeafId) : undefined;
			expect(newLeafEntry?.type).toBe("message");
			if (newLeafEntry?.type === "message") {
				expect(newLeafEntry.message.role).toBe("user");
			}
		} finally {
			await harness.cleanup();
		}
	});

	it("reroll does not emit leaf_changed when there is no user message to branch to", async () => {
		const harness = await createHarness();
		try {
			const rerolled = await harness.session.reroll();
			expect(rerolled).toBe(false);
			expect(harness.eventsOfType("leaf_changed")).toHaveLength(0);
		} finally {
			await harness.cleanup();
		}
	});

	it("editMessage emits entry_edited for the edited entry", async () => {
		const harness = await createHarness();
		try {
			await harness.session.prompt("Edit me");
			const msgEntry = harness.sessionManager.getEntries().find((e) => e.type === "message");
			expect(msgEntry).toBeDefined();

			const edited = harness.session.editMessage(msgEntry!.id, "Edited text");

			expect(edited).toBe(true);
			const events = harness.eventsOfType("entry_edited");
			expect(events).toHaveLength(1);
			expect(events[0]!.entryId).toBe(msgEntry!.id);
		} finally {
			await harness.cleanup();
		}
	});

	it("setActivePreset emits preset_activated", async () => {
		const harness = await createHarness();
		try {
			// "default" is the disabled-preset id — activation falls back to the
			// built-in default preset and emits preset_activated without needing
			// any on-disk presets to be loaded.
			const result = await harness.session.setActivePreset("default");

			expect(result.ok).toBe(true);
			const events = harness.eventsOfType("preset_activated");
			expect(events).toHaveLength(1);
			expect(events[0]!.presetId).toBe("default");
		} finally {
			await harness.cleanup();
		}
	});
});
