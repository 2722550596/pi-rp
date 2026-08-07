/**
 * Regression: navigateTree rollback must restore StateManager state to the
 * target branch's last state snapshot.
 *
 * Previously, navigateTree only moved the session leaf pointer and synced
 * agent.state.messages; _stateManager._data kept the old branch's snapshot.
 * get_state / the next state_update / the turn_end appendState all operated on
 * the stale state, permanently polluting the target branch.
 */

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createHarness } from "../suite/harness.ts";

describe("navigateTree restores state to the target branch", () => {
	it("rolls back StateManager state to the target leaf's last state entry", async () => {
		const harness = await createHarness();
		try {
			const { session, sessionManager } = harness;
			harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);

			// Turn 1: u1 -> a1. Persist turn-1 state as a session entry (parent = a1),
			// mirroring the turn_end appendState of a state_update during turn 1.
			await session.prompt("first turn");
			await session.agent.waitForIdle();
			const turn1StateId = sessionManager.appendState({ ns: { v: 1 } });

			// Turn 2: u2 parents onto the state entry, then a2. Persist turn-2 state.
			await session.prompt("second turn");
			await session.agent.waitForIdle();
			const turn2StateId = sessionManager.appendState({ ns: 2 });

			// Live state matches the turn-2 snapshot (what state_update produced).
			session.stateManager.apply("ns", "replace", 2);

			// Both state entries are on the active path, holding per-turn values
			const stateEntries = sessionManager.getEntries().filter((e) => e.type === "state");
			expect(stateEntries.map((e) => e.id)).toEqual([turn1StateId, turn2StateId]);
			expect(stateEntries[0]!.state).toEqual({ ns: { v: 1 } });
			expect(stateEntries[1]!.state).toEqual({ ns: 2 });

			// Live state is the newer value — exactly what navigateTree must roll
			// back (pre-fix it leaked into the target branch).
			expect(session.stateManager.get("ns")).toBe(2);

			// Roll back to turn 2's user message: the leaf lands on the turn-1
			// state entry, so the target branch's last snapshot is { v: 1 }.
			const userMessages = sessionManager
				.getEntries()
				.filter((e) => e.type === "message" && e.message.role === "user");
			expect(userMessages).toHaveLength(2);
			const result = await session.navigateTree(userMessages[1]!.id, { summarize: false });
			expect(result.cancelled).toBe(false);

			// Not a no-op: the leaf really moved to the turn-1 state entry
			expect(sessionManager.getLeafId()).toBe(turn1StateId);

			// State is restored to the target branch's last state snapshot
			expect(session.stateManager.get("ns")).toEqual({ v: 1 });
		} finally {
			harness.cleanup();
		}
	});
});
