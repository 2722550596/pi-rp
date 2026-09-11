import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, it } from "vitest";
import { ENV_AGENT_DIR, ENV_PROJECT_CONFIG_DIR } from "../../src/config.ts";
import { isPrepareError, prepareSubagentConversation } from "../../src/core/subagent/prepare.ts";
import { runSubagent } from "../../src/core/subagent/run.ts";
import { createHarness, getMessageText } from "./harness.ts";

// E2E (AIRP view): "world initialization" via a recursive preset dir, a
// parameterized file slot, and a write-capable subagent, all rooted at a
// world cwd that differs from process.cwd(). Covers C7 (recursion), C3
// (slot options macros), C1/C2 (write tool), C5 (session cwd).
describe("e2e: airp-style world init via subagent", () => {
	it("discovers a nested preset, renders its parameterized file slot, and writes into the world cwd", async () => {
		const prevAgentDir = process.env[ENV_AGENT_DIR];
		const prevProjectConfigDir = process.env[ENV_PROJECT_CONFIG_DIR];
		const harness = await createHarness({ settings: { userName: "明月" } });
		try {
			// World dir = harness temp dir (differs from process.cwd()).
			const worldDir = harness.tempDir;
			assert.notEqual(process.cwd(), worldDir, "world cwd must differ from process cwd (C5)");

			// AIRP-style config dir name, exercised via env.
			process.env[ENV_PROJECT_CONFIG_DIR] = ".airpworld";
			process.env[ENV_AGENT_DIR] = join(worldDir, "agent");

			// C7: preset lives two levels deep, discovered by recursion.
			const presetDir = join(worldDir, ".airpworld", "prompt-presets", "agent", "main");
			mkdirSync(presetDir, { recursive: true });
			writeFileSync(
				join(presetDir, "world-init.json"),
				JSON.stringify({
					schemaVersion: 1,
					id: "world-init",
					delegatable: true,
					variables: { who: "w" },
					tools: { allow: ["read", "bash", "write"] },
					items: [
						{ kind: "block", id: "role", enabled: true, role: "system", content: "你是世界初始化子代理。" },
						// C3: parameterized file slot — {{who}} resolved from runtime variables.
						{
							kind: "slot",
							id: "who",
							enabled: true,
							role: "user",
							slot: "file",
							options: { path: "{{who}}.md" },
						},
						{
							kind: "block",
							id: "prompt",
							enabled: true,
							role: "user",
							content: "读取角色定义后，把初始化结果写入 notes/init.md。",
						},
					],
				}),
			);
			// C3 fixture: the parameterized path resolves to this file.
			writeFileSync(join(worldDir, "w.md"), "角色：凌霜，职业：织梦者。");

			harness.session.reloadPresets();

			// prepareSubagentConversation with cwd = worldDir (the "writer
			// delegation" entry point, same path the subagent tool uses).
			const preparation = await prepareSubagentConversation({
				cwd: worldDir,
				profileId: "world-init",
				task: "初始化世界。",
				modelRuntime: harness.session.modelRuntime,
				session: harness.session,
				modelRef: `${harness.getModel().provider}/${harness.getModel().id}`,
			});
			assert.equal(isPrepareError(preparation), false, isPrepareError(preparation) ? preparation.error : "");
			if (isPrepareError(preparation)) return;

			// C1/C2: allow:["read","bash","write"] keeps write; C3: the file
			// slot read the parameterized path (content visible in messages).
			assert.ok(preparation.effectiveTools.includes("write"), "write must survive the allow policy (C1/C2)");
			const allText = preparation.messages.map((m) => getMessageText(m)).join("\n");
			assert.ok(allText.includes("织梦者"), `file slot must render {{who}}.md content (C3): ${allText}`);

			// C1/C2 + C5: drive the subagent so the model writes a relative
			// path; the file must land under the world cwd.
			harness.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("write", { path: "notes/init.md", content: "初始化完成：凌霜已登记。" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("世界初始化完成。"),
			]);
			const runResult = await runSubagent(preparation, harness.session.modelRuntime);
			assert.equal(runResult.status, "completed", `run error: ${runResult.error ?? "none"}`);

			const written = join(worldDir, "notes", "init.md");
			assert.ok(existsSync(written), `relative write must land under the world cwd (C5): ${written}`);
			assert.ok(readFileSync(written, "utf-8").includes("凌霜"), "written content must be intact (C1/C2)");
		} finally {
			process.env[ENV_AGENT_DIR] = prevAgentDir;
			process.env[ENV_PROJECT_CONFIG_DIR] = prevProjectConfigDir;
			harness.cleanup();
		}
	});
});
